import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ContractError } from '../../protocol/src/json.ts';

const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export interface TaskProgressLimits {
  readonly maxObservations: number;
  readonly maxDecisions: number;
  readonly maxStateVisits: number;
}

export const DEFAULT_PROGRESS_LIMITS: TaskProgressLimits = Object.freeze({
  maxObservations: 90, maxDecisions: 30, maxStateVisits: 3,
});

export type ProgressPauseReason = 'observations' | 'decisions' | 'no_progress';
export class TaskProgressExceeded extends ContractError {
  readonly reason: ProgressPauseReason;
  constructor(reason: ProgressPauseReason) {
    super(`task ${reason} budget exhausted`);
    this.reason = reason;
  }
}

export interface TaskObservation {
  readonly observationId: string;
  readonly scopeRef: string;
  /** Semantic state only: exclude ephemeral handles, IDs and timestamps. */
  readonly stateDigest: string;
}

export interface TaskCheckpoint {
  readonly checkpointId: string;
  readonly observationId: string;
  readonly stageRef: string;
  readonly predicateRef: string;
  readonly evidenceRef: string;
  readonly executionId?: string;
  readonly terminal: boolean;
}

export interface TaskProgress extends TaskProgressLimits {
  readonly scopeRef: string;
  readonly completionVerifierRef: string;
  readonly observationsUsed: number;
  readonly decisionsUsed: number;
  readonly pauseReason: ProgressPauseReason | null;
  readonly currentObservation: (TaskObservation & { readonly actionable: boolean }) | null;
  readonly checkpoints: readonly (TaskCheckpoint & { readonly current: boolean })[];
}

interface ProgressRow {
  scope_ref: string;
  completion_verifier_ref: string;
  max_observations: number;
  max_decisions: number;
  max_state_visits: number;
  observations_used: number;
  decisions_used: number;
  progress_generation: number;
  current_ticket: string | null;
  current_observation: string | null;
  current_checkpoint: string | null;
  pause_reason: ProgressPauseReason | null;
}

interface ObservationRow {
  task_id: string;
  generation: number;
  actionable: number;
  observation_id: string | null;
  state_digest: string | null;
}

interface CheckpointRow {
  checkpoint_id: string;
  observation_id: string;
  stage_ref: string;
  predicate_ref: string;
  evidence_ref: string;
  execution_id: string | null;
  terminal: number;
}

/** Uses the journal's connection and transactions. These methods are internal
 * persistence helpers; only AttemptJournal may own lifecycle transitions. */
export class TaskProgressStore {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_progress (
        task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
        scope_ref TEXT NOT NULL, completion_verifier_ref TEXT NOT NULL,
        max_observations INTEGER NOT NULL, max_decisions INTEGER NOT NULL,
        max_state_visits INTEGER NOT NULL,
        observations_used INTEGER NOT NULL DEFAULT 0,
        decisions_used INTEGER NOT NULL DEFAULT 0,
        progress_generation INTEGER NOT NULL DEFAULT 0,
        current_ticket TEXT, current_observation TEXT, current_checkpoint TEXT,
        pause_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS task_observations (
        ticket TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id),
        generation INTEGER NOT NULL, actionable INTEGER NOT NULL,
        observation_id TEXT, state_digest TEXT,
        UNIQUE(task_id, generation), UNIQUE(task_id, observation_id)
      );
      CREATE TABLE IF NOT EXISTS task_checkpoints (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, checkpoint_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(task_id), observation_id TEXT NOT NULL,
        stage_ref TEXT NOT NULL, predicate_ref TEXT NOT NULL,
        evidence_ref TEXT NOT NULL, execution_id TEXT, terminal INTEGER NOT NULL
      );
    `);
  }

  enable(taskId: string, scopeRef: string, verifierRef: string, limits: TaskProgressLimits): void {
    assertId(scopeRef); assertId(verifierRef);
    if (![limits.maxObservations, limits.maxDecisions, limits.maxStateVisits]
      .every(value => Number.isSafeInteger(value) && value >= 1 && value <= 1000)) {
      throw new ContractError('invalid task progress limits');
    }
    if (this.#row(taskId)) throw new ContractError('task progress already enabled');
    this.#db.prepare(`INSERT INTO task_progress
      (task_id, scope_ref, completion_verifier_ref, max_observations, max_decisions, max_state_visits)
      VALUES (?, ?, ?, ?, ?, ?)`).run(taskId, scopeRef, verifierRef,
      limits.maxObservations, limits.maxDecisions, limits.maxStateVisits);
  }

  reserve(taskId: string, actionable: boolean): string | TaskProgressExceeded {
    const row = this.#required(taskId);
    if (typeof actionable !== 'boolean') throw new ContractError('invalid observation kind');
    if (row.observations_used >= row.max_observations) return new TaskProgressExceeded('observations');
    const ticket = randomUUID();
    const generation = row.observations_used + 1;
    this.#db.prepare('INSERT INTO task_observations VALUES (?, ?, ?, ?, NULL, NULL)')
      .run(ticket, taskId, generation, actionable ? 1 : 0);
    this.#db.prepare(`UPDATE task_progress SET observations_used = ?, current_ticket = ?,
      current_observation = NULL, current_checkpoint = NULL WHERE task_id = ?`)
      .run(generation, ticket, taskId);
    return ticket;
  }

  observe(taskId: string, ticket: string, observed: TaskObservation): void | TaskProgressExceeded {
    assertId(ticket); assertId(observed.observationId); assertId(observed.scopeRef);
    if (!DIGEST.test(observed.stateDigest)) throw new ContractError('invalid semantic state digest');
    const row = this.#required(taskId);
    const reservation = this.#db.prepare('SELECT * FROM task_observations WHERE ticket = ?')
      .get(ticket) as ObservationRow | undefined;
    if (!reservation || reservation.task_id !== taskId || row.current_ticket !== ticket
      || reservation.observation_id !== null || observed.scopeRef !== row.scope_ref) {
      throw new ContractError('stale observation reservation or scope');
    }
    const visits = (this.#db.prepare(`SELECT COUNT(*) AS count FROM task_observations
      WHERE task_id = ? AND generation > ? AND state_digest = ?`)
      .get(taskId, row.progress_generation, observed.stateDigest) as { count: number }).count;
    if (visits >= row.max_state_visits) return new TaskProgressExceeded('no_progress');
    this.#db.prepare('UPDATE task_observations SET observation_id = ?, state_digest = ? WHERE ticket = ?')
      .run(observed.observationId, observed.stateDigest, ticket);
    this.#db.prepare('UPDATE task_progress SET current_observation = ? WHERE task_id = ?')
      .run(observed.observationId, taskId);
  }

  decide(taskId: string, observationId: string): void | TaskProgressExceeded {
    this.assertCurrent(taskId, observationId, true);
    const row = this.#required(taskId);
    if (row.decisions_used >= row.max_decisions) return new TaskProgressExceeded('decisions');
    this.#db.prepare('UPDATE task_progress SET decisions_used = decisions_used + 1 WHERE task_id = ?')
      .run(taskId);
  }

  checkpoint(taskId: string, value: TaskCheckpoint): void {
    for (const id of [value.checkpointId, value.observationId, value.stageRef,
      value.predicateRef, value.evidenceRef]) assertId(id);
    if (value.executionId !== undefined) assertId(value.executionId);
    if (typeof value.terminal !== 'boolean') throw new ContractError('invalid terminal checkpoint');
    this.assertCurrent(taskId, value.observationId, false);
    const row = this.#required(taskId);
    if (value.terminal && value.predicateRef !== row.completion_verifier_ref) {
      throw new ContractError('terminal predicate differs from task verifier');
    }
    const previouslyVerified = this.#db.prepare(`SELECT 1 FROM task_checkpoints
      WHERE task_id = ? AND stage_ref = ? LIMIT 1`).get(taskId, value.stageRef);
    this.#db.prepare(`INSERT INTO task_checkpoints
      (checkpoint_id, task_id, observation_id, stage_ref, predicate_ref, evidence_ref, execution_id, terminal)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(value.checkpointId, taskId, value.observationId,
      value.stageRef, value.predicateRef, value.evidenceRef, value.executionId ?? null, value.terminal ? 1 : 0);
    // Refreshing the same stage is not new progress and cannot reset a loop budget.
    this.#db.prepare(`UPDATE task_progress SET current_checkpoint = ?,
      progress_generation = ? WHERE task_id = ?`).run(value.checkpointId,
      previouslyVerified ? row.progress_generation : row.observations_used, taskId);
  }

  assertCurrent(taskId: string, observationId: string, actionable: boolean): void {
    assertId(observationId);
    const row = this.#required(taskId);
    const current = this.#current(row);
    if (row.current_observation !== observationId || !current
      || (actionable && !current.actionable)) {
      throw new ContractError('task observation is not current or actionable');
    }
  }

  assertCompletion(taskId: string, evidenceRef: string): void {
    const row = this.#row(taskId);
    if (!row) return;
    const checkpoint = this.#db.prepare('SELECT * FROM task_checkpoints WHERE checkpoint_id = ?')
      .get(row.current_checkpoint) as CheckpointRow | undefined;
    if (!checkpoint || checkpoint.terminal !== 1 || checkpoint.evidence_ref !== evidenceRef
      || checkpoint.predicate_ref !== row.completion_verifier_ref
      || checkpoint.observation_id !== row.current_observation) {
      throw new ContractError('completion requires a current terminal checkpoint');
    }
  }

  expire(taskId: string, reason?: ProgressPauseReason): void {
    this.#db.prepare(`UPDATE task_progress SET current_ticket = NULL,
      current_observation = NULL, current_checkpoint = NULL,
      pause_reason = COALESCE(?, pause_reason) WHERE task_id = ?`).run(reason ?? null, taskId);
  }

  get(taskId: string): TaskProgress | null {
    const row = this.#row(taskId);
    if (!row) return null;
    const checkpoints = this.#db.prepare('SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY sequence')
      .all(taskId) as unknown as CheckpointRow[];
    return Object.freeze({ scopeRef: row.scope_ref, completionVerifierRef: row.completion_verifier_ref,
      maxObservations: row.max_observations, maxDecisions: row.max_decisions,
      maxStateVisits: row.max_state_visits, observationsUsed: row.observations_used,
      decisionsUsed: row.decisions_used, pauseReason: row.pause_reason,
      currentObservation: this.#current(row), checkpoints: Object.freeze(checkpoints.map(value =>
        Object.freeze({ checkpointId: value.checkpoint_id, observationId: value.observation_id,
          stageRef: value.stage_ref, predicateRef: value.predicate_ref, evidenceRef: value.evidence_ref,
          ...(value.execution_id ? { executionId: value.execution_id } : {}), terminal: value.terminal === 1,
          current: value.checkpoint_id === row.current_checkpoint
            && value.observation_id === row.current_observation }))) });
  }

  #current(row: ProgressRow): TaskProgress['currentObservation'] {
    if (!row.current_ticket || !row.current_observation) return null;
    const value = this.#db.prepare('SELECT * FROM task_observations WHERE ticket = ?')
      .get(row.current_ticket) as ObservationRow | undefined;
    if (!value || value.observation_id !== row.current_observation || !value.state_digest) {
      throw new ContractError('task observation integrity mismatch');
    }
    return Object.freeze({ observationId: value.observation_id, scopeRef: row.scope_ref,
      stateDigest: value.state_digest, actionable: value.actionable === 1 });
  }

  #required(taskId: string): ProgressRow {
    const row = this.#row(taskId);
    if (!row) throw new ContractError('task progress is not enabled');
    return row;
  }

  #row(taskId: string): ProgressRow | undefined {
    return this.#db.prepare('SELECT * FROM task_progress WHERE task_id = ?').get(taskId) as ProgressRow | undefined;
  }
}

function assertId(value: string): void {
  if (!ID.test(value)) throw new ContractError('invalid task progress reference');
}
