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
  const state = { supported: false, stalled: false, verified: true, prepares: 0, commits: 0, verifies: 0, stops: 0,
    observations: 0, label: 'Fixture Name', stopResult: true, holdStops: false, holdObservations: false,
    holdCommits: false, commitResult: 'verified', held: [] as (() => void)[], stopIDs: [] as string[], values: [] as string[] };
  let worker!: NativeFieldPipeWorker;
  worker = new NativeFieldPipeWorker(message => {
    if (message.type !== 'native_worker_request') return;
    let result: JSONValue;
    switch (message.operation) {
      case 'observe': state.observations++; result = { observationId: randomUUID(), scopeRef: 'field-process',
        bundleId: 'com.aurium.systemone.fixture', complete: true, controls: [{ id: 'field-1',
          role: 'AXTextField', label: state.label, enabled: true, secure: false, canSetValue: true }] }; break;
      case 'prepare': state.prepares++; state.values.push(String(message.value)); if (state.stalled) return;
        result = state.supported ? { kind: 'ready', preparationRef: randomUUID() } : { kind: 'unsupported' }; break;
      case 'commit': state.commits++; result = state.commitResult; break;
      case 'verify': state.verifies++; result = state.verified; break;
      case 'stop': state.stops++; state.stopIDs.push(String(message.taskId)); result = state.stopResult; break;
      default: throw new Error(`unexpected field operation ${message.operation}`);
    }
    const reply = () => worker.receive({ type: 'native_worker_reply', requestId: message.requestId!, operation: message.operation!, result });
    if (message.operation === 'stop' && state.holdStops || message.operation === 'observe' && state.holdObservations
      || message.operation === 'commit' && state.holdCommits) state.held.push(reply);
    else queueMicrotask(reply);
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

function correction(source: ReturnType<typeof start>, value = 'corrected-456', fieldLabel = source.fieldLabel,
  revision = 2) {
  const requestId = randomUUID();
  return { type: 'replace_native_field', requestId, targetRequestId: source.requestId,
    replacement: { bundleId: source.bundleId, fieldLabel, value,
      command: { ...source.command, messageId: randomUUID(), taskId: source.requestId,
        goalRevision: revision, utteranceId: randomUUID(), text: `Fill ${fieldLabel} in ${source.bundleId} with text: ${value}` } } };
}
async function pausedField(t: TestContext, input = start()) {
  const h = harness(t); h.send(input); await waitFor(() => h.has(input.requestId, 'blocked_recovery'));
  return { ...h, input };
}
test('changed field/value obtains a fresh fenced admission, lineage and independent completion', async t => {
  const h = await pausedField(t); const replacement = correction(h.input, 'changed 😀', 'Fixture Notes');
  h.state.label = 'Fixture Notes'; h.state.supported = true;
  h.send(replacement); await waitFor(() => h.has(replacement.requestId, 'ready'));
  assert.equal(h.has(replacement.requestId, 'verified_native_fill'), true);
  assert.equal(h.journal.getTaskState(h.input.requestId), 'cancelled');
  const record = h.journal.getTaskRecord(replacement.requestId)!;
  assert.equal(record.state, 'completed'); assert.equal(record.goalRevision, 2);
  assert.deepEqual(record.replaces, { taskId: h.input.requestId });
  assert.deepEqual(h.journal.getTaskRecord(h.input.requestId)?.replacement, { taskId: replacement.requestId });
  assert.equal(h.journal.attemptsForTask(h.input.requestId).length, 0);
  assert.equal(h.journal.attemptsForTask(replacement.requestId).length, 1);
  assert.equal(h.state.verifies, 1); assert.equal(h.state.commits, 1);
  assert.deepEqual(h.state.stopIDs, [h.input.requestId]);
  assert.deepEqual(h.state.values, ['fixture-123', 'changed 😀']);
  const handoff = h.output.find(p => p.type === 'native_replacement_task')!;
  assert.deepEqual(handoff, { type: 'native_replacement_task', requestId: replacement.requestId,
    targetRequestId: h.input.requestId, taskId: replacement.requestId, taskEpoch: 1, goalRevision: 2, mode: 'fill' });
});
test('unchanged, uncommitted and mismatched corrections cannot cancel or fence a paused field', async t => {
  const h = await pausedField(t);
  const unchanged = correction(h.input, h.input.value);
  const wrongValue = correction(h.input); wrongValue.replacement.command.text += 'invented';
  const wrongSource = correction(h.input); wrongSource.replacement.command.source = 'model';
  const wrongTask = correction(h.input); wrongTask.replacement.command.taskId = randomUUID();
  const draft = correction(h.input); draft.replacement.command.isFinal = false;
  for (const request of [unchanged, wrongValue, wrongSource, wrongTask, draft, correction(h.input, 'new', h.input.fieldLabel, 3)]) {
    h.send(request); await waitFor(() => h.has(request.requestId, 'error'));
  }
  h.send({ ...correction(h.input), approval: true }); assert.equal(h.has('invalid', 'error'), true);
  assert.equal(h.journal.getTaskState(h.input.requestId), 'paused');
  assert.equal(h.state.stops, 0); assert.equal(h.state.commits, 0);
  assert.equal(h.output.some(p => p.type === 'native_replacement_task'), false);
});
test('field correction cannot switch a captured process or drop its process binding', async t => {
  const input = { ...start(), targetPid: 123, targetLaunchMillis: 456 };
  const h = await pausedField(t, input);
  for (const target of [{}, { targetPid: 124, targetLaunchMillis: 456 }, { targetPid: 123, targetLaunchMillis: 457 }]) {
    const replacement = correction(input);
    h.send({ ...replacement, replacement: { ...replacement.replacement, ...target } });
    await waitFor(() => h.has(replacement.requestId, 'error'));
  }
  assert.equal(h.state.stops, 0); assert.equal(h.journal.getTaskState(input.requestId), 'paused');
  const replacement = correction(input);
  h.state.supported = true;
  h.send({ ...replacement, replacement: { ...replacement.replacement, targetPid: 123, targetLaunchMillis: 456 } });
  await waitFor(() => h.has(replacement.requestId, 'ready'));
  assert.equal(h.has(replacement.requestId, 'verified_native_fill'), true);
});
test('pending correction fence keeps all intake exclusive; Stop prevents replacement observations', async t => {
  const h = await pausedField(t); h.state.holdStops = true;
  const before = h.state.observations; const replacement = correction(h.input); h.send(replacement);
  await waitFor(() => h.state.stops === 1);
  assert.equal(h.state.observations, before);
  const other = start(); h.send(other); assert.equal(h.has(other.requestId, 'busy'), true);
  const stop = randomUUID(); h.send({ type: 'stop', requestId: stop, targetRequestId: h.input.requestId });
  h.state.holdStops = false; h.state.held.splice(0).forEach(reply => reply());
  await waitFor(() => h.has(h.input.requestId, 'ready'));
  assert.equal(h.has(stop, 'stopped'), true);
  assert.equal(h.state.observations, before); assert.equal(h.journal.getTaskRecord(replacement.requestId), undefined);
  assert.equal(h.output.some(p => p.type === 'native_replacement_task'), false);
});
test('Stop during fresh correction observation fences the derived worker task before admission', async t => {
  const h = await pausedField(t); h.state.holdObservations = true;
  const replacement = correction(h.input); const before = h.state.observations; h.send(replacement);
  await waitFor(() => h.state.observations > before);
  const stop = randomUUID(); h.send({ type: 'stop', requestId: stop, targetRequestId: h.input.requestId });
  await waitFor(() => h.has(h.input.requestId, 'ready'));
  h.state.held.splice(0).forEach(reply => reply());
  assert.deepEqual(h.state.stopIDs, [h.input.requestId, replacement.requestId]);
  assert.equal(h.journal.getTaskRecord(replacement.requestId), undefined); assert.equal(h.state.commits, 0);
});
test('paused field replacement accepts only its immediate source Stop alias and the next correction revision', async t => {
  const h = await pausedField(t); const replacement = correction(h.input); h.send(replacement);
  await waitFor(() => h.has(replacement.requestId, 'blocked_recovery'));
  assert.equal(h.journal.getTaskState(replacement.requestId), 'paused');
  const child = { ...h.input, requestId: replacement.requestId, value: replacement.replacement.value };
  const next = correction(child, 'third-value', child.fieldLabel, 3); h.send(next);
  await waitFor(() => h.has(next.requestId, 'blocked_recovery'));
  assert.equal(h.journal.getTaskRecord(next.requestId)?.goalRevision, 3);
  const tooOld = randomUUID(); h.send({ type: 'stop', requestId: tooOld, targetRequestId: h.input.requestId });
  assert.equal(h.has(tooOld, 'uncertain'), true);
  assert.equal(h.journal.getTaskState(next.requestId), 'paused');
  const stop = randomUUID(); h.send({ type: 'stop', requestId: stop, targetRequestId: replacement.requestId });
  await waitFor(() => h.has(next.requestId, 'ready'));
  assert.equal(h.has(stop, 'stopped'), true); assert.equal(h.journal.getTaskState(next.requestId), 'cancelled');
});
test('a failed field correction fence cancels only the source and blocks further admission', async t => {
  const h = await pausedField(t); h.state.stopResult = false;
  const before = h.state.observations; const replacement = correction(h.input); h.send(replacement);
  await waitFor(() => h.has(replacement.requestId, 'blocked_recovery'));
  assert.equal(h.journal.getTaskState(h.input.requestId), 'cancelled');
  assert.equal(h.journal.getTaskRecord(replacement.requestId), undefined);
  assert.equal(h.state.observations, before); assert.equal(h.state.commits, 0);
  const other = start(); h.send(other); assert.equal(h.has(other.requestId, 'blocked_recovery'), true);
});
test('unknown previous edit excludes field correction and never issues a second setter', async t => {
  const h = harness(t); h.state.supported = true; h.state.commitResult = 'unknown';
  const input = start(); h.send(input); await waitFor(() => h.has(input.requestId, 'blocked_recovery'));
  const replacement = correction(input); h.send(replacement);
  await waitFor(() => h.has(replacement.requestId, 'error'));
  assert.equal(h.state.stops, 0); assert.equal(h.state.commits, 1);
  assert.equal(h.journal.getTaskState(input.requestId), 'paused');
  assert.equal(h.journal.getTaskRecord(replacement.requestId), undefined);
});
test('session loss during field correction cancels transition and invalidates late replacement reads', async t => {
  const h = await pausedField(t); h.state.holdObservations = true;
  const replacement = correction(h.input); const before = h.state.observations; h.send(replacement);
  await waitFor(() => h.state.observations > before);
  h.send({ type: 'host_lifecycle', requestId: randomUUID(), sequence: 1, sleeping: true, sessionActive: true });
  await waitFor(() => h.output.some(p => p.type === 'host_lifecycle_status' && p.interruptionSettled === true));
  h.state.held.splice(0).forEach(reply => reply());
  h.send({ type: 'host_lifecycle', requestId: randomUUID(), sequence: 2, sleeping: false, sessionActive: true });
  assert.equal(h.journal.getTaskRecord(replacement.requestId), undefined); assert.equal(h.state.commits, 0);
  assert.equal(h.output.some(p => p.type === 'native_replacement_task'), false);
});
test('Stop during the replacement setter retains the child slot and late effect history', async t => {
  const h = await pausedField(t); h.state.supported = true; h.state.holdCommits = true;
  const replacement = correction(h.input); h.send(replacement);
  await waitFor(() => h.state.commits === 1);
  const stop = randomUUID(); h.send({ type: 'stop', requestId: stop, targetRequestId: h.input.requestId });
  await waitFor(() => h.has(stop, 'uncertain'));
  const early = start(); h.send(early); assert.equal(h.has(early.requestId, 'busy'), true);
  assert.equal(h.journal.getTaskState(replacement.requestId), 'cancelled');
  h.state.held.splice(0).forEach(reply => reply());
  await waitFor(() => h.has(replacement.requestId, 'blocked_recovery'));
  assert.equal(h.has(replacement.requestId, 'verified_native_fill'), false);
  assert.equal(h.journal.getTaskRecord(replacement.requestId)?.completion, null);
  assert.equal(h.journal.attemptsForTask(replacement.requestId).length, 1);
  assert.equal(h.state.verifies, 0); assert.equal(h.state.commits, 1);
  const retry = start(); h.send(retry); assert.equal(h.has(retry.requestId, 'blocked_recovery'), true);
});
test('final voice correction and empty literal value bind to the retained captured target', async t => {
  const input = { ...start(), targetPid: 123, targetLaunchMillis: 456 };
  input.command.text = 'Fill Fixture Name with fixture-123'; input.command.source = 'voice';
  const h = await pausedField(t, input); h.state.supported = true;
  const replacement = correction(input, ''); replacement.replacement.command.source = 'voice';
  replacement.replacement.command.text = `Fill Fixture Name in ${input.bundleId} with text: `;
  h.send({ ...replacement, replacement: { ...replacement.replacement, targetPid: 123, targetLaunchMillis: 456 } });
  await waitFor(() => h.has(replacement.requestId, 'ready'));
  assert.equal(h.has(replacement.requestId, 'verified_native_fill'), true);
  assert.equal(h.journal.getTaskRecord(replacement.requestId)?.admission?.goal,
    `Fill Fixture Name in ${input.bundleId} with text: `);
  assert.equal(h.state.values.at(-1), ''); assert.equal(h.state.verifies, 1);
});
test('restart history cannot recreate a correction authority for a previously paused field', async t => {
  const h = await pausedField(t); await h.close();
  const reopened = new AttemptJournal(h.path);
  const phases: { id: string; phase: string }[] = [];
  const worker = new NativeFieldPipeWorker(message => {
    if (message.type === 'native_worker_request') throw new Error('restart must not observe or dispatch');
  });
  const controller = new NativeManagedController(reopened, (id, phase) => phases.push({ id, phase }), true, worker, () => {});
  try {
    const replacement = correction(h.input); controller.receive(Buffer.from(JSON.stringify(replacement)));
    assert.equal(phases.some(p => p.id === replacement.requestId && p.phase === 'blocked_recovery'), true);
    assert.equal(reopened.getTaskState(h.input.requestId), 'paused');
    assert.equal(reopened.getTaskRecord(replacement.requestId), undefined);
  } finally { await controller.close(); }
});
test('replacement revokes old Resume authority and requires a fresh child prompt at its current revision', async t => {
  const h = await pausedField(t);
  const prepare = async (targetRequestId: string) => {
    const requestId = randomUUID(); h.send({ type: 'prepare_native_recovery', requestId,
      targetRequestId, uiSessionRef: 'panel-session' });
    await waitFor(() => h.output.some(p => p.requestId === requestId));
    await waitFor(() => h.phases.filter(p => p.id === targetRequestId && p.phase === 'blocked_recovery').length >= 2);
    return h.output.find(p => p.requestId === requestId)!;
  };
  const resume = (taskId: string, prompt: Record<string, JSONValue>) => ({
    type: 'resume_native_task', requestId: randomUUID(), targetRequestId: taskId, uiSessionRef: 'panel-session',
    intent: { type: 'resume_request', protocolVersion: '2.0', messageId: randomUUID(), taskId: prompt.taskId,
      taskEpoch: prompt.taskEpoch, goalRevision: prompt.goalRevision, issuer: 'native_ui', actorRef: prompt.actorRef,
      uiSessionRef: prompt.uiSessionRef, promptId: prompt.promptId, presentationDigest: prompt.presentationDigest,
      checkpointRef: prompt.checkpointRef, checkpointDigest: prompt.checkpointDigest,
      recoveryObservationId: prompt.recoveryObservationId, createdAt: new Date().toISOString() } });
  const oldPrompt = await prepare(h.input.requestId);
  h.send({ type: 'native_recovery_presented', requestId: randomUUID(), targetRequestId: h.input.requestId,
    uiSessionRef: 'panel-session', promptId: oldPrompt.promptId, presentationDigest: oldPrompt.presentationDigest });
  const replacement = correction(h.input); h.send(replacement);
  await waitFor(() => h.has(replacement.requestId, 'blocked_recovery'));
  h.send(resume(h.input.requestId, oldPrompt));
  assert.equal(h.state.commits, 0); assert.equal(h.journal.getTaskState(h.input.requestId), 'cancelled');
  const prompt = await prepare(replacement.requestId);
  assert.equal(prompt.taskId, replacement.requestId); assert.equal(prompt.goalRevision, 2);
  assert.notEqual(prompt.checkpointRef, oldPrompt.checkpointRef);
  h.send({ type: 'native_recovery_presented', requestId: randomUUID(), targetRequestId: replacement.requestId,
    uiSessionRef: 'panel-session', promptId: prompt.promptId, presentationDigest: prompt.presentationDigest });
  h.state.supported = true; h.send(resume(replacement.requestId, prompt));
  await waitFor(() => h.has(replacement.requestId, 'ready'));
  assert.equal(h.has(replacement.requestId, 'verified_native_fill'), true);
  assert.equal(h.journal.getTaskState(replacement.requestId), 'completed');
  assert.equal(h.state.values.at(-1), replacement.replacement.value);
  assert.equal(h.state.commits, 1); assert.equal(h.state.verifies, 1);
});
