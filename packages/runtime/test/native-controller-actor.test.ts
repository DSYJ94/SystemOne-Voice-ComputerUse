import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { JSONValue } from '../../protocol/src/json.ts';
import { AttemptJournal } from '../src/attempt-journal.ts';
import { NativeFieldPipeWorker } from '../src/native-field-pipe-worker.ts';
import { NativeManagedController } from '../src/native-managed-controller.ts';

const HOME = 'SystemOne Fixture';
const DOCS = HOME + ' — Documents';
const LOCATED = DOCS + ' — Budget.xlsx selected';
const OPENED = DOCS + ' — Budget.xlsx opened';
function start(requestId = randomUUID()) {
  return { type: 'start_native_open', requestId, bundleId: 'com.aurium.systemone.fixture',
    folderName: 'Documents', fileName: 'Budget.xlsx', expectedWindowTitle: OPENED,
    command: { type: 'command', protocolVersion: '2.0', messageId: randomUUID(), taskId: requestId,
      taskEpoch: 1, goalRevision: 1, source: 'text', mode: 'command', utteranceId: randomUUID(),
      utteranceRevision: 1, text: 'Open synthetic fixture file Documents/Budget.xlsx', isFinal: true,
      createdAt: new Date().toISOString(), originSurface: { adapter: 'native', surfaceId: 'systemone-panel',
        appBundleId: 'com.aurium.systemone.dev', windowId: 'command-panel', contentRevision: requestId } } };
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 2500; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('controller actor status did not arrive');
}
function harness(t: TestContext, pausedAtStart = false) {
  const root = mkdtempSync(join(tmpdir(), 'systemone-controller-actor-'));
  const path = join(root, 'attempts.sqlite');
  const journal = new AttemptJournal(path);
  if (pausedAtStart) { journal.startTask('unfinished', 1, 1); journal.pauseTask('unfinished', 'test-interruption'); }
  const phases: { id: string; phase: string }[] = [];
  const state = { title: HOME, duplicate: true, stalled: false, prepares: 0, commits: 0, stops: 0, observations: 0 };
  let expected = '';
  let worker!: NativeFieldPipeWorker;
  worker = new NativeFieldPipeWorker(message => {
    if (message.type !== 'native_worker_request') return;
    let result: JSONValue;
    switch (message.operation) {
      case 'observe_press': {
        state.observations++;
        const label = state.title === HOME ? 'Documents' : state.title === DOCS ? 'Budget.xlsx' : 'Open selected file';
        const control = { id: randomUUID(), role: 'AXButton', label, enabled: true, secure: false, canPress: true };
        result = { observationId: randomUUID(), scopeRef: 'native-fixture', bundleId: 'com.aurium.systemone.fixture',
          complete: true, windowTitles: [state.title], controls: state.duplicate && state.title === DOCS
            ? [control, { ...control, id: randomUUID() }] : [control] }; break;
      }
      case 'prepare_press':
        state.prepares++; if (state.stalled) return;
        expected = String(message.expectedWindowTitle); result = { kind: 'ready', preparationRef: randomUUID() }; break;
      case 'commit_press': state.commits++; state.title = expected; result = 'returned_unverified'; break;
      case 'verify_press': result = state.title === message.expectedWindowTitle; break;
      case 'stop': state.stops++; result = true; break;
      default: throw new Error(`unexpected operation ${message.operation}`);
    }
    queueMicrotask(() => worker.receive({ type: 'native_worker_reply', requestId: message.requestId!,
      operation: message.operation!, result }));
  });
  const controller = new NativeManagedController(journal, (id, phase) => { phases.push({ id, phase }); }, true, worker);
  let closed = false;
  async function close() { if (!closed) { closed = true; await controller.close(); } }
  t.after(async () => { await close(); rmSync(root, { recursive: true, force: true }); });
  const send = (message: unknown) => controller.receive(Buffer.from(JSON.stringify(message)));
  const has = (id: string, phase: string) => phases.some(p => p.id === id && p.phase === phase);
  return { controller, journal, path, phases, state, send, has, close };
}

test('controller keeps a checkpoint pause, blocks every surface and explicitly stops the retained native actor', async t => {
  const h = harness(t); const input = start(); h.send(input);
  await waitFor(() => h.has(input.requestId, 'blocked_recovery'));
  assert.equal(h.has(input.requestId, 'native_paused'), true);
  assert.equal(h.has(input.requestId, 'ready'), false);
  assert.equal(h.journal.getTaskState(input.requestId), 'paused');
  assert.deepEqual(h.journal.getTaskProgress(input.requestId)?.checkpoints.map(c => c.stageRef), ['documents']);
  const other = start(); h.send(other); await waitFor(() => h.has(other.requestId, 'blocked_recovery'));
  const managedId = randomUUID();
  h.send({ type: 'start_fill', requestId: managedId, url: 'https://example.com', fieldLabel: 'Name', value: 'synthetic', command: {} });
  await waitFor(() => h.has(managedId, 'blocked_recovery'));
  assert.equal(h.state.commits, 1);
  const wrongStop = randomUUID(); h.send({ type: 'stop', requestId: wrongStop, targetRequestId: other.requestId });
  await waitFor(() => h.has(wrongStop, 'uncertain')); assert.equal(h.journal.getTaskState(input.requestId), 'paused');
  const stop = randomUUID(); h.send({ type: 'stop', requestId: stop, targetRequestId: input.requestId });
  await waitFor(() => h.has(stop, 'stopped')); await waitFor(() => h.has(input.requestId, 'ready'));
  assert.equal(h.journal.getTaskState(input.requestId), 'cancelled'); assert.equal(h.state.stops, 1);
  h.state.duplicate = false; h.state.title = HOME;
  const next = start(); h.send(next); await waitFor(() => h.has(next.requestId, 'ready'));
  assert.equal(h.has(next.requestId, 'verified_native_open'), true);
  assert.equal(h.state.commits, 4);
});
test('restart with a paused record and no unknown effect blocks new intake', async t => {
  const h = harness(t, true);
  assert.equal(h.controller.startupPhase(), 'blocked_recovery');
  assert.deepEqual(h.journal.unresolvedAttempts(), []);
  const input = start(); h.send(input); await waitFor(() => h.has(input.requestId, 'blocked_recovery'));
  assert.equal(h.state.observations, 0); assert.equal(h.journal.getTaskRecord(input.requestId), undefined);
  assert.equal(h.journal.getTaskState('unfinished'), 'paused');
});
test('shutdown closes a timed-out native transport before closing journal history', async t => {
  const h = harness(t); h.state.stalled = true;
  const input = start(); h.send(input); await waitFor(() => h.has(input.requestId, 'blocked_recovery'));
  assert.equal(h.has(input.requestId, 'native_paused'), true);
  assert.equal(h.state.prepares, 1); assert.equal(h.state.commits, 0);
  await h.close();
  const reopened = new AttemptJournal(h.path);
  try {
    assert.equal(reopened.getTaskState(input.requestId), 'paused');
    assert.deepEqual(reopened.attemptsForTask(input.requestId), []);
    assert.equal(reopened.getTaskRecord(input.requestId)?.completion, null);
  } finally { reopened.close(); }
});
