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
function start(requestId: string = randomUUID()) {
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
function harness(t: TestContext, pausedAtStart = false, requireHostSnapshot = false) {
  const root = mkdtempSync(join(tmpdir(), 'systemone-controller-actor-'));
  const path = join(root, 'attempts.sqlite');
  const journal = new AttemptJournal(path);
  if (pausedAtStart) { journal.startTask('unfinished', 1, 1); journal.pauseTask('unfinished', 'test-interruption'); }
  const output: Record<string, JSONValue>[] = [];
  const phases: { id: string; phase: string }[] = [];
  const state = { title: HOME, duplicate: true, stalled: false, prepares: 0, commits: 0, stops: 0, observations: 0,
    stopResult: true, holdStops: false, holdObservations: false, holdCommits: false,
    held: [] as (() => void)[], stopIDs: [] as string[] };
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
      case 'stop': state.stops++; state.stopIDs.push(String(message.taskId)); result = state.stopResult; break;
      default: throw new Error(`unexpected operation ${message.operation}`);
    }
    const reply = () => { worker.receive({ type: 'native_worker_reply', requestId: message.requestId!,
      operation: message.operation!, result }); };
    if ((message.operation === 'commit_press' && state.holdCommits)
      || (message.operation === 'stop' && state.holdStops)
      || (message.operation === 'observe_press' && state.holdObservations)) state.held.push(reply);
    else queueMicrotask(reply);
  });
  const controller = new NativeManagedController(journal, (id, phase) => { phases.push({ id, phase }); }, true, worker, message => { output.push(message); }, undefined, requireHostSnapshot);
  let closed = false;
  async function close() { if (!closed) { closed = true; await controller.close(); } }
  t.after(async () => { await close(); rmSync(root, { recursive: true, force: true }); });
  const send = (message: unknown) => controller.receive(Buffer.from(JSON.stringify(message)));
  const has = (id: string, phase: string) => phases.some(p => p.id === id && p.phase === phase);
  return { controller, journal, path, phases, state, send, has, close, output };
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

function recoveryControl(type: string, targetRequestId: string, extra = {}) {
  return { type, requestId: randomUUID(), targetRequestId, uiSessionRef: 'panel-session', ...extra };
}
function recoveryReply(prompt: Record<string, JSONValue>, extra = {}) {
  return { protocolVersion: '2.0', type: 'resume_request', messageId: randomUUID(),
    taskId: prompt.taskId, taskEpoch: prompt.taskEpoch, goalRevision: prompt.goalRevision,
    issuer: 'native_ui', actorRef: prompt.actorRef, uiSessionRef: prompt.uiSessionRef,
    promptId: prompt.promptId, presentationDigest: prompt.presentationDigest,
    checkpointRef: prompt.checkpointRef, checkpointDigest: prompt.checkpointDigest,
    recoveryObservationId: prompt.recoveryObservationId, createdAt: new Date().toISOString(), ...extra };
}
async function pausedController(t: TestContext) {
  const h = harness(t); const input = start(); h.send(input);
  await waitFor(() => h.has(input.requestId, 'blocked_recovery'));
  h.state.duplicate = false;
  return { ...h, input };
}
async function prepare(h: ReturnType<typeof harness>, target: string) {
  const request = recoveryControl('prepare_native_recovery', target);
  h.send(request);
  await waitFor(() => h.output.some(p => p.requestId === request.requestId));
  // The async operation must release its controller slot before UI acknowledgment.
  await waitFor(() => h.phases.filter(p => p.id === target && p.phase === 'blocked_recovery').length >= 2);
  return h.output.find(p => p.requestId === request.requestId)!;
}
test('controller recovers a retained fixture actor only after presentation and exact Resume', async t => {
  const h = await pausedController(t);
  const prompt = await prepare(h, h.input.requestId);
  assert.equal(prompt.type, 'native_recovery_prompt'); assert.equal(h.state.commits, 1);
  h.send(recoveryControl('native_recovery_presented', h.input.requestId,
    { promptId: prompt.promptId, presentationDigest: prompt.presentationDigest }));
  h.send(recoveryControl('resume_native_task', h.input.requestId, { intent: recoveryReply(prompt) }));
  await waitFor(() => h.has(h.input.requestId, 'ready'));
  assert.equal(h.has(h.input.requestId, 'verified_native_open'), true);
  assert.equal(h.state.commits, 3); assert.equal(h.state.stops, 0);
  assert.equal(h.journal.getTaskState(h.input.requestId), 'completed');
});
test('controller rejects Resume before presentation and changed reply sessions', async t => {
  const h = await pausedController(t); const prompt = await prepare(h, h.input.requestId);
  h.send(recoveryControl('resume_native_task', h.input.requestId, { intent: recoveryReply(prompt) }));
  await waitFor(() => h.phases.filter(p => p.phase === 'blocked_recovery').length >= 3);
  h.send(recoveryControl('native_recovery_presented', h.input.requestId,
    { promptId: prompt.promptId, presentationDigest: prompt.presentationDigest }));
  h.send(recoveryControl('resume_native_task', h.input.requestId,
    { intent: recoveryReply(prompt, { uiSessionRef: 'different-session' }) }));
  assert.equal(h.has('invalid', 'error'), true);
  assert.equal(h.journal.getTaskState(h.input.requestId), 'paused'); assert.equal(h.state.commits, 1);
});
test('controller Stop revokes a presented recovery prompt and permits no late Resume', async t => {
  const h = await pausedController(t); const prompt = await prepare(h, h.input.requestId);
  h.send(recoveryControl('native_recovery_presented', h.input.requestId,
    { promptId: prompt.promptId, presentationDigest: prompt.presentationDigest }));
  const stop = randomUUID(); h.send({ type: 'stop', requestId: stop, targetRequestId: h.input.requestId });
  await waitFor(() => h.has(stop, 'stopped'));
  h.send(recoveryControl('resume_native_task', h.input.requestId, { intent: recoveryReply(prompt) }));
  assert.equal(h.journal.getTaskState(h.input.requestId), 'cancelled'); assert.equal(h.state.commits, 1);
});
test('restart recovery and extra control fields cannot reconstruct a native admission', async t => {
  const h = harness(t, true);
  h.send(recoveryControl('prepare_native_recovery', 'unfinished'));
  assert.equal(h.has('unfinished', 'blocked_recovery'), true);
  h.send(recoveryControl('prepare_native_recovery', 'unfinished', { command: {} }));
  assert.equal(h.has('invalid', 'error'), true);
  assert.equal(h.state.observations, 0); assert.deepEqual(h.output, []);
  const stop = randomUUID(); h.send({ type: 'stop', requestId: stop, targetRequestId: 'unfinished' });
  assert.equal(h.has(stop, 'uncertain'), true); assert.equal(h.journal.getTaskState('unfinished'), 'paused');
});

function replace(targetRequestId: string, mode: 'navigate' | 'locate' | 'open' = 'locate', revision = 2) {
  const next = start(); next.command.taskId = targetRequestId; next.command.goalRevision = revision;
  next.command.text = mode === 'navigate' ? 'Navigate synthetic fixture to Documents'
    : `${mode === 'open' ? 'Open' : 'Locate'} synthetic fixture file Documents/Budget.xlsx`;
  const replacement: Record<string, unknown> = { bundleId: next.bundleId, folderName: next.folderName,
    command: next.command, expectedWindowTitle: mode === 'navigate' ? DOCS : mode === 'locate' ? LOCATED : OPENED };
  if (mode !== 'navigate') replacement.fileName = 'Budget.xlsx';
  return { type: 'replace_native_fixture', requestId: next.requestId, targetRequestId, mode, replacement };
}
test('controller installs changed fixture goal with revision and ownership handoff after old Stop fence', async t => {
  const h = await pausedController(t); const replacement = replace(h.input.requestId);
  h.send(replacement); await waitFor(() => h.has(replacement.requestId, 'ready'));
  const handoff = h.output.find(p => p.type === 'native_replacement_task')!;
  assert.equal(handoff.taskId, replacement.requestId); assert.equal(handoff.targetRequestId, h.input.requestId);
  assert.equal(handoff.goalRevision, 2); assert.equal(handoff.mode, 'locate');
  assert.equal(h.has(replacement.requestId, 'verified_native_locate'), true);
  assert.equal(h.has(h.input.requestId, 'ready'), false);
  assert.deepEqual(h.state.stopIDs, [h.input.requestId]); assert.equal(h.state.commits, 2);
  assert.equal(h.journal.getTaskState(h.input.requestId), 'cancelled');
  assert.deepEqual(h.journal.getTaskRecord(replacement.requestId)!.replaces, { taskId: h.input.requestId });
});
test('pending old worker fence excludes replacement observations and cross-surface intake; Stop cancels transition', async t => {
  const h = await pausedController(t); h.state.holdStops = true;
  const replacement = replace(h.input.requestId); const observations = h.state.observations;
  h.send(replacement); await waitFor(() => h.state.stops === 1);
  assert.equal(h.state.observations, observations);
  const concurrent = start(); h.send(concurrent); assert.equal(h.has(concurrent.requestId, 'busy'), true);
  const stop = randomUUID(); h.send({ type: 'stop', requestId: stop, targetRequestId: h.input.requestId });
  h.state.holdStops = false; h.state.held.splice(0).forEach(reply => reply());
  await waitFor(() => h.has(h.input.requestId, 'ready'));
  assert.equal(h.has(stop, 'stopped'), true); assert.equal(h.state.observations, observations);
  assert.equal(h.journal.getTaskRecord(replacement.requestId), undefined);
  assert.equal(h.output.some(p => p.type === 'native_replacement_task'), false);
});
test('Stop using old UI target during replacement read fences child task before admission', async t => {
  const h = await pausedController(t); h.state.holdObservations = true;
  const replacement = replace(h.input.requestId); const before = h.state.observations;
  h.send(replacement); await waitFor(() => h.state.observations > before);
  const stop = randomUUID(); h.send({ type: 'stop', requestId: stop, targetRequestId: h.input.requestId });
  await waitFor(() => h.has(h.input.requestId, 'ready'));
  assert.deepEqual(h.state.stopIDs, [h.input.requestId, replacement.requestId]);
  h.state.held.splice(0).forEach(reply => reply());
  assert.equal(h.journal.getTaskRecord(replacement.requestId), undefined); assert.equal(h.state.commits, 1);
});
test('paused child handoff accepts in-flight old Stop target only for its linked replacement', async t => {
  const h = await pausedController(t); h.state.duplicate = true;
  const replacement = replace(h.input.requestId); h.send(replacement);
  await waitFor(() => h.has(replacement.requestId, 'blocked_recovery'));
  assert.equal(h.journal.getTaskState(replacement.requestId), 'paused');
  const wrongStop = randomUUID(); h.send({ type: 'stop', requestId: wrongStop, targetRequestId: 'unrelated-task' });
  assert.equal(h.has(wrongStop, 'uncertain'), true);
  const stop = randomUUID(); h.send({ type: 'stop', requestId: stop, targetRequestId: h.input.requestId });
  await waitFor(() => h.has(replacement.requestId, 'ready'));
  assert.equal(h.journal.getTaskState(replacement.requestId), 'cancelled');
  assert.deepEqual(h.state.stopIDs, [h.input.requestId, replacement.requestId]);
});
test('failed old worker fence emits no handoff, replacement observation or admission', async t => {
  const h = await pausedController(t); h.state.stopResult = false;
  const before = h.state.observations; const replacement = replace(h.input.requestId); h.send(replacement);
  await waitFor(() => h.has(replacement.requestId, 'blocked_recovery'));
  assert.equal(h.journal.getTaskState(h.input.requestId), 'cancelled');
  assert.equal(h.journal.getTaskRecord(replacement.requestId), undefined);
  assert.equal(h.state.observations, before); assert.deepEqual(h.output, []);
});
test('unchanged, malformed and wrong-source replacement requests preserve the original paused actor', async t => {
  const h = await pausedController(t); const before = h.state.observations;
  const unchanged = replace(h.input.requestId, 'open'); h.send(unchanged);
  await waitFor(() => h.has(unchanged.requestId, 'error'));
  const wrong = replace('foreign-task'); h.send(wrong); assert.equal(h.has(wrong.requestId, 'blocked_recovery'), true);
  h.send({ ...replace(h.input.requestId), approval: true }); assert.equal(h.has('invalid', 'error'), true);
  assert.equal(h.journal.getTaskState(h.input.requestId), 'paused'); assert.equal(h.state.stops, 0);
  assert.equal(h.state.observations, before); assert.deepEqual(h.output, []);
});

function host(sequence: number, sleeping = false, sessionActive = true) {
  return { type: 'host_lifecycle', requestId: randomUUID(), sequence, sleeping, sessionActive };
}
function settled(h: ReturnType<typeof harness>, sequence: number) {
  return h.output.some(p => p.type === 'host_lifecycle_status' && p.sequence === sequence
    && p.interruptionSettled === true);
}
test('required initial host snapshot blocks admission and unavailable Chrome grants', async t => {
  const h = harness(t, false, true);
  assert.equal(h.controller.startupPhase(), 'host_unavailable');
  const input = start(); h.send(input);
  assert.equal(h.has(input.requestId, 'host_unavailable'), true);
  assert.equal(h.journal.getTaskRecord(input.requestId), undefined);
  h.send({ type: 'chrome_port_open', connectionId: 'held-port' });
  assert.equal(h.output.some(p => p.type === 'chrome_port_close'), true);
  h.send(host(1)); assert.equal(h.controller.startupPhase(), 'ready');
  assert.equal(h.state.observations, 0); assert.equal(h.state.commits, 0);
  const fresh = start(); h.send(fresh);
  await waitFor(() => h.has(fresh.requestId, 'blocked_recovery'));
});
test('wake and replay cannot release a pending native Stop or resume the old task', async t => {
  const h = harness(t); h.state.holdObservations = true; h.state.holdStops = true;
  const input = start(); h.send(input);
  await waitFor(() => h.state.observations === 1);
  h.send(host(2, true)); assert.equal(h.state.stops, 1);
  h.send(host(3, false, false)); h.send(host(2));
  const rejected = start(); h.send(rejected);
  assert.equal(h.has(rejected.requestId, 'host_unavailable'), true);
  h.send(host(4));
  const early = start(); h.send(early);
  assert.equal(h.has(early.requestId, 'host_unavailable'), true);
  assert.equal(settled(h, 4), false);
  h.state.holdObservations = false; h.state.holdStops = false;
  for (const reply of h.state.held.splice(0)) reply();
  await waitFor(() => settled(h, 4));
  await waitFor(() => h.controller.startupPhase() === 'ready');
  // The held first observation never admitted a durable task or effect.
  assert.equal(h.journal.getTaskState(input.requestId), undefined);
  assert.equal(h.state.commits, 0); assert.equal(h.state.observations, 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.state.commits, 0);
  const fresh = start(); h.send(fresh);
  await waitFor(() => h.has(fresh.requestId, 'blocked_recovery'));
  assert.equal(h.state.commits, 1);
});
test('session loss cancels retained recovery and preserves verified checkpoint history', async t => {
  const h = await pausedController(t); const prompt = await prepare(h, h.input.requestId);
  h.send(host(1, false, false));
  await waitFor(() => settled(h, 1));
  assert.equal(h.journal.getTaskState(h.input.requestId), 'cancelled');
  assert.deepEqual(h.journal.getTaskProgress(h.input.requestId)?.checkpoints.map(c => c.stageRef), ['documents']);
  assert.equal(h.state.stops, 1);
  h.send(recoveryControl('resume_native_task', h.input.requestId, { intent: recoveryReply(prompt) }));
  assert.equal(h.state.commits, 1);
  h.send(host(2)); await waitFor(() => settled(h, 2));
  assert.equal(h.state.commits, 1);
  h.send(recoveryControl('resume_native_task', h.input.requestId, { intent: recoveryReply(prompt) }));
  assert.equal(h.state.commits, 1); assert.equal(h.journal.getTaskState(h.input.requestId), 'cancelled');
});
test('interruption after completion preserves completion and requires no new native Stop', async t => {
  const h = harness(t); h.state.duplicate = false;
  const input = start(); h.send(input); await waitFor(() => h.has(input.requestId, 'ready'));
  h.send(host(1, true)); await waitFor(() => settled(h, 1));
  assert.equal(h.journal.getTaskState(input.requestId), 'completed');
  assert.equal(h.state.stops, 0); assert.equal(h.state.commits, 3);
  h.send(host(2)); assert.equal(h.controller.startupPhase(), 'ready');
  assert.equal(h.state.commits, 3);
});
test('failed session interruption fence remains blocking after wake', async t => {
  const h = harness(t); h.state.holdObservations = true; h.state.stopResult = false;
  const input = start(); h.send(input); await waitFor(() => h.state.observations === 1);
  h.send(host(1, true)); await waitFor(() => settled(h, 1));
  for (const reply of h.state.held.splice(0)) reply();
  h.send(host(2)); await waitFor(() => h.controller.startupPhase() === 'blocked_recovery');
  const fresh = start(); h.send(fresh);
  assert.equal(h.has(fresh.requestId, 'blocked_recovery'), true);
  assert.equal(h.state.commits, 0);
});
test('session interruption retains a dispatched effect and excludes retries after late receipt', async t => {
  const h = harness(t); h.state.holdCommits = true;
  const input = start(); h.send(input); await waitFor(() => h.state.commits === 1);
  h.send(host(1, true)); h.send(host(2));
  const early = start(); h.send(early);
  assert.equal(h.has(early.requestId, 'host_unavailable'), true);
  await waitFor(() => settled(h, 2));
  assert.equal(h.journal.getTaskState(input.requestId), 'cancelled');
  assert.equal(h.journal.getTaskRecord(input.requestId)?.completion, null);
  assert.equal(h.journal.attemptsForTask(input.requestId).length, 1);
  h.state.held.splice(0).forEach(reply => reply());
  await waitFor(() => h.has(input.requestId, 'blocked_recovery'));
  const retry = start(); h.send(retry);
  assert.equal(h.has(retry.requestId, 'blocked_recovery'), true);
  assert.equal(h.state.commits, 1);
  assert.deepEqual(h.journal.getTaskProgress(input.requestId)?.checkpoints, []);
});
test('shutdown settles a pending interruption before closing its durable history', async t => {
  const h = await pausedController(t); h.state.holdStops = true;
  h.send(host(1, true)); assert.equal(h.state.stops, 1);
  const closing = h.close();
  queueMicrotask(() => h.state.held.splice(0).forEach(reply => reply()));
  await closing;
  const reopened = new AttemptJournal(h.path);
  try {
    assert.equal(reopened.getTaskState(h.input.requestId), 'cancelled');
    assert.deepEqual(reopened.getTaskProgress(h.input.requestId)?.checkpoints.map(c => c.stageRef), ['documents']);
  } finally { reopened.close(); }
});
