import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AttemptJournal } from '../src/attempt-journal.ts';
import { NativePressAuthority } from '../src/native-press-authority.ts';
import type { NativePressObservation, NativePressRequest,
  NativePressWorker } from '../src/native-press-authority.ts';

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() { this.promise = new Promise(resolve => { this.resolve = resolve; }); }
}

class FixturePressWorker implements NativePressWorker {
  observation: NativePressObservation = {
    observationId: randomUUID(), scopeRef: `native:${randomUUID()}`,
    bundleId: 'com.aurium.systemone.fixture', complete: true,
    windowTitles: ['SystemOne Fixture'],
    controls: [{ id: 'documents-node', role: 'AXButton', label: 'Documents',
      enabled: true, secure: false, canPress: true }],
  };
  observeCalls = 0;
  prepareCalls = 0;
  commitCalls = 0;
  verifyCalls = 0;
  stopCalls = 0;
  verification = true;
  commitGate?: Deferred<'returned_unverified' | 'not_dispatched' | 'unknown'>;

  async observePress(): Promise<NativePressObservation> {
    this.observeCalls++;
    return this.observation;
  }
  async preparePress(input: { observationId: string; candidateId: string;
    expectedWindowTitle: string; policyRevision: string }): Promise<
      { kind: 'ready'; preparationRef: string }> {
    this.prepareCalls++;
    assert.equal(input.observationId, this.observation.observationId);
    assert.equal(input.candidateId, 'documents-node');
    assert.equal(input.expectedWindowTitle, 'SystemOne Fixture — Documents');
    assert.equal(input.policyRevision, 'native-ax-press-fixture-v1');
    return { kind: 'ready', preparationRef: randomUUID() };
  }
  async commitPress(): Promise<'returned_unverified' | 'not_dispatched' | 'unknown'> {
    this.commitCalls++;
    return this.commitGate ? this.commitGate.promise : 'returned_unverified';
  }
  async verifyPress(): Promise<boolean> {
    this.verifyCalls++;
    return this.verification;
  }
  async stop(): Promise<boolean> { this.stopCalls++; return true; }
}

function request(requestId = randomUUID()): NativePressRequest {
  return { requestId, bundleId: 'com.aurium.systemone.fixture',
    folderName: 'Documents',
    expectedWindowTitle: 'SystemOne Fixture — Documents', command: {
      type: 'command', protocolVersion: '2.0', messageId: randomUUID(),
      taskId: requestId, taskEpoch: 1, goalRevision: 1,
      source: 'text', mode: 'command', utteranceId: randomUUID(),
      utteranceRevision: 1, text: 'Navigate synthetic fixture to Documents',
      isFinal: true, createdAt: new Date().toISOString(),
      originSurface: { adapter: 'native', surfaceId: 'systemone-panel',
        appBundleId: 'com.aurium.systemone.dev', windowId: 'command-panel',
        contentRevision: requestId },
    } };
}

function harness(t: { after(callback: () => void): void }): {
  worker: FixturePressWorker; journal: AttemptJournal;
  authority: NativePressAuthority } {
  const root = mkdtempSync(join(tmpdir(), 'systemone-native-press-'));
  const journal = new AttemptJournal(join(root, 'attempts.sqlite'));
  const worker = new FixturePressWorker();
  const authority = new NativePressAuthority(journal, worker);
  t.after(() => { journal.close(); rmSync(root, { recursive: true, force: true }); });
  return { worker, journal, authority };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 500; count++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('native press stage not reached');
}

test('fixture press requires independent title verification before completion', async t => {
  const { worker, journal, authority } = harness(t);
  const input = request();
  assert.equal(await authority.start(input), 'verified_navigation');
  assert.equal(worker.commitCalls, 1);
  assert.equal(worker.verifyCalls, 1);
  assert.equal(journal.getTaskState(input.requestId), 'completed');
  const attempt = journal.attemptsForTask(input.requestId)[0]!;
  assert.equal(attempt.outcome?.verification, 'matched');
  assert.deepEqual(journal.eventKinds(attempt.executionId),
    ['prepared', 'dispatch_boundary', 'outcome']);
  assert.equal(await authority.start(input), 'error', 'request replay rejected');
});

test('unbound input, duplicate control and incomplete coverage send no press', async t => {
  const { worker, authority } = harness(t);
  const changed = request();
  changed.command.text = 'Navigate synthetic fixture to Downloads';
  assert.equal(await authority.start(changed), 'error');
  assert.equal(worker.observeCalls, 0);
  worker.observation = { ...worker.observation,
    controls: [worker.observation.controls[0]!,
      { ...worker.observation.controls[0]!, id: 'other-documents-node' }] };
  assert.equal(await authority.start(request()), 'unsupported');
  assert.equal(worker.prepareCalls, 0);
  worker.observation = { ...worker.observation, complete: false,
    controls: [worker.observation.controls[0]!] };
  assert.equal(await authority.start(request()), 'unsupported');
  assert.equal(worker.commitCalls, 0);
});

test('already navigated state is verified without dispatching AXPress', async t => {
  const { worker, journal, authority } = harness(t);
  worker.observation = { ...worker.observation,
    windowTitles: ['SystemOne Fixture — Documents'] };
  const input = request();
  assert.equal(await authority.start(input), 'already_matched');
  assert.equal(worker.verifyCalls, 1);
  assert.equal(worker.commitCalls, 0);
  assert.equal(journal.attemptsForTask(input.requestId).length, 0);
});

test('returned press with failed verification remains unknown and blocks retry', async t => {
  const { worker, journal, authority } = harness(t);
  worker.verification = false;
  const input = request();
  assert.equal(await authority.start(input), 'uncertain');
  assert.equal(journal.getTaskState(input.requestId), 'cancelled');
  assert.equal(journal.attemptsForTask(input.requestId)[0]?.outcome?.effectStatus,
    'unknown');
  assert.equal(authority.needsRecovery, true);
  assert.equal(await authority.start(request()), 'uncertain');
  assert.equal(worker.commitCalls, 1);
});

test('Stop after press boundary cannot turn a late receipt into success', async t => {
  const { worker, journal, authority } = harness(t);
  worker.commitGate = new Deferred();
  const input = request();
  const pending = authority.start(input);
  await waitFor(() => worker.commitCalls === 1);
  const stop = await authority.stop();
  assert.equal(stop.workerFenced, true);
  assert.equal(stop.unresolvedExecutionIds.length, 1);
  worker.commitGate.resolve('returned_unverified');
  assert.equal(await pending, 'stopped');
  assert.equal(worker.verifyCalls, 0);
  assert.equal(journal.getTaskState(input.requestId), 'cancelled');
  assert.equal(authority.needsRecovery, true);
  assert.equal(await authority.start(request()), 'uncertain');
});
