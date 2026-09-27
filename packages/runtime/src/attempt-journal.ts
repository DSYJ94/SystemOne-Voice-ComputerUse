import { DatabaseSync } from 'node:sqlite';
import { ContractError } from '../../protocol/src/json.ts';

const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const DIGEST = /^[a-f0-9]{64}$/;

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

interface TaskRow {
  task_epoch: number;
  goal_revision: number;
  state: 'active' | 'cancelled' | 'paused' | 'completed';
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

  constructor(path: string) {
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
    `);
    const broken = this.#db.prepare('PRAGMA foreign_key_check').get();
    if (broken) throw new ContractError('journal foreign-key check failed');
  }

  close(): void { this.#db.close(); }

  startTask(taskId: string, taskEpoch: number, goalRevision: number): void {
    assertId(taskId, 'task ID');
    assertCounter(taskEpoch, 'task epoch');
    assertCounter(goalRevision, 'goal revision');
    this.#transaction(() => {
      if (this.#db.prepare('SELECT 1 FROM tasks WHERE state = ?').get('active')) {
        throw new ContractError('another task is active');
      }
      if (this.#db.prepare(`SELECT 1 FROM attempts
        WHERE phase IN ('prepared', 'at_dispatch_boundary')
          OR delivery_status = 'unknown' OR effect_status = 'unknown'`).get()) {
        throw new ContractError('an earlier attempt is unresolved or unknown');
      }
      this.#db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)')
        .run(taskId, taskEpoch, goalRevision, 'active');
      this.#taskEvent(taskId, 'started');
    });
  }

  prepare(attempt: PreparedAttempt): JournalAttempt {
    validatePrepared(attempt);
    return this.#transaction(() => {
      this.#assertActive(attempt);
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
    return this.#transaction(() => {
      const attempt = this.#requiredAttempt(executionId);
      if (attempt.phase !== 'prepared') throw new ContractError('attempt is not prepared');
      this.#assertActive(attempt);
      this.#db.prepare(`UPDATE attempts SET phase = 'at_dispatch_boundary'
        WHERE execution_id = ?`).run(executionId);
      this.#event(executionId, 'dispatch_boundary');
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
      if (!task || task.state !== 'active') throw new ContractError('task is not active');
      this.#db.prepare(`UPDATE tasks SET state = 'cancelled' WHERE task_id = ?`).run(taskId);
      this.#taskEvent(taskId, 'cancelled');
      this.#settlePrepared(taskId, 'cancelled_before_dispatch');
      return this.unresolvedAttempts(taskId);
    });
  }

  /** Records a host-verified terminal result. The caller must own and check the
   * completion predicate; a read-only task can finish without any action.
   * Unknown delivery/effect cannot be silently completed. */
  completeTask(taskId: string, completionEvidenceRef: string): void {
    assertId(taskId, 'task ID');
    assertId(completionEvidenceRef, 'completion evidence reference');
    this.#transaction(() => {
      const task = this.#task(taskId);
      if (!task || task.state !== 'active') throw new ContractError('task is not active');
      if (this.#db.prepare(`SELECT 1 FROM attempts WHERE task_id = ?
        AND (phase != 'settled' OR delivery_status = 'unknown'
          OR effect_status = 'unknown')`).get(taskId)) {
        throw new ContractError('task has unsettled or unknown attempts');
      }
      this.#db.prepare(`UPDATE tasks SET state = 'completed' WHERE task_id = ?`)
        .run(taskId);
      this.#taskEvent(taskId, `completed:${completionEvidenceRef}`);
    });
  }

  /** Call only after the new host has exclusive ownership of the journal. */
  recoverAfterRestart(): readonly JournalAttempt[] {
    return this.#transaction(() => {
      const active = this.#db.prepare(`SELECT task_id FROM tasks WHERE state = 'active'`)
        .all() as { task_id: string }[];
      for (const { task_id: taskId } of active) {
        this.#db.prepare(`UPDATE tasks SET state = 'paused' WHERE task_id = ?`).run(taskId);
        this.#taskEvent(taskId, 'paused_after_restart');
        this.#settlePrepared(taskId, 'recovered_before_dispatch');
      }
      return this.unresolvedAttempts();
    });
  }

  getTaskState(taskId: string): TaskRow['state'] | undefined {
    assertId(taskId, 'task ID');
    return this.#task(taskId)?.state;
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

  #assertActive(attempt: Pick<PreparedAttempt, 'taskId' | 'taskEpoch' | 'goalRevision'>): void {
    const task = this.#task(attempt.taskId);
    if (!task || task.state !== 'active' || task.task_epoch !== attempt.taskEpoch
      || task.goal_revision !== attempt.goalRevision) {
      throw new ContractError('task revision is not active');
    }
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
