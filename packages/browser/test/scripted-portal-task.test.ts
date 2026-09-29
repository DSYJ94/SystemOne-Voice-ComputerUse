import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startPortalFixture } from '../../fixtures/portal.ts';
import { ManagedPortalSession } from '../src/managed-portal.ts';
import type { PortalObservation } from '../src/managed-portal.ts';
import { ScriptedPortalStore, ScriptedPortalTask } from '../src/scripted-portal-task.ts';
import { AttemptJournal } from '../../runtime/src/attempt-journal.ts';
import { TaskAdmissionRegistry } from '../../runtime/src/task-authority.ts';
import type { TaskAdmission } from '../../runtime/src/task-authority.ts';
import { CommittedInputSession } from '../../runtime/src/committed-input.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { schema } from '../../protocol/src/contract.ts';
import { digest } from '../../protocol/src/json.ts';
import type { ScriptedPortalContract, ScriptedPortalRecord } from '../src/scripted-portal-task.ts';

const admissions = new WeakMap<object, TaskAdmission>();

function mint(contract: ScriptedPortalContract) {
  const revision = { taskId: contract.taskId, taskEpoch: 1, goalRevision: 1 };
  const endpoint = bindEndpoint(['command']);
  const inputSession = new CommittedInputSession(endpoint, revision);
  const messageId = `command-${contract.taskId}`;
  const input = inputSession.accept(endpoint, Buffer.from(JSON.stringify({
    ...structuredClone(schema.examples[0]), ...revision, messageId,
    utteranceId: `utterance-${contract.taskId}`, source: 'text',
    text: `Fixture ${contract.outcomeKind.toLowerCase()} ${contract.invoiceId}; `
      + `title ${contract.title}; account ${contract.account}; query ${contract.query}; `
      + `origin ${contract.origin}`,
  }))).input;
  const registry = new TaskAdmissionRegistry(revision, inputSession);
  const parameterValues: [string, string, string][] = [
    ['origin', messageId, contract.origin],
    ['invoiceId', 'fixture-config', contract.invoiceId],
    ['title', 'fixture-config', contract.title],
    ['account', 'fixture-config', contract.account],
    ['query', 'fixture-config', contract.query],
    ...(contract.destinationPath
      ? [['destinationPath', 'fixture-output', contract.destinationPath] as [string, string, string]] : []),
  ];
  const parameters = parameterValues.map(([parameterRef, sourceRef, value]) =>
    ({ parameterRef, sourceRef, valueDigest: digest(value) }));
  const admission = registry.admit(input, {
    admissionId: `admission-${contract.taskId}`, goal: input.text,
    outcomeKind: contract.outcomeKind, scopeRef: 'synthetic-portal-only',
    completionVerifierRef: `portal-${contract.outcomeKind.toLowerCase()}-v1`,
    policyRevision: 'portal-policy-1',
    approvedEffects: contract.outcomeKind === 'DOWNLOAD'
      ? ['READ', 'NAVIGATE', 'DOWNLOAD', 'LOCAL_EDIT'] : ['READ', 'NAVIGATE'],
    parameters,
  });
  return { registry, admission };
}

function start(store: ScriptedPortalStore, contract: ScriptedPortalContract): ScriptedPortalRecord {
  const { registry, admission } = mint(contract);
  const record = store.start(registry, admission, contract);
  admissions.set(record, admission);
  return record;
}

function newTask(store: ScriptedPortalStore, journal: AttemptJournal,
  session: ConstructorParameters<typeof ScriptedPortalTask>[2], record: ScriptedPortalRecord): ScriptedPortalTask {
  return new ScriptedPortalTask(store, journal, session, admissions.get(record)!, record);
}

function privateStore() {
  const root = mkdtempSync(join(tmpdir(), 'systemone-scripted-task-'));
  const output = join(root, 'output');
  mkdirSync(output);
  const database = join(root, 'tasks.sqlite');
  return { root, output, store: new ScriptedPortalStore(database, output),
    journal: new AttemptJournal(database) };
}

test('progress cannot skip, repeat, or complete at an intermediate stage', () => {
  const local = privateStore();
  const record = start(local.store, { taskId: 'task-stage-guard',
    origin: 'http://127.0.0.1:12345', outcomeKind: 'DOWNLOAD',
    invoiceId: 'INV-105', title: 'April Service Statement', account: 'Harbor Works',
    query: 'April', destinationPath: join(local.output, 'INV-105.txt') });
  try {
    assert.throws(() => local.store.begin(record.taskId, 'download'), /not ready/);
    assert.equal(local.store.verified(record.taskId, 'saved', true), false);
    local.store.begin(record.taskId, 'search');
    assert.equal(local.store.verified(record.taskId, 'located', true, 'search'), false);
    assert.equal(local.store.verified(record.taskId, 'opened', false, 'search'), false);
    assert.equal(local.store.verified(record.taskId, 'located', false, 'search'), true);
    assert.throws(() => local.store.begin(record.taskId, 'search'), /not ready/);
    assert.equal(local.store.get(record.taskId)?.stage, 'located');
    assert.equal(local.store.get(record.taskId)?.state, 'active');
  } finally {
    local.journal.close(); local.store.close();
    rmSync(local.root, { recursive: true, force: true });
  }
});

test('a LOCATE contract cannot advance to opening or downloading', () => {
  const local = privateStore();
  const record = start(local.store, { taskId: 'task-locate-stage',
    origin: 'http://127.0.0.1:12345', outcomeKind: 'LOCATE', invoiceId: 'INV-105',
    title: 'April Service Statement', account: 'Harbor Works', query: 'April' });
  try {
    local.store.begin(record.taskId, 'search');
    assert.equal(local.store.verified(record.taskId, 'located', false, 'search'), false);
    assert.equal(local.store.verified(record.taskId, 'located', true, 'search'), true);
    assert.throws(() => local.store.begin(record.taskId, 'open'), /outside/);
    assert.throws(() => local.store.begin(record.taskId, 'download'), /outside/);
  } finally {
    local.journal.close(); local.store.close();
    rmSync(local.root, { recursive: true, force: true });
  }
});

test('concurrent advancement is rejected without disturbing the first task step', async () => {
  const local = privateStore();
  const origin = 'http://127.0.0.1:12345';
  const record = start(local.store, { taskId: 'task-single-step', origin,
    outcomeKind: 'LOCATE', invoiceId: 'INV-105', title: 'April Service Statement',
    account: 'Harbor Works', query: 'April' });
  let release!: (value: PortalObservation) => void;
  const held = new Promise<PortalObservation>(resolve => { release = resolve; });
  let observations = 0;
  let searches = 0;
  const home: PortalObservation = { kind: 'home', revision: 1, url: origin };
  const fake = {
    origin, stop: async () => ({ workerFenced: true }),
    observe: async () => ++observations === 1 ? held : home,
    search: async (): Promise<PortalObservation> => {
      searches++;
      return { kind: 'results', revision: 2, url: `${origin}/invoices?q=April`, rows: [] };
    },
    openInvoice: async (): Promise<PortalObservation> => { throw new Error('unexpected open'); },
    downloadInvoice: async () => { throw new Error('unexpected download'); },
    verifyGoal: async () => ({ status: 'matched', revision: 2 } as const),
  };
  try {
    const task = newTask(local.store, local.journal, fake, record);
    const pending = task.advance();
    await assert.rejects(task.advance(), /already in progress/);
    assert.equal(observations, 1);
    release(home);
    assert.equal((await pending).state, 'completed');
    assert.equal(searches, 1);
    assert.equal(local.journal.attemptsForTask(record.taskId).length, 1);
  } finally {
    local.journal.close(); local.store.close();
    rmSync(local.root, { recursive: true, force: true });
  }
});

test('portal start rejects forged or altered admission before any task is stored', () => {
  const local = privateStore();
  const contract: ScriptedPortalContract = {
    taskId: 'task-admission-check', origin: 'http://127.0.0.1:12345',
    outcomeKind: 'LOCATE', invoiceId: 'INV-105',
    title: 'April Service Statement', account: 'Harbor Works', query: 'April',
  };
  try {
    const { registry, admission } = mint(contract);
    assert.throws(() => local.store.start(registry, { ...admission }, contract), /not issued/);
    assert.throws(() => local.store.start(registry, admission,
      { ...contract, invoiceId: 'INV-104' }), /parameter mismatch/);
    assert.throws(() => local.store.start(registry, admission,
      { ...contract, taskId: 'other-task' }), /admission mismatch/);
    assert.throws(() => local.store.start(registry, admission,
      { ...contract, outcomeKind: 'OPEN' }), /admission mismatch/);
    assert.equal(local.store.get(contract.taskId), undefined);
    const record = local.store.start(registry, admission, contract);
    assert.equal(record.state, 'active');
    assert.throws(() => local.store.claimStarted({ ...record }, admission), /not issued/);
    assert.throws(() => local.store.claimStarted(record, { ...admission }), /not issued/);
    local.store.claimStarted(record, admission);
    assert.throws(() => local.store.claimStarted(record, admission), /claimed/);
    local.store.stop(contract.taskId);
    assert.throws(() => local.store.start(registry, admission, contract), /claimed/);
  } finally {
    local.journal.close();
    local.store.close();
    rmSync(local.root, { recursive: true, force: true });
  }
});

test('changed observation during action preflight pauses without a browser dispatch', async () => {
  const local = privateStore();
  const origin = 'http://127.0.0.1:12345';
  const started = start(local.store, { taskId: 'task-preflight-change', origin,
    outcomeKind: 'LOCATE', invoiceId: 'INV-105', title: 'April Service Statement',
    account: 'Harbor Works', query: 'April' });
  let observations = 0;
  let searches = 0;
  const fake = {
    origin,
    stop: async () => ({ workerFenced: true }),
    observe: async (): Promise<PortalObservation> =>
      ({ kind: 'home', revision: ++observations, url: origin }),
    search: async (): Promise<PortalObservation> => {
      searches++;
      throw new Error('unexpected browser action');
    },
    openInvoice: async (): Promise<PortalObservation> => { throw new Error('unexpected open'); },
    downloadInvoice: async () => { throw new Error('unexpected download'); },
    verifyGoal: async () => ({ status: 'unavailable', reason: 'unused' } as const),
  };
  try {
    const task = newTask(local.store, local.journal, fake, started);
    const paused = await task.advance();
    assert.equal(paused.state, 'paused');
    assert.equal(paused.reason, 'search preflight observation changed');
    assert.equal(searches, 0);
    assert.deepEqual(local.journal.attemptsForTask(started.taskId), []);
  } finally {
    local.journal.close();
    local.store.close();
    rmSync(local.root, { recursive: true, force: true });
  }
});

test('Stop during portal preflight prevents a later browser action', async () => {
  const local = privateStore();
  const origin = 'http://127.0.0.1:12345';
  const started = start(local.store, { taskId: 'task-preflight-stop', origin,
    outcomeKind: 'LOCATE', invoiceId: 'INV-105', title: 'April Service Statement',
    account: 'Harbor Works', query: 'April' });
  let observeCount = 0;
  let preflightStarted!: () => void;
  let releasePreflight!: (value: PortalObservation) => void;
  const atPreflight = new Promise<void>(resolve => { preflightStarted = resolve; });
  const held = new Promise<PortalObservation>(resolve => { releasePreflight = resolve; });
  let searches = 0;
  const fake = {
    origin,
    stop: async () => ({ workerFenced: true }),
    observe: async (): Promise<PortalObservation> => {
      if (++observeCount === 1) return { kind: 'home', revision: 1, url: origin };
      preflightStarted();
      return held;
    },
    search: async (): Promise<PortalObservation> => {
      searches++;
      throw new Error('unexpected browser action');
    },
    openInvoice: async (): Promise<PortalObservation> => { throw new Error('unexpected open'); },
    downloadInvoice: async () => { throw new Error('unexpected download'); },
    verifyGoal: async () => ({ status: 'unavailable', reason: 'unused' } as const),
  };
  try {
    const task = newTask(local.store, local.journal, fake, started);
    const pending = task.advance();
    await atPreflight;
    const stopped = await task.stop();
    assert.equal(stopped.workerFenced, true);
    releasePreflight({ kind: 'home', revision: 1, url: origin });
    assert.equal((await pending).state, 'cancelled');
    assert.equal(searches, 0);
    assert.deepEqual(local.journal.attemptsForTask(started.taskId), []);
  } finally {
    local.journal.close();
    local.store.close();
    rmSync(local.root, { recursive: true, force: true });
  }
});

test('one task searches, opens exact duplicate, downloads, then saves to scoped output', async () => {
  const portal = await startPortalFixture();
  const local = privateStore();
  let session: ManagedPortalSession | undefined;
  const destinationPath = join(local.output, 'INV-105.txt');
  try {
    session = await ManagedPortalSession.launch(portal.url);
    const startedRecord = start(local.store, { taskId: 'task-1', origin: portal.url, outcomeKind: 'DOWNLOAD',
      invoiceId: 'INV-105', title: 'April Service Statement', account: 'Harbor Works',
      query: 'April Service Statement', destinationPath });
    const task = newTask(local.store, local.journal, session, startedRecord);
    assert.deepEqual([ (await task.advance()).stage, (await task.advance()).stage,
      (await task.advance()).stage, (await task.advance()).stage ],
    ['located', 'opened', 'downloaded_temporary', 'saved']);
    assert.equal(local.store.get('task-1')?.state, 'completed');
    assert.equal(local.journal.getTaskState('task-1'), 'completed');
    const attempts = local.journal.attemptsForTask('task-1');
    assert.deepEqual(attempts.map(item => item.candidateId),
      ['scripted-search', 'scripted-open', 'scripted-download', 'scripted-save']);
    for (const item of attempts) {
      assert.deepEqual(local.journal.eventKinds(item.executionId),
        ['prepared', 'dispatch_boundary', 'outcome']);
      assert.equal(item.outcome?.verification, 'matched');
    }
    assert.match(await readFile(destinationPath, 'utf8'), /Invoice: INV-105\nTitle: April Service Statement\nAccount: Harbor Works/);
    await assert.rejects(task.advance(), /not active/);
  } finally {
    await session?.close();
    local.journal.close();
    local.store.close();
    await portal.close();
    rmSync(local.root, { recursive: true, force: true });
  }
});

test('restart pauses an active task and never auto-replays a prior step', async () => {
  const portal = await startPortalFixture();
  const local = privateStore();
  try {
    start(local.store, { taskId: 'task-recover', origin: portal.url, outcomeKind: 'OPEN',
      invoiceId: 'INV-105', title: 'April Service Statement', account: 'Harbor Works',
      query: 'April' });
    local.store.begin('task-recover', 'search');
    local.store.close();
    const recovered = new ScriptedPortalStore(join(local.root, 'tasks.sqlite'), local.output);
    try {
      const paused = recovered.recoverAfterRestart();
      assert.equal(paused.length, 1);
      assert.equal(paused[0]?.state, 'paused');
      assert.equal(paused[0]?.reason, 'action outcome unknown after restart');
      assert.equal(paused[0]?.inFlight, 'search');
      assert.throws(() => start(recovered, { taskId: 'second', origin: portal.url,
        outcomeKind: 'LOCATE', invoiceId: 'INV-104', title: 'April Service Statement',
        account: 'Northstar Studio', query: 'April' }));
    } finally { recovered.close(); }
  } finally {
    local.journal.close();
    await portal.close();
    rmSync(local.root, { recursive: true, force: true });
  }
});

test('download output cannot escape its private fixture directory', async () => {
  const portal = await startPortalFixture();
  const local = privateStore();
  try {
    assert.throws(() => start(local.store, { taskId: 'task-escape', origin: portal.url,
      outcomeKind: 'DOWNLOAD', invoiceId: 'INV-105',
      title: 'April Service Statement', account: 'Harbor Works', query: 'April',
      destinationPath: join(local.root, 'INV-105.txt') }), /outside the private fixture/);
    assert.equal(local.store.get('task-escape'), undefined);
  } finally {
    local.journal.close();
    local.store.close();
    await portal.close();
    rmSync(local.root, { recursive: true, force: true });
  }
});

test('fixture output root refuses a symlink to another directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'systemone-output-link-'));
  const output = join(root, 'output');
  mkdirSync(output, { mode: 0o700 });
  const link = join(root, 'redirected-output');
  symlinkSync(output, link, 'dir');
  try {
    assert.throws(() => new ScriptedPortalStore(join(root, 'tasks.sqlite'), link),
      /fixture output directory is unsafe/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('manual navigation after verified search pauses instead of fighting the user', async () => {
  const portal = await startPortalFixture();
  const local = privateStore();
  let session: ManagedPortalSession | undefined;
  try {
    session = await ManagedPortalSession.launch(portal.url);
    const startedRecord = start(local.store, { taskId: 'task-interference', origin: portal.url,
      outcomeKind: 'OPEN', invoiceId: 'INV-105', title: 'April Service Statement',
      account: 'Harbor Works', query: 'April' });
    const task = newTask(local.store, local.journal, session, startedRecord);
    assert.equal((await task.advance()).stage, 'located');
    await session.search('May');
    const paused = await task.advance();
    assert.equal(paused.state, 'paused');
    assert.equal(paused.reason, 'verified result is no longer current');
    assert.equal((await session.observe()).kind, 'results');
  } finally {
    await session?.close();
    local.journal.close();
    local.store.close();
    await portal.close();
    rmSync(local.root, { recursive: true, force: true });
  }
});

test('Stop during an unresolved browser action cannot become task completion', async () => {
  const portal = await startPortalFixture();
  const local = privateStore();
  let releaseSearch!: (observation: PortalObservation) => void;
  let searchStarted!: () => void;
  const searchPending = new Promise<PortalObservation>(resolve => { releaseSearch = resolve; });
  const started = new Promise<void>(resolve => { searchStarted = resolve; });
  try {
    const startedRecord = start(local.store, { taskId: 'task-stop', origin: portal.url, outcomeKind: 'LOCATE',
      invoiceId: 'INV-105', title: 'April Service Statement', account: 'Harbor Works',
      query: 'April' });
    const fake = {
      origin: portal.url,
      stop: async () => ({ workerFenced: false }),
      observe: async (): Promise<PortalObservation> =>
        ({ kind: 'home', revision: 1, url: portal.url }),
      search: async (): Promise<PortalObservation> => { searchStarted(); return searchPending; },
      openInvoice: async (): Promise<PortalObservation> => { throw new Error('unexpected open'); },
      downloadInvoice: async () => { throw new Error('unexpected download'); },
      verifyGoal: async () => ({ status: 'matched', revision: 2 } as const),
    };
    const task = newTask(local.store, local.journal, fake, startedRecord);
    const pending = task.advance();
    await started;
    const stopped = await task.stop();
    assert.equal(stopped.record.reason, 'stopped with unresolved action');
    assert.equal(stopped.workerFenced, false);
    assert.equal(stopped.journalFenced, true);
    assert.equal(stopped.unresolvedExecutionIds.length, 1);
    assert.throws(() => start(local.store, { taskId: 'task-after-unknown',
      origin: portal.url, outcomeKind: 'LOCATE', invoiceId: 'INV-104',
      title: 'April Service Statement', account: 'Northstar Studio', query: 'April' }),
    /unresolved action/);
    releaseSearch({ kind: 'results', revision: 2, url: `${portal.url}/invoices`,
      rows: [{ id: 'INV-105', title: 'April Service Statement', account: 'Harbor Works' }] });
    assert.equal((await pending).state, 'cancelled');
    assert.equal(local.store.get('task-stop')?.stage, 'admitted');
    assert.equal(local.journal.getTaskState('task-stop'), 'cancelled');
    assert.equal(local.journal.attemptsForTask('task-stop').length, 1);
  } finally {
    local.journal.close();
    local.store.close();
    await portal.close();
    rmSync(local.root, { recursive: true, force: true });
  }
});

test('a stopped task with no in-flight action permits a fresh task', () => {
  const local = privateStore();
  const contract = { origin: 'http://127.0.0.1:12345', outcomeKind: 'LOCATE' as const,
    invoiceId: 'INV-105', title: 'April Service Statement',
    account: 'Harbor Works', query: 'April' };
  try {
    start(local.store, { ...contract, taskId: 'settled-task' });
    assert.equal(local.store.stop('settled-task').inFlight, null);
    assert.equal(start(local.store, { ...contract, taskId: 'next-task' }).state, 'active');
  } finally {
    local.journal.close();
    local.store.close();
    rmSync(local.root, { recursive: true, force: true });
  }
});

test('Stop closes the managed context during a delayed download control', async () => {
  const portal = await startPortalFixture({ downloadDelayMs: 5_000 });
  const local = privateStore();
  let session: ManagedPortalSession | undefined;
  const destinationPath = join(local.output, 'INV-105.txt');
  try {
    session = await ManagedPortalSession.launch(portal.url);
    const startedRecord = start(local.store, { taskId: 'task-worker-stop', origin: portal.url,
      outcomeKind: 'DOWNLOAD', invoiceId: 'INV-105',
      title: 'April Service Statement', account: 'Harbor Works',
      query: 'April', destinationPath });
    const task = newTask(local.store, local.journal, session, startedRecord);
    assert.equal((await task.advance()).stage, 'located');
    assert.equal((await task.advance()).stage, 'opened');
    const pending = task.advance();
    await delay(100);
    const stopped = await task.stop();
    assert.equal(stopped.workerFenced, true);
    assert.equal(stopped.journalFenced, true);
    assert.equal(stopped.unresolvedExecutionIds.length, 1);
    assert.equal(stopped.record.reason, 'stopped with unresolved action');
    assert.equal((await pending).state, 'cancelled');
    assert.equal(local.journal.getTaskState('task-worker-stop'), 'cancelled');
    assert.deepEqual(local.journal.unresolvedAttempts('task-worker-stop')
      .map(item => item.executionId), stopped.unresolvedExecutionIds);
    assert.equal(portal.requestCount('/downloads/INV-105'), 0);
    await assert.rejects(task.advance(), /not active/);
    await assert.rejects(readFile(destinationPath), /ENOENT/);
  } finally {
    await session?.close();
    local.journal.close();
    local.store.close();
    await portal.close();
    rmSync(local.root, { recursive: true, force: true });
  }
});

test('Stop during save verification prevents a later file write', async () => {
  const local = privateStore();
  const origin = 'http://127.0.0.1:12345';
  const destinationPath = join(local.output, 'INV-105.txt');
  const receiptPath = join(local.root, 'receipt.txt');
  const bytes = Buffer.from('SYNTHETIC FIXTURE\nInvoice: INV-105\n');
  await writeFile(receiptPath, bytes);
  const receipt = { invoiceId: 'INV-105', filename: 'INV-105.txt', path: receiptPath,
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  const results: PortalObservation = { kind: 'results', revision: 2,
    url: `${origin}/invoices?q=April`, rows: [{ id: 'INV-105',
      title: 'April Service Statement', account: 'Harbor Works' }] };
  const detail: PortalObservation = { kind: 'detail', revision: 3,
    url: `${origin}/invoices/INV-105`, invoiceId: 'INV-105',
    title: 'April Service Statement', account: 'Harbor Works' };
  let current: PortalObservation = { kind: 'home', revision: 1, url: origin };
  let downloadChecks = 0;
  let releaseSave!: () => void;
  let saving!: () => void;
  const held = new Promise<void>(resolve => { releaseSave = resolve; });
  const saveStarted = new Promise<void>(resolve => { saving = resolve; });
  const fake = {
    origin,
    stop: async () => ({ workerFenced: true }),
    observe: async () => current,
    search: async () => { current = results; return current; },
    openInvoice: async () => { current = detail; return current; },
    downloadInvoice: async () => receipt,
    verifyGoal: async (goal: { kind: string }) => {
      if (goal.kind === 'DOWNLOAD' && ++downloadChecks === 2) {
        saving();
        await held;
      }
      return { status: 'matched', revision: current.revision } as const;
    },
  };
  try {
    const startedRecord = start(local.store, { taskId: 'task-save-stop', origin,
      outcomeKind: 'DOWNLOAD', invoiceId: 'INV-105',
      title: 'April Service Statement', account: 'Harbor Works',
      query: 'April', destinationPath });
    const task = newTask(local.store, local.journal, fake, startedRecord);
    assert.equal((await task.advance()).stage, 'located');
    assert.equal((await task.advance()).stage, 'opened');
    assert.equal((await task.advance()).stage, 'downloaded_temporary');
    const pending = task.advance();
    await saveStarted;
    const stopped = await task.stop();
    assert.equal(stopped.record.state, 'cancelled');
    assert.equal(stopped.browserFenced, true);
    assert.equal(stopped.localSaveFenced, false);
    assert.equal(stopped.workerFenced, false);
    releaseSave();
    assert.equal((await pending).state, 'cancelled');
    await assert.rejects(readFile(destinationPath), /ENOENT/);
    assert.equal(local.journal.unresolvedAttempts('task-save-stop').length, 1);
  } finally {
    local.journal.close();
    local.store.close();
    rmSync(local.root, { recursive: true, force: true });
  }
});

test('restart preserves a journaled browser boundary and pauses the task', async () => {
  const local = privateStore();
  const origin = 'http://127.0.0.1:12345';
  let releaseSearch!: (value: PortalObservation) => void;
  let searchStarted!: () => void;
  const waiting = new Promise<PortalObservation>(resolve => { releaseSearch = resolve; });
  const started = new Promise<void>(resolve => { searchStarted = resolve; });
  const fake = {
    origin,
    stop: async () => ({ workerFenced: false }),
    observe: async (): Promise<PortalObservation> =>
      ({ kind: 'home', revision: 1, url: origin }),
    search: async () => { searchStarted(); return waiting; },
    openInvoice: async () => { throw new Error('unexpected open'); },
    downloadInvoice: async () => { throw new Error('unexpected download'); },
    verifyGoal: async () => ({ status: 'matched', revision: 2 } as const),
  };
  const startedRecord = start(local.store, { taskId: 'task-crash-boundary', origin,
    outcomeKind: 'LOCATE', invoiceId: 'INV-105',
    title: 'April Service Statement', account: 'Harbor Works', query: 'April' });
  const task = newTask(local.store, local.journal, fake, startedRecord);
  const pending = task.advance();
  await started;
  const executionId = local.journal.attemptsForTask('task-crash-boundary')[0]!.executionId;
  assert.equal(local.journal.getAttempt(executionId)?.phase, 'at_dispatch_boundary');
  local.journal.close();
  local.store.close();
  const database = join(local.root, 'tasks.sqlite');
  const recoveredStore = new ScriptedPortalStore(database, local.output);
  const recoveredJournal = new AttemptJournal(database);
  try {
    assert.equal(recoveredStore.recoverAfterRestart()[0]?.state, 'paused');
    assert.deepEqual(recoveredJournal.recoverAfterRestart()
      .map(item => item.executionId), [executionId]);
    assert.throws(() => recoveredJournal.startTask('next-task', 1, 1), /unresolved/);
    assert.throws(() => start(recoveredStore, { taskId: 'next-task', origin,
      outcomeKind: 'LOCATE', invoiceId: 'INV-104',
      title: 'April Service Statement', account: 'Northstar Studio', query: 'April' }),
    /unresolved action/);
    releaseSearch({ kind: 'results', revision: 2, url: `${origin}/invoices`,
      rows: [{ id: 'INV-105', title: 'April Service Statement', account: 'Harbor Works' }] });
    await assert.rejects(pending);
    assert.equal(recoveredStore.get('task-crash-boundary')?.state, 'paused');
    assert.equal(recoveredJournal.getTaskState('task-crash-boundary'), 'paused');
  } finally {
    recoveredJournal.close();
    recoveredStore.close();
    rmSync(local.root, { recursive: true, force: true });
  }
});
