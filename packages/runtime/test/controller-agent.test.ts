import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { JSONValue } from '../../protocol/src/json.ts';
import { AttemptJournal } from '../src/attempt-journal.ts';
import { NativeManagedController } from '../src/native-managed-controller.ts';
import type { AgentDecisionFactory } from '../src/native-managed-controller.ts';

function agent(requestId: string, text: string) {
  return { type: 'start_agent', requestId, decisionProvider: 'jev', command: { type: 'command',
    protocolVersion: '2.0', messageId: randomUUID(), taskId: requestId, taskEpoch: 1, goalRevision: 1,
    source: 'voice', mode: 'command', utteranceId: randomUUID(), utteranceRevision: 1, text, isFinal: true,
    createdAt: new Date().toISOString(), originSurface: { adapter: 'native', surfaceId: 'systemone-panel',
      appBundleId: 'com.aurium.systemone.dev', windowId: 'command-panel', contentRevision: requestId } } };
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 3_000; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 2)); }
  throw new Error('controller agent status did not arrive');
}

test('Stop while the agent is still starting is clean and never blocks the next request', async t => {
  const root = mkdtempSync(join(tmpdir(), 'systemone-controller-agent-'));
  const journal = new AttemptJournal(join(root, 'attempts.sqlite'));
  const phases: { id: string; phase: string }[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const factory: AgentDecisionFactory = async () => {
    if (++calls === 1) await gate; // first start is slow, like a Keychain read
    return { async select(set) {
      return (set.candidates.find(c => c.operation === 'finish')?.candidateId as string | undefined) ?? null;
    } };
  };
  let controller!: NativeManagedController;
  controller = new NativeManagedController(journal, (id, phase) => { phases.push({ id, phase }); }, true, undefined,
    (message: Record<string, JSONValue>) => {
      if (message.type === 'agent_ax_request') queueMicrotask(() => controller.receive(Buffer.from(JSON.stringify({
        type: 'agent_ax_reply', requestId: message.requestId, ok: true, value: { app: 'Notes', bundleId: 'com.apple.Notes',
          pid: 9, windowTitle: 'Notes', url: '', elements: [], truncated: false, signature: 's' } }))));
      if (message.type === 'browse_proposal') queueMicrotask(() => controller.receive(Buffer.from(JSON.stringify({
        type: 'confirm_step', requestId: randomUUID(), targetRequestId: message.requestId,
        proposalId: message.proposalId, allow: true }))));
    }, undefined, false, undefined, undefined, factory);
  t.after(async () => { await controller.close(); rmSync(root, { recursive: true, force: true }); });
  const has = (id: string, phase: string) => phases.some(p => p.id === id && p.phase === phase);
  const first = randomUUID();
  controller.receive(Buffer.from(JSON.stringify(agent(first, 'play the video'))));
  const stop = randomUUID();
  controller.receive(Buffer.from(JSON.stringify({ type: 'stop', requestId: stop, targetRequestId: first })));
  await waitFor(() => has(stop, 'stopped') || has(stop, 'uncertain'));
  assert.equal(has(stop, 'stopped'), true);
  release();
  await waitFor(() => has(first, 'ready'));
  const second = randomUUID();
  controller.receive(Buffer.from(JSON.stringify(agent(second, 'play the video'))));
  await waitFor(() => has(second, 'agent_done') || has(second, 'blocked_recovery') || has(second, 'error'));
  assert.equal(has(second, 'agent_done'), true);
});

test('a paused agent task never blocks the next request', async t => {
  const root = mkdtempSync(join(tmpdir(), 'systemone-controller-agent-paused-'));
  const journal = new AttemptJournal(join(root, 'attempts.sqlite'));
  const phases: { id: string; phase: string }[] = [];
  let calls = 0;
  let controller!: NativeManagedController;
  controller = new NativeManagedController(journal, (id, phase) => { phases.push({ id, phase }); }, true, undefined,
    (message: Record<string, JSONValue>) => {
      if (message.type === 'agent_ax_request') queueMicrotask(() => controller.receive(Buffer.from(JSON.stringify({
        type: 'agent_ax_reply', requestId: message.requestId, ok: true, value: { app: 'Notes', bundleId: 'com.apple.Notes',
          pid: 9, windowTitle: 'Notes', url: '', elements: [], truncated: false, signature: 's' } }))));
      if (message.type === 'browse_proposal') queueMicrotask(() => controller.receive(Buffer.from(JSON.stringify({
        type: 'confirm_step', requestId: randomUUID(), targetRequestId: message.requestId,
        proposalId: message.proposalId, allow: true }))));
    }, undefined, false, undefined, undefined, async () => ({ async select(set) {
      // First task abstains (pauses); the second finishes.
      return ++calls === 1 ? null : (set.candidates.find(c => c.operation === 'finish')?.candidateId as string);
    } }));
  t.after(async () => { await controller.close(); rmSync(root, { recursive: true, force: true }); });
  const has = (id: string, phase: string) => phases.some(p => p.id === id && p.phase === phase);
  const first = randomUUID();
  controller.receive(Buffer.from(JSON.stringify(agent(first, 'do something unclear'))));
  await waitFor(() => has(first, 'agent_paused'));
  await waitFor(() => has(first, 'ready') || has(first, 'blocked_recovery'));
  const second = randomUUID();
  controller.receive(Buffer.from(JSON.stringify(agent(second, 'play the video'))));
  await waitFor(() => has(second, 'agent_done') || has(second, 'blocked_recovery') || has(second, 'error'));
  assert.equal(has(second, 'agent_done'), true);
  assert.equal(journal.getTaskState(first), 'cancelled');
});

test('a follow-up request receives what the previous request did', async t => {
  const root = mkdtempSync(join(tmpdir(), 'systemone-controller-agent-context-'));
  const journal = new AttemptJournal(join(root, 'attempts.sqlite'));
  const phases: { id: string; phase: string }[] = [];
  const contexts: (string | undefined)[] = [];
  let controller!: NativeManagedController;
  controller = new NativeManagedController(journal, (id, phase) => { phases.push({ id, phase }); }, true, undefined,
    (message: Record<string, JSONValue>) => {
      if (message.type === 'agent_ax_request') queueMicrotask(() => controller.receive(Buffer.from(JSON.stringify({
        type: 'agent_ax_reply', requestId: message.requestId, ok: true, value: { app: 'Google Chrome',
          bundleId: 'com.google.Chrome', pid: 9, windowTitle: 'lofi - YouTube', url: 'https://www.youtube.com/results',
          elements: [], truncated: false, signature: 's' } }))));
      if (message.type === 'browse_proposal') queueMicrotask(() => controller.receive(Buffer.from(JSON.stringify({
        type: 'confirm_step', requestId: randomUUID(), targetRequestId: message.requestId,
        proposalId: message.proposalId, allow: true }))));
    }, undefined, false, undefined, undefined, async (_id, _goal, context) => {
      contexts.push(context);
      return { async select(set) { return set.candidates.find(c => c.operation === 'finish')?.candidateId as string; } };
    });
  t.after(async () => { await controller.close(); rmSync(root, { recursive: true, force: true }); });
  const has = (id: string, phase: string) => phases.some(p => p.id === id && p.phase === phase);
  const first = randomUUID();
  controller.receive(Buffer.from(JSON.stringify(agent(first, 'search youtube for lofi'))));
  await waitFor(() => has(first, 'ready'));
  const second = randomUUID();
  controller.receive(Buffer.from(JSON.stringify(agent(second, 'now play the second one'))));
  await waitFor(() => has(second, 'agent_done'));
  assert.equal(contexts[0], undefined);
  assert.match(contexts[1] ?? '', /search youtube for lofi/u);
  assert.match(contexts[1] ?? '', /youtube\.com\/results/u);
});

test('a 👎 with a reason and a correction lands in the task trace and its dataset file', async t => {
  const root = mkdtempSync(join(tmpdir(), 'systemone-controller-feedback-'));
  const previous = process.env.SYSTEMONE_TRACE_DIR;
  process.env.SYSTEMONE_TRACE_DIR = join(root, 'traces');
  const journal = new AttemptJournal(join(root, 'attempts.sqlite'));
  const phases: { id: string; phase: string }[] = [];
  const factory: AgentDecisionFactory = async (_id, _goal, _context, judgment) => ({ async select(set) {
    judgment?.({ kind: 'judgment', ms: 5, request: { state: 'Goal: play the video.', questions: { next_action: {
      instructions: 'Which step?', criteria: { finish: 'Done: stop here.' } } } },
    answer: { answers: { next_action: { probabilities: { finish: 1 } } } } });
    return (set.candidates.find(c => c.operation === 'finish')?.candidateId as string | undefined) ?? null;
  } });
  let controller!: NativeManagedController;
  controller = new NativeManagedController(journal, (id, phase) => { phases.push({ id, phase }); }, true, undefined,
    (message: Record<string, JSONValue>) => {
      if (message.type === 'agent_ax_request') queueMicrotask(() => controller.receive(Buffer.from(JSON.stringify({
        type: 'agent_ax_reply', requestId: message.requestId, ok: true, value: { app: 'Notes', bundleId: 'com.apple.Notes',
          pid: 9, windowTitle: 'Notes', url: '', elements: [], truncated: false, signature: 's' } }))));
      if (message.type === 'browse_proposal') queueMicrotask(() => controller.receive(Buffer.from(JSON.stringify({
        type: 'confirm_step', requestId: randomUUID(), targetRequestId: message.requestId,
        proposalId: message.proposalId, allow: true }))));
    }, undefined, false, undefined, undefined, factory);
  t.after(async () => {
    await controller.close();
    if (previous === undefined) delete process.env.SYSTEMONE_TRACE_DIR; else process.env.SYSTEMONE_TRACE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const task = randomUUID();
  controller.receive(Buffer.from(JSON.stringify(agent(task, 'play the video'))));
  await waitFor(() => phases.some(p => p.id === task && p.phase === 'ready'));
  controller.receive(Buffer.from(JSON.stringify({ type: 'agent_feedback', requestId: randomUUID(), targetRequestId: task,
    value: 'bad', reason: 'stopped_early', note: 'it should have pressed play first' })));
  const { readdirSync, readFileSync } = await import('node:fs');
  const files = readdirSync(join(root, 'datasets', 'tasks'));
  assert.equal(files.length, 1);
  const example = JSON.parse(readFileSync(join(root, 'datasets', 'tasks', files[0]!), 'utf8').trim().split('\n')[0]!);
  assert.deepEqual(example.feedback, { value: 'bad', reason: 'stopped_early', note: 'it should have pressed play first', attachments: [] });
  assert.equal(example.outcome, 'completed');
  assert.equal(example.question, 'Which step?');
  // An unknown reason is rejected, not recorded.
  const bogus = randomUUID();
  controller.receive(Buffer.from(JSON.stringify({ type: 'agent_feedback', requestId: bogus, targetRequestId: task,
    value: 'bad', reason: 'because' })));
  assert.equal(phases.some(p => p.id === bogus && p.phase === 'error') || phases.some(p => p.id === 'invalid'), true);
});
