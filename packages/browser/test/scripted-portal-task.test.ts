import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { startPortalFixture } from '../../fixtures/portal.ts';
import { ManagedPortalSession } from '../src/managed-portal.ts';
import type { PortalObservation } from '../src/managed-portal.ts';
import type { TaskProgressLimits } from '../../runtime/src/task-progress.ts';
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
  const journal = new AttemptJournal(database);
  return { root, output, store: new ScriptedPortalStore(database, output, journal), journal };
}

function scriptedHarness(t: { after(callback: () => void): void },
  outcomeKind: 'LOCATE' | 'OPEN' = 'OPEN', limits?: TaskProgressLimits) {
  const local = privateStore();
  const origin = 'http://127.0.0.1:12345';
  const row = { id: 'INV-105', title: 'April Service Statement', account: 'Harbor Works' };
  const state = { current: { kind: 'home', revision: 1, url: origin } as PortalObservation,
    observations: 0, searches: 0, opens: 0, failOpen: false, changeReadRevision: false };
  const results: PortalObservation = { kind: 'results', revision: 2,
    url: `${origin}/invoices?q=April`, rows: [row] };
  const fake = {
    origin, stop: async () => ({ workerFenced: true }),
    observe: async () => {
      state.observations++;
      return state.changeReadRevision ? { ...state.current, revision: state.observations } : state.current;
    },
    search: async () => { state.searches++; state.current = results; return state.current; },
    openInvoice: async (): Promise<PortalObservation> => {
      state.opens++;
      if (state.failOpen) throw new Error('synthetic lost open reply');
      state.current = { kind: 'detail', revision: 3, url: `${origin}/invoices/INV-105`,
        invoiceId: row.id, title: row.title, account: row.account };
      return state.current;
    },
    downloadInvoice: async () => { throw new Error('unexpected download'); },
    verifyGoal: async () => ({ status: 'matched', revision: state.current.revision } as const),
  };
  const record = start(local.store, { taskId: 'recovery-task', origin, outcomeKind,
    invoiceId: row.id, title: row.title, account: row.account, query: 'April' });
  const task = new ScriptedPortalTask(local.store, local.journal, fake, admissions.get(record)!, record, limits);
  t.after(() => { local.journal.close(); local.store.close(); rmSync(local.root, { recursive: true, force: true }); });
  return { ...local, state, results, fake, record, task };
}

test('restart reconciles a verified intermediate checkpoint after projection-write failure without replay', async t => {
  const h = scriptedHarness(t);
  const other = new DatabaseSync(join(h.root, 'tasks.sqlite'));
  try {
    other.exec(`CREATE TRIGGER reject_progress BEFORE UPDATE OF stage ON scripted_portal_tasks
      WHEN NEW.stage != OLD.stage BEGIN SELECT RAISE(ABORT, 'synthetic projection failure'); END;`);
    assert.equal((await h.task.advance()).state, 'paused');
    assert.equal(h.store.get(h.record.taskId)?.stage, 'admitted');
    assert.equal(h.journal.getTaskProgress(h.record.taskId)?.checkpoints[0]?.stageRef, 'located');
    const counts = h.journal.getTaskProgress(h.record.taskId)!;
    other.exec('DROP TRIGGER reject_progress');
    const recovered = h.store.recoverAfterRestart()[0]!;
    assert.equal(recovered.stage, 'located');
    assert.equal(recovered.state, 'paused');
    assert.equal(recovered.inFlight, null);
    assert.equal(h.journal.getTaskState(h.record.taskId), 'paused');
    assert.equal(h.journal.getTaskProgress(h.record.taskId)?.observationsUsed, counts.observationsUsed);
    assert.equal(h.journal.getTaskProgress(h.record.taskId)?.currentObservation, null);
    assert.equal(h.state.searches, 1); assert.equal(h.state.opens, 0);
    await assert.rejects(h.task.advance(), /not active/);
  } finally { other.close(); }
});

test('restart restores already-committed terminal history after projection-write failure', async t => {
  const h = scriptedHarness(t, 'LOCATE');
  const other = new DatabaseSync(join(h.root, 'tasks.sqlite'));
  try {
    other.exec(`CREATE TRIGGER reject_progress BEFORE UPDATE OF stage ON scripted_portal_tasks
      WHEN NEW.stage != OLD.stage BEGIN SELECT RAISE(ABORT, 'synthetic projection failure'); END;`);
    assert.equal((await h.task.advance()).state, 'paused');
    assert.equal(h.journal.getTaskState(h.record.taskId), 'completed');
    other.exec('DROP TRIGGER reject_progress');
    assert.deepEqual(h.store.recoverAfterRestart(), []);
    assert.equal(h.store.get(h.record.taskId)?.state, 'completed');
    assert.equal(h.store.get(h.record.taskId)?.stage, 'located');
    assert.equal(h.store.get(h.record.taskId)?.inFlight, null);
    assert.equal(h.state.searches, 1);
    assert.equal(h.journal.getTaskProgress(h.record.taskId)?.currentObservation, null);
  } finally { other.close(); }
});

test('a matched receipt without a committed checkpoint cannot promote portal progress', async t => {
  const h = scriptedHarness(t, 'LOCATE');
  const other = new DatabaseSync(join(h.root, 'tasks.sqlite'));
  try {
    other.exec(`CREATE TRIGGER reject_checkpoint BEFORE INSERT ON task_checkpoints
      BEGIN SELECT RAISE(ABORT, 'synthetic checkpoint failure'); END;`);
    assert.equal((await h.task.advance()).state, 'paused');
    assert.equal(h.journal.attemptsForTask(h.record.taskId)[0]?.outcome?.verification, 'matched');
    assert.equal(h.journal.getTaskProgress(h.record.taskId)?.checkpoints.length, 0);
    other.exec('DROP TRIGGER reject_checkpoint');
    const recovered = h.store.recoverAfterRestart()[0]!;
    assert.equal(recovered.stage, 'admitted');
    assert.equal(recovered.inFlight, 'search');
    assert.equal(recovered.reason, 'action outcome unknown after restart');
    assert.equal(h.journal.getTaskRecord(h.record.taskId)?.completion, null);
    assert.equal(h.store.hasBlockingTask(), true);
    assert.equal(h.state.searches, 1);
  } finally { other.close(); }
});

test('a terminal checkpoint without committed completion remains paused on restart', async t => {
  const h = scriptedHarness(t, 'LOCATE');
  const other = new DatabaseSync(join(h.root, 'tasks.sqlite'));
  try {
    other.exec(`CREATE TRIGGER reject_completion BEFORE INSERT ON task_completions
      BEGIN SELECT RAISE(ABORT, 'synthetic completion failure'); END;`);
    assert.equal((await h.task.advance()).state, 'paused');
    assert.equal(h.journal.getTaskProgress(h.record.taskId)?.checkpoints[0]?.terminal, true);
    other.exec('DROP TRIGGER reject_completion');
    const recovered = h.store.recoverAfterRestart()[0]!;
    assert.equal(recovered.state, 'paused'); assert.equal(recovered.stage, 'located');
    assert.equal(recovered.inFlight, null);
    assert.equal(h.journal.getTaskRecord(h.record.taskId)?.completion, null);
    await assert.rejects(h.task.advance(), /not active/);
  } finally { other.close(); }
});

test('restart retains the last verified stage and a later unknown browser effect', async t => {
  const h = scriptedHarness(t);
  assert.equal((await h.task.advance()).stage, 'located');
  h.state.failOpen = true;
  assert.equal((await h.task.advance()).state, 'paused');
  const recovered = h.store.recoverAfterRestart()[0]!;
  assert.equal(recovered.stage, 'located'); assert.equal(recovered.inFlight, 'open');
  assert.equal(h.journal.unresolvedAttempts(h.record.taskId).length, 1);
  assert.equal(h.journal.getTaskProgress(h.record.taskId)?.checkpoints.length, 1);
  assert.equal(h.state.opens, 1);
  await assert.rejects(h.task.advance(), /not active/);
});

test('already-matched portal predicates complete without actions and recover as historical completion', async t => {
  const h = scriptedHarness(t, 'LOCATE');
  h.state.current = h.results;
  assert.equal((await h.task.advance()).state, 'completed');
  assert.equal(h.journal.attemptsForTask(h.record.taskId).length, 0);
  assert.equal(h.journal.getTaskProgress(h.record.taskId)?.checkpoints[0]?.executionId, undefined);
  assert.deepEqual(h.store.recoverAfterRestart(), []);
  assert.equal(h.store.get(h.record.taskId)?.state, 'completed');
  assert.equal(h.state.searches, 0);
});

test('changed stored portal bindings pause before I/O and block restart reconciliation', async t => {
  const h = scriptedHarness(t);
  assert.equal((await h.task.advance()).stage, 'located');
  const observations = h.state.observations;
  const other = new DatabaseSync(join(h.root, 'tasks.sqlite'));
  try {
    other.prepare('UPDATE scripted_portal_tasks SET account = ? WHERE task_id = ?')
      .run('Different account', h.record.taskId);
    assert.equal((await h.task.advance()).state, 'paused');
    assert.equal(h.state.observations, observations);
    assert.equal(h.state.opens, 0);
    assert.equal(h.store.recoverAfterRestart()[0]?.reason, 'portal contract or journal evidence requires review');
    assert.equal(h.journal.getTaskProgress(h.record.taskId)?.currentObservation, null);
  } finally { other.close(); }
});

test('staged orphan portal projection blocks restart instead of inventing journal authority', () => {
  const h = privateStore();
  const other = new DatabaseSync(join(h.root, 'tasks.sqlite'));
  try {
    other.exec(`INSERT INTO scripted_portal_tasks VALUES
      ('orphan', 'http://127.0.0.1:12345', 'LOCATE', 'INV-105', 'April Service Statement',
       'Harbor Works', 'April', NULL, 'active', 'admitted', NULL, NULL)`);
    assert.equal(h.store.recoverAfterRestart()[0]?.state, 'paused');
    assert.equal(h.journal.getTaskRecord('orphan'), undefined);
    assert.equal(h.store.hasBlockingTask(), true);
  } finally { other.close(); h.journal.close(); h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
});

test('admission-write failure removes the unsent portal projection and permits genuine retry', () => {
  const h = privateStore();
  const contract: ScriptedPortalContract = { taskId: 'failed-start', origin: 'http://127.0.0.1:12345',
    outcomeKind: 'LOCATE', invoiceId: 'INV-105', title: 'April Service Statement', account: 'Harbor Works', query: 'April' };
  const { registry, admission } = mint(contract);
  const other = new DatabaseSync(join(h.root, 'tasks.sqlite'));
  try {
    other.exec(`CREATE TRIGGER reject_admission BEFORE INSERT ON task_admissions
      BEGIN SELECT RAISE(ABORT, 'synthetic admission failure'); END;`);
    assert.throws(() => h.store.start(registry, admission, contract), /admission failure/);
    assert.equal(h.store.get(contract.taskId), undefined);
    assert.equal(h.journal.getTaskRecord(contract.taskId), undefined);
    other.exec('DROP TRIGGER reject_admission');
    assert.equal(h.store.start(registry, admission, contract).state, 'active');
    assert.equal(h.journal.getTaskRecord(contract.taskId)?.admission?.admissionId, admission.admissionId);
  } finally { other.close(); h.journal.close(); h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
});

test('browser observation quota pauses before a preflight read or action', async t => {
  const h = scriptedHarness(t, 'LOCATE', { maxObservations: 1, maxDecisions: 10, maxStateVisits: 10 });
  assert.equal((await h.task.advance()).reason, 'task observations budget exhausted');
  assert.equal(h.state.observations, 1); assert.equal(h.state.searches, 0);
  assert.equal(h.journal.getTaskState(h.record.taskId), 'paused');
  assert.equal(h.journal.getTaskProgress(h.record.taskId)?.pauseReason, 'observations');
  assert.equal(h.journal.getTaskProgress(h.record.taskId)?.currentObservation, null);
});

test('browser decision quota preserves verified progress and Stop also fences a paused journal', async t => {
  const h = scriptedHarness(t, 'OPEN', { maxObservations: 20, maxDecisions: 1, maxStateVisits: 10 });
  assert.equal((await h.task.advance()).stage, 'located');
  assert.equal((await h.task.advance()).reason, 'task decisions budget exhausted');
  assert.equal(h.state.opens, 0);
  assert.equal(h.journal.getTaskProgress(h.record.taskId)?.checkpoints[0]?.stageRef, 'located');
  assert.equal(h.journal.getTaskState(h.record.taskId), 'paused');
  const stopped = await h.task.stop();
  assert.equal(stopped.journalFenced, true);
  assert.equal(h.journal.getTaskState(h.record.taskId), 'cancelled');
});

test('changing browser document revisions cannot hide an equivalent-state visit', async t => {
  const h = scriptedHarness(t, 'LOCATE', { maxObservations: 10, maxDecisions: 10, maxStateVisits: 1 });
  h.state.changeReadRevision = true;
  assert.equal((await h.task.advance()).reason, 'task no_progress budget exhausted');
  assert.equal(h.state.observations, 2); assert.equal(h.state.searches, 0);
  assert.equal(h.journal.getTaskProgress(h.record.taskId)?.pauseReason, 'no_progress');
});

test('Stop during a predicate read fences a late matched result and creates no terminal checkpoint', async t => {
  const h = scriptedHarness(t, 'LOCATE');
  h.state.current = h.results;
  let release!: () => void;
  let reached!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { reached = resolve; });
  h.fake.verifyGoal = async () => { reached(); await waiting; return { status: 'matched', revision: 2 }; };
  const pending = h.task.advance();
  await started;
  assert.equal((await h.task.stop()).journalFenced, true);
  release();
  assert.equal((await pending).state, 'cancelled');
  assert.equal(h.journal.getTaskProgress(h.record.taskId)?.checkpoints.length, 0);
  assert.equal(h.journal.getTaskRecord(h.record.taskId)?.completion, null);
  assert.equal(h.journal.getTaskProgress(h.record.taskId)?.currentObservation, null);
});

test('a completed portal projection cannot outrun verified journal history', async t => {
  const h = scriptedHarness(t);
  await h.task.advance();
  const other = new DatabaseSync(join(h.root, 'tasks.sqlite'));
  try {
    other.prepare(`UPDATE scripted_portal_tasks SET state = 'completed', stage = 'opened'
      WHERE task_id = ?`).run(h.record.taskId);
    const recovered = h.store.recoverAfterRestart()[0]!;
    assert.equal(recovered.state, 'paused'); assert.equal(recovered.stage, 'located');
    assert.equal(recovered.reason, 'terminal checkpoint and completion disagree');
    assert.equal(h.journal.getTaskRecord(h.record.taskId)?.completion, null);
    assert.equal(h.state.opens, 0);
  } finally { other.close(); }
});

test('restart finishes a persisted Stop fence without resurrecting the portal task', async t => {
  const h = scriptedHarness(t);
  await h.task.advance();
  const other = new DatabaseSync(join(h.root, 'tasks.sqlite'));
  try {
    other.prepare(`UPDATE scripted_portal_tasks SET state = 'cancelled' WHERE task_id = ?`)
      .run(h.record.taskId);
    assert.equal(h.journal.getTaskState(h.record.taskId), 'active');
    assert.deepEqual(h.store.recoverAfterRestart(), []);
    assert.equal(h.store.get(h.record.taskId)?.state, 'cancelled');
    assert.equal(h.journal.getTaskState(h.record.taskId), 'cancelled');
    assert.equal(h.journal.getTaskProgress(h.record.taskId)?.currentObservation, null);
    assert.equal(h.state.opens, 0);
  } finally { other.close(); }
});

test('legacy unbound journal records require review instead of reconstructing admission from portal text', async t => {
  const h = scriptedHarness(t);
  const other = new DatabaseSync(join(h.root, 'tasks.sqlite'));
  try {
    other.prepare('DELETE FROM task_admissions WHERE task_id = ?').run(h.record.taskId);
    other.prepare('UPDATE tasks SET admission_digest = NULL WHERE task_id = ?').run(h.record.taskId);
    assert.equal(h.store.recoverAfterRestart()[0]?.reason, 'portal contract or journal evidence requires review');
    assert.equal(h.journal.getTaskRecord(h.record.taskId)?.admission, null);
    assert.equal(h.store.hasBlockingTask(), true);
    assert.equal(h.state.searches, 0);
  } finally { other.close(); }
});

test('multiple legacy completions can pause for review without a uniqueness failure or new task', () => {
  const h = privateStore();
  const other = new DatabaseSync(join(h.root, 'tasks.sqlite'));
  try {
    for (const taskId of ['legacy-one', 'legacy-two']) {
      other.prepare(`INSERT INTO scripted_portal_tasks VALUES
        (?, 'http://127.0.0.1:12345', 'LOCATE', 'INV-105', 'April Service Statement',
         'Harbor Works', 'April', NULL, 'completed', 'located', NULL, NULL)`).run(taskId);
    }
    assert.equal(h.store.recoverAfterRestart().length, 2);
    assert.equal(h.store.hasBlockingTask(), true);
    assert.throws(() => start(h.store, { taskId: 'next-task', origin: 'http://127.0.0.1:12345',
      outcomeKind: 'LOCATE', invoiceId: 'INV-105', title: 'April Service Statement',
      account: 'Harbor Works', query: 'April' }), /unresolved/);
  } finally { other.close(); h.journal.close(); h.store.close(); rmSync(h.root, { recursive: true, force: true }); }
});

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
    const record = local.journal.getTaskRecord('task-1')!;
    assert.equal(record.admission?.outcomeKind, 'DOWNLOAD');
    assert.equal(record.admission?.parameters.find(value => value.parameterRef === 'destinationPath')?.valueDigest,
      digest(destinationPath));
    assert.deepEqual(record.progress?.checkpoints.map(value => value.stageRef),
      ['located', 'opened', 'downloaded_temporary', 'saved']);
    assert.equal(record.progress?.decisionsUsed, 4);
    assert.equal(record.progress?.currentObservation, null);
    assert.ok(record.progress?.checkpoints.every(value => !value.current));
    assert.equal(record.completion?.completionVerifierRef, 'portal-download-v1');
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
    const recovered = new ScriptedPortalStore(join(local.root, 'tasks.sqlite'), local.output, local.journal);
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
    assert.throws(() => new ScriptedPortalStore(join(root, 'tasks.sqlite'), link, undefined!),
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
    assert.equal(local.journal.getTaskState('task-interference'), 'paused');
    assert.equal(local.journal.getTaskProgress('task-interference')?.currentObservation, null);
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
  const recoveredJournal = new AttemptJournal(database);
  const recoveredStore = new ScriptedPortalStore(database, local.output, recoveredJournal);
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
