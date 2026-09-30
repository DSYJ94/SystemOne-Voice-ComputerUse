import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ContractError, digest } from '../../protocol/src/json.ts';
import { AttemptJournal } from '../../runtime/src/attempt-journal.ts';
import type { JournalAttempt, PreparedAttempt } from '../../runtime/src/attempt-journal.ts';
import { TaskAdmissionRegistry } from '../../runtime/src/task-authority.ts';
import type { TaskAdmission } from '../../runtime/src/task-authority.ts';
import { ManagedObservationSession } from './managed-observation.ts';
import type { ManagedObservation } from './managed-observation.ts';

export interface ManagedNavigatePermit extends PreparedAttempt {
  readonly expiresAtMonotonic: number;
}

export interface ManagedNavigateStop {
  readonly journalFenced: true;
  readonly browserFenced: boolean;
  readonly unresolvedExecutionIds: readonly string[];
}

/** A NAVIGATE goal proves arrival at one exact approved URL. It does not claim
 * that a named document/object was opened or that page scripts had no effects. */
export class ManagedNavigateTask {
  readonly #journal: AttemptJournal;
  readonly #admission: TaskAdmission;
  readonly #session: ManagedObservationSession;
  readonly #observation: ManagedObservation;
  readonly #controlId: string;
  readonly #destinationUrl: string;
  readonly #clock: () => number;
  readonly #candidateSetDigest: string;
  readonly #actionDigest: string;
  #issued: ManagedNavigatePermit | undefined;
  #started = false;
  #stopped = false;
  #lastTime = -Infinity;
  #controller: AbortController | undefined;
  #stopPromise: Promise<ManagedNavigateStop> | undefined;

  constructor(journal: AttemptJournal, registry: TaskAdmissionRegistry,
    admission: TaskAdmission, session: ManagedObservationSession,
    observation: ManagedObservation, controlId: string, destinationUrl: string,
    parameterRef: string, clock: () => number = () => performance.now()) {
    const control = observation.controls.find(item => item.id === controlId);
    const parameter = admission.parameters.find(item => item.parameterRef === parameterRef);
    if (admission.outcomeKind !== 'NAVIGATE'
      || !admission.approvedEffects.includes('NAVIGATE')
      || admission.scopeRef !== session.scopeRef
      || observation.browserSessionId !== session.scopeRef.slice('managed-browser:'.length)
      || !observation.coverage.complete
      || !control?.enabled || control.destinationUrl !== destinationUrl
      || destinationUrl === observation.url
      || !parameter || parameter.valueDigest !== digest(destinationUrl)) {
      throw new ContractError('managed navigation is outside admitted task or observation');
    }
    const action = { operation: 'navigate_link',
      browserSessionId: observation.browserSessionId,
      observationId: observation.observationId, controlId,
      destinationDigest: parameter.valueDigest, parameterRef,
      sourceRef: parameter.sourceRef, scopeRef: admission.scopeRef,
      policyRevision: admission.policyRevision };
    journal.startAdmittedTask(registry, admission);
    this.#journal = journal;
    this.#admission = admission;
    this.#session = session;
    this.#observation = observation;
    this.#controlId = controlId;
    this.#destinationUrl = destinationUrl;
    this.#clock = clock;
    this.#candidateSetDigest = digest(observation.controls
      .filter(item => item.enabled && item.destinationUrl !== null)
      .map(item => ({ id: item.id, role: item.role, label: item.label,
        context: item.context, destinationUrl: item.destinationUrl })));
    this.#actionDigest = digest(action);
  }

  issuePermit(): ManagedNavigatePermit {
    if (this.#stopped || this.#started || this.#issued) {
      throw new ContractError('managed navigation permit unavailable');
    }
    const now = this.#now();
    const expiresAtMonotonic = now + 5_000;
    if (!Number.isFinite(expiresAtMonotonic) || expiresAtMonotonic <= now) {
      void this.stop();
      throw new ContractError('managed navigation permit deadline invalid');
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
      leaseGeneration: 1, expiresAtMonotonic,
    });
    this.#issued = permit;
    return permit;
  }

  async execute(permit: ManagedNavigatePermit): Promise<JournalAttempt> {
    if (this.#stopped || this.#started || this.#issued !== permit) {
      throw new ContractError('managed navigation permit missing, cloned or replayed');
    }
    if (this.#now() >= permit.expiresAtMonotonic) {
      this.#issued = undefined;
      throw new ContractError('managed navigation permit expired');
    }
    this.#issued = undefined;
    this.#started = true;
    this.#journal.prepare(permit);
    const controller = new AbortController();
    this.#controller = controller;
    let prepared;
    try {
      prepared = await this.#session.prepareNavigate(
        this.#observation.observationId, this.#controlId,
        this.#destinationUrl, controller.signal);
    } catch { return this.#notDispatched(permit.executionId); }
    try {
      if (this.#stopped || controller.signal.aborted
        || this.#now() >= permit.expiresAtMonotonic) {
        prepared.release();
        return this.#notDispatched(permit.executionId);
      }
      this.#journal.markDispatchBoundary(permit.executionId);
    } catch {
      prepared.release();
      return this.#notDispatched(permit.executionId);
    }
    try {
      const sent = await prepared.send();
      const after = sent && !this.#stopped
        ? await this.#session.observe().catch(() => undefined) : undefined;
      const matched = !!after && after.url === this.#destinationUrl
        && after.navigationRevision > this.#observation.navigationRevision;
      return this.#recordOutcome(permit.executionId, matched);
    } catch { return this.#recordOutcome(permit.executionId, false); }
    finally { this.#controller = undefined; }
  }

  stop(): Promise<ManagedNavigateStop> {
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
    if (!attempt) throw new ContractError('managed navigation attempt disappeared');
    return attempt.phase === 'prepared'
      ? this.#journal.recordNotDispatched(executionId) : attempt;
  }

  #recordOutcome(executionId: string, matched: boolean): JournalAttempt {
    try {
      const evidenceRef = `dom-navigation-${executionId}`;
      const attempt = this.#journal.recordOutcome(executionId, matched
        ? { deliveryStatus: 'dispatched', effectStatus: 'applied',
          verification: 'matched', evidenceRef }
        : { deliveryStatus: 'unknown', effectStatus: 'unknown',
          verification: 'unavailable' });
      if (matched && !this.#stopped
        && this.#journal.getTaskState(this.#admission.taskId) === 'active') {
        this.#journal.completeTask(this.#admission.taskId, evidenceRef);
      }
      return attempt;
    } catch {
      const attempt = this.#journal.getAttempt(executionId);
      if (!attempt) throw new ContractError('managed navigation attempt disappeared');
      return attempt;
    }
  }

  #now(): number {
    const now = this.#clock();
    if (!Number.isFinite(now) || now < 0 || now < this.#lastTime) {
      void this.stop();
      throw new ContractError('managed navigation monotonic clock invalid');
    }
    this.#lastTime = now;
    return now;
  }
}
