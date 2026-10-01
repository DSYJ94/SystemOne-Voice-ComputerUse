import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AttemptJournal } from '../src/attempt-journal.ts';
import { NativeFillAuthority } from '../src/native-fill-authority.ts';
import type { NativeFieldObservation, NativeFieldWorker,
  NativeFillRequest } from '../src/native-fill-authority.ts';

const bundleId = 'com.aurium.systemone.fixture';
const fieldLabel = 'Fixture Name';

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() {
    this.promise = new Promise(resolve => { this.resolve = resolve; });
  }
}

class FakeWorker implements NativeFieldWorker {
  observation: NativeFieldObservation = {
    observationId: randomUUID(), scopeRef: `native:${randomUUID()}`,
    bundleId, complete: true,
    controls: [{ id: 'node-1', role: 'AXTextField', label: fieldLabel,
      enabled: true, secure: false, canSetValue: true }],
  };
  observeCalls = 0;
  capturedPID: number | undefined;
  prepareCalls = 0;
  commitCalls: Array<{ taskId: string; executionId: string;
    permitRef: string; preparationRef: string }> = [];
  stopCalls = 0;
  stopFenced = true;
  prepareGate: Deferred<{ kind: 'ready'; preparationRef: string }> | undefined;
  commitGate: Deferred<'verified' | 'not_dispatched' | 'unknown'> | undefined;
  commitResult: 'verified' | 'not_dispatched' | 'unknown' = 'verified';
  prepareResult: 'ready' | 'matched_at_preflight' | 'unsupported' = 'ready';
  commitThrows = false;
  verifyResult = true;
  verifyCalls = 0;
  verifyGate: Deferred<boolean> | undefined;

  async observe(input: { taskId: string; bundleId: string;
    targetPid?: number }): Promise<NativeFieldObservation> {
    assert.equal(input.bundleId, bundleId);
    assert.match(input.taskId, /^[a-f0-9-]{36}$/);
    this.observeCalls++;
    this.observation = { ...this.observation, observationId: randomUUID() };
    this.capturedPID = input.targetPid;
    return this.observation;
  }
  async prepare(input: { taskId: string; observationId: string;
    candidateId: string; value: string }): Promise<
      { kind: 'ready'; preparationRef: string }
      | { kind: 'matched_at_preflight' }
      | { kind: 'unsupported' }> {
    this.prepareCalls++;
    assert.equal(input.observationId, this.observation.observationId);
    assert.equal(input.candidateId, 'node-1');
    assert.equal(input.value, 'fixture-123');
    if (this.prepareGate) return this.prepareGate.promise;
    if (this.prepareResult === 'ready') {
      return { kind: 'ready', preparationRef: randomUUID() };
    }
    return { kind: this.prepareResult };
  }
  async commit(input: { taskId: string; executionId: string;
    permitRef: string; preparationRef: string }): Promise<
      'verified' | 'not_dispatched' | 'unknown'> {
    this.commitCalls.push(input);
    if (this.commitThrows) throw new Error('setter reply lost');
    return this.commitGate ? this.commitGate.promise : this.commitResult;
  }
  async verify(): Promise<boolean> { this.verifyCalls++; return this.verifyGate ? this.verifyGate.promise : this.verifyResult; }
  async stop(): Promise<boolean> { this.stopCalls++; return this.stopFenced; }
}

function request(requestId = randomUUID()): NativeFillRequest {
  return { requestId, bundleId, fieldLabel, value: 'fixture-123', command: {
    type: 'command', protocolVersion: '2.0', messageId: randomUUID(),
    taskId: requestId, taskEpoch: 1, goalRevision: 1,
    source: 'text', mode: 'command', utteranceId: randomUUID(),
    utteranceRevision: 1,
    text: `Fill ${fieldLabel} in ${bundleId} with text: fixture-123`,
    isFinal: true, createdAt: new Date().toISOString(),
    originSurface: { adapter: 'native', surfaceId: 'systemone-panel',
      appBundleId: 'com.aurium.systemone.dev', windowId: 'command-panel',
      contentRevision: requestId },
  } };
}

function harness(t: { after(callback: () => void): void }): {
  worker: FakeWorker; journal: AttemptJournal; authority: NativeFillAuthority } {
  const root = mkdtempSync(join(tmpdir(), 'systemone-native-authority-'));
  const journal = new AttemptJournal(join(root, 'attempts.sqlite'));
  const worker = new FakeWorker();
  const authority = new NativeFillAuthority(journal, worker);
  t.after(() => { journal.close(); rmSync(root, { recursive: true, force: true }); });
  return { worker, journal, authority };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 500; count++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('synthetic worker stage not reached');
}

test('native host admits exact candidate and journaled setter once', async t => {
  const { worker, journal, authority } = harness(t);
  const input = request();
  assert.equal(await authority.start(input), 'verified');
  assert.equal(journal.getTaskState(input.requestId), 'completed');
  const attempts = journal.attemptsForTask(input.requestId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.outcome?.verification, 'matched');
  assert.deepEqual(journal.eventKinds(attempts[0]!.executionId),
    ['prepared', 'dispatch_boundary', 'outcome']);
  assert.equal(worker.commitCalls.length, 1);
  assert.equal(worker.commitCalls[0]?.executionId, attempts[0]?.executionId);
  const record = journal.getTaskRecord(input.requestId)!;
  assert.equal(record.admission?.goal, input.command.text);
  assert.equal(record.admission?.commandMessageId, input.command.messageId);
  assert.equal(record.admission?.outcomeKind, 'FILL');
  assert.equal(record.completion?.completionVerifierRef, record.admission?.completionVerifierRef);
  assert.equal(await authority.start(input), 'error', 'task request cannot replay');
});

test('reviewed voice command enters the same native permit and verification path', async t => {
  const { worker, journal, authority } = harness(t);
  const input = { ...request(), targetPid: 501,
    targetLaunchMillis: 1_790_000_000_000 };
  input.command.source = 'voice';
  input.command.text = 'Fill Fixture Name with fixture-123';
  assert.equal(await authority.start(input), 'verified');
  assert.equal(worker.capturedPID, 501);
  assert.equal(worker.commitCalls.length, 1);
  assert.equal(journal.getTaskState(input.requestId), 'completed');
  const altered = { ...request(), targetPid: 501,
    targetLaunchMillis: 1_790_000_000_000 };
  altered.command.source = 'voice';
  altered.command.text = 'Fill Other Name with fixture-123';
  assert.equal(await authority.start(altered), 'error');
  const unbound = request();
  unbound.command.source = 'voice';
  unbound.command.text = 'Fill Fixture Name with fixture-123';
  assert.equal(await authority.start(unbound), 'error');
});

test('unbound command and ambiguous or incomplete observation send no setter', async t => {
  const { worker, authority } = harness(t);
  const forged = request();
  forged.command.text = 'different request';
  assert.equal(await authority.start(forged), 'error');
  const changedValue = request();
  assert.equal(await authority.start({ ...changedValue,
    value: 'different-value' }), 'error');
  assert.equal(worker.observeCalls, 0);
  worker.observation = { ...worker.observation, controls: [
    worker.observation.controls[0]!,
    { ...worker.observation.controls[0]!, id: 'node-2' },
  ] };
  assert.equal(await authority.start(request()), 'unsupported');
  assert.equal(worker.prepareCalls, 0);
  worker.observation = { ...worker.observation, complete: false,
    controls: [worker.observation.controls[0]!] };
  assert.equal(await authority.start(request()), 'unsupported');
  assert.equal(worker.commitCalls.length, 0);
});

test('current value requires independent read and never dispatches a setter', async t => {
  const { worker, journal, authority } = harness(t);
  worker.prepareResult = 'matched_at_preflight';
  const input = request();
  assert.equal(await authority.start(input), 'already_matched');
  assert.equal(worker.commitCalls.length, 0);
  assert.equal(journal.getTaskState(input.requestId), 'completed');
  assert.equal(journal.attemptsForTask(input.requestId).length, 0);
});

test('Stop during worker preflight prevents a later boundary and allows a fresh task', async t => {
  const { worker, journal, authority } = harness(t);
  worker.prepareGate = new Deferred();
  const input = request();
  const pending = authority.start(input);
  await waitFor(() => worker.prepareCalls === 1);
  const stop = await authority.stop();
  assert.equal(stop.workerFenced, true);
  worker.prepareGate.resolve({ kind: 'ready', preparationRef: randomUUID() });
  assert.equal(await pending, 'stopped');
  assert.equal(journal.getTaskState(input.requestId), 'cancelled');
  assert.equal(journal.attemptsForTask(input.requestId).length, 0);
  assert.equal(worker.commitCalls.length, 0);
  worker.prepareGate = undefined;
  assert.equal(await authority.start(request()), 'verified');
});

test('Stop after boundary never completes a late verified effect or authorizes retry', async t => {
  const { worker, journal, authority } = harness(t);
  worker.commitGate = new Deferred();
  const input = request();
  const pending = authority.start(input);
  await waitFor(() => worker.commitCalls.length === 1);
  const stop = await authority.stop();
  assert.equal(stop.workerFenced, true);
  assert.equal(stop.unresolvedExecutionIds.length, 1);
  worker.commitGate.resolve('verified');
  assert.equal(await pending, 'stopped');
  assert.equal(journal.getTaskState(input.requestId), 'cancelled');
  assert.equal(journal.attemptsForTask(input.requestId)[0]?.outcome?.verification,
    'matched');
  assert.equal(await authority.start(request()), 'uncertain');
});

test('lost setter reply stays unknown and blocks another task', async t => {
  const { worker, journal, authority } = harness(t);
  worker.commitThrows = true;
  const input = request();
  assert.equal(await authority.start(input), 'uncertain');
  assert.equal(journal.getTaskState(input.requestId), 'paused');
  assert.equal(journal.unresolvedAttempts(input.requestId).length, 1);
  assert.equal(await authority.start(request()), 'uncertain');
});

test('unconfirmed worker Stop fences future native starts', async t => {
  const { worker, authority } = harness(t);
  worker.prepareGate = new Deferred();
  worker.stopFenced = false;
  const pending = authority.start(request());
  await waitFor(() => worker.prepareCalls === 1);
  const stop = await authority.stop();
  assert.equal(stop.workerFenced, false);
  worker.prepareGate.resolve({ kind: 'ready', preparationRef: randomUUID() });
  assert.equal(await pending, 'stopped');
  assert.equal(await authority.start(request()), 'uncertain');
});

function resumeReply(prompt: Awaited<ReturnType<NativeFillAuthority['prepareRecovery']>>, extra = {}) {
  return Buffer.from(JSON.stringify({ protocolVersion: '2.0', type: 'resume_request', messageId: randomUUID(),
    taskId: prompt.taskId, taskEpoch: prompt.taskEpoch, goalRevision: prompt.goalRevision,
    issuer: 'native_ui', actorRef: prompt.actorRef, uiSessionRef: prompt.uiSessionRef, promptId: prompt.promptId,
    presentationDigest: prompt.presentationDigest, checkpointRef: prompt.checkpointRef,
    checkpointDigest: prompt.checkpointDigest, recoveryObservationId: prompt.recoveryObservationId,
    createdAt: new Date().toISOString(), ...extra }));
}
test('field actor persists eligibility and terminal evidence with bounded observations and decisions', async t => {
  const { worker, journal, authority } = harness(t); const input = request();
  assert.equal(await authority.start(input), 'verified');
  const record = journal.getTaskRecord(input.requestId)!;
  assert.equal(record.progress!.observationsUsed, 2); assert.equal(record.progress!.decisionsUsed, 1);
  assert.deepEqual(record.progress!.checkpoints.map(c => c.stageRef), ['field_ready', 'field_filled']);
  assert.equal(record.progress!.checkpoints[1]!.executionId, worker.commitCalls[0]!.executionId);
  assert.equal(record.progress!.checkpoints[1]!.evidenceRef, record.completion!.evidenceRef);
  assert.equal(record.admission!.parameters.find(p => p.parameterRef === 'fill-field')!.sourceStart, 5);
});
test('a verified setter receipt without a matching fresh value read cannot complete or recover', async t => {
  const { worker, journal, authority } = harness(t); worker.verifyResult = false;
  const input = request(); assert.equal(await authority.start(input), 'paused');
  assert.equal(journal.getTaskRecord(input.requestId)!.completion, null);
  assert.equal(journal.attemptsForTask(input.requestId)[0]!.outcome!.effectStatus, 'applied');
  await assert.rejects(authority.prepareRecovery(input.requestId, 'panel-session'));
  await authority.stop(); assert.equal(await authority.start(request()), 'uncertain');
});
test('undispatched field pause resumes only after scoped eligibility checks and a displayed exact reply', async t => {
  const { worker, journal, authority } = harness(t); worker.prepareResult = 'unsupported';
  const input = request(); assert.equal(await authority.start(input), 'paused');
  const admission = journal.getTaskRecord(input.requestId)!.admission;
  const deadline = journal.getTaskBudget(input.requestId)!.deadlineMillis;
  worker.prepareResult = 'ready';
  const prompt = await authority.prepareRecovery(input.requestId, 'panel-session');
  await assert.rejects(authority.resume(input.requestId, resumeReply(prompt)), /displayed/);
  authority.presented(input.requestId, prompt.promptId, prompt.presentationDigest, prompt.uiSessionRef);
  await assert.rejects(authority.resume(input.requestId, resumeReply(prompt, { uiSessionRef: 'other-session' })));
  assert.equal(await authority.resume(input.requestId, resumeReply(prompt)), 'verified');
  assert.deepEqual(journal.getTaskRecord(input.requestId)!.admission, admission);
  assert.equal(journal.getTaskBudget(input.requestId)!.deadlineMillis, deadline);
  assert.equal(journal.getTaskProgress(input.requestId)!.decisionsUsed, 2);
  assert.equal(worker.commitCalls.length, 1);
  await assert.rejects(authority.resume(input.requestId, resumeReply(prompt)));
});
test('field recovery rejects replacement scope, secure controls and changed labels without dispatch', async t => {
  const { worker, journal, authority } = harness(t); worker.prepareResult = 'unsupported';
  const input = request(); assert.equal(await authority.start(input), 'paused');
  const original = worker.observation;
  for (const altered of [{ ...original, scopeRef: 'replacement-process' },
    { ...original, controls: [{ ...original.controls[0]!, secure: true }] },
    { ...original, controls: [{ ...original.controls[0]!, label: 'Other field' }] }]) {
    worker.observation = altered;
    await assert.rejects(authority.prepareRecovery(input.requestId, 'panel-session'));
  }
  assert.equal(journal.getTaskState(input.requestId), 'paused'); assert.equal(worker.commitCalls.length, 0);
});
test('field actor enforces original decision and observation limits before more dispatch', async t => {
  const { worker, journal } = harness(t);
  const authority = new NativeFillAuthority(journal, worker, { maxDecisions: 1, maxObservations: 1, maxStateVisits: 3 });
  const input = request(); assert.equal(await authority.start(input), 'paused');
  assert.equal(worker.commitCalls.length, 1); assert.equal(journal.getTaskRecord(input.requestId)!.completion, null);
  const before = worker.observeCalls;
  await assert.rejects(authority.prepareRecovery(input.requestId, 'panel-session'));
  assert.equal(worker.observeCalls, before);
  assert.equal(journal.getTaskProgress(input.requestId)!.pauseReason, 'observations');
});
test('field timeout retains pending preparation, accepts independent Stop and waits before journal shutdown', async t => {
  const { worker, journal, authority } = harness(t); worker.prepareGate = new Deferred();
  const input = request(); assert.equal(await authority.start(input), 'paused');
  assert.equal(authority.needsRecovery, true);
  await assert.rejects(authority.prepareRecovery(input.requestId, 'panel-session'));
  assert.equal((await authority.stop()).workerFenced, true);
  let settled = false; const closing = authority.settleBeforeClose().then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  worker.prepareGate.resolve({ kind: 'ready', preparationRef: randomUUID() }); await closing;
  assert.equal(journal.getTaskState(input.requestId), 'cancelled'); assert.equal(worker.commitCalls.length, 0);
});

test('Stop during independent terminal value read rejects late completion evidence', async t => {
  const { worker, journal, authority } = harness(t); worker.verifyGate = new Deferred();
  const input = request(); const pending = authority.start(input);
  await waitFor(() => worker.verifyCalls === 1);
  assert.equal(journal.getTaskRecord(input.requestId)!.completion, null);
  await authority.stop(); worker.verifyGate.resolve(true);
  assert.equal(await pending, 'stopped'); assert.equal(journal.getTaskRecord(input.requestId)!.completion, null);
  assert.deepEqual(journal.getTaskProgress(input.requestId)!.checkpoints.map(c => c.stageRef), ['field_ready']);
  assert.equal(await authority.start(request()), 'uncertain');
});
