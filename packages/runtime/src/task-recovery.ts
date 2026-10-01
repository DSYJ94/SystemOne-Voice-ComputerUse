import type { TaskRevision } from '../../protocol/src/session.ts';

/** Engineering freshness bound, starting before the host awaits its read. */
export const TASK_RECOVERY_READ_TTL_MS = 30_000;

/** The host must independently recheck the historical predicate in the admitted
 * scope. A candidate, action receipt or user reply cannot supply this evidence. */
export interface RecoveryPredicateEvidence {
  readonly checkpointRef: string;
  readonly predicateRef: string;
  readonly evidenceRef: string;
}

/** Host presentation data, not a permit, admission or serialized authority. */
export interface TaskRecoveryBinding extends TaskRevision {
  readonly state: 'paused';
  readonly checkpointRef: string;
  readonly checkpointDigest: string;
  readonly recoveryObservationId: string;
}

export interface RecoveryReadRow {
  readonly ticket: string;
  readonly task_id: string;
  readonly deadline_ms: number;
  readonly checkpoint_ref: string;
  readonly history_digest: string;
  readonly observation_id: string | null;
  readonly binding_digest: string | null;
  readonly evidence_ref: string | null;
}
