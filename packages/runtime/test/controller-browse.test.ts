import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { startPortalFixture } from '../../fixtures/portal.ts';
import type { JSONValue } from '../../protocol/src/json.ts';
import type { BrowseDecision } from '../../browser/src/managed-browse-task.ts';
import { AttemptJournal } from '../src/attempt-journal.ts';
import { NativeManagedController } from '../src/native-managed-controller.ts';
import type { BrowseDecisionFactory } from '../src/native-managed-controller.ts';

function browse(requestId: string, text: string, source: 'text' | 'voice' = 'voice') {
  return { type: 'start_browse', requestId, decisionProvider: 'jev', command: { type: 'command',
    protocolVersion: '2.0', messageId: randomUUID(), taskId: requestId, taskEpoch: 1, goalRevision: 1,
    source, mode: 'command', utteranceId: randomUUID(), utteranceRevision: 1, text, isFinal: true,
    createdAt: new Date().toISOString(), originSurface: { adapter: 'native', surfaceId: 'systemone-panel',
      appBundleId: 'com.aurium.systemone.dev', windowId: 'command-panel', contentRevision: requestId } } };
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 5_000; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('controller browse status did not arrive');
}

async function harness(t: TestContext, factory?: BrowseDecisionFactory, autoConfirm = true) {
  const portal = await startPortalFixture();
  const root = mkdtempSync(join(tmpdir(), 'systemone-controller-browse-'));
  const journal = new AttemptJournal(join(root, 'attempts.sqlite'));
  const phases: { id: string; phase: string }[] = [];
  const output: Record<string, JSONValue>[] = [];
  let controller!: NativeManagedController;
  controller = new NativeManagedController(journal, (id, phase) => { phases.push({ id, phase }); }, true,
    undefined, message => {
      output.push(message);
      if (autoConfirm && message.type === 'browse_proposal') {
        queueMicrotask(() => controller.receive(Buffer.from(JSON.stringify({ type: 'confirm_step',
          requestId: randomUUID(), targetRequestId: message.requestId, proposalId: message.proposalId, allow: true }))));
      }
    }, undefined, false, undefined, factory);
  t.after(async () => { await controller.close(); await portal.close();
    rmSync(root, { recursive: true, force: true }); });
  return { controller, journal, phases, output, host: new URL(portal.url).host,
    send: (value: unknown) => controller.receive(Buffer.from(JSON.stringify(value))),
    has: (id: string, phase: string) => phases.some(p => p.id === id && p.phase === phase) };
}

const scripted = (operations: string[]): BrowseDecisionFactory => async () => {
  let index = 0;
  const decision: BrowseDecision = { async select(set) {
    const want = operations[index++];
    return (set.candidates.find(c => c.operation === want)?.candidateId as string | undefined) ?? null;
  } };
  return decision;
};

test('a spoken browse request runs confirmed steps, keeps the result open and closes on Stop', async t => {
  const goals: string[] = [];
  const h = await harness(t, async (requestId, goal) => { goals.push(goal);
    return scripted(['set_value', 'invoke', 'finish'])(requestId, goal); });
  const id = randomUUID();
  h.send(browse(id, `go to ${h.host} and search for April`));
  await waitFor(() => h.has(id, 'verified_browse'));
  assert.deepEqual(goals, [`go to ${h.host} and search for April`]);
  assert.deepEqual(h.output.filter(m => m.type === 'browse_proposal').map(m => m.kind), ['fill', 'submit', 'finish']);
  assert.equal(h.journal.getTaskState(id), 'completed');
  const busy = randomUUID(); h.send(browse(busy, `go to ${h.host}`));
  await waitFor(() => h.has(busy, 'busy'));
  const stop = randomUUID(); h.send({ type: 'stop', requestId: stop, targetRequestId: id });
  await waitFor(() => h.has(stop, 'stopped'));
  await waitFor(() => h.has(id, 'ready'));
});

test('stale, forged or unprompted confirmations are refused and nothing runs without one', async t => {
  const h = await harness(t, scripted(['set_value']), false);
  const id = randomUUID();
  h.send(browse(id, `go to ${h.host} and search for April`, 'text'));
  await waitFor(() => h.output.some(m => m.type === 'browse_proposal'));
  const proposal = h.output.find(m => m.type === 'browse_proposal')!;
  const forged = randomUUID();
  h.send({ type: 'confirm_step', requestId: forged, targetRequestId: id, proposalId: 'not-the-proposal', allow: true });
  await waitFor(() => h.has(forged, 'error'));
  assert.equal(h.journal.attemptsForTask(id).length, 0);
  h.send({ type: 'confirm_step', requestId: randomUUID(), targetRequestId: id,
    proposalId: proposal.proposalId, allow: false });
  await waitFor(() => h.has(id, 'browse_paused'));
  assert.equal(h.journal.attemptsForTask(id).length, 0);
});

test('browse without a provider, or with a malformed request, is refused before any browser starts', async t => {
  const h = await harness(t);
  const id = randomUUID(); h.send(browse(id, `go to ${h.host}`));
  await waitFor(() => h.has(id, 'error'));
  h.send({ ...browse(randomUUID(), `go to ${h.host}`), decisionProvider: 'clm' });
  await waitFor(() => h.has('invalid', 'error'));
  const unsupported = randomUUID(); h.send(browse(unsupported, 'delete everything on example.com'));
  await waitFor(() => h.has(unsupported, 'error'));
});
