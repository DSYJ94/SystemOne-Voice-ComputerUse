import { createHash, randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { digest } from '../../protocol/src/json.ts';
import { AttemptJournal } from '../../runtime/src/attempt-journal.ts';
import type { PreparedAttempt } from '../../runtime/src/attempt-journal.ts';
import { TaskAdmissionRegistry } from '../../runtime/src/task-authority.ts';
import type { TaskAdmission, Effect } from '../../runtime/src/task-authority.ts';
import type { PortalDownload, PortalGoal, PortalGoalResult, PortalObservation } from './managed-portal.ts';

type GoalKind = PortalGoal['kind'];
type Stage = 'admitted' | 'located' | 'opened' | 'downloaded_temporary' | 'saved';
type State = 'active' | 'paused' | 'completed' | 'cancelled';
type Action = 'search' | 'open' | 'download' | 'save';
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const INVOICE_ID = /^INV-\d{3}$/;

export interface ScriptedPortalContract {
  readonly taskId: string;
  readonly origin: string;
  readonly outcomeKind: GoalKind;
  readonly invoiceId: string;
  readonly title: string;
  readonly account: string;
  readonly query: string;
  /** Explicit fixture output path inside the store's private output root.
   * This is not a production file-grant or user approval record. */
  readonly destinationPath?: string;
}

export interface ScriptedPortalRecord extends ScriptedPortalContract {
  readonly state: State;
  readonly stage: Stage;
  readonly inFlight: Action | null;
  readonly reason: string | null;
}

interface PortalSession {
  readonly origin: string;
  stop(): Promise<{ workerFenced: boolean }>;
  observe(): Promise<PortalObservation>;
  search(query: string): Promise<PortalObservation>;
  openInvoice(id: string, revision: number): Promise<PortalObservation>;
  downloadInvoice(id: string, revision: number): Promise<PortalDownload>;
  verifyGoal(goal: PortalGoal, revision: number, receipt?: PortalDownload): Promise<PortalGoalResult>;
}

/** Fixture-only durable progress. Active tasks pause on host restart; an
 * in-flight action becomes unknown and is never silently replayed. This store
 * is not the production permit journal or a general task admission service. */
export class ScriptedPortalStore {
  readonly #db: DatabaseSync;
  readonly #outputRoot: string;
  readonly #issued = new WeakSet<object>();
  readonly #claimed = new WeakSet<object>();
  readonly #admissions = new WeakMap<object, TaskAdmission>();

  constructor(path: string, fixtureOutputRoot: string) {
    this.#outputRoot = realpathSync(fixtureOutputRoot);
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS scripted_portal_tasks (
        task_id TEXT PRIMARY KEY, origin TEXT NOT NULL,
        outcome_kind TEXT NOT NULL, invoice_id TEXT NOT NULL,
        title TEXT NOT NULL, account TEXT NOT NULL, query TEXT NOT NULL,
        destination_path TEXT, state TEXT NOT NULL, stage TEXT NOT NULL,
        in_flight TEXT, reason TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_unresolved_scripted_portal_task
      ON scripted_portal_tasks ((1))
      WHERE state IN ('active', 'paused') OR in_flight IS NOT NULL;`);
  }

  close(): void { this.#db.close(); }

  start(registry: TaskAdmissionRegistry, admission: TaskAdmission,
    contract: ScriptedPortalContract): ScriptedPortalRecord {
    validateContract(contract);
    this.#assertOutputScope(contract);
    assertAdmission(admission, contract);
    if (this.#db.prepare(`SELECT 1 FROM scripted_portal_tasks
      WHERE state IN ('active', 'paused') OR in_flight IS NOT NULL`).get()) {
      throw new Error('earlier scripted task is active or has an unresolved action');
    }
    registry.claimForTask(admission);
    this.#db.prepare(`INSERT INTO scripted_portal_tasks VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, 'active', 'admitted', NULL, NULL)`)
      .run(contract.taskId, contract.origin, contract.outcomeKind,
        contract.invoiceId, contract.title, contract.account, contract.query,
        contract.destinationPath ?? null);
    const record = this.get(contract.taskId)!;
    this.#issued.add(record);
    this.#admissions.set(record, admission);
    return record;
  }

  claimStarted(record: ScriptedPortalRecord, admission: TaskAdmission): void {
    if (!this.#issued.has(record) || this.#claimed.has(record)
      || this.#admissions.get(record) !== admission
      || this.get(record.taskId)?.state !== 'active') {
      throw new Error('scripted task start was not issued here or was claimed');
    }
    this.#claimed.add(record);
  }

  get(taskId: string): ScriptedPortalRecord | undefined {
    if (!ID.test(taskId)) throw new Error('invalid task ID');
    const row = this.#db.prepare('SELECT * FROM scripted_portal_tasks WHERE task_id = ?')
      .get(taskId) as Record<string, string | null> | undefined;
    if (!row) return undefined;
    const record: ScriptedPortalRecord = {
      taskId: row.task_id!, origin: row.origin!, outcomeKind: row.outcome_kind as GoalKind,
      invoiceId: row.invoice_id!, title: row.title!, account: row.account!, query: row.query!,
      ...(row.destination_path ? { destinationPath: row.destination_path } : {}),
      state: row.state as State, stage: row.stage as Stage,
      inFlight: (row.in_flight ?? null) as Action | null, reason: row.reason ?? null,
    };
    validateContract(record);
    this.#assertOutputScope(record);
    if (!['active', 'paused', 'completed', 'cancelled'].includes(record.state)
      || !['admitted', 'located', 'opened', 'downloaded_temporary', 'saved'].includes(record.stage)
      || (record.inFlight !== null && !['search', 'open', 'download', 'save'].includes(record.inFlight))) {
      throw new Error('invalid stored scripted task state');
    }
    return Object.freeze(record);
  }

  begin(taskId: string, action: Action): void {
    if (!['search', 'open', 'download', 'save'].includes(action)) throw new Error('invalid action');
    const result = this.#db.prepare(`UPDATE scripted_portal_tasks SET in_flight = ?
      WHERE task_id = ? AND state = 'active' AND in_flight IS NULL`).run(action, taskId);
    if (result.changes !== 1) throw new Error('task is not ready for an action');
  }

  verified(taskId: string, stage: Stage, completed: boolean, action?: Action): boolean {
    const result = this.#db.prepare(`UPDATE scripted_portal_tasks
      SET stage = ?, state = ?, in_flight = NULL, reason = NULL
      WHERE task_id = ? AND state = 'active' AND in_flight IS ?`)
      .run(stage, completed ? 'completed' : 'active', taskId, action ?? null);
    return result.changes === 1;
  }

  pause(taskId: string, reason: string): ScriptedPortalRecord {
    this.#db.prepare(`UPDATE scripted_portal_tasks SET state = 'paused', reason = ?
      WHERE task_id = ? AND state = 'active'`).run(reason, taskId);
    return this.get(taskId)!;
  }

  stop(taskId: string): ScriptedPortalRecord {
    this.#db.prepare(`UPDATE scripted_portal_tasks SET state = 'cancelled',
      reason = CASE WHEN in_flight IS NULL THEN 'stopped' ELSE 'stopped with unresolved action' END
      WHERE task_id = ? AND state IN ('active', 'paused')`).run(taskId);
    return this.get(taskId)!;
  }

  /** New owner must call this before opening a worker. No automatic resume. */
  recoverAfterRestart(): readonly ScriptedPortalRecord[] {
    this.#db.prepare(`UPDATE scripted_portal_tasks SET state = 'paused',
      reason = CASE WHEN in_flight IS NULL THEN 'fresh observation required after restart'
      ELSE 'action outcome unknown after restart' END WHERE state = 'active'`).run();
    const rows = this.#db.prepare(`SELECT task_id FROM scripted_portal_tasks
      WHERE state = 'paused'`).all() as { task_id: string }[];
    return Object.freeze(rows.map(row => this.get(row.task_id)!));
  }

  #assertOutputScope(contract: ScriptedPortalContract): void {
    if (contract.outcomeKind === 'DOWNLOAD'
      && (!contract.destinationPath
        || realpathSync(dirname(contract.destinationPath)) !== this.#outputRoot
        || basename(contract.destinationPath) !== `${contract.invoiceId}.txt`)) {
      throw new Error('download destination is outside the private fixture output directory');
    }
  }
}

/** One observe -> one action -> verify step per call. Only the synthetic portal
 * and an explicitly named output file are supported. A Playwright wait is not a
 * qualified Stop barrier; Stop records uncertainty and never reports undo. */
export class ScriptedPortalTask {
  readonly #store: ScriptedPortalStore;
  readonly #journal: AttemptJournal;
  readonly #session: PortalSession;
  readonly #taskId: string;
  readonly #admission: TaskAdmission;
  #receipt: PortalDownload | undefined;
  #localSaveActive = false;

  constructor(store: ScriptedPortalStore, journal: AttemptJournal,
    session: PortalSession, admission: TaskAdmission, started: ScriptedPortalRecord) {
    this.#store = store;
    this.#journal = journal;
    this.#session = session;
    this.#taskId = admission.taskId;
    this.#admission = admission;
    assertAdmission(admission, started);
    const task = store.get(admission.taskId);
    if (!task || task.origin !== session.origin || task.state !== 'active') {
      throw new Error('scripted task origin or state mismatch');
    }
    store.claimStarted(started, admission);
    try { journal.startTask(admission.taskId, admission.taskEpoch, admission.goalRevision); }
    catch (error) {
      store.pause(admission.taskId, 'journal admission failed');
      throw error;
    }
  }

  async stop(): Promise<{ record: ScriptedPortalRecord; journalFenced: boolean;
    workerFenced: boolean; browserFenced: boolean; localSaveFenced: boolean;
    unresolvedExecutionIds: readonly string[] }> {
    // Persist cancellation before waiting for Playwright to close. A successful
    // worker fence never changes an in-flight action into "not dispatched".
    const record = this.#store.stop(this.#taskId);
    let journalFenced = false;
    let unresolvedExecutionIds: readonly string[] = [];
    try {
      unresolvedExecutionIds = this.#journal.cancelTask(this.#taskId)
        .map(attempt => attempt.executionId);
      journalFenced = true;
    } catch {
      unresolvedExecutionIds = this.#journal.unresolvedAttempts(this.#taskId)
        .map(attempt => attempt.executionId);
    }
    let browserFenced = false;
    try { browserFenced = (await this.#session.stop()).workerFenced; }
    catch { /* The task remains cancelled; worker outcome stays unknown. */ }
    // A browser close cannot fence an independent local file operation that
    // already crossed its dispatch boundary. Report an incomplete barrier.
    const localSaveFenced = !this.#localSaveActive;
    return Object.freeze({ record, journalFenced,
      workerFenced: browserFenced && localSaveFenced, browserFenced, localSaveFenced,
      unresolvedExecutionIds: Object.freeze(unresolvedExecutionIds) });
  }

  async advance(): Promise<ScriptedPortalRecord> {
    const task = this.#store.get(this.#taskId)!;
    if (task.state !== 'active' || task.inFlight !== null) {
      throw new Error('scripted task is not active and settled');
    }
    let observed: PortalObservation;
    try { observed = await this.#session.observe(); }
    catch { return this.#store.pause(task.taskId, 'current observation unavailable'); }
    if (this.#store.get(task.taskId)?.state !== 'active') return this.#store.get(task.taskId)!;
    if ((task.stage === 'opened' || task.stage === 'downloaded_temporary')
      && (observed.kind !== 'detail' || observed.invoiceId !== task.invoiceId
        || observed.title !== task.title || observed.account !== task.account)) {
      return this.#store.pause(task.taskId, 'verified detail is no longer current');
    }
    const exact = observed.kind === 'results'
      && observed.rows.some(row => row.id === task.invoiceId
        && row.title === task.title && row.account === task.account);
    const detail = observed.kind === 'detail' && observed.invoiceId === task.invoiceId
      && observed.title === task.title && observed.account === task.account;
    if (task.stage === 'located' && !exact && !detail) {
      return this.#store.pause(task.taskId, 'verified result is no longer current');
    }
    if (task.stage === 'downloaded_temporary') {
      if (!detail || !this.#receipt) {
        return this.#store.pause(task.taskId, 'temporary download evidence is unavailable');
      }
      this.#localSaveActive = true;
      try {
        return await this.#action(task, 'save', 'saved', true, async () => {
          const goal = goalFor(task, 'DOWNLOAD');
          const verified = await this.#session.verifyGoal(goal, observed.revision, this.#receipt);
          if (verified.status !== 'matched') throw new Error('temporary download changed');
          this.#assertTaskActive(task.taskId);
          const bytes = await readFile(this.#receipt!.path);
          this.#assertTaskActive(task.taskId);
          const output = await open(task.destinationPath!, 'wx', 0o600);
          try {
            this.#assertTaskActive(task.taskId);
            await output.writeFile(bytes);
          }
          finally { await output.close(); }
          this.#assertTaskActive(task.taskId);
          const saved = await readFile(task.destinationPath!);
          this.#assertTaskActive(task.taskId);
          if (createHash('sha256').update(saved).digest('hex') !== this.#receipt!.sha256) {
            throw new Error('saved document changed');
          }
          return `saved-${this.#receipt!.sha256}`;
        }, observed);
      }
      finally { this.#localSaveActive = false; }
    }
    if (detail) {
      const verified = await this.#session.verifyGoal(goalFor(task, 'OPEN'), observed.revision);
      if (verified.status !== 'matched') return this.#store.pause(task.taskId, 'exact detail unavailable');
      if (task.outcomeKind === 'OPEN') {
        this.#completeWithoutAction(task, 'opened', `portal-open-${observed.revision}`);
        return this.#store.get(task.taskId)!;
      }
      if (task.outcomeKind === 'LOCATE') return this.#store.pause(task.taskId, 'locate evidence is no longer current');
      return this.#action(task, 'download', 'downloaded_temporary', false, async () => {
        this.#receipt = await this.#session.downloadInvoice(task.invoiceId, observed.revision);
        const outcome = await this.#session.verifyGoal(goalFor(task, 'DOWNLOAD'),
          observed.revision, this.#receipt);
        if (outcome.status !== 'matched') throw new Error('download was not verified');
        return `portal-download-${outcome.revision}`;
      }, observed);
    }
    if (exact && observed.kind === 'results') {
      const verified = await this.#session.verifyGoal(goalFor(task, 'LOCATE'), observed.revision);
      if (verified.status !== 'matched') return this.#store.pause(task.taskId, 'exact result unavailable');
      if (task.outcomeKind === 'LOCATE') {
        this.#completeWithoutAction(task, 'located', `portal-locate-${observed.revision}`);
        return this.#store.get(task.taskId)!;
      }
      return this.#action(task, 'open', 'opened', task.outcomeKind === 'OPEN', async () => {
        const after = await this.#session.openInvoice(task.invoiceId, observed.revision);
        const outcome = await this.#session.verifyGoal(goalFor(task, 'OPEN'), after.revision);
        if (outcome.status !== 'matched') throw new Error('opened detail was not verified');
        return `portal-open-${outcome.revision}`;
      }, observed);
    }
    if (observed.kind === 'detail') {
      return this.#store.pause(task.taskId, 'a different invoice is open');
    }
    return this.#action(task, 'search', 'located', task.outcomeKind === 'LOCATE', async () => {
      const after = await this.#session.search(task.query);
      const outcome = await this.#session.verifyGoal(goalFor(task, 'LOCATE'), after.revision);
      if (outcome.status !== 'matched') throw new Error('exact invoice was not found');
      return `portal-locate-${outcome.revision}`;
    }, observed);
  }

  async #action(task: ScriptedPortalRecord, action: Action, stage: Stage,
    completed: boolean, body: () => Promise<string>,
    observed: PortalObservation): Promise<ScriptedPortalRecord> {
    const attempt = this.#attempt(task, action, observed);
    try { this.#journal.prepare(attempt); }
    catch { return this.#store.pause(task.taskId, `${action} journal preparation failed`); }
    try {
      this.#store.begin(task.taskId, action);
      // No await between the durable marker and the browser call. The marker
      // means an effect is possible, including during Playwright auto-waiting.
      this.#journal.markDispatchBoundary(attempt.executionId);
    } catch {
      if (this.#journal.getAttempt(attempt.executionId)?.phase === 'prepared') {
        this.#journal.recordNotDispatched(attempt.executionId);
      }
      return this.#store.pause(task.taskId, `${action} was not dispatched`);
    }
    let evidenceRef: string;
    try { evidenceRef = await body(); }
    catch {
      this.#recordUnknown(attempt.executionId);
      return this.#store.pause(task.taskId, `${action} outcome uncertain; re-observe before any retry`);
    }
    try {
      this.#journal.recordOutcome(attempt.executionId, {
        deliveryStatus: 'dispatched', effectStatus: 'applied',
        verification: 'matched', evidenceRef,
      });
      if (this.#journal.getTaskState(task.taskId) === 'active'
        && this.#store.get(task.taskId)?.state === 'active') {
        if (completed) this.#journal.completeTask(task.taskId, evidenceRef);
        this.#store.verified(task.taskId, stage, completed, action);
      }
    } catch {
      return this.#store.pause(task.taskId, `${action} journal outcome uncertain`);
    }
    return this.#store.get(task.taskId)!;
  }

  #completeWithoutAction(task: ScriptedPortalRecord, stage: Stage, evidenceRef: string): void {
    try {
      this.#assertTaskActive(task.taskId);
      this.#journal.completeTask(task.taskId, evidenceRef);
      this.#store.verified(task.taskId, stage, true);
    } catch {
      this.#store.pause(task.taskId, 'terminal verification could not be recorded');
    }
  }

  #attempt(task: ScriptedPortalRecord, action: Action,
    observed: PortalObservation): PreparedAttempt {
    const observationRecord = observed.kind === 'results'
      ? { kind: observed.kind, revision: observed.revision, url: observed.url,
          rows: observed.rows.map(row => ({ id: row.id, title: row.title,
            account: row.account })) }
      : observed.kind === 'detail'
        ? { kind: observed.kind, revision: observed.revision, url: observed.url,
            invoiceId: observed.invoiceId, title: observed.title,
            account: observed.account }
        : { kind: observed.kind, revision: observed.revision, url: observed.url };
    const actionRecord = { action, taskId: task.taskId, origin: task.origin,
      invoiceId: task.invoiceId, query: task.query,
      destinationPath: task.destinationPath ?? null, observation: observationRecord };
    return Object.freeze({ executionId: randomUUID(), permitRef: randomUUID(),
      taskId: task.taskId, taskEpoch: this.#admission.taskEpoch,
      goalRevision: this.#admission.goalRevision,
      scopeRef: this.#admission.scopeRef,
      observationId: `portal-${digest(observationRecord).slice(0, 32)}`,
      candidateId: `scripted-${action}`,
      candidateSetDigest: digest([actionRecord]),
      actionDigest: digest(actionRecord), policyRevision: this.#admission.policyRevision,
      leaseGeneration: 1 });
  }

  #recordUnknown(executionId: string): void {
    try { this.#journal.recordOutcome(executionId, {
      deliveryStatus: 'unknown', effectStatus: 'unknown', verification: 'unavailable',
    }); } catch { /* Keep the durable dispatch boundary unresolved. */ }
  }

  #assertTaskActive(taskId: string): void {
    if (this.#store.get(taskId)?.state !== 'active'
      || this.#journal.getTaskState(taskId) !== 'active') {
      throw new Error('task was stopped before the next file operation');
    }
  }
}

function goalFor(task: ScriptedPortalRecord, kind: GoalKind): PortalGoal {
  return { kind, invoiceId: task.invoiceId, title: task.title, account: task.account };
}

/** Fixture contract binding only. It checks the host's stated parameter
 * digests; it does not prove that values were correctly extracted from speech. */
function assertAdmission(admission: TaskAdmission, contract: ScriptedPortalContract): void {
  const effects: readonly Effect[] = contract.outcomeKind === 'DOWNLOAD'
    ? ['READ', 'NAVIGATE', 'DOWNLOAD', 'LOCAL_EDIT'] : ['READ', 'NAVIGATE'];
  const expected = new Map<string, [string, string]>([
    ['origin', ['fixture-config', contract.origin]],
    ['invoiceId', [admission.commandMessageId, contract.invoiceId]],
    ['title', [admission.commandMessageId, contract.title]],
    ['account', [admission.commandMessageId, contract.account]],
    ['query', [admission.commandMessageId, contract.query]],
  ]);
  if (contract.destinationPath) {
    expected.set('destinationPath', ['fixture-output', contract.destinationPath]);
  }
  if (admission.taskId !== contract.taskId || admission.outcomeKind !== contract.outcomeKind
    || admission.scopeRef !== 'synthetic-portal-only'
    || admission.policyRevision !== 'portal-policy-1'
    || admission.completionVerifierRef !== `portal-${contract.outcomeKind.toLowerCase()}-v1`
    || admission.approvedEffects.length !== effects.length
    || effects.some((effect, index) => admission.approvedEffects[index] !== effect)
    || admission.parameters.length !== expected.size) {
    throw new Error('scripted portal admission mismatch');
  }
  for (const parameter of admission.parameters) {
    const value = expected.get(parameter.parameterRef);
    if (!value || parameter.sourceRef !== value[0] || parameter.valueDigest !== digest(value[1])) {
      throw new Error('scripted portal parameter mismatch');
    }
  }
}

function validateContract(value: ScriptedPortalContract): void {
  let origin: URL;
  try { origin = new URL(value.origin); }
  catch { throw new Error('invalid scripted portal origin'); }
  if (!ID.test(value.taskId) || !INVOICE_ID.test(value.invoiceId)
    || !['LOCATE', 'OPEN', 'DOWNLOAD'].includes(value.outcomeKind)
    || !value.title || !value.account || !value.query || value.query.length > 100
    || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'
    || origin.origin !== value.origin || !origin.port) {
    throw new Error('invalid scripted portal contract');
  }
  if (value.outcomeKind === 'DOWNLOAD') {
    if (!value.destinationPath || !isAbsolute(value.destinationPath)
      || basename(value.destinationPath) !== `${value.invoiceId}.txt`) {
      throw new Error('download requires an exact approved destination');
    }
  } else if (value.destinationPath !== undefined) {
    throw new Error('unexpected destination for non-download task');
  }
}
