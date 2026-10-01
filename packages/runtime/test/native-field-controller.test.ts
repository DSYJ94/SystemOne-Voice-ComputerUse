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

function start() {
  const requestId = randomUUID();
  return { type: 'start_native_fill', requestId, bundleId: 'com.aurium.systemone.fixture',
    fieldLabel: 'Fixture Name', value: 'fixture-123', command: {
      type: 'command', protocolVersion: '2.0', messageId: randomUUID(), taskId: requestId,
      taskEpoch: 1, goalRevision: 1, source: 'text', mode: 'command', utteranceId: randomUUID(),
      utteranceRevision: 1, isFinal: true, text: 'Fill Fixture Name in com.aurium.systemone.fixture with text: fixture-123',
      createdAt: new Date().toISOString(), originSurface: { adapter: 'native', surfaceId: 'systemone-panel',
        appBundleId: 'com.aurium.systemone.dev', windowId: 'command-panel', contentRevision: requestId } } };
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 2500; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error('field controller stage did not arrive');
}
function harness(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'systemone-field-controller-'));
  const path = join(root, 'journal.sqlite'); const journal = new AttemptJournal(path);
  const phases: { id: string; phase: string }[] = []; const output: Record<string, JSONValue>[] = [];
  const state = { supported: false, stalled: false, verified: true, prepares: 0, commits: 0, verifies: 0, stops: 0 };
  let worker!: NativeFieldPipeWorker;
  worker = new NativeFieldPipeWorker(message => {
    if (message.type !== 'native_worker_request') return;
    let result: JSONValue;
    switch (message.operation) {
      case 'observe': result = { observationId: randomUUID(), scopeRef: 'field-process',
        bundleId: 'com.aurium.systemone.fixture', complete: true, controls: [{ id: 'field-1',
          role: 'AXTextField', label: 'Fixture Name', enabled: true, secure: false, canSetValue: true }] }; break;
      case 'prepare': state.prepares++; if (state.stalled) return;
        result = state.supported ? { kind: 'ready', preparationRef: randomUUID() } : { kind: 'unsupported' }; break;
      case 'commit': state.commits++; result = 'verified'; break;
      case 'verify': state.verifies++; result = state.verified; break;
      case 'stop': state.stops++; result = true; break;
      default: throw new Error(`unexpected field operation ${message.operation}`);
    }
    queueMicrotask(() => worker.receive({ type: 'native_worker_reply', requestId: message.requestId!, operation: message.operation!, result }));
  });
  const controller = new NativeManagedController(journal, (id, phase) => phases.push({ id, phase }), true, worker,
    message => { output.push(message); });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await controller.close(); } };
  t.after(async () => { await close(); rmSync(root, { recursive: true, force: true }); });
  const send = (message: unknown) => controller.receive(Buffer.from(JSON.stringify(message)));
  const has = (id: string, phase: string) => phases.some(p => p.id === id && p.phase === phase);
  return { journal, path, state, phases, output, controller, close, send, has };
}
test('field controller retains safe pause and accepts only explicitly presented Resume', async t => {
  const h = harness(t); const input = start(); h.send(input);
  await waitFor(() => h.has(input.requestId, 'blocked_recovery'));
  assert.equal(h.has(input.requestId, 'native_paused'), true);
  const concurrent = start(); h.send(concurrent); assert.equal(h.has(concurrent.requestId, 'blocked_recovery'), true);
  const read = randomUUID(); h.send({ type: 'prepare_native_recovery', requestId: read,
    targetRequestId: input.requestId, uiSessionRef: 'panel-session' });
  await waitFor(() => h.output.some(p => p.requestId === read));
  const prompt = h.output.find(p => p.requestId === read)!;
  h.send({ type: 'native_recovery_presented', requestId: randomUUID(), targetRequestId: input.requestId,
    uiSessionRef: 'panel-session', promptId: prompt.promptId, presentationDigest: prompt.presentationDigest });
  h.state.supported = true;
  h.send({ type: 'resume_native_task', requestId: randomUUID(), targetRequestId: input.requestId,
    uiSessionRef: 'panel-session', intent: { type: 'resume_request', protocolVersion: '2.0', messageId: randomUUID(),
      taskId: input.requestId, taskEpoch: prompt.taskEpoch, goalRevision: prompt.goalRevision, issuer: 'native_ui',
      actorRef: prompt.actorRef, uiSessionRef: prompt.uiSessionRef, promptId: prompt.promptId,
      presentationDigest: prompt.presentationDigest, checkpointRef: prompt.checkpointRef,
      checkpointDigest: prompt.checkpointDigest, recoveryObservationId: prompt.recoveryObservationId,
      createdAt: new Date().toISOString() } });
  await waitFor(() => h.has(input.requestId, 'ready'));
  assert.equal(h.has(input.requestId, 'verified_native_fill'), true);
  assert.equal(h.state.commits, 1); assert.equal(h.state.verifies, 1);
  assert.equal(h.journal.getTaskState(input.requestId), 'completed');
});
test('Stop reaches a retained paused field actor and releases intake after its fence', async t => {
  const h = harness(t); const input = start(); h.send(input);
  await waitFor(() => h.has(input.requestId, 'blocked_recovery'));
  const stop = randomUUID(); h.send({ type: 'stop', requestId: stop, targetRequestId: input.requestId });
  await waitFor(() => h.has(input.requestId, 'ready'));
  assert.equal(h.has(stop, 'stopped'), true); assert.equal(h.state.stops, 1);
  assert.equal(h.journal.getTaskState(input.requestId), 'cancelled');
});
test('field transport is closed and actual timeout operation settles before journal shutdown', async t => {
  const h = harness(t); h.state.stalled = true; const input = start(); h.send(input);
  await waitFor(() => h.has(input.requestId, 'blocked_recovery')); await h.close();
  const reopened = new AttemptJournal(h.path);
  try { assert.equal(reopened.getTaskState(input.requestId), 'paused');
    assert.deepEqual(reopened.attemptsForTask(input.requestId), []); }
  finally { reopened.close(); }
});
