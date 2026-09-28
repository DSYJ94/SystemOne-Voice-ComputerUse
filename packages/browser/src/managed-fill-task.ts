import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ContractError, digest } from '../../protocol/src/json.ts';
import { AttemptJournal } from '../../runtime/src/attempt-journal.ts';
import type { JournalAttempt, PreparedAttempt } from '../../runtime/src/attempt-journal.ts';
import { TaskAdmissionRegistry } from '../../runtime/src/task-authority.ts';
import type { TaskAdmission } from '../../runtime/src/task-authority.ts';
import { ManagedObservationSession } from './managed-observation.ts';
import type { ManagedObservation } from './managed-observation.ts';

export interface ManagedFillPermit extends PreparedAttempt {
  readonly controlId: string;
  readonly expiresAtMonotonic: number;
}

export interface ManagedFillStop {
  readonly journalFenced: true;
  readonly browserFenced: boolean;
  readonly unresolvedExecutionIds: readonly string[];
}

/**
 * One admitted field replacement in managed Chromium. In-process identity is
 * not OS peer authentication; the Node controller remains the only journal and
 * permit owner. A matched result proves only the current DOM field value.
 */
export class ManagedFillTask {
  readonly #journal: AttemptJournal;
  readonly #admission: TaskAdmission;
  readonly #session: ManagedObservationSession;
  readonly #observation: ManagedObservation;
  readonly #controlId: string;
  readonly #value: string;
  readonly #clock: () => number;
  readonly #candidateSetDigest: string;
  readonly #actionDigest: string;
  #issued: ManagedFillPermit | undefined;
  #started = false;
  #stopped = false;
  #lastTime = -Infinity;
  #controller: AbortController | undefined;
  #stopPromise: Promise<ManagedFillStop> | undefined;

  constructor(journal: AttemptJournal, registry: TaskAdmissionRegistry,
    admission: TaskAdmission, session: ManagedObservationSession,
    observation: ManagedObservation, controlId: string, value: string,
    parameterRef: string, clock: () => number = () => performance.now()) {
    if (admission.outcomeKind !== 'FILL'
      || !admission.approvedEffects.includes('LOCAL_EDIT')
      || !admission.approvedEffects.includes('EXTERNAL_WRITE')
      || admission.scopeRef !== session.scopeRef
      || observation.browserSessionId !== session.scopeRef.slice('managed-browser:'.length)
      || !observation.controls.some(control =>
        control.id === controlId && control.editable && control.enabled)
      || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > 4_096) {
      throw new ContractError('managed fill is outside admitted task or observation');
    }
    const parameter = admission.parameters.find(item => item.parameterRef === parameterRef);
    if (!parameter || parameter.valueDigest !== digest(value)) {
      throw new ContractError('managed fill value has no admitted byte provenance');
    }
    const action = { operation: 'fill', browserSessionId: observation.browserSessionId,
      observationId: observation.observationId, controlId,
      valueDigest: parameter.valueDigest, parameterRef,
      sourceRef: parameter.sourceRef, scopeRef: admission.scopeRef,
      policyRevision: admission.policyRevision };
    registry.claimForTask(admission);
    journal.startTask(admission.taskId, admission.taskEpoch, admission.goalRevision);
    this.#journal = journal;
    this.#admission = admission;
    this.#session = session;
    this.#observation = observation;
    this.#controlId = controlId;
    this.#value = value;
    this.#clock = clock;
    this.#candidateSetDigest = digest([action]);
    this.#actionDigest = digest(action);
  }

  issuePermit(): ManagedFillPermit {
    if (this.#stopped || this.#started || this.#issued) {
      throw new ContractError('managed fill permit unavailable');
    }
    const now = this.#now();
    const expiresAtMonotonic = now + 5_000;
    if (!Number.isFinite(expiresAtMonotonic) || expiresAtMonotonic <= now) {
      void this.stop();
      throw new ContractError('managed fill permit deadline invalid');
    }
    const permit = Object.freeze({
      executionId: randomUUID(), permitRef: randomUUID(),
      taskId: this.#admission.taskId, taskEpoch: this.#admission.taskEpoch,
      goalRevision: this.#admission.goalRevision,
      scopeRef: this.#admission.scopeRef,
      observationId: this.#observation.observationId,
      candidateId: this.#controlId,
      candidateSetDigest: this.#candidateSetDigest,
      actionDigest: this.#actionDigest,
      policyRevision: this.#admission.policyRevision,
      leaseGeneration: 1, controlId: this.#controlId,
      expiresAtMonotonic,
    });
    this.#issued = permit;
    return permit;
  }

  async execute(permit: ManagedFillPermit): Promise<JournalAttempt> {
    if (this.#stopped || this.#started || this.#issued !== permit) {
      throw new ContractError('managed fill permit missing, cloned or replayed');
    }
    if (this.#now() >= permit.expiresAtMonotonic) {
      this.#issued = undefined;
      throw new ContractError('managed fill permit expired');
    }
    this.#issued = undefined;
    this.#started = true;
    this.#journal.prepare(permit);
    const controller = new AbortController();
    this.#controller = controller;
    let prepared;
    try {
      prepared = await this.#session.prepareFill(
        this.#observation.observationId, this.#controlId,
        this.#value, controller.signal);
    } catch { return this.#notDispatched(permit.executionId); }
    try {
      if (this.#stopped || controller.signal.aborted
        || this.#now() >= permit.expiresAtMonotonic) {
        prepared.release();
        return this.#notDispatched(permit.executionId);
      }
      // No await between this marker and calling the driver. A Playwright
      // actionability wait is already a possible-effect boundary.
      this.#journal.markDispatchBoundary(permit.executionId);
    } catch {
      prepared.release();
      return this.#notDispatched(permit.executionId);
    }
    try {
      const matched = await prepared.send();
      return this.#recordOutcome(permit.executionId, matched);
    } catch {
      return this.#recordOutcome(permit.executionId, false);
    } finally { this.#controller = undefined; }
  }

  stop(): Promise<ManagedFillStop> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopped = true;
    this.#issued = undefined;
    this.#controller?.abort();
    if (this.#journal.getTaskState(this.#admission.taskId) === 'active') {
      this.#journal.cancelTask(this.#admission.taskId);
    }
    this.#stopPromise = this.#session.close().then(
      () => Object.freeze({ journalFenced: true as const, browserFenced: true,
        unresolvedExecutionIds: Object.freeze(this.#journal
          .unresolvedAttempts(this.#admission.taskId).map(item => item.executionId)) }),
      () => Object.freeze({ journalFenced: true as const, browserFenced: false,
        unresolvedExecutionIds: Object.freeze(this.#journal
          .unresolvedAttempts(this.#admission.taskId).map(item => item.executionId)) }),
    );
    return this.#stopPromise;
  }

  #notDispatched(executionId: string): JournalAttempt {
    this.#controller = undefined;
    const attempt = this.#journal.getAttempt(executionId);
    if (!attempt) throw new ContractError('managed fill attempt disappeared');
    return attempt.phase === 'prepared'
      ? this.#journal.recordNotDispatched(executionId) : attempt;
  }

  #recordOutcome(executionId: string, matched: boolean): JournalAttempt {
    try {
      const evidenceRef = `dom-fill-${executionId}`;
      const attempt = this.#journal.recordOutcome(executionId, matched
        ? { deliveryStatus: 'dispatched', effectStatus: 'applied',
          verification: 'matched', evidenceRef }
        : { deliveryStatus: 'unknown', effectStatus: 'unknown',
          verification: 'unavailable' });
      if (matched && !this.#stopped
        && this.#journal.getTaskState(this.#admission.taskId) === 'active') {
        // FILL means the exact current DOM field holds the admitted bytes.
        // It says nothing about a later submit or server-side persistence.
        this.#journal.completeTask(this.#admission.taskId, evidenceRef);
      }
      return attempt;
    } catch {
      const attempt = this.#journal.getAttempt(executionId);
      if (!attempt) throw new ContractError('managed fill attempt disappeared');
      return attempt;
    }
  }

  #now(): number {
    const now = this.#clock();
    if (!Number.isFinite(now) || now < 0 || now < this.#lastTime) {
      void this.stop();
      throw new ContractError('managed fill monotonic clock invalid');
    }
    this.#lastTime = now;
    return now;
  }
}
