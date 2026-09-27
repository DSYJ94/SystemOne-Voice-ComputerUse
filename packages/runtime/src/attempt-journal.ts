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
  readonly actionDigest: string;
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
  state: 'active' | 'cancelled' | 'paused';
}

interface AttemptRow {
  execution_id: string;
  permit_ref: string;
  task_id: string;
  task_epoch: number;
  goal_revision: number;
  scope_ref: string;
  action_digest: string;
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
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        task_epoch INTEGER NOT NULL,
        goal_revision INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'cancelled', 'paused'))
      );
      CREATE TABLE IF NOT EXISTS attempts (
        execution_id TEXT PRIMARY KEY,
        permit_ref TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        task_epoch INTEGER NOT NULL,
        goal_revision INTEGER NOT NULL,
        scope_ref TEXT NOT NULL,
        action_digest TEXT NOT NULL,
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
        WHERE phase IN ('prepared', 'at_dispatch_boundary')`).get()) {
        throw new ContractError('an earlier attempt is unresolved');
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
         action_digest, phase) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared')`)
        .run(attempt.executionId, attempt.permitRef, attempt.taskId,
          attempt.taskEpoch, attempt.goalRevision, attempt.scopeRef, attempt.actionDigest);
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

  unresolvedAttempts(taskId?: string): readonly JournalAttempt[] {
    if (taskId !== undefined) assertId(taskId, 'task ID');
    const rows = taskId === undefined
      ? this.#db.prepare(`SELECT * FROM attempts WHERE phase = 'at_dispatch_boundary'`).all()
      : this.#db.prepare(`SELECT * FROM attempts
          WHERE phase = 'at_dispatch_boundary' AND task_id = ?`).all(taskId);
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
    scopeRef: row.scope_ref, actionDigest: row.action_digest,
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
  if (!DIGEST.test(value.actionDigest)) throw new ContractError('invalid action digest');
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
