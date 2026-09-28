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

  async observe(target: string): Promise<NativeFieldObservation> {
    assert.equal(target, bundleId);
    this.observeCalls++;
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
  async verify(): Promise<boolean> { return this.verifyResult; }
  async stop(): Promise<boolean> { this.stopCalls++; return this.stopFenced; }
}

function request(requestId = randomUUID()): NativeFillRequest {
  return { requestId, bundleId, fieldLabel, value: 'fixture-123', command: {
    type: 'command', protocolVersion: '2.0', messageId: randomUUID(),
    taskId: requestId, taskEpoch: 1, goalRevision: 1,
    source: 'text', mode: 'command', utteranceId: randomUUID(),
    utteranceRevision: 1,
    text: `Fill ${fieldLabel} in ${bundleId} with supplied text`,
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
  assert.equal(await authority.start(input), 'error', 'task request cannot replay');
});

test('unbound command and ambiguous or incomplete observation send no setter', async t => {
  const { worker, authority } = harness(t);
  const forged = request();
  forged.command.text = 'different request';
  assert.equal(await authority.start(forged), 'error');
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
  assert.equal(journal.getTaskState(input.requestId), 'cancelled');
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
