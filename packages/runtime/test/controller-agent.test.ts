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
