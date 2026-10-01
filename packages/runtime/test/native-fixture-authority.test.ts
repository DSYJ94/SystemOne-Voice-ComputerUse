import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { AttemptJournal } from '../src/attempt-journal.ts';
import { NativeFixtureAuthority } from '../src/native-fixture-authority.ts';
import type { NativePressWorker, NativePressObservation, NativeLocateRequest } from '../src/native-press-authority.ts';

const HOME = 'SystemOne Fixture';
const DOCS = HOME + ' — Documents';
const LOCATED = DOCS + ' — Budget.xlsx selected';
const OPENED = DOCS + ' — Budget.xlsx opened';
class Deferred<T> {
  resolve!: (value: T) => void;
  readonly promise = new Promise<T>(resolve => { this.resolve = resolve; });
}
class Worker implements NativePressWorker {
  title = HOME;
  scope = 'fixture-scope';
  observations = 0;
  commits: string[] = [];
  stops: string[] = [];
  complete = true;
  duplicate = false;
  verification = true;
  stopResult = true;
  expected = '';
  label = '';
  observeGate: Deferred<void> | undefined;
  prepareGate: Deferred<void> | undefined;
  commitGate: Deferred<void> | undefined;
  onObserve: (() => void) | undefined;
  onPrepare: (() => void) | undefined;
  onCommit: (() => void) | undefined;
  async observePress(): Promise<NativePressObservation> {
    this.observations++; this.onObserve?.(); await this.observeGate?.promise;
    const label = this.title === HOME ? 'Documents' : this.title === DOCS ? 'Budget.xlsx' : 'Open selected file';
    const control = { id: randomUUID(), role: 'AXButton' as const, label, enabled: true, secure: false, canPress: true };
    return { observationId: randomUUID(), scopeRef: this.scope,
      bundleId: 'com.aurium.systemone.fixture', complete: this.complete, windowTitles: [this.title],
      controls: this.duplicate ? [control, { ...control, id: randomUUID() }] : [control] };
  }
  async preparePress(input: Parameters<NativePressWorker['preparePress']>[0]) {
    this.label = this.title === HOME ? 'Documents' : this.title === DOCS ? 'Budget.xlsx' : 'Open selected file';
    this.expected = input.expectedWindowTitle; this.onPrepare?.(); await this.prepareGate?.promise;
    return { kind: 'ready' as const, preparationRef: randomUUID() };
  }
  async commitPress(): Promise<'returned_unverified'> {
    this.commits.push(this.label); this.onCommit?.(); await this.commitGate?.promise;
    this.title = this.expected; return 'returned_unverified';
  }
  async verifyPress(input: { expectedWindowTitle: string }) {
    return this.verification && this.title === input.expectedWindowTitle;
  }
  async stop(taskId: string) { this.stops.push(taskId); return this.stopResult; }
}
function request(kind: 'navigate' | 'locate' | 'open' = 'open'): NativeLocateRequest {
  const requestId = randomUUID();
  return { requestId, bundleId: 'com.aurium.systemone.fixture', folderName: 'Documents', fileName: 'Budget.xlsx',
    expectedWindowTitle: kind === 'navigate' ? DOCS : kind === 'locate' ? LOCATED : OPENED,
    command: { type: 'command', protocolVersion: '2.0', messageId: randomUUID(),
      taskId: requestId, taskEpoch: 1, goalRevision: 1, source: 'text', mode: 'command',
      utteranceId: randomUUID(), utteranceRevision: 1, isFinal: true,
      text: kind === 'navigate' ? 'Navigate synthetic fixture to Documents'
        : `${kind === 'open' ? 'Open' : 'Locate'} synthetic fixture file Documents/Budget.xlsx`,
      createdAt: new Date().toISOString(), originSurface: { adapter: 'native', surfaceId: 'systemone-panel',
        appBundleId: 'com.aurium.systemone.dev', windowId: 'command-panel', contentRevision: requestId } } };
}
function harness(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'systemone-fixture-authority-'));
  const journal = new AttemptJournal(join(root, 'journal.sqlite'));
  const worker = new Worker();
  const authority = new NativeFixtureAuthority(journal, worker);
  t.after(() => { journal.close(); rmSync(root, { recursive: true, force: true }); });
  return { journal, worker, authority };
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('fixture stage did not arrive');
}

for (const mode of ['navigate', 'locate', 'open'] as const) {
  test(`controller authority completes distinct ${mode} with original command binding`, async t => {
    const { worker, journal, authority } = harness(t);
    const input = request(mode);
    const result = mode === 'navigate' ? await authority.start(input)
      : mode === 'locate' ? await authority.startLocate(input) : await authority.startOpen(input);
    assert.equal(result, mode === 'navigate' ? 'verified_navigation' : mode === 'locate' ? 'verified_locate' : 'verified_open');
    assert.deepEqual(worker.commits, mode === 'navigate' ? ['Documents'] : mode === 'locate'
      ? ['Documents', 'Budget.xlsx'] : ['Documents', 'Budget.xlsx', 'Open selected file']);
    assert.equal(journal.getTaskRecord(input.requestId)?.admission?.commandMessageId, input.command.messageId);
    assert.equal(journal.getTaskRecord(input.requestId)?.progress?.decisionsUsed, worker.commits.length);
    assert.equal(journal.getTaskRecord(input.requestId)?.state, 'completed');
    assert.deepEqual(journal.pendingTaskIds(), []);
    assert.equal(await authority.startOpen(input), 'error');
  });
}
test('changed command source, text and scope parameters cannot begin observation', async t => {
  const { worker, authority } = harness(t);
  for (const update of [ { source: 'voice' }, { text: 'Open personal file' }, { mode: 'dictation' },
    { isFinal: false }, { goalRevision: 2 } ]) {
    const input = request(); Object.assign(input.command, update);
    assert.equal(await authority.startOpen(input), 'error');
  }
  assert.equal(await authority.startOpen({ ...request(), bundleId: 'personal.app' }), 'error');
  assert.equal(worker.observations, 0);
});
test('already satisfied objective gets fresh predicate evidence without an action', async t => {
  const { worker, journal, authority } = harness(t); worker.title = OPENED;
  const input = request(); assert.equal(await authority.startOpen(input), 'already_matched');
  assert.deepEqual(worker.commits, []);
  assert.ok(journal.getTaskRecord(input.requestId)?.completion);
});
test('decision pause keeps history and blocks replacement until exact Stop', async t => {
  const { worker, journal } = harness(t);
  const authority = new NativeFixtureAuthority(journal, worker,
    { maxObservations: 10, maxDecisions: 1, maxStateVisits: 3 });
  const input = request(); assert.equal(await authority.startOpen(input), 'paused');
  assert.deepEqual(worker.commits, ['Documents']);
  assert.deepEqual(journal.pendingTaskIds(), [input.requestId]);
  const deadline = journal.getTaskBudget(input.requestId)?.deadlineMillis;
  assert.equal(await authority.startOpen(request()), 'uncertain');
  assert.equal((await authority.stop()).workerFenced, true);
  assert.equal(journal.getTaskState(input.requestId), 'cancelled');
  assert.equal(journal.getTaskBudget(input.requestId)?.deadlineMillis, deadline);
  assert.deepEqual(journal.getTaskProgress(input.requestId)?.checkpoints.map(c => c.stageRef), ['documents']);
  worker.title = HOME;
  const next = request('navigate'); assert.equal(await authority.start(next), 'verified_navigation');
});
test('pre-admission Stop after an earlier completion fences the new worker task', async t => {
  const { worker, journal, authority } = harness(t);
  const first = request('navigate'); assert.equal(await authority.start(first), 'verified_navigation');
  worker.title = HOME; worker.observeGate = new Deferred();
  const input = request(); const pending = authority.startOpen(input);
  await waitFor(() => worker.observations === 2);
  assert.equal((await authority.stop()).workerFenced, true);
  assert.equal(worker.stops.at(-1), input.requestId);
  worker.observeGate.resolve(); assert.equal(await pending, 'stopped');
  assert.equal(journal.getTaskRecord(input.requestId), undefined);
});
test('Stop during preparation rejects late preparation and keeps ownership until settled', async t => {
  const { worker, journal, authority } = harness(t); worker.prepareGate = new Deferred();
  let preparing = false; worker.onPrepare = () => { preparing = true; };
  const input = request(); const pending = authority.startOpen(input); await waitFor(() => preparing);
  assert.equal((await authority.stop()).workerFenced, true);
  assert.equal(authority.needsRecovery, true);
  assert.equal(await authority.startOpen(request()), 'error');
  worker.prepareGate.resolve(); assert.equal(await pending, 'stopped');
  assert.deepEqual(worker.commits, []); assert.equal(journal.getTaskState(input.requestId), 'cancelled');
  assert.equal(authority.needsRecovery, false);
});
test('Stop after dispatch never converts a late effect into successful completion or retry', async t => {
  const { worker, journal, authority } = harness(t); worker.commitGate = new Deferred();
  const input = request(); const pending = authority.startOpen(input); await waitFor(() => worker.commits.length === 1);
  assert.equal((await authority.stop()).unresolvedExecutionIds.length, 1);
  worker.commitGate.resolve(); assert.equal(await pending, 'stopped');
  assert.equal(journal.getTaskRecord(input.requestId)?.completion, null);
  assert.equal(journal.unresolvedAttempts(input.requestId).length, 1);
  assert.equal(await authority.startOpen(request()), 'uncertain');
});
test('failed worker fence remains a blocker after cancellation', async t => {
  const { worker, journal, authority } = harness(t); worker.duplicate = true;
  const input = request(); assert.equal(await authority.startOpen(input), 'paused');
  worker.stopResult = false; assert.equal((await authority.stop()).workerFenced, false);
  assert.equal(journal.getTaskState(input.requestId), 'cancelled');
  assert.equal(await authority.startOpen(request()), 'uncertain');
});
test('actor timeout retains a late preparation and prevents journal close callbacks until transport settles', async t => {
  const { worker, journal, authority } = harness(t); worker.prepareGate = new Deferred();
  const input = request(); assert.equal(await authority.startOpen(input), 'paused');
  assert.equal(authority.needsRecovery, true); assert.deepEqual(worker.commits, []);
  assert.equal((await authority.stop()).workerFenced, true);
  let settled = false; const closing = authority.settleBeforeClose().then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  worker.prepareGate.resolve(); await closing;
  assert.equal(journal.getTaskState(input.requestId), 'cancelled');
  assert.deepEqual(journal.attemptsForTask(input.requestId), []);
  assert.equal(authority.needsRecovery, false);
});
