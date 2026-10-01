import { DatabaseSync } from 'node:sqlite';
import { ContractError, digest, parseJSON } from '../../protocol/src/json.ts';
import type { JSONValue } from '../../protocol/src/json.ts';
import type { TaskAdmission, TaskAdmissionRegistry } from './task-authority.ts';
import { DEFAULT_PROGRESS_LIMITS, TaskProgressExceeded, TaskProgressStore } from './task-progress.ts';
import type { TaskCheckpoint, TaskObservation, TaskProgress, TaskProgressLimits } from './task-progress.ts';
import { TASK_RECOVERY_READ_TTL_MS } from './task-recovery.ts';
import type { RecoveryPredicateEvidence, RecoveryReadRow, TaskRecoveryBinding } from './task-recovery.ts';
import type { ResumeRequest, UserPromptLedger } from './user-prompts.ts';
import type { CommittedInput, CommittedInputSession } from './committed-input.ts';

const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export interface TaskBudgetLimits {
  readonly maxSteps: number;
  readonly timeoutMs: number;
}

export interface TaskBudget extends TaskBudgetLimits {
  readonly stepsUsed: number;
  readonly deadlineMillis: number;
  readonly pauseReason: 'steps' | 'time' | 'clock' | 'missing' | null;
}

/** Host policy only: never take these limits from a model proposal. */
export const DEFAULT_TASK_BUDGET: TaskBudgetLimits = Object.freeze({
  maxSteps: 30, timeoutMs: 300_000,
});

export class TaskBudgetExceeded extends ContractError {
  readonly reason: NonNullable<TaskBudget['pauseReason']>;
  constructor(reason: NonNullable<TaskBudget['pauseReason']>) {
    super(reason === 'steps' ? 'task step budget exhausted'
      : reason === 'time' ? 'task time budget exhausted'
        : reason === 'clock' ? 'task budget clock invalid' : 'task budget missing');
    this.reason = reason;
  }
}

interface BudgetRow {
  max_steps: number;
  timeout_ms: number;
  deadline_ms: number;
  last_checked_ms: number;
  pause_reason: TaskBudget['pauseReason'];
}

export interface PreparedAttempt {
  readonly executionId: string;
  readonly permitRef: string;
  readonly taskId: string;
  readonly taskEpoch: number;
  readonly goalRevision: number;
  readonly scopeRef: string;
  readonly observationId: string;
  readonly candidateId: string;
  readonly candidateSetDigest: string;
  readonly actionDigest: string;
  readonly policyRevision: string;
  readonly leaseGeneration: number;
}

export interface AttemptOutcome {
  readonly deliveryStatus: 'not_dispatched' | 'dispatched' | 'unknown';
  readonly effectStatus: 'not_applied' | 'applied' | 'unknown';
  readonly verification: 'matched' | 'not_matched' | 'unavailable';
  /** Opaque local reference, not the observation or private value itself. */
  readonly evidenceRef?: string;
}

export interface JournalAttempt extends PreparedAttempt {
  readonly phase: 'prepared' | 'at_dispatch_boundary' | 'settled';
  readonly outcome?: AttemptOutcome;
}

export interface TaskCompletion {
  readonly evidenceRef: string;
  /** Null for the legacy revision-only journal API. */
  readonly completionVerifierRef: string | null;
}

export interface TaskCorrection {
  readonly commandMessageId: string;
  readonly replacementGoalRevision: number;
  readonly commandDigest: string;
}

/** Private diagnostic history, never an admission, resume intent or permit.
 * The stored contract cannot be transferred through TaskAdmissionRegistry. */
export interface JournalTaskRecord {
  readonly taskId: string;
  readonly taskEpoch: number;
  readonly goalRevision: number;
  readonly state: TaskRow['state'];
  readonly admission: TaskAdmission | null;
  readonly budget: TaskBudget | undefined;
  readonly attempts: readonly JournalAttempt[];
  readonly completion: TaskCompletion | null;
  readonly progress: TaskProgress | null;
  readonly correction: TaskCorrection | null;
  readonly replacement: { readonly taskId: string } | null;
  readonly replaces: { readonly taskId: string } | null;
}

interface TaskRow {
  task_epoch: number;
  goal_revision: number;
  state: 'active' | 'cancelled' | 'paused' | 'completed';
  admission_digest: string | null;
}

interface AttemptRow {
  execution_id: string;
  permit_ref: string;
  task_id: string;
  task_epoch: number;
  goal_revision: number;
  scope_ref: string;
  observation_id: string;
  candidate_id: string;
  candidate_set_digest: string;
  action_digest: string;
  policy_revision: string;
  lease_generation: number;
  phase: JournalAttempt['phase'];
  delivery_status: AttemptOutcome['deliveryStatus'] | null;
  effect_status: AttemptOutcome['effectStatus'] | null;
  verification: AttemptOutcome['verification'] | null;
  evidence_ref: string | null;
}

/**
 * Synchronous, host-private journal foundation. A durable boundary marker is
 * committed before the caller may hand an operation to an adapter. That marker
 * means delivery is POSSIBLE, never that it definitely happened. This class is
 * not a permit issuer, worker cancellation barrier, or full task controller.
 */
export class AttemptJournal {
  readonly #db: DatabaseSync;
  readonly #clock: () => number;
  readonly #progress: TaskProgressStore;

  constructor(path: string, clock: () => number = Date.now) {
    this.#clock = clock;
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 1000;
    `);
    this.#migrateLegacyTasks();
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        task_epoch INTEGER NOT NULL,
        goal_revision INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'cancelled', 'paused', 'completed'))
      );
      CREATE TABLE IF NOT EXISTS task_budgets (
        task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
        max_steps INTEGER NOT NULL CHECK(max_steps BETWEEN 1 AND 1000),
        timeout_ms INTEGER NOT NULL CHECK(timeout_ms BETWEEN 1 AND 3600000),
        deadline_ms INTEGER NOT NULL,
        last_checked_ms INTEGER NOT NULL,
        pause_reason TEXT CHECK(pause_reason IN ('steps', 'time', 'clock', 'missing'))
      );
      CREATE TABLE IF NOT EXISTS task_admissions (
        task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
        contract_json TEXT NOT NULL,
        contract_digest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_completions (
        task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
        evidence_ref TEXT NOT NULL,
        completion_verifier_ref TEXT
      );
      CREATE TABLE IF NOT EXISTS attempts (
        execution_id TEXT PRIMARY KEY,
        permit_ref TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        task_epoch INTEGER NOT NULL,
        goal_revision INTEGER NOT NULL,
        scope_ref TEXT NOT NULL,
        observation_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        candidate_set_digest TEXT NOT NULL,
        action_digest TEXT NOT NULL,
        policy_revision TEXT NOT NULL,
        lease_generation INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('prepared', 'at_dispatch_boundary', 'settled')),
        delivery_status TEXT,
        effect_status TEXT,
        verification TEXT,
        evidence_ref TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_unsettled_attempt
        ON attempts ((1)) WHERE phase IN ('prepared', 'at_dispatch_boundary');
      CREATE TABLE IF NOT EXISTS attempt_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT REFERENCES attempts(execution_id),
        event_kind TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        event_kind TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_recovery_reads (
        ticket TEXT PRIMARY KEY REFERENCES task_observations(ticket),
        task_id TEXT NOT NULL REFERENCES tasks(task_id), deadline_ms INTEGER NOT NULL,
        checkpoint_ref TEXT NOT NULL, history_digest TEXT NOT NULL,
        observation_id TEXT, binding_digest TEXT, evidence_ref TEXT
      );
      CREATE TABLE IF NOT EXISTS task_resume_intents (
        message_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id),
        recovery_ticket TEXT NOT NULL UNIQUE REFERENCES task_recovery_reads(ticket),
        prompt_id TEXT NOT NULL, presentation_digest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_replacements (
        source_task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
        replacement_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id)
      );
      CREATE TABLE IF NOT EXISTS task_corrections (
        task_id TEXT PRIMARY KEY REFERENCES tasks(task_id), command_message_id TEXT NOT NULL UNIQUE,
        replacement_goal_revision INTEGER NOT NULL, command_digest TEXT NOT NULL
      );
    `);
    const taskColumns = this.#db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    if (!taskColumns.some(column => column.name === 'admission_digest')) {
      this.#db.exec('ALTER TABLE tasks ADD COLUMN admission_digest TEXT');
    }
    this.#progress = new TaskProgressStore(this.#db);
    const broken = this.#db.prepare('PRAGMA foreign_key_check').get();
    if (broken) throw new ContractError('journal foreign-key check failed');
  }

  close(): void { this.#db.close(); }

  startTask(taskId: string, taskEpoch: number, goalRevision: number,
    limits: TaskBudgetLimits = DEFAULT_TASK_BUDGET): void {
    this.#startTask(taskId, taskEpoch, goalRevision, limits);
  }

  /** Transfer the exact in-process admission and durably bind it to the task
   * and budget in one transaction. A failed SQL commit may consume the
   * admission, but can never leave an active task without its contract. */
  startAdmittedTask(registry: TaskAdmissionRegistry, admission: TaskAdmission,
    limits: TaskBudgetLimits = DEFAULT_TASK_BUDGET): void {
    const serialized = JSON.stringify(admission);
    const contractDigest = digest(parseJSON(Buffer.from(serialized)));
    this.#startTask(admission.taskId, admission.taskEpoch, admission.goalRevision, limits, () => {
      this.#db.prepare('INSERT INTO task_admissions VALUES (?, ?, ?)')
        .run(admission.taskId, serialized, contractDigest);
      this.#db.prepare('UPDATE tasks SET admission_digest = ? WHERE task_id = ?')
        .run(contractDigest, admission.taskId);
      const source = registry.correctionSource;
      if (source) {
        const old = this.#task(source.taskId);
        const correction = this.#db.prepare('SELECT * FROM task_corrections WHERE task_id = ?')
          .get(source.taskId) as { command_message_id: string; replacement_goal_revision: number;
            command_digest: string } | undefined;
        if (this.#db.prepare("SELECT 1 FROM tasks WHERE state = 'paused'").get()
          || !old || old.state !== 'cancelled' || old.task_epoch !== source.taskEpoch
          || old.goal_revision + 1 !== source.goalRevision
          || !correction || correction.command_message_id !== source.commandMessageId
          || correction.command_digest !== source.commandDigest
          || correction.replacement_goal_revision !== admission.goalRevision
          || admission.commandMessageId !== source.commandMessageId) {
          throw new ContractError('replacement does not match a cancelled correction');
        }
        this.#db.prepare('INSERT INTO task_replacements VALUES (?, ?)').run(source.taskId, admission.taskId);
        this.#taskEvent(source.taskId, `replaced_by:${admission.taskId}`);
        this.#taskEvent(admission.taskId, `replaces:${source.taskId}`);
      }
      // Claim last: normal validation/SQL failures do not consume a genuine
      // admission. A copied or foreign admission rolls back all inserted rows.
      registry.claimForTask(admission);
    });
  }

  #startTask(taskId: string, taskEpoch: number, goalRevision: number,
    limits: TaskBudgetLimits, persistAdmission?: () => void): void {
    assertId(taskId, 'task ID');
    assertCounter(taskEpoch, 'task epoch');
    assertCounter(goalRevision, 'goal revision');
    const now = this.#clock();
    if (!Number.isSafeInteger(limits.maxSteps) || limits.maxSteps < 1 || limits.maxSteps > 1000
      || !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1
      || limits.timeoutMs > 3_600_000 || !Number.isSafeInteger(now) || now < 0
      || !Number.isSafeInteger(now + limits.timeoutMs)) {
      throw new ContractError('invalid host task budget');
    }
    this.#transaction(() => {
      if (this.#db.prepare('SELECT 1 FROM tasks WHERE state = ?').get('active')) {
        throw new ContractError('another task is active');
      }
      if (this.#db.prepare(`SELECT 1 FROM attempts
        WHERE phase IN ('prepared', 'at_dispatch_boundary')
          OR delivery_status = 'unknown' OR effect_status = 'unknown'`).get()) {
        throw new ContractError('an earlier attempt is unresolved or unknown');
      }
      this.#db.prepare('INSERT INTO tasks (task_id, task_epoch, goal_revision, state) VALUES (?, ?, ?, ?)')
        .run(taskId, taskEpoch, goalRevision, 'active');
      this.#db.prepare('INSERT INTO task_budgets VALUES (?, ?, ?, ?, ?, NULL)')
        .run(taskId, limits.maxSteps, limits.timeoutMs, now + limits.timeoutMs, now);
      this.#taskEvent(taskId, 'started');
      persistAdmission?.();
    });
  }

  prepare(attempt: PreparedAttempt): JournalAttempt {
    validatePrepared(attempt);
    return this.#budgeted(attempt, true, () => {
      this.#assertAdmittedAttempt(attempt);
      this.#assertProgressAttempt(attempt);
      if (this.unresolvedAttempts().length) {
        throw new ContractError('an earlier effect is unresolved or unknown');
      }
      this.#db.prepare(`INSERT INTO attempts
        (execution_id, permit_ref, task_id, task_epoch, goal_revision, scope_ref,
         observation_id, candidate_id, candidate_set_digest, action_digest,
         policy_revision, lease_generation, phase)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared')`)
        .run(attempt.executionId, attempt.permitRef, attempt.taskId,
          attempt.taskEpoch, attempt.goalRevision, attempt.scopeRef,
          attempt.observationId, attempt.candidateId, attempt.candidateSetDigest,
          attempt.actionDigest, attempt.policyRevision, attempt.leaseGeneration);
      this.#event(attempt.executionId, 'prepared');
      return this.getAttempt(attempt.executionId)!;
    });
  }

  /** Persist immediately before the adapter's actual dispatch boundary. */
  markDispatchBoundary(executionId: string): JournalAttempt {
    assertId(executionId, 'execution ID');
    const attempt = this.#requiredAttempt(executionId);
    if (attempt.phase !== 'prepared') throw new ContractError('attempt is not prepared');
    return this.#budgeted(attempt, false, () => {
      this.#assertAdmittedAttempt(attempt);
      this.#assertProgressAttempt(attempt);
      if (this.#requiredAttempt(executionId).phase !== 'prepared') {
        throw new ContractError('attempt is not prepared');
      }
      this.#db.prepare(`UPDATE attempts SET phase = 'at_dispatch_boundary'
        WHERE execution_id = ?`).run(executionId);
      this.#event(executionId, 'dispatch_boundary');
      this.#progress.expire(attempt.taskId);
      return this.getAttempt(executionId)!;
    });
  }

  /** Preflight rejected the action before the adapter boundary. */
  recordNotDispatched(executionId: string): JournalAttempt {
    assertId(executionId, 'execution ID');
    return this.#transaction(() => {
      const attempt = this.#requiredAttempt(executionId);
      if (attempt.phase !== 'prepared') throw new ContractError('attempt crossed dispatch boundary');
      this.#settle(executionId, {
        deliveryStatus: 'not_dispatched', effectStatus: 'not_applied',
        verification: 'unavailable',
      }, 'not_dispatched');
      return this.getAttempt(executionId)!;
    });
  }

  /** Late receipts update only this attempt; they never reactivate its task. */
  recordOutcome(executionId: string, outcome: AttemptOutcome): JournalAttempt {
    assertId(executionId, 'execution ID');
    validateOutcome(outcome);
    return this.#transaction(() => {
      const attempt = this.#requiredAttempt(executionId);
      if (attempt.phase !== 'at_dispatch_boundary') {
        throw new ContractError('attempt has no unresolved dispatch boundary');
      }
      this.#settle(executionId, outcome, 'outcome');
      return this.getAttempt(executionId)!;
    });
  }

  /** Fences future journal dispatches. Adapter queues still need their own barrier. */
  cancelTask(taskId: string): readonly JournalAttempt[] {
    assertId(taskId, 'task ID');
    return this.#transaction(() => {
      const task = this.#task(taskId);
      if (!task || !['active', 'paused'].includes(task.state)) throw new ContractError('task is not active or paused');
      this.#db.prepare(`UPDATE tasks SET state = 'cancelled' WHERE task_id = ?`).run(taskId);
      this.#taskEvent(taskId, 'cancelled');
      this.#settlePrepared(taskId, 'cancelled_before_dispatch');
      this.#progress.expire(taskId);
      return this.unresolvedAttempts(taskId);
    });
  }

  /** Host interruption fence. Pausing expires facts and settles only unsent
   * preparations; it does not resolve an effect or authorize resume. */
  pauseTask(taskId: string, reasonRef: string): readonly JournalAttempt[] {
    assertId(taskId, 'task ID');
    assertId(reasonRef, 'pause reason');
    return this.#transaction(() => {
      const task = this.#task(taskId);
      if (!task || !['active', 'paused'].includes(task.state)) {
        throw new ContractError('task is not active or paused');
      }
      if (task.state === 'active') {
        this.#db.prepare("UPDATE tasks SET state = 'paused' WHERE task_id = ?").run(taskId);
        this.#taskEvent(taskId, `paused_host:${reasonRef}`);
      }
      this.#settlePrepared(taskId, 'paused_before_dispatch');
      this.#progress.expire(taskId);
      return this.unresolvedAttempts(taskId);
    });
  }

  /** A correction is a new committed command, never an edit to an admission.
   * Cancel the old revision atomically; replacement admission and adapter Stop
   * barriers remain separate host responsibilities. No compensation is implied. */
  cancelTaskForCorrection(taskId: string, session: CommittedInputSession,
    input: CommittedInput): readonly JournalAttempt[] {
    assertId(taskId, 'task ID');
    return this.#transaction(() => {
      const task = this.#task(taskId);
      if (!task || !['active', 'paused'].includes(task.state)
        || input.taskId !== taskId || input.taskEpoch !== task.task_epoch
        || input.goalRevision !== task.goal_revision + 1 || input.mode !== 'command') {
        throw new ContractError('correction requires a new command at the next goal revision');
      }
      const commandDigest = digest(parseJSON(Buffer.from(JSON.stringify(input))));
      this.#db.prepare('INSERT INTO task_corrections VALUES (?, ?, ?, ?)')
        .run(taskId, input.messageId, input.goalRevision, commandDigest);
      this.#db.prepare("UPDATE tasks SET state = 'cancelled' WHERE task_id = ?").run(taskId);
      this.#taskEvent(taskId, `corrected:${input.messageId}:r${input.goalRevision}`);
      this.#settlePrepared(taskId, 'corrected_before_dispatch');
      this.#progress.expire(taskId);
      const unresolved = this.unresolvedAttempts(taskId);
      session.claimForCorrection(input);
      return unresolved;
    });
  }

  /** Records a host-verified terminal result. The caller must own and check the
   * completion predicate; a read-only task can finish without any action.
   * Unknown delivery/effect cannot be silently completed. */
  completeTask(taskId: string, completionEvidenceRef: string): void {
    assertId(taskId, 'task ID');
    assertId(completionEvidenceRef, 'completion evidence reference');
    const task = this.#task(taskId);
    if (!task || task.state !== 'active') throw new ContractError('task is not active');
    this.#budgeted({ taskId, taskEpoch: task.task_epoch,
      goalRevision: task.goal_revision }, false, () => {
      if (this.#db.prepare(`SELECT 1 FROM attempts WHERE task_id = ?
        AND (phase != 'settled' OR delivery_status = 'unknown'
          OR effect_status = 'unknown')`).get(taskId)) {
        throw new ContractError('task has unsettled or unknown attempts');
      }
      const admission = this.#storedAdmission(taskId);
      this.#progress.assertCompletion(taskId, completionEvidenceRef);
      this.#db.prepare('INSERT INTO task_completions VALUES (?, ?, ?)')
        .run(taskId, completionEvidenceRef, admission?.completionVerifierRef
          ?? this.#progress.get(taskId)?.completionVerifierRef ?? null);
      this.#db.prepare(`UPDATE tasks SET state = 'completed' WHERE task_id = ?`)
        .run(taskId);
      this.#taskEvent(taskId, `completed:${completionEvidenceRef}`);
      this.#progress.expire(taskId);
    });
  }

  /** Call only after the new host has exclusive ownership of the journal. */
  recoverAfterRestart(): readonly JournalAttempt[] {
    return this.#transaction(() => {
      const active = this.#db.prepare(`SELECT task_id FROM tasks WHERE state IN ('active', 'paused')`)
        .all() as { task_id: string }[];
      for (const { task_id: taskId } of active) {
        this.#db.prepare(`UPDATE tasks SET state = 'paused' WHERE task_id = ?`).run(taskId);
        this.#taskEvent(taskId, 'paused_after_restart');
        this.#settlePrepared(taskId, 'recovered_before_dispatch');
        this.#progress.expire(taskId);
      }
      return this.unresolvedAttempts();
    });
  }

  getTaskState(taskId: string): TaskRow['state'] | undefined {
    assertId(taskId, 'task ID');
    return this.#task(taskId)?.state;
  }

  /** Unfinished durable tasks keep controller intake blocked after restart.
   * No admission/permit is reconstructed from this diagnostic listing. */
  pendingTaskIds(): readonly string[] {
    const rows = this.#db.prepare("SELECT task_id FROM tasks WHERE state IN ('active', 'paused') ORDER BY task_id")
      .all() as { task_id: string }[];
    return Object.freeze(rows.map(row => row.task_id));
  }

  /** One consistent snapshot of the contract, lifecycle and effect history.
   * A paused record is not a safe-to-retry or safe-to-resume decision. */
  getTaskRecord(taskId: string): JournalTaskRecord | undefined {
    assertId(taskId, 'task ID');
    return this.#transaction(() => {
      const task = this.#task(taskId);
      if (!task) return undefined;
      const row = this.#db.prepare('SELECT * FROM task_completions WHERE task_id = ?')
        .get(taskId) as { evidence_ref: string; completion_verifier_ref: string | null } | undefined;
      const correction = this.#db.prepare('SELECT * FROM task_corrections WHERE task_id = ?')
        .get(taskId) as { command_message_id: string; replacement_goal_revision: number;
          command_digest: string } | undefined;
      return Object.freeze({ taskId, taskEpoch: task.task_epoch,
        goalRevision: task.goal_revision, state: task.state,
        admission: this.#storedAdmission(taskId), budget: this.getTaskBudget(taskId),
        attempts: this.attemptsForTask(taskId),
        progress: this.#progress.get(taskId),
        correction: correction ? Object.freeze({ commandMessageId: correction.command_message_id,
          replacementGoalRevision: correction.replacement_goal_revision,
          commandDigest: correction.command_digest }) : null,
        replacement: this.#replacementLink(taskId, false),
        replaces: this.#replacementLink(taskId, true),
        completion: row ? Object.freeze({ evidenceRef: row.evidence_ref,
          completionVerifierRef: row.completion_verifier_ref }) : null });
    });
  }

  #replacementLink(taskId: string, source: boolean): { readonly taskId: string } | null {
    const row = this.#db.prepare(source
      ? 'SELECT source_task_id AS task_id FROM task_replacements WHERE replacement_task_id = ?'
      : 'SELECT replacement_task_id AS task_id FROM task_replacements WHERE source_task_id = ?')
      .get(taskId) as { task_id: string } | undefined;
    return row ? Object.freeze({ taskId: row.task_id }) : null;
  }

  /** Private host diagnostics. Attempts include failed preflights: minting a
   * fresh execution ID cannot reset retry cost or extend the deadline. */
  getTaskBudget(taskId: string): TaskBudget | undefined {
    assertId(taskId, 'task ID');
    const row = this.#db.prepare('SELECT * FROM task_budgets WHERE task_id = ?')
      .get(taskId) as BudgetRow | undefined;
    if (!row) return undefined;
    return Object.freeze({ maxSteps: row.max_steps, timeoutMs: row.timeout_ms,
      deadlineMillis: row.deadline_ms, stepsUsed: this.#stepsUsed(taskId),
      pauseReason: row.pause_reason });
  }

  getAttempt(executionId: string): JournalAttempt | undefined {
    assertId(executionId, 'execution ID');
    const row = this.#db.prepare('SELECT * FROM attempts WHERE execution_id = ?')
      .get(executionId) as AttemptRow | undefined;
    return row && fromRow(row);
  }

  attemptsForTask(taskId: string): readonly JournalAttempt[] {
    assertId(taskId, 'task ID');
    const rows = this.#db.prepare(`SELECT * FROM attempts
      WHERE task_id = ? ORDER BY rowid`).all(taskId) as unknown as AttemptRow[];
    return Object.freeze(rows.map(fromRow));
  }

  unresolvedAttempts(taskId?: string): readonly JournalAttempt[] {
    if (taskId !== undefined) assertId(taskId, 'task ID');
    const rows = taskId === undefined
      ? this.#db.prepare(`SELECT * FROM attempts WHERE phase = 'at_dispatch_boundary'
          OR delivery_status = 'unknown' OR effect_status = 'unknown'`).all()
      : this.#db.prepare(`SELECT * FROM attempts
          WHERE task_id = ? AND (phase = 'at_dispatch_boundary'
            OR delivery_status = 'unknown' OR effect_status = 'unknown')`).all(taskId);
    return Object.freeze((rows as unknown as AttemptRow[]).map(fromRow));
  }

  eventKinds(executionId: string): readonly string[] {
    assertId(executionId, 'execution ID');
    const rows = this.#db.prepare(`SELECT event_kind FROM attempt_events
      WHERE execution_id = ? ORDER BY sequence`).all(executionId) as { event_kind: string }[];
    return Object.freeze(rows.map(row => row.event_kind));
  }

  taskEventKinds(taskId: string): readonly string[] {
    assertId(taskId, 'task ID');
    const rows = this.#db.prepare(`SELECT event_kind FROM task_events
      WHERE task_id = ? ORDER BY sequence`).all(taskId) as { event_kind: string }[];
    return Object.freeze(rows.map(row => row.event_kind));
  }

  #task(taskId: string): TaskRow | undefined {
    return this.#db.prepare('SELECT * FROM tasks WHERE task_id = ?')
      .get(taskId) as TaskRow | undefined;
  }

  #storedAdmission(taskId: string): TaskAdmission | null {
    const task = this.#task(taskId);
    const row = this.#db.prepare('SELECT * FROM task_admissions WHERE task_id = ?')
      .get(taskId) as { contract_json: string; contract_digest: string } | undefined;
    if (!row) {
      if (task?.admission_digest) throw new ContractError('stored task admission integrity mismatch');
      return null; // Legacy rows remain explicitly unbound.
    }
    const value = parseJSON(Buffer.from(row.contract_json));
    if (!task || !value || typeof value !== 'object' || Array.isArray(value)
      || digest(value) !== row.contract_digest || row.contract_digest !== task.admission_digest
      || value.taskId !== taskId || value.taskEpoch !== task.task_epoch
      || value.goalRevision !== task.goal_revision) {
      throw new ContractError('stored task admission integrity mismatch');
    }
    // Only registry-issued admissions enter this table. Freeze a new diagnostic
    // copy; reading JSON cannot recreate the registry's object-identity authority.
    return freezeJSON(value) as unknown as TaskAdmission;
  }

  #assertAdmittedAttempt(attempt: PreparedAttempt): void {
    const admission = this.#storedAdmission(attempt.taskId);
    if (admission && (admission.scopeRef !== attempt.scopeRef
      || admission.policyRevision !== attempt.policyRevision)) {
      throw new ContractError('attempt scope or policy differs from admitted task');
    }
  }

  /** Opt-in for scripted hosts that own fresh observations and predicates.
   * Existing untracked callers retain their original journal contract. */
  enableTaskProgress(taskId: string, scopeRef: string, completionVerifierRef: string,
    limits: TaskProgressLimits = DEFAULT_PROGRESS_LIMITS): void {
    this.#progressOperation(taskId, () => {
      const admission = this.#storedAdmission(taskId);
      if (admission && (admission.scopeRef !== scopeRef
        || admission.completionVerifierRef !== completionVerifierRef)) {
        throw new ContractError('progress scope or verifier differs from admitted task');
      }
      if (this.attemptsForTask(taskId).length) {
        throw new ContractError('progress must be enabled before any attempt');
      }
      this.#progress.enable(taskId, scopeRef, completionVerifierRef, limits);
      this.#taskEvent(taskId, 'progress_enabled');
    });
  }

  /** Spend before awaiting a read; failed/stale reads still consume the quota.
   * A new reservation expires facts and fences older in-flight observations. */
  reserveTaskObservation(taskId: string, actionable = true): string {
    return this.#progressOperation(taskId, () => this.#progress.reserve(taskId, actionable));
  }

  recordTaskObservation(taskId: string, ticket: string, observed: TaskObservation): void {
    this.#progressOperation(taskId, () => this.#progress.observe(taskId, ticket, observed));
  }

  consumeTaskDecision(taskId: string, observationId: string): void {
    this.#progressOperation(taskId, () => this.#progress.decide(taskId, observationId));
  }

  /** Host-owned predicate checks only; a model choice or action receipt is not
   * a checkpoint. Linked attempts must already have matching settled evidence. */
  recordTaskCheckpoint(taskId: string, checkpoint: TaskCheckpoint): void {
    this.#progressOperation(taskId, () => {
      if (this.attemptsForTask(taskId).some(attempt => attempt.phase !== 'settled'
        || attempt.outcome?.effectStatus === 'unknown'
        || attempt.outcome?.deliveryStatus === 'unknown')) {
        throw new ContractError('checkpoint has unresolved or unknown effects');
      }
      if (checkpoint.executionId) {
        const attempt = this.#requiredAttempt(checkpoint.executionId);
        if (attempt.taskId !== taskId || attempt.phase !== 'settled'
          || attempt.outcome?.verification !== 'matched'
          || attempt.outcome.evidenceRef !== checkpoint.evidenceRef) {
          throw new ContractError('checkpoint does not match settled attempt evidence');
        }
      }
      this.#progress.checkpoint(taskId, checkpoint);
      this.#taskEvent(taskId, `checkpoint:${checkpoint.stageRef}`);
    });
  }

  getTaskProgress(taskId: string): TaskProgress | null {
    assertId(taskId, 'task ID');
    return this.#progress.get(taskId);
  }

  /** Only a bounded independent read is permitted while paused. Spend the
   * existing quota before awaiting; each new reservation fences older reads. */
  reserveTaskRecoveryObservation(taskId: string): string {
    return this.#progressOperation(taskId, () => {
      const context = this.#recoveryContext(taskId);
      const ticket = this.#progress.reserve(taskId, false);
      if (ticket instanceof TaskProgressExceeded) return ticket;
      this.#db.prepare(`INSERT INTO task_recovery_reads
        (ticket, task_id, deadline_ms, checkpoint_ref, history_digest) VALUES (?, ?, ?, ?, ?)`)
        .run(ticket, taskId, Math.min(this.getTaskBudget(taskId)!.deadlineMillis,
          this.#lastBudgetTime(taskId) + TASK_RECOVERY_READ_TTL_MS),
          context.checkpoint.checkpointId, context.historyDigest);
      return ticket;
    }, 'paused');
  }

  /** Caller owns the fresh predicate check. This journals its scope-bound
   * evidence and returns exactly what a Resume presentation must reference. */
  recordTaskRecoveryObservation(taskId: string, ticket: string, observed: TaskObservation,
    verified: RecoveryPredicateEvidence): TaskRecoveryBinding {
    return this.#progressOperation(taskId, () => {
      const context = this.#recoveryContext(taskId);
      const read = this.#recoveryRead(taskId, ticket);
      assertId(verified.evidenceRef, 'recovery evidence reference');
      if (read.observation_id !== null || read.history_digest !== context.historyDigest
        || read.checkpoint_ref !== context.checkpoint.checkpointId
        || verified.checkpointRef !== context.checkpoint.checkpointId
        || verified.predicateRef !== context.checkpoint.predicateRef) {
        throw new ContractError('recovery checkpoint or predicate changed');
      }
      const failure = this.#progress.observe(taskId, ticket, observed);
      if (failure instanceof TaskProgressExceeded) return failure;
      const checkpointDigest = digest({ historyDigest: context.historyDigest,
        ticket, observation: { observationId: observed.observationId, scopeRef: observed.scopeRef,
          stateDigest: observed.stateDigest }, evidence: { checkpointRef: verified.checkpointRef,
          predicateRef: verified.predicateRef, evidenceRef: verified.evidenceRef } });
      this.#db.prepare(`UPDATE task_recovery_reads SET observation_id = ?,
        binding_digest = ?, evidence_ref = ? WHERE ticket = ?`)
        .run(observed.observationId, checkpointDigest, verified.evidenceRef, ticket);
      const task = this.#task(taskId)!;
      return Object.freeze({ taskId, taskEpoch: task.task_epoch, goalRevision: task.goal_revision,
        state: 'paused', checkpointRef: read.checkpoint_ref, checkpointDigest,
        recoveryObservationId: observed.observationId });
    }, 'paused');
  }

  /** Consume exact native-UI intent after a fresh checkpoint revalidation.
   * Reactivation expires the recovery read: it cannot authorize an action or
   * complete the task. A new actionable read and predicate check are required. */
  resumeTask(ledger: UserPromptLedger, intent: ResumeRequest): void {
    this.#progressOperation(intent.taskId, () => {
      const task = this.#task(intent.taskId)!;
      const context = this.#recoveryContext(intent.taskId);
      if (intent.taskEpoch !== task.task_epoch || intent.goalRevision !== task.goal_revision) {
        throw new ContractError('resume task revision mismatch');
      }
      const read = this.#db.prepare(`SELECT * FROM task_recovery_reads
        WHERE task_id = ? AND observation_id = ?`).get(intent.taskId,
        intent.recoveryObservationId) as RecoveryReadRow | undefined;
      if (!read) throw new ContractError('resume has no recovery observation');
      this.#recoveryRead(intent.taskId, read.ticket);
      this.#progress.assertCurrent(intent.taskId, intent.recoveryObservationId, false);
      const current = context.progress.currentObservation!;
      const expectedDigest = digest({ historyDigest: context.historyDigest, ticket: read.ticket,
        observation: { observationId: current.observationId, scopeRef: current.scopeRef,
          stateDigest: current.stateDigest }, evidence: { checkpointRef: read.checkpoint_ref,
          predicateRef: context.checkpoint.predicateRef, evidenceRef: read.evidence_ref } });
      if (read.history_digest !== context.historyDigest
        || intent.checkpointRef !== read.checkpoint_ref
        || intent.checkpointDigest !== read.binding_digest || read.binding_digest !== expectedDigest) {
        throw new ContractError('resume checkpoint binding changed');
      }
      if (context.progress.observationsUsed >= context.progress.maxObservations
        || context.progress.decisionsUsed >= context.progress.maxDecisions) {
        return new TaskProgressExceeded(context.progress.observationsUsed >= context.progress.maxObservations
          ? 'observations' : 'decisions');
      }
      this.#db.prepare('INSERT INTO task_resume_intents VALUES (?, ?, ?, ?, ?)')
        .run(intent.messageId, intent.taskId, read.ticket, intent.promptId, intent.presentationDigest);
      this.#db.prepare("UPDATE tasks SET state = 'active' WHERE task_id = ?").run(intent.taskId);
      this.#taskEvent(intent.taskId, `resumed:${intent.messageId}`);
      this.#progress.expire(intent.taskId);
      // Claim last so ordinary validation/SQL failures leave a genuine intent
      // unconsumed. A commit failure may consume it, but never authorize replay.
      ledger.claimForRecovery(intent);
    }, 'paused');
  }

  #lastBudgetTime(taskId: string): number {
    return (this.#db.prepare('SELECT last_checked_ms FROM task_budgets WHERE task_id = ?')
      .get(taskId) as { last_checked_ms: number }).last_checked_ms;
  }

  #recoveryRead(taskId: string, ticket: string): RecoveryReadRow {
    assertId(ticket, 'recovery ticket');
    const read = this.#db.prepare('SELECT * FROM task_recovery_reads WHERE ticket = ?')
      .get(ticket) as RecoveryReadRow | undefined;
    if (!read || read.task_id !== taskId || this.#lastBudgetTime(taskId) >= read.deadline_ms) {
      throw new ContractError('missing or expired recovery read');
    }
    return read;
  }

  #recoveryContext(taskId: string): {
    progress: TaskProgress; checkpoint: TaskCheckpoint; historyDigest: string;
  } {
    const admission = this.#storedAdmission(taskId);
    const progress = this.#progress.get(taskId);
    const checkpoint = progress?.checkpoints.at(-1);
    if (!admission || !progress || !checkpoint || progress.scopeRef !== admission.scopeRef
      || progress.completionVerifierRef !== admission.completionVerifierRef) {
      throw new ContractError('recovery requires an admitted task and verified checkpoint');
    }
    if (progress.pauseReason) throw new TaskProgressExceeded(progress.pauseReason);
    if (this.#db.prepare("SELECT 1 FROM tasks WHERE state = 'active'").get()
      || this.#db.prepare("SELECT 1 FROM attempts WHERE phase = 'prepared'").get()
      || this.unresolvedAttempts().length) {
      throw new ContractError('recovery blocked by active execution or unresolved/unknown effects');
    }
    const attempts = this.attemptsForTask(taskId);
    for (const attempt of attempts) {
      if (attempt.outcome?.effectStatus === 'applied' && (attempt.outcome.verification !== 'matched'
        || !progress.checkpoints.some(value => value.executionId === attempt.executionId
          && value.evidenceRef === attempt.outcome?.evidenceRef))) {
        throw new ContractError('recovery has an applied effect without a verified checkpoint');
      }
    }
    // Include lifecycle and outcome history to fence replies if either changes
    // while the independent read or user presentation is pending.
    const events = this.taskEventKinds(taskId);
    const historyDigest = digest(parseJSON(Buffer.from(JSON.stringify({ admission, attempts,
      checkpoints: progress.checkpoints.map(({ current: _current, ...value }) => value), events }))));
    return { progress, checkpoint, historyDigest };
  }

  #assertProgressAttempt(attempt: PreparedAttempt): void {
    const progress = this.#progress.get(attempt.taskId);
    if (!progress) return;
    if (progress.scopeRef !== attempt.scopeRef) throw new ContractError('attempt progress scope differs');
    this.#progress.assertCurrent(attempt.taskId, attempt.observationId, true);
  }

  #progressOperation<T>(taskId: string, operation: () => T | TaskProgressExceeded,
    expectedState: 'active' | 'paused' = 'active'): T {
    assertId(taskId, 'task ID');
    const task = this.#task(taskId);
    if (!task) throw new ContractError('unknown task');
    const result = this.#budgeted({ taskId, taskEpoch: task.task_epoch,
      goalRevision: task.goal_revision }, false, () => {
      const value = operation();
      if (value instanceof TaskProgressExceeded) {
        this.#db.prepare("UPDATE tasks SET state = 'paused' WHERE task_id = ?").run(taskId);
        this.#taskEvent(taskId, `paused_budget:${value.reason}`);
        this.#settlePrepared(taskId, 'progress_budget_before_dispatch');
        this.#progress.expire(taskId, value.reason);
      }
      return value;
    }, expectedState);
    // Pause and prepared-attempt settlement must commit before surfacing failure.
    if (result instanceof TaskProgressExceeded) throw result;
    return result;
  }

  #migrateLegacyTasks(): void {
    const row = this.#db.prepare(`SELECT sql FROM sqlite_schema
      WHERE type = 'table' AND name = 'tasks'`).get() as { sql: string } | undefined;
    if (!row) return;
    if (row.sql.includes("'completed'")) return;
    if (!row.sql.includes("CHECK(state IN ('active', 'cancelled', 'paused'))")) {
      throw new ContractError('unsupported journal task schema');
    }
    // SQLite's documented rebuild sequence keeps child FKs pointing at tasks.
    // Do not rename the old table first: that would rewrite FK references.
    this.#db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
    try {
      this.#db.exec(`
        CREATE TABLE tasks_next (
          task_id TEXT PRIMARY KEY, task_epoch INTEGER NOT NULL,
          goal_revision INTEGER NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('active', 'cancelled', 'paused', 'completed'))
        );
        INSERT INTO tasks_next SELECT task_id, task_epoch, goal_revision, state FROM tasks;
        DROP TABLE tasks;
        ALTER TABLE tasks_next RENAME TO tasks;
        COMMIT;
      `);
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    } finally {
      this.#db.exec('PRAGMA foreign_keys = ON');
    }
  }

  #assertActive(attempt: Pick<PreparedAttempt, 'taskId' | 'taskEpoch' | 'goalRevision'>,
    expectedState: 'active' | 'paused'): void {
    const task = this.#task(attempt.taskId);
    if (!task || task.state !== expectedState || task.task_epoch !== attempt.taskEpoch
      || task.goal_revision !== attempt.goalRevision) {
      throw new ContractError(`task revision is not ${expectedState}`);
    }
  }

  #stepsUsed(taskId: string): number {
    return (this.#db.prepare('SELECT COUNT(*) AS count FROM attempts WHERE task_id = ?')
      .get(taskId) as { count: number }).count;
  }

  #budgeted<T>(revision: Pick<PreparedAttempt, 'taskId' | 'taskEpoch' | 'goalRevision'>,
    newStep: boolean, body: () => T, expectedState: 'active' | 'paused' = 'active'): T {
    const result = this.#transaction((): { value: T } | { failure: TaskBudgetExceeded } => {
      this.#assertActive(revision, expectedState);
      const row = this.#db.prepare('SELECT * FROM task_budgets WHERE task_id = ?')
        .get(revision.taskId) as BudgetRow | undefined;
      const now = this.#clock();
      const reason: TaskBudget['pauseReason'] = !row ? 'missing'
        : row.pause_reason ? row.pause_reason
        : !Number.isSafeInteger(now) || now < row.last_checked_ms ? 'clock'
          : now >= row.deadline_ms ? 'time'
            : (newStep || expectedState === 'paused')
              && this.#stepsUsed(revision.taskId) >= row.max_steps ? 'steps' : null;
      if (reason) {
        this.#db.prepare("UPDATE tasks SET state = 'paused' WHERE task_id = ?")
          .run(revision.taskId);
        this.#db.prepare('UPDATE task_budgets SET pause_reason = ? WHERE task_id = ?')
          .run(reason, revision.taskId);
        this.#taskEvent(revision.taskId, `paused_budget:${reason}`);
        this.#settlePrepared(revision.taskId, 'budget_before_dispatch');
        this.#progress.expire(revision.taskId);
        // Commit the pause before throwing. Unknown/dispatched effects stay
        // untouched; a budget is not an OS cancellation barrier or an undo.
        return { failure: new TaskBudgetExceeded(reason) };
      }
      this.#db.prepare('UPDATE task_budgets SET last_checked_ms = ? WHERE task_id = ?')
        .run(now, revision.taskId);
      return { value: body() };
    });
    if ('failure' in result) throw result.failure;
    return result.value;
  }

  #requiredAttempt(executionId: string): JournalAttempt {
    const attempt = this.getAttempt(executionId);
    if (!attempt) throw new ContractError('unknown execution ID');
    return attempt;
  }

  #settlePrepared(taskId: string, eventKind: string): void {
    const rows = this.#db.prepare(`SELECT execution_id FROM attempts
      WHERE task_id = ? AND phase = 'prepared'`).all(taskId) as { execution_id: string }[];
    for (const { execution_id: executionId } of rows) {
      this.#settle(executionId, {
        deliveryStatus: 'not_dispatched', effectStatus: 'not_applied',
        verification: 'unavailable',
      }, eventKind);
    }
  }

  #settle(executionId: string, outcome: AttemptOutcome, eventKind: string): void {
    this.#db.prepare(`UPDATE attempts SET phase = 'settled', delivery_status = ?,
      effect_status = ?, verification = ?, evidence_ref = ? WHERE execution_id = ?`)
      .run(outcome.deliveryStatus, outcome.effectStatus, outcome.verification,
        outcome.evidenceRef ?? null, executionId);
    this.#event(executionId, eventKind);
  }

  #event(executionId: string, eventKind: string): void {
    this.#db.prepare(`INSERT INTO attempt_events
      (execution_id, event_kind, recorded_at) VALUES (?, ?, ?)`)
      .run(executionId, eventKind, new Date().toISOString());
  }

  #taskEvent(taskId: string, eventKind: string): void {
    this.#db.prepare(`INSERT INTO task_events
      (task_id, event_kind, recorded_at) VALUES (?, ?, ?)`)
      .run(taskId, eventKind, new Date().toISOString());
  }

  #transaction<T>(body: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
}

function fromRow(row: AttemptRow): JournalAttempt {
  const base: PreparedAttempt = {
    executionId: row.execution_id, permitRef: row.permit_ref, taskId: row.task_id,
    taskEpoch: row.task_epoch, goalRevision: row.goal_revision,
    scopeRef: row.scope_ref, observationId: row.observation_id,
    candidateId: row.candidate_id, candidateSetDigest: row.candidate_set_digest,
    actionDigest: row.action_digest, policyRevision: row.policy_revision,
    leaseGeneration: row.lease_generation,
  };
  validatePrepared(base);
  if (!['prepared', 'at_dispatch_boundary', 'settled'].includes(row.phase)) {
    throw new ContractError('invalid stored attempt phase');
  }
  if (row.phase !== 'settled') {
    if (row.delivery_status || row.effect_status || row.verification || row.evidence_ref) {
      throw new ContractError('unsettled attempt has outcome fields');
    }
    return Object.freeze({ ...base, phase: row.phase });
  }
  if (!row.delivery_status || !row.effect_status || !row.verification) {
    throw new ContractError('settled attempt is missing outcome fields');
  }
  const outcome: AttemptOutcome = {
    deliveryStatus: row.delivery_status, effectStatus: row.effect_status,
    verification: row.verification,
    ...(row.evidence_ref ? { evidenceRef: row.evidence_ref } : {}),
  };
  validateOutcome(outcome);
  return Object.freeze({ ...base, phase: row.phase, outcome: Object.freeze(outcome) });
}

function assertId(value: string, label: string): void {
  if (!ID.test(value)) throw new ContractError(`invalid ${label}`);
}

function freezeJSON(value: JSONValue): JSONValue {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJSON(child);
    Object.freeze(value);
  }
  return value;
}

function assertCounter(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new ContractError(`invalid ${label}`);
}

function validatePrepared(value: PreparedAttempt): void {
  assertId(value.executionId, 'execution ID');
  assertId(value.permitRef, 'permit reference');
  assertId(value.taskId, 'task ID');
  assertCounter(value.taskEpoch, 'task epoch');
  assertCounter(value.goalRevision, 'goal revision');
  assertId(value.scopeRef, 'scope reference');
  assertId(value.observationId, 'observation ID');
  assertId(value.candidateId, 'candidate ID');
  if (!DIGEST.test(value.candidateSetDigest)) throw new ContractError('invalid candidate set digest');
  if (!DIGEST.test(value.actionDigest)) throw new ContractError('invalid action digest');
  assertId(value.policyRevision, 'policy revision');
  assertCounter(value.leaseGeneration, 'lease generation');
  if (value.leaseGeneration < 1) throw new ContractError('invalid lease generation');
}

function validateOutcome(value: AttemptOutcome): void {
  if (!['not_dispatched', 'dispatched', 'unknown'].includes(value.deliveryStatus)
    || !['not_applied', 'applied', 'unknown'].includes(value.effectStatus)
    || !['matched', 'not_matched', 'unavailable'].includes(value.verification)) {
    throw new ContractError('invalid attempt outcome');
  }
  if (value.deliveryStatus === 'not_dispatched' && value.effectStatus !== 'not_applied') {
    throw new ContractError('effect cannot apply without dispatch');
  }
  if (value.effectStatus === 'unknown' && value.verification === 'matched') {
    throw new ContractError('unknown effect cannot verify success');
  }
  if (value.verification === 'matched' && !value.evidenceRef) {
    throw new ContractError('matched verification requires evidence');
  }
  if (value.evidenceRef !== undefined) assertId(value.evidenceRef, 'evidence reference');
}
