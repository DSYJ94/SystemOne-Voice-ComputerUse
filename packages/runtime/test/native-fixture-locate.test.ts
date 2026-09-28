import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AttemptJournal } from '../src/attempt-journal.ts';
import { NativePressAuthority } from '../src/native-press-authority.ts';
import type { NativeLocateRequest, NativeOpenRequest,
  NativePressControl, NativePressObservation,
  NativePressWorker } from '../src/native-press-authority.ts';

const ROOT = 'SystemOne Fixture';
const DOCUMENTS = 'SystemOne Fixture — Documents';
const SELECTED = 'SystemOne Fixture — Documents — Budget.xlsx selected';
const OPENED = 'SystemOne Fixture — Documents — Budget.xlsx opened';

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() { this.promise = new Promise(resolve => { this.resolve = resolve; }); }
}

class FixtureWorker implements NativePressWorker {
  title = ROOT;
  scope = 'native:fixture-scope';
  duplicateFile = false;
  duplicateOpen = false;
  observeCalls = 0;
  commits: string[] = [];
  verifications: string[] = [];
  prepared: string | undefined;
  stopCalls = 0;
  firstCommitGate?: Deferred<'returned_unverified' | 'not_dispatched' | 'unknown'>;
  thirdCommitGate?: Deferred<'returned_unverified' | 'not_dispatched' | 'unknown'>;
  secondObserveGate?: Deferred<void>;
  thirdObserveGate?: Deferred<void>;
  interfereAfterFolder = false;
  interfereAfterSelection = false;
  secondCommitResult: 'returned_unverified' | 'not_dispatched' | 'unknown'
    = 'returned_unverified';
  thirdCommitResult: 'returned_unverified' | 'not_dispatched' | 'unknown'
    = 'returned_unverified';

  async observePress(): Promise<NativePressObservation> {
    this.observeCalls++;
    if (this.observeCalls === 2 && this.secondObserveGate) {
      await this.secondObserveGate.promise;
    }
    if (this.observeCalls === 3 && this.thirdObserveGate) {
      await this.thirdObserveGate.promise;
    }
    const controls: NativePressControl[] = [
      { id: 'documents-button', role: 'AXButton', label: 'Documents',
        enabled: true, secure: false, canPress: true },
      { id: 'downloads-button', role: 'AXButton', label: 'Downloads',
        enabled: true, secure: false, canPress: true },
    ];
    if (this.title === DOCUMENTS || this.title === SELECTED || this.title === OPENED) {
      controls.push({ id: 'budget-button', role: 'AXButton',
        label: 'Budget.xlsx', enabled: true, secure: false, canPress: true });
      if (this.duplicateFile) controls.push({ id: 'other-budget-button',
        role: 'AXButton', label: 'Budget.xlsx', enabled: true,
        secure: false, canPress: true });
      if (this.title === SELECTED || this.title === OPENED) {
        controls.push({ id: 'open-button', role: 'AXButton',
          label: 'Open selected file', enabled: true, secure: false,
          canPress: true });
        if (this.duplicateOpen) controls.push({ id: 'other-open-button',
          role: 'AXButton', label: 'Open selected file',
          enabled: true, secure: false, canPress: true });
      }
    }
    return { observationId: randomUUID(), scopeRef: this.scope,
      bundleId: 'com.aurium.systemone.fixture', complete: true,
      controls, windowTitles: [this.title] };
  }

  async preparePress(input: { candidateId: string; expectedWindowTitle: string;
    policyRevision: string }): Promise<{ kind: 'ready'; preparationRef: string }> {
    assert.equal(input.policyRevision, 'native-ax-press-fixture-v1');
    if (input.candidateId === 'documents-button') {
      assert.equal(input.expectedWindowTitle, DOCUMENTS);
    } else if (input.candidateId === 'budget-button') {
      assert.equal(input.candidateId, 'budget-button');
      assert.equal(input.expectedWindowTitle, SELECTED);
      assert.equal(this.title, DOCUMENTS);
    } else {
      assert.equal(input.candidateId, 'open-button');
      assert.equal(input.expectedWindowTitle, OPENED);
      assert.equal(this.title, SELECTED);
    }
    this.prepared = input.candidateId;
    return { kind: 'ready', preparationRef: randomUUID() };
  }

  async commitPress(): Promise<'returned_unverified' | 'not_dispatched' | 'unknown'> {
    const candidate = this.prepared!;
    this.commits.push(candidate);
    if (candidate === 'documents-button') {
      const result = this.firstCommitGate
        ? await this.firstCommitGate.promise : 'returned_unverified';
      if (result === 'returned_unverified') this.title = DOCUMENTS;
      return result;
    }
    if (candidate === 'budget-button') {
      if (this.secondCommitResult === 'returned_unverified') this.title = SELECTED;
      return this.secondCommitResult;
    }
    const openResult = this.thirdCommitGate
      ? await this.thirdCommitGate.promise : this.thirdCommitResult;
    if (openResult === 'returned_unverified') this.title = OPENED;
    return openResult;
  }

  async verifyPress(input: { expectedWindowTitle: string }): Promise<boolean> {
    this.verifications.push(input.expectedWindowTitle);
    const matched = this.title === input.expectedWindowTitle;
    if (matched && input.expectedWindowTitle === DOCUMENTS
      && this.interfereAfterFolder) this.title = 'SystemOne Fixture — Downloads';
    if (matched && input.expectedWindowTitle === SELECTED
      && this.interfereAfterSelection) {
      this.title = 'SystemOne Fixture — Downloads';
    }
    return matched;
  }

  async stop(): Promise<boolean> { this.stopCalls++; return true; }
}

function request(requestId = randomUUID()): NativeLocateRequest {
  return { requestId, bundleId: 'com.aurium.systemone.fixture',
    folderName: 'Documents', fileName: 'Budget.xlsx',
    expectedWindowTitle: SELECTED, command: {
      type: 'command', protocolVersion: '2.0', messageId: randomUUID(),
      taskId: requestId, taskEpoch: 1, goalRevision: 1,
      source: 'text', mode: 'command', utteranceId: randomUUID(),
      utteranceRevision: 1,
      text: 'Locate synthetic fixture file Documents/Budget.xlsx',
      isFinal: true, createdAt: new Date().toISOString(),
      originSurface: { adapter: 'native', surfaceId: 'systemone-panel',
        appBundleId: 'com.aurium.systemone.dev', windowId: 'command-panel',
        contentRevision: requestId },
    } };
}

function openRequest(requestId = randomUUID()): NativeOpenRequest {
  const locate = request(requestId);
  return { ...locate, expectedWindowTitle: OPENED,
    command: { ...locate.command,
      text: 'Open synthetic fixture file Documents/Budget.xlsx' } };
}

function harness(t: { after(callback: () => void): void }): {
  worker: FixtureWorker; journal: AttemptJournal;
  authority: NativePressAuthority } {
  const root = mkdtempSync(join(tmpdir(), 'systemone-native-locate-'));
  const journal = new AttemptJournal(join(root, 'attempts.sqlite'));
  const worker = new FixtureWorker();
  const authority = new NativePressAuthority(journal, worker);
  t.after(() => { journal.close(); rmSync(root, { recursive: true, force: true }); });
  return { worker, journal, authority };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 500; count++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('native locate stage not reached');
}

test('one admitted task navigates and selects exact file without opening', async t => {
  const { worker, journal, authority } = harness(t);
  const input = request();
  assert.equal(await authority.startLocate(input), 'verified_locate');
  assert.equal(worker.title, SELECTED);
  assert.notEqual(worker.title, OPENED);
  assert.deepEqual(worker.commits, ['documents-button', 'budget-button']);
  assert.deepEqual(worker.verifications, [DOCUMENTS, SELECTED]);
  assert.equal(worker.observeCalls, 2);
  assert.equal(journal.getTaskState(input.requestId), 'completed');
  const attempts = journal.attemptsForTask(input.requestId);
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every(attempt => attempt.outcome?.verification === 'matched'));
  assert.equal(await authority.startLocate(input), 'error');
});

test('existing folder skips navigation and selected state skips both presses', async t => {
  const { worker, journal, authority } = harness(t);
  worker.title = DOCUMENTS;
  const fromFolder = request();
  assert.equal(await authority.startLocate(fromFolder), 'verified_locate');
  assert.deepEqual(worker.commits, ['budget-button']);
  assert.equal(journal.attemptsForTask(fromFolder.requestId).length, 1);
  const already = request();
  assert.equal(await authority.startLocate(already), 'already_matched');
  assert.equal(journal.attemptsForTask(already.requestId).length, 0);
  assert.deepEqual(worker.commits, ['budget-button']);
});

test('duplicate exact file and inter-step interference cannot claim LOCATE', async t => {
  const { worker, journal, authority } = harness(t);
  worker.duplicateFile = true;
  const duplicate = request();
  assert.equal(await authority.startLocate(duplicate), 'unsupported');
  assert.deepEqual(worker.commits, ['documents-button']);
  assert.equal(journal.getTaskState(duplicate.requestId), 'cancelled');
  worker.duplicateFile = false;
  worker.title = ROOT;
  worker.interfereAfterFolder = true;
  const interference = request();
  assert.equal(await authority.startLocate(interference), 'unsupported');
  assert.deepEqual(worker.commits, ['documents-button', 'documents-button']);
  assert.equal(journal.getTaskState(interference.requestId), 'cancelled');
});

test('opened file is not mistaken for selected file', async t => {
  const { worker, authority } = harness(t);
  worker.title = OPENED;
  assert.equal(await authority.startLocate(request()), 'unsupported');
  assert.deepEqual(worker.commits, []);
});

test('Stop during first dispatch prevents a late receipt from selecting file', async t => {
  const { worker, journal, authority } = harness(t);
  worker.firstCommitGate = new Deferred();
  const input = request();
  const pending = authority.startLocate(input);
  await waitFor(() => worker.commits.length === 1);
  const stopped = await authority.stop();
  assert.equal(stopped.workerFenced, true);
  worker.firstCommitGate.resolve('returned_unverified');
  assert.equal(await pending, 'stopped');
  assert.deepEqual(worker.commits, ['documents-button']);
  assert.equal(journal.getTaskState(input.requestId), 'cancelled');
  assert.equal(authority.needsRecovery, true);
  assert.equal(await authority.startLocate(request()), 'uncertain');
});

test('Stop between verified steps sends no file press and needs no effect recovery', async t => {
  const { worker, journal, authority } = harness(t);
  worker.secondObserveGate = new Deferred();
  const input = request();
  const pending = authority.startLocate(input);
  await waitFor(() => worker.observeCalls === 2);
  const stopped = await authority.stop();
  assert.equal(stopped.workerFenced, true);
  worker.secondObserveGate.resolve();
  assert.equal(await pending, 'stopped');
  assert.deepEqual(worker.commits, ['documents-button']);
  assert.equal(journal.attemptsForTask(input.requestId)[0]?.outcome?.verification,
    'matched');
  assert.equal(journal.getTaskState(input.requestId), 'cancelled');
  assert.equal(authority.needsRecovery, false);
});

test('unknown file selection blocks automatic retry', async t => {
  const { worker, journal, authority } = harness(t);
  worker.secondCommitResult = 'unknown';
  const input = request();
  assert.equal(await authority.startLocate(input), 'uncertain');
  assert.deepEqual(worker.commits, ['documents-button', 'budget-button']);
  assert.equal(journal.attemptsForTask(input.requestId)[1]?.outcome?.effectStatus,
    'unknown');
  assert.equal(authority.needsRecovery, true);
  assert.equal(await authority.startLocate(request()), 'uncertain');
});

test('OPEN follows folder and exact selection under one task', async t => {
  const { worker, journal, authority } = harness(t);
  const input = openRequest();
  assert.equal(await authority.startOpen(input), 'verified_open');
  assert.equal(worker.title, OPENED);
  assert.deepEqual(worker.commits,
    ['documents-button', 'budget-button', 'open-button']);
  assert.deepEqual(worker.verifications, [DOCUMENTS, SELECTED, OPENED]);
  assert.equal(worker.observeCalls, 3);
  assert.equal(journal.getTaskState(input.requestId), 'completed');
  const attempts = journal.attemptsForTask(input.requestId);
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every(attempt => attempt.outcome?.verification === 'matched'));
});

test('OPEN from selected state sends one press; already opened sends none', async t => {
  const { worker, journal, authority } = harness(t);
  worker.title = SELECTED;
  const selected = openRequest();
  assert.equal(await authority.startOpen(selected), 'verified_open');
  assert.deepEqual(worker.commits, ['open-button']);
  assert.equal(journal.attemptsForTask(selected.requestId).length, 1);
  const already = openRequest();
  assert.equal(await authority.startOpen(already), 'already_matched');
  assert.equal(journal.attemptsForTask(already.requestId).length, 0);
});

test('LOCATE command cannot authorize OPEN', async t => {
  const { worker, authority } = harness(t);
  const changed = openRequest();
  changed.command.text = 'Locate synthetic fixture file Documents/Budget.xlsx';
  assert.equal(await authority.startOpen(changed), 'error');
  assert.equal(worker.observeCalls, 0);
});

test('duplicate Open control or interference after selection never dispatches Open',
  async t => {
    const { worker, journal, authority } = harness(t);
    worker.title = SELECTED;
    worker.duplicateOpen = true;
    const duplicate = openRequest();
    assert.equal(await authority.startOpen(duplicate), 'unsupported');
    assert.deepEqual(worker.commits, []);
    worker.title = DOCUMENTS;
    worker.duplicateOpen = false;
    worker.interfereAfterSelection = true;
    const changed = openRequest();
    assert.equal(await authority.startOpen(changed), 'unsupported');
    assert.deepEqual(worker.commits, ['budget-button']);
    assert.equal(journal.getTaskState(changed.requestId), 'cancelled');
  });

test('Stop between verified selection and Open sends no Open press', async t => {
  const { worker, journal, authority } = harness(t);
  worker.thirdObserveGate = new Deferred();
  const input = openRequest();
  const pending = authority.startOpen(input);
  await waitFor(() => worker.observeCalls === 3);
  const stopped = await authority.stop();
  assert.equal(stopped.workerFenced, true);
  worker.thirdObserveGate.resolve();
  assert.equal(await pending, 'stopped');
  assert.deepEqual(worker.commits, ['documents-button', 'budget-button']);
  assert.equal(journal.getTaskState(input.requestId), 'cancelled');
  assert.equal(authority.needsRecovery, false);
});

test('unknown Open effect cannot be reported as completion or retried', async t => {
  const { worker, journal, authority } = harness(t);
  worker.title = SELECTED;
  worker.thirdCommitResult = 'unknown';
  const input = openRequest();
  assert.equal(await authority.startOpen(input), 'uncertain');
  assert.deepEqual(worker.commits, ['open-button']);
  assert.equal(journal.attemptsForTask(input.requestId)[0]?.outcome?.effectStatus,
    'unknown');
  assert.equal(authority.needsRecovery, true);
  assert.equal(await authority.startOpen(openRequest()), 'uncertain');
});

test('Stop after Open dispatch cannot turn a late Open receipt into success', async t => {
  const { worker, journal, authority } = harness(t);
  worker.title = SELECTED;
  worker.thirdCommitGate = new Deferred();
  const input = openRequest();
  const pending = authority.startOpen(input);
  await waitFor(() => worker.commits.length === 1);
  const stopped = await authority.stop();
  assert.equal(stopped.workerFenced, true);
  worker.thirdCommitGate.resolve('returned_unverified');
  assert.equal(await pending, 'stopped');
  assert.equal(worker.title, OPENED, 'a dispatched Open may still take effect');
  assert.equal(worker.verifications.includes(OPENED), false);
  assert.equal(journal.getTaskState(input.requestId), 'cancelled');
  assert.equal(authority.needsRecovery, true);
});
