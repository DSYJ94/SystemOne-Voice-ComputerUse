import { createHash, randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { digest } from '../../protocol/src/json.ts';
import { AttemptJournal, TaskBudgetExceeded } from '../../runtime/src/attempt-journal.ts';
import { TaskAdmissionRegistry } from '../../runtime/src/task-authority.ts';
import type { TaskAdmission, Effect } from '../../runtime/src/task-authority.ts';
import { PortalActionAuthority } from './portal-action-authority.ts';
import { portalPredicate, reconcilePortalHistory } from './portal-recovery.ts';
import { DEFAULT_PROGRESS_LIMITS, TaskProgressExceeded } from '../../runtime/src/task-progress.ts';
import type { TaskProgressLimits } from '../../runtime/src/task-progress.ts';
import type { ResumeRequest, UserPromptLedger } from '../../runtime/src/user-prompts.ts';
import type { TaskRecoveryBinding } from '../../runtime/src/task-recovery.ts';
import type { JSONValue } from '../../protocol/src/json.ts';
import type { PortalDownload, PortalGoal, PortalGoalResult, PortalObservation } from './managed-portal.ts';

type GoalKind = PortalGoal['kind'];
type Stage = 'admitted' | 'located' | 'opened' | 'downloaded_temporary' | 'saved';
type State = 'active' | 'paused' | 'completed' | 'cancelled';
type Action = 'search' | 'open' | 'download' | 'save';
const TRANSITIONS: Record<Action, readonly [Stage, Stage]> = {
  search: ['admitted', 'located'], open: ['located', 'opened'],
  download: ['opened', 'downloaded_temporary'], save: ['downloaded_temporary', 'saved'],
};
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

export interface PortalSession {
  readonly origin: string;
  stop(): Promise<{ workerFenced: boolean }>;
  observe(): Promise<PortalObservation>;
  search(query: string): Promise<PortalObservation>;
  openInvoice(id: string, revision: number): Promise<PortalObservation>;
  downloadInvoice(id: string, revision: number): Promise<PortalDownload>;
  verifyGoal(goal: PortalGoal, revision: number, receipt?: PortalDownload): Promise<PortalGoalResult>;
}

interface VerifiedEvidence {
  readonly observationId: string;
  readonly evidenceRef: string;
}

function budgetFailure(error: unknown): error is TaskBudgetExceeded | TaskProgressExceeded {
  return error instanceof TaskBudgetExceeded || error instanceof TaskProgressExceeded;
}

/** Fixture-only durable progress. Active tasks pause on host restart; an
 * in-flight action becomes unknown and is never silently replayed. This store
 * is not the production permit journal or a general task admission service. */
export class ScriptedPortalStore {
  readonly #db: DatabaseSync;
  readonly #outputRoot: string;
  readonly #journal: AttemptJournal;
  readonly #issued = new WeakSet<object>();
  readonly #claimed = new WeakSet<object>();
  readonly #admissions = new WeakMap<object, TaskAdmission>();

  constructor(path: string, fixtureOutputRoot: string, journal: AttemptJournal) {
    this.#journal = journal;
    const output = lstatSync(fixtureOutputRoot);
    if (!output.isDirectory() || output.isSymbolicLink()
      || (output.mode & 0o022) !== 0) {
      throw new Error('fixture output directory is unsafe');
    }
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
      DROP INDEX IF EXISTS one_unresolved_scripted_portal_task;
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_scripted_portal_task
      ON scripted_portal_tasks ((1))
      WHERE state = 'active';`);
  }

  close(): void { this.#db.close(); }

  fixtureDestination(invoiceId: string): string {
    if (!INVOICE_ID.test(invoiceId)) throw new Error('invalid fixture invoice ID');
    return join(this.#outputRoot, `${invoiceId}.txt`);
  }

  hasBlockingTask(): boolean {
    return Boolean(this.#db.prepare(`SELECT 1 FROM scripted_portal_tasks
      WHERE state IN ('active', 'paused') OR in_flight IS NOT NULL LIMIT 1`).get());
  }

  start(registry: TaskAdmissionRegistry, admission: TaskAdmission,
    contract: ScriptedPortalContract): ScriptedPortalRecord {
    validateContract(contract);
    this.#assertOutputScope(contract);
    assertAdmission(admission, contract);
    if (this.#db.prepare(`SELECT 1 FROM scripted_portal_tasks
      WHERE state IN ('active', 'paused') OR in_flight IS NOT NULL`).get()) {
      throw new Error('earlier scripted task is active or has an unresolved action');
    }
    if (this.get(contract.taskId)) throw new Error('portal task already stored or admission claimed');
    this.#db.prepare(`INSERT INTO scripted_portal_tasks VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, 'active', 'admitted', NULL, NULL)`)
      .run(contract.taskId, contract.origin, contract.outcomeKind,
        contract.invoiceId, contract.title, contract.account, contract.query,
        contract.destinationPath ?? null);
    // The projection is staged first. No worker can claim it until the exact
    // admission commits in the journal. A crash in between leaves a blocked,
    // unbound record; ordinary admission failures remove the unsent projection.
    try { this.#journal.startAdmittedTask(registry, admission); }
    catch (error) {
      this.#db.prepare('DELETE FROM scripted_portal_tasks WHERE task_id = ?').run(contract.taskId);
      throw error;
    }
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

  /** Issue execution ownership only after the journal consumes exact recovery
   * intent. A persisted admission alone can never attach a new task object. */
  resume(ledger: UserPromptLedger, intent: ResumeRequest): {
    readonly record: ScriptedPortalRecord; readonly admission: TaskAdmission;
  } {
    const task = this.get(intent.taskId);
    const journal = this.#journal.getTaskRecord(intent.taskId);
    if (!task || task.state !== 'paused' || task.inFlight !== null
      || !['located', 'opened'].includes(task.stage) || !journal?.admission) {
      throw new Error('portal recovery requires a settled results/detail checkpoint');
    }
    assertAdmission(journal.admission, task);
    const history = reconcilePortalHistory(task, journal);
    if (history.state !== 'paused' || history.stage !== task.stage || history.inFlight !== null) {
      throw new Error('portal projection requires reconciliation before resume');
    }
    if (this.#db.prepare(`SELECT 1 FROM scripted_portal_tasks WHERE task_id != ?
      AND (state IN ('active', 'paused') OR in_flight IS NOT NULL)`).get(task.taskId)) {
      throw new Error('another portal task requires recovery');
    }
    this.#journal.resumeTask(ledger, intent);
    try {
      const update = this.#db.prepare(`UPDATE scripted_portal_tasks SET state = 'active', reason = NULL
        WHERE task_id = ? AND state = 'paused' AND in_flight IS NULL AND stage = ?`)
        .run(task.taskId, task.stage);
      if (update.changes !== 1) throw new Error('portal resume projection changed');
      const record = this.get(task.taskId)!;
      this.#issued.add(record);
      this.#admissions.set(record, journal.admission);
      return Object.freeze({ record, admission: journal.admission });
    } catch (error) {
      this.#journal.pauseTask(task.taskId, 'portal_resume_projection_failed');
      throw error;
    }
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
    const task = this.get(taskId);
    if (!task || ((action === 'download' || action === 'save') && task.outcomeKind !== 'DOWNLOAD')
      || (action === 'open' && task.outcomeKind === 'LOCATE')) {
      throw new Error('action is outside the task outcome');
    }
    const result = this.#db.prepare(`UPDATE scripted_portal_tasks SET in_flight = ?
      WHERE task_id = ? AND state = 'active' AND in_flight IS NULL AND stage = ?`)
      .run(action, taskId, TRANSITIONS[action][0]);
    if (result.changes !== 1) throw new Error('task is not ready for an action');
  }

  verified(taskId: string, stage: Stage, completed: boolean, action?: Action): boolean {
    const task = this.get(taskId);
    if (!task) return false;
    const terminalStage = task.outcomeKind === 'LOCATE' ? 'located'
      : task.outcomeKind === 'OPEN' ? 'opened' : 'saved';
    const validTransition = action === undefined
      ? completed && task.inFlight === null && task.outcomeKind !== 'DOWNLOAD'
        && (task.stage === 'admitted' || task.stage === 'located' || task.stage === stage)
      : task.inFlight === action && task.stage === TRANSITIONS[action]?.[0]
        && stage === TRANSITIONS[action]?.[1];
    if (!validTransition || completed !== (stage === terminalStage)) return false;
    const result = this.#db.prepare(`UPDATE scripted_portal_tasks
      SET stage = ?, state = ?, in_flight = NULL, reason = NULL
      WHERE task_id = ? AND state = 'active' AND in_flight IS ? AND stage = ?`)
      .run(stage, completed ? 'completed' : 'active', taskId, action ?? null, task.stage);
    return result.changes === 1;
  }

  pause(taskId: string, reason: string): ScriptedPortalRecord {
    if (['active', 'paused'].includes(this.#journal.getTaskState(taskId) ?? '')) {
      this.#journal.pauseTask(taskId, 'portal_interruption');
    }
    this.#db.prepare(`UPDATE scripted_portal_tasks SET state = 'paused', reason = ?
      WHERE task_id = ? AND state = 'active'`).run(reason, taskId);
    return this.get(taskId)!;
  }

  stop(taskId: string): ScriptedPortalRecord {
    this.#db.prepare(`UPDATE scripted_portal_tasks SET state = 'cancelled',
      reason = CASE WHEN in_flight IS NULL THEN 'stopped' ELSE 'stopped with unresolved action' END
      WHERE task_id = ? AND state IN ('active', 'paused')`).run(taskId);
    try {
      if (['active', 'paused'].includes(this.#journal.getTaskState(taskId) ?? '')) {
        this.#journal.cancelTask(taskId);
      }
    } catch { /* Task.stop reports the journal fence separately. */ }
    return this.get(taskId)!;
  }

  /** New owner must call this before opening a worker. No automatic resume. */
  recoverAfterRestart(): readonly ScriptedPortalRecord[] {
    const rows = this.#db.prepare('SELECT task_id FROM scripted_portal_tasks ORDER BY rowid')
      .all() as { task_id: string }[];
    for (const { task_id: taskId } of rows) {
      const task = this.get(taskId)!;
      if (['active', 'paused'].includes(this.#journal.getTaskState(taskId) ?? '')) {
        this.#journal.pauseTask(taskId, 'portal_restart');
      }
      let recovered: Pick<ScriptedPortalRecord, 'state' | 'stage' | 'inFlight' | 'reason'>;
      try {
        const record = this.#journal.getTaskRecord(taskId);
        if (!record?.admission) throw new Error('portal journal admission is missing');
        assertAdmission(record.admission, task);
        if (record.progress && (record.progress.scopeRef !== record.admission.scopeRef
          || record.progress.completionVerifierRef !== record.admission.completionVerifierRef)) {
          throw new Error('portal progress binding mismatch');
        }
        recovered = reconcilePortalHistory(task, record);
      } catch {
        recovered = { state: task.state === 'cancelled' ? 'cancelled' : 'paused',
          stage: task.stage, inFlight: task.inFlight,
          reason: 'portal contract or journal evidence requires review' };
      }
      if (recovered.state === 'cancelled'
        && ['active', 'paused'].includes(this.#journal.getTaskState(taskId) ?? '')) {
        this.#journal.cancelTask(taskId);
      }
      this.#db.prepare(`UPDATE scripted_portal_tasks SET state = ?, stage = ?,
        in_flight = ?, reason = ? WHERE task_id = ?`).run(recovered.state, recovered.stage,
        recovered.inFlight, recovered.reason, taskId);
    }
    return Object.freeze(rows.map(row => this.get(row.task_id)!).filter(row => row.state === 'paused'));
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
  #authority: PortalActionAuthority;
  #receipt: PortalDownload | undefined;
  #localSaveActive = false;
  #advancing = false;
  #recovering = false;

  get taskId(): string { return this.#taskId; }

  constructor(store: ScriptedPortalStore, journal: AttemptJournal,
    session: PortalSession, admission: TaskAdmission, started: ScriptedPortalRecord,
    progressLimits: TaskProgressLimits = DEFAULT_PROGRESS_LIMITS) {
    this.#store = store;
    this.#journal = journal;
    this.#session = session;
    this.#taskId = admission.taskId;
    assertAdmission(admission, started);
    const task = store.get(admission.taskId);
    if (!task || task.origin !== session.origin || task.state !== 'active') {
      throw new Error('scripted task origin or state mismatch');
    }
    store.claimStarted(started, admission);
    this.#authority = new PortalActionAuthority(admission);
    try {
      const persisted = journal.getTaskRecord(admission.taskId);
      if (persisted?.state !== 'active' || !persisted.admission
        || digest(persisted.admission as unknown as JSONValue)
          !== digest(admission as unknown as JSONValue)) {
        throw new Error('portal journal admission mismatch');
      }
      if (!persisted.progress) journal.enableTaskProgress(admission.taskId, admission.scopeRef,
        admission.completionVerifierRef, progressLimits);
      else if (persisted.progress.scopeRef !== admission.scopeRef
        || persisted.progress.completionVerifierRef !== admission.completionVerifierRef) {
        throw new Error('portal progress policy mismatch');
      }
    }
    catch (error) {
      store.pause(admission.taskId, 'journal admission failed');
      throw error;
    }
  }

  /** Revoke all old permits before recovery. Existing calls still need to
   * settle; a pause cannot undo an action already dispatched. */
  pause(reasonRef = 'manual_interruption'): { readonly workerFenced: boolean } {
    this.#authority.stop();
    this.#store.pause(this.#taskId, reasonRef);
    return Object.freeze({ workerFenced: !this.#advancing && !this.#localSaveActive });
  }

  async prepareRecovery(): Promise<TaskRecoveryBinding> {
    if (this.#advancing || this.#recovering || this.#localSaveActive) {
      throw new Error('portal operation has not settled');
    }
    const task = this.#store.get(this.#taskId)!;
    if (task.state !== 'paused' || task.inFlight !== null
      || !['located', 'opened'].includes(task.stage)) {
      throw new Error('portal recovery requires current results/detail evidence');
    }
    const before = this.#journal.getTaskRecord(this.#taskId)!;
    if (!before.admission || before.state !== 'paused') throw new Error('portal journal is not paused');
    assertAdmission(before.admission, task);
    const history = reconcilePortalHistory(task, before);
    if (history.stage !== task.stage || history.inFlight !== null) {
      throw new Error('portal recovery projection is not reconciled');
    }
    this.#authority.stop();
    this.#recovering = true;
    try {
      const ticket = this.#journal.reserveTaskRecoveryObservation(this.#taskId);
      const observed = await this.#session.observe();
      const semantic = portalSemanticState(observed, task.origin);
      const exact = task.stage === 'located'
        ? observed.kind === 'results' && new URL(observed.url).searchParams.get('q') === task.query
          && observed.rows.filter(row => row.id === task.invoiceId
            && row.title === task.title && row.account === task.account).length === 1
        : observed.kind === 'detail' && observed.invoiceId === task.invoiceId
          && observed.title === task.title && observed.account === task.account;
      if (!exact) throw new Error('portal checkpoint is not currently verified');
      const kind = task.stage === 'located' ? 'LOCATE' : 'OPEN';
      const result = await this.#session.verifyGoal(goalFor(task, kind), observed.revision);
      const after = await this.#session.observe();
      const current = this.#store.get(this.#taskId)!;
      if (current.state !== 'paused' || current.stage !== task.stage || current.inFlight !== null
        || result.status !== 'matched' || result.revision !== observed.revision
        || !PortalActionAuthority.sameObservation(observed, after)) {
        throw new Error('portal checkpoint is not currently verified');
      }
      const checkpoint = before.progress!.checkpoints.at(-1)!;
      return this.#journal.recordTaskRecoveryObservation(this.#taskId, ticket, {
        observationId: randomUUID(), scopeRef: before.admission.scopeRef, stateDigest: digest(semantic),
      }, { checkpointRef: checkpoint.checkpointId, predicateRef: portalPredicate(task.stage),
        evidenceRef: randomUUID() });
    } finally { this.#recovering = false; }
  }

  resume(ledger: UserPromptLedger, intent: ResumeRequest): void {
    if (intent.taskId !== this.#taskId || this.#advancing || this.#recovering || this.#localSaveActive) {
      throw new Error('portal resume is stale or an operation has not settled');
    }
    const activated = this.#store.resume(ledger, intent);
    this.#store.claimStarted(activated.record, activated.admission);
    this.#authority = new PortalActionAuthority(activated.admission);
  }

  async stop(): Promise<{ record: ScriptedPortalRecord; journalFenced: boolean;
    workerFenced: boolean; browserFenced: boolean; localSaveFenced: boolean;
    unresolvedExecutionIds: readonly string[] }> {
    // Persist cancellation before waiting for Playwright to close. A successful
    // worker fence never changes an in-flight action into "not dispatched".
    this.#authority.stop();
    const record = this.#store.stop(this.#taskId);
    let journalFenced = false;
    let unresolvedExecutionIds: readonly string[] = [];
    try {
      if (this.#journal.getTaskState(this.#taskId) !== 'cancelled') {
        this.#journal.cancelTask(this.#taskId);
      }
      unresolvedExecutionIds = this.#journal.unresolvedAttempts(this.#taskId).map(attempt => attempt.executionId);
      journalFenced = this.#journal.getTaskState(this.#taskId) === 'cancelled';
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
    if (this.#advancing) throw new Error('task advance already in progress');
    const before = this.#store.get(this.#taskId)!;
    if (before.state !== 'active' || before.inFlight !== null) throw new Error('scripted task is not active and settled');
    this.#advancing = true;
    try { return await this.#advance(); }
    catch (error) {
      if (this.#store.get(this.#taskId)?.state !== 'active') return this.#store.get(this.#taskId)!;
      return this.#store.pause(this.#taskId, budgetFailure(error) ? error.message : 'current verification unavailable');
    }
    finally { this.#advancing = false; }
  }

  async #advance(): Promise<ScriptedPortalRecord> {
    const task = this.#store.get(this.#taskId)!;
    if (task.state !== 'active' || task.inFlight !== null) {
      throw new Error('scripted task is not active and settled');
    }
    let observed: PortalObservation;
    let observationId: string;
    try { ({ observed, observationId } = await this.#observe()); }
    catch (error) { return this.#store.pause(task.taskId,
      budgetFailure(error) ? error.message : 'current observation unavailable'); }
    if (this.#store.get(task.taskId)?.state !== 'active') return this.#store.get(task.taskId)!;
    this.#journal.consumeTaskDecision(task.taskId, observationId);
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
          const verified = await this.#verify(goal, observed.revision, this.#receipt);
          if (verified.result.status !== 'matched') throw new Error('temporary download changed');
          this.#assertTaskActive(task.taskId);
          const { bytes } = await this.#readVerifiedFile(this.#receipt!.path, 'temporary');
          this.#assertTaskActive(task.taskId);
          const output = await open(task.destinationPath!, 'wx', 0o600);
          try {
            this.#assertTaskActive(task.taskId);
            await output.writeFile(bytes);
          }
          finally { await output.close(); }
          this.#assertTaskActive(task.taskId);
          const { bytes: saved, observationId: savedObservationId } =
            await this.#readVerifiedFile(task.destinationPath!, 'saved');
          this.#assertTaskActive(task.taskId);
          if (createHash('sha256').update(saved).digest('hex') !== this.#receipt!.sha256) {
            throw new Error('saved document changed');
          }
          return { evidenceRef: `saved-${this.#receipt!.sha256}`, observationId: savedObservationId };
        }, observed);
      }
      finally { this.#localSaveActive = false; }
    }
    if (detail) {
      const verified = await this.#verify(goalFor(task, 'OPEN'), observed.revision);
      if (verified.result.status !== 'matched') return this.#store.pause(task.taskId, 'exact detail unavailable');
      if (task.outcomeKind === 'OPEN') {
        this.#completeWithoutAction(task, 'opened', { evidenceRef: `portal-open-${observed.revision}`,
          observationId: verified.observationId });
        return this.#store.get(task.taskId)!;
      }
      if (task.outcomeKind === 'LOCATE') return this.#store.pause(task.taskId, 'locate evidence is no longer current');
      return this.#action(task, 'download', 'downloaded_temporary', false, async () => {
        this.#receipt = await this.#session.downloadInvoice(task.invoiceId, observed.revision);
        const outcome = await this.#verify(goalFor(task, 'DOWNLOAD'),
          observed.revision, this.#receipt);
        if (outcome.result.status !== 'matched') throw new Error('download was not verified');
        return { evidenceRef: `portal-download-${outcome.result.revision}`, observationId: outcome.observationId };
      }, observed);
    }
    if (exact && observed.kind === 'results') {
      const verified = await this.#verify(goalFor(task, 'LOCATE'), observed.revision);
      if (verified.result.status !== 'matched') return this.#store.pause(task.taskId, 'exact result unavailable');
      if (task.outcomeKind === 'LOCATE') {
        this.#completeWithoutAction(task, 'located', { evidenceRef: `portal-locate-${observed.revision}`,
          observationId: verified.observationId });
        return this.#store.get(task.taskId)!;
      }
      return this.#action(task, 'open', 'opened', task.outcomeKind === 'OPEN', async () => {
        const after = await this.#session.openInvoice(task.invoiceId, observed.revision);
        const outcome = await this.#verify(goalFor(task, 'OPEN'), after.revision);
        if (outcome.result.status !== 'matched') throw new Error('opened detail was not verified');
        return { evidenceRef: `portal-open-${outcome.result.revision}`, observationId: outcome.observationId };
      }, observed);
    }
    if (observed.kind === 'detail') {
      return this.#store.pause(task.taskId, 'a different invoice is open');
    }
    return this.#action(task, 'search', 'located', task.outcomeKind === 'LOCATE', async () => {
      const after = await this.#session.search(task.query);
      const outcome = await this.#verify(goalFor(task, 'LOCATE'), after.revision);
      if (outcome.result.status !== 'matched') throw new Error('exact invoice was not found');
      return { evidenceRef: `portal-locate-${outcome.result.revision}`, observationId: outcome.observationId };
    }, observed);
  }

  async #action(task: ScriptedPortalRecord, action: Action, stage: Stage,
    completed: boolean, body: () => Promise<VerifiedEvidence>,
    observed: PortalObservation): Promise<ScriptedPortalRecord> {
    let fresh: PortalObservation;
    let observationId: string;
    try { ({ observed: fresh, observationId } = await this.#observe()); }
    catch (error) { return this.#store.pause(task.taskId, budgetFailure(error)
      ? error.message : `${action} preflight observation unavailable`); }
    const current = this.#store.get(task.taskId)!;
    if (current.state !== 'active') return current;
    if (!PortalActionAuthority.sameObservation(observed, fresh)) {
      return this.#store.pause(task.taskId, `${action} preflight observation changed`);
    }
    let permit;
    try { permit = this.#authority.issue(current, action, fresh, observationId); }
    catch { return this.#store.pause(task.taskId, `${action} was not admitted`); }
    try { this.#journal.prepare(permit); }
    catch (error) { return this.#store.pause(task.taskId, budgetFailure(error)
      ? error.message : `${action} journal preparation failed`); }
    try {
      this.#authority.consume(permit, current, action, fresh);
      this.#store.begin(task.taskId, action);
      // No await between the durable marker and the browser call. The marker
      // means an effect is possible, including during Playwright auto-waiting.
      this.#journal.markDispatchBoundary(permit.executionId);
    } catch (error) {
      if (this.#journal.getAttempt(permit.executionId)?.phase === 'prepared') {
        this.#journal.recordNotDispatched(permit.executionId);
      }
      return this.#store.pause(task.taskId, budgetFailure(error)
        ? error.message : `${action} was not dispatched`);
    }
    let evidence: VerifiedEvidence;
    try { evidence = await body(); }
    catch (error) {
      this.#recordUnknown(permit.executionId);
      return this.#store.pause(task.taskId, budgetFailure(error)
        ? error.message : `${action} outcome uncertain; re-observe before any retry`);
    }
    try {
      this.#journal.recordOutcome(permit.executionId, {
        deliveryStatus: 'dispatched', effectStatus: 'applied',
        verification: 'matched', evidenceRef: evidence.evidenceRef,
      });
      if (this.#journal.getTaskState(task.taskId) === 'active'
        && this.#store.get(task.taskId)?.state === 'active') {
        this.#checkpoint(task, stage, completed, evidence, permit.executionId);
        if (completed) this.#journal.completeTask(task.taskId, evidence.evidenceRef);
        if (!this.#store.verified(task.taskId, stage, completed, action)) {
          throw new Error('progress checkpoint was refused');
        }
      }
    } catch (error) {
      return this.#store.pause(task.taskId, budgetFailure(error)
        ? error.message : `${action} journal outcome uncertain`);
    }
    return this.#store.get(task.taskId)!;
  }

  #completeWithoutAction(task: ScriptedPortalRecord, stage: Stage, evidence: VerifiedEvidence): void {
    try {
      this.#assertTaskActive(task.taskId);
      this.#checkpoint(task, stage, true, evidence);
      this.#journal.completeTask(task.taskId, evidence.evidenceRef);
      if (!this.#store.verified(task.taskId, stage, true)) {
        throw new Error('terminal checkpoint was refused');
      }
    } catch {
      this.#store.pause(task.taskId, 'terminal verification could not be recorded');
    }
  }

  #checkpoint(task: ScriptedPortalRecord, stage: Stage, terminal: boolean,
    evidence: VerifiedEvidence, executionId?: string): void {
    this.#journal.recordTaskCheckpoint(task.taskId, { checkpointId: randomUUID(),
      observationId: evidence.observationId, evidenceRef: evidence.evidenceRef,
      stageRef: stage, predicateRef: portalPredicate(stage), terminal,
      ...(executionId ? { executionId } : {}) });
  }

  async #observe(): Promise<{ observed: PortalObservation; observationId: string }> {
    this.#assertTaskActive(this.#taskId);
    const ticket = this.#journal.reserveTaskObservation(this.#taskId);
    const observed = await this.#session.observe();
    this.#assertTaskActive(this.#taskId);
    const observationId = randomUUID();
    const semantic = portalSemanticState(observed, this.#session.origin);
    this.#journal.recordTaskObservation(this.#taskId, ticket, { observationId,
      scopeRef: 'synthetic-portal-only', stateDigest: digest(semantic) });
    return { observed, observationId };
  }

  async #verify(goal: PortalGoal, revision: number, receipt?: PortalDownload):
    Promise<{ result: PortalGoalResult; observationId: string }> {
    this.#assertTaskActive(this.#taskId);
    const ticket = this.#journal.reserveTaskObservation(this.#taskId, false);
    const result = await this.#session.verifyGoal(goal, revision, receipt);
    this.#assertTaskActive(this.#taskId);
    if (!['matched', 'not_matched', 'unavailable'].includes(result.status)
      || (result.status === 'matched' && result.revision !== revision)) {
      throw new Error('portal predicate returned stale or invalid evidence');
    }
    const observationId = randomUUID();
    this.#journal.recordTaskObservation(this.#taskId, ticket, { observationId,
      scopeRef: 'synthetic-portal-only', stateDigest: digest({ kind: 'portal-predicate',
        goal: { ...goal }, status: result.status }) });
    return { result, observationId };
  }

  async #readVerifiedFile(path: string, purpose: 'temporary' | 'saved'):
    Promise<{ bytes: Buffer; observationId: string }> {
    this.#assertTaskActive(this.#taskId);
    const ticket = this.#journal.reserveTaskObservation(this.#taskId, false);
    const bytes = await readFile(path);
    this.#assertTaskActive(this.#taskId);
    const observationId = randomUUID();
    this.#journal.recordTaskObservation(this.#taskId, ticket, { observationId,
      scopeRef: 'synthetic-portal-only', stateDigest: digest({ kind: 'portal-file', purpose,
        sha256: createHash('sha256').update(bytes).digest('hex') }) });
    return { bytes, observationId };
  }

  #recordUnknown(executionId: string): void {
    try { this.#journal.recordOutcome(executionId, {
      deliveryStatus: 'unknown', effectStatus: 'unknown', verification: 'unavailable',
    }); } catch { /* Keep the durable dispatch boundary unresolved. */ }
  }

  #assertTaskActive(taskId: string): void {
    const task = this.#store.get(taskId);
    const record = this.#journal.getTaskRecord(taskId);
    if (task?.state !== 'active' || record?.state !== 'active' || !record.admission) {
      throw new Error('task was stopped before the next operation');
    }
    assertAdmission(record.admission, task);
  }
}

function goalFor(task: ScriptedPortalRecord, kind: GoalKind): PortalGoal {
  return { kind, invoiceId: task.invoiceId, title: task.title, account: task.account };
}

function portalSemanticState(observed: PortalObservation, origin: string): JSONValue {
  const url = new URL(observed.url);
  if (!Number.isSafeInteger(observed.revision) || observed.revision < 0
    || url.origin !== origin || url.username || url.password || url.hash
    || !['home', 'results', 'detail'].includes(observed.kind)) {
    throw new Error('invalid portal observation identity');
  }
  const text = (value: string) => typeof value === 'string' && value.length > 0
    && value.length <= 160 && value.isWellFormed();
  if (observed.kind === 'results') {
    if (url.pathname !== '/invoices' || observed.rows.length > 100
      || new Set(observed.rows.map(row => row.id)).size !== observed.rows.length
      || observed.rows.some(row => !INVOICE_ID.test(row.id) || !text(row.title) || !text(row.account))) {
      throw new Error('invalid portal results observation');
    }
    return { kind: observed.kind, url: url.href,
      rows: observed.rows.map(row => ({ id: row.id, title: row.title, account: row.account }))
        .sort((a, b) => a.id.localeCompare(b.id)) };
  }
  if (observed.kind === 'detail') {
    if (!INVOICE_ID.test(observed.invoiceId) || !text(observed.title) || !text(observed.account)
      || url.pathname !== `/invoices/${observed.invoiceId}` || url.search) {
      throw new Error('invalid portal detail observation');
    }
    return { kind: observed.kind, url: url.href, invoiceId: observed.invoiceId,
      title: observed.title, account: observed.account };
  }
  if (url.pathname !== '/' || url.search) throw new Error('invalid portal home observation');
  return { kind: observed.kind, url: url.href };
}

/** Fixture contract binding only. It checks the host's stated parameter
 * digests; it does not prove that values were correctly extracted from speech. */
function assertAdmission(admission: TaskAdmission, contract: ScriptedPortalContract): void {
  const effects: readonly Effect[] = contract.outcomeKind === 'DOWNLOAD'
    ? ['READ', 'NAVIGATE', 'DOWNLOAD', 'LOCAL_EDIT'] : ['READ', 'NAVIGATE'];
  const expected = new Map<string, [string, string]>([
    ['origin', [admission.commandMessageId, contract.origin]],
    ['invoiceId', ['fixture-config', contract.invoiceId]],
    ['title', ['fixture-config', contract.title]],
    ['account', ['fixture-config', contract.account]],
    ['query', ['fixture-config', contract.query]],
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
