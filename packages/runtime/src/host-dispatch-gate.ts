import { randomUUID } from 'node:crypto';
import { digest, ContractError } from '../../protocol/src/json.ts';
import type { TaskAdmission } from './task-authority.ts';
import { AttemptJournal } from './attempt-journal.ts';
import type { AttemptOutcome, JournalAttempt, PreparedAttempt } from './attempt-journal.ts';

const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const FIXTURE_SCOPE = 'fixture-only';
const FIXTURE_SURFACE = 'fixture-window';
const FIXTURE_TARGET = 'fixture.name';

export interface TargetBinding {
  readonly targetRef: string;
  readonly surfaceId: string;
  readonly identityFingerprint: string;
  readonly currentValueDigest: string;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly capabilities: readonly string[];
}

/** One bounded operation for the first synthetic host/adapter integration. */
export interface SetValueCandidate {
  readonly candidateId: string;
  readonly description: string;
  readonly scopeRef: string;
  readonly policyRevision: string;
  readonly effect: 'LOCAL_EDIT';
  readonly operation: 'set_value';
  readonly target: TargetBinding;
  readonly value: string;
  readonly valueSourceRef: string;
}

export interface CandidateObservation {
  readonly observationId: string;
  readonly candidates: readonly SetValueCandidate[];
}

export interface SelectedCandidate {
  readonly observationId: string;
  readonly candidateSetDigest: string;
  readonly candidateId: string;
}

export interface DispatchPermit extends PreparedAttempt {
  readonly issuedAtMonotonic: number;
  readonly expiresAtMonotonic: number;
}

/**
 * `prepare` must have no UI effect. `send` must begin any possible effect in its
 * synchronous invocation, before returning a Promise. A Playwright call that
 * waits for actionability does not satisfy this interface without a worker-side
 * cancellation fence. This contract is tested only with synthetic drivers here.
 */
export interface PreparedDelivery {
  readonly target: TargetBinding;
  send(): Promise<AttemptOutcome>;
}

export interface SetValueDriver {
  prepare(candidate: SetValueCandidate, signal: AbortSignal): Promise<PreparedDelivery>;
}

export interface JournalStopResult {
  readonly journalFenced: true;
  readonly unresolvedExecutionIds: readonly string[];
}

/**
 * Fixture-scoped in-process host authority for one observed set_value candidate. The selected
 * ID is only a proposal; a permit is issued from the trusted, copied candidate
 * set and accepted later by object identity. OS peer authentication, approval
 * routing and real adapter worker barriers are outside this slice.
 */
export class HostDispatchGate {
  readonly #journal: AttemptJournal;
  readonly #admission: TaskAdmission;
  readonly #observationId: string;
  readonly #candidateSetDigest: string;
  readonly #candidates: ReadonlyMap<string, SetValueCandidate>;
  readonly #clock: () => number;
  readonly #newId: () => string;
  #issued: DispatchPermit | undefined;
  #controller: AbortController | undefined;
  #started = false;
  #stopped = false;
  #lastTime = -Infinity;

  constructor(journal: AttemptJournal, admission: TaskAdmission,
    observation: CandidateObservation, clock: () => number,
    newId: () => string = randomUUID) {
    assertId(admission.taskId, 'task ID');
    assertId(admission.scopeRef, 'scope reference');
    assertId(admission.policyRevision, 'policy revision');
    assertId(observation.observationId, 'observation ID');
    if (!Number.isSafeInteger(admission.taskEpoch) || admission.taskEpoch < 0
      || !Number.isSafeInteger(admission.goalRevision) || admission.goalRevision < 0) {
      throw new ContractError('invalid task revision');
    }
    if (admission.outcomeKind !== 'FILL' || !admission.approvedEffects.includes('LOCAL_EDIT')) {
      throw new ContractError('task did not admit a local field edit');
    }
    if (admission.approvedEffects.includes('UNKNOWN')) {
      throw new ContractError('unknown task effect is not permitted');
    }
    if (admission.scopeRef !== FIXTURE_SCOPE) {
      throw new ContractError('this dispatch gate is limited to the synthetic fixture');
    }
    if (observation.candidates.length < 1 || observation.candidates.length > 64) {
      throw new ContractError('invalid candidate count');
    }
    const candidates = observation.candidates.map(candidate => copyCandidate(candidate));
    const byId = new Map(candidates.map(candidate => [candidate.candidateId, candidate]));
    if (byId.size !== candidates.length) throw new ContractError('duplicate candidate ID');
    for (const candidate of candidates) {
      if (candidate.scopeRef !== admission.scopeRef
        || candidate.policyRevision !== admission.policyRevision) {
        throw new ContractError('candidate scope or policy mismatch');
      }
      if (candidate.target.surfaceId !== FIXTURE_SURFACE
        || candidate.target.targetRef !== FIXTURE_TARGET) {
        throw new ContractError('candidate is outside the synthetic fixture');
      }
    }
    this.#journal = journal;
    this.#admission = Object.freeze({ ...admission,
      approvedEffects: Object.freeze([...admission.approvedEffects]),
      parameters: Object.freeze([...admission.parameters]),
    });
    this.#observationId = observation.observationId;
    this.#candidateSetDigest = digest(candidates.map(candidateRecord));
    this.#candidates = byId;
    this.#clock = clock;
    this.#newId = newId;
    journal.startTask(admission.taskId, admission.taskEpoch, admission.goalRevision);
  }

  get candidateSetDigest(): string { return this.#candidateSetDigest; }

  issuePermit(selection: SelectedCandidate, lifetimeMs: number): DispatchPermit {
    if (this.#stopped || this.#started || this.#issued) {
      throw new ContractError('task cannot issue another permit');
    }
    if (selection.observationId !== this.#observationId
      || selection.candidateSetDigest !== this.#candidateSetDigest) {
      throw new ContractError('stale observation or candidate set');
    }
    const candidate = this.#candidates.get(selection.candidateId);
    if (!candidate) throw new ContractError('selected candidate was not observed');
    if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > 30_000) {
      throw new ContractError('invalid permit lifetime');
    }
    const now = this.#now();
    const expiresAt = now + lifetimeMs;
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new ContractError('invalid permit deadline');
    }
    const executionId = this.#newId();
    const permitRef = this.#newId();
    assertId(executionId, 'execution ID');
    assertId(permitRef, 'permit reference');
    if (executionId === permitRef) throw new ContractError('execution and permit IDs must differ');
    const permit: DispatchPermit = Object.freeze({
      executionId, permitRef,
      taskId: this.#admission.taskId,
      taskEpoch: this.#admission.taskEpoch,
      goalRevision: this.#admission.goalRevision,
      scopeRef: this.#admission.scopeRef,
      observationId: this.#observationId,
      candidateId: candidate.candidateId,
      candidateSetDigest: this.#candidateSetDigest,
      actionDigest: digest(actionRecord(candidate)),
      policyRevision: this.#admission.policyRevision,
      leaseGeneration: 1,
      issuedAtMonotonic: now,
      expiresAtMonotonic: expiresAt,
    });
    this.#issued = permit;
    return permit;
  }

  async dispatch(permit: DispatchPermit, driver: SetValueDriver): Promise<JournalAttempt> {
    if (this.#stopped || this.#started || this.#issued !== permit) {
      throw new ContractError('permit missing, replayed or not host issued');
    }
    if (this.#now() >= permit.expiresAtMonotonic) {
      this.#issued = undefined;
      throw new ContractError('permit expired');
    }
    const candidate = this.#candidates.get(permit.candidateId)!;
    this.#issued = undefined;
    this.#started = true;
    this.#journal.prepare(permit);
    const controller = new AbortController();
    this.#controller = controller;

    let delivery: PreparedDelivery;
    try {
      delivery = await driver.prepare(candidate, controller.signal);
    } catch {
      return this.#finishBeforeDispatch(permit.executionId);
    }
    if (!this.#mayDispatch(permit) || !delivery || !isFreshTarget(candidate.target, delivery)) {
      return this.#finishBeforeDispatch(permit.executionId);
    }

    // No await between the final fence check, durable marker and synchronous
    // send invocation. A real adapter must prove its send boundary separately.
    this.#journal.markDispatchBoundary(permit.executionId);
    try {
      const outcome = await delivery.send();
      try {
        return this.#journal.recordOutcome(permit.executionId, outcome);
      } catch {
        return this.#recordUnknown(permit.executionId);
      }
    } catch {
      return this.#recordUnknown(permit.executionId);
    } finally {
      this.#controller = undefined;
    }
  }

  stop(): JournalStopResult {
    if (!this.#stopped) {
      this.#stopped = true;
      this.#issued = undefined;
      this.#controller?.abort();
      this.#journal.cancelTask(this.#admission.taskId);
    }
    return Object.freeze({
      journalFenced: true,
      unresolvedExecutionIds: Object.freeze(this.#journal
        .unresolvedAttempts(this.#admission.taskId).map(attempt => attempt.executionId)),
    });
  }

  #finishBeforeDispatch(executionId: string): JournalAttempt {
    this.#controller = undefined;
    const existing = this.#journal.getAttempt(executionId);
    if (!existing) throw new ContractError('prepared attempt disappeared');
    return existing.phase === 'prepared'
      ? this.#journal.recordNotDispatched(executionId) : existing;
  }

  #recordUnknown(executionId: string): JournalAttempt {
    return this.#journal.recordOutcome(executionId, {
      deliveryStatus: 'unknown', effectStatus: 'unknown', verification: 'unavailable',
    });
  }

  #mayDispatch(permit: DispatchPermit): boolean {
    try {
      return !this.#stopped && this.#journal.getTaskState(permit.taskId) === 'active'
        && this.#now() < permit.expiresAtMonotonic;
    } catch { return false; }
  }

  #now(): number {
    const now = this.#clock();
    if (!Number.isFinite(now) || now < 0 || now < this.#lastTime) {
      this.stop();
      throw new ContractError('monotonic clock invalid');
    }
    this.#lastTime = now;
    return now;
  }
}

function copyCandidate(candidate: SetValueCandidate): SetValueCandidate {
  assertId(candidate.candidateId, 'candidate ID');
  assertId(candidate.scopeRef, 'scope reference');
  assertId(candidate.policyRevision, 'policy revision');
  assertId(candidate.valueSourceRef, 'value source');
  if (candidate.description.length < 10 || candidate.description.length > 1200
    || candidate.effect !== 'LOCAL_EDIT' || candidate.operation !== 'set_value'
    || candidate.value.length === 0 || Buffer.byteLength(candidate.value, 'utf8') > 128) {
    throw new ContractError('invalid set-value candidate');
  }
  const target = candidate.target;
  assertId(target.targetRef, 'target reference');
  assertId(target.surfaceId, 'surface ID');
  assertId(target.identityFingerprint, 'target identity');
  if (!DIGEST.test(target.currentValueDigest)
    || !target.capabilities.includes('set_value') || !target.visible || !target.enabled) {
    throw new ContractError('target does not support set_value');
  }
  return Object.freeze({ ...candidate, target: Object.freeze({
    ...target, capabilities: Object.freeze([...target.capabilities]),
  }) });
}

function isFreshTarget(expected: TargetBinding, delivery: PreparedDelivery): boolean {
  const current = delivery.target;
  if (!current || typeof delivery.send !== 'function'
    || !Array.isArray(current.capabilities)) return false;
  return current.targetRef === expected.targetRef
    && current.surfaceId === expected.surfaceId
    && current.identityFingerprint === expected.identityFingerprint
    && current.currentValueDigest === expected.currentValueDigest
    && current.visible && current.enabled && current.capabilities.includes('set_value');
}

function candidateRecord(candidate: SetValueCandidate) {
  return { candidateId: candidate.candidateId, description: candidate.description,
    scopeRef: candidate.scopeRef, policyRevision: candidate.policyRevision,
    effect: candidate.effect, action: actionRecord(candidate) };
}

function actionRecord(candidate: SetValueCandidate) {
  return { operation: candidate.operation, targetRef: candidate.target.targetRef,
    surfaceId: candidate.target.surfaceId,
    identityFingerprint: candidate.target.identityFingerprint,
    currentValueDigest: candidate.target.currentValueDigest,
    value: candidate.value, valueSourceRef: candidate.valueSourceRef };
}

function assertId(value: string, label: string): void {
  if (!ID.test(value)) throw new ContractError(`invalid ${label}`);
}
