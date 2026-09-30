import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ContractError, digest } from '../../protocol/src/json.ts';
import type { PreparedAttempt } from '../../runtime/src/attempt-journal.ts';
import type { Effect, TaskAdmission } from '../../runtime/src/task-authority.ts';
import type { PortalObservation } from './managed-portal.ts';
import type { ScriptedPortalRecord } from './scripted-portal-task.ts';

export type PortalAction = 'search' | 'open' | 'download' | 'save';

export interface PortalActionPermit extends PreparedAttempt {
  readonly action: PortalAction;
  readonly observationDigest: string;
  readonly expiresAtMonotonic: number;
}

const EFFECT: Record<PortalAction, Effect> = {
  search: 'NAVIGATE', open: 'NAVIGATE', download: 'DOWNLOAD', save: 'LOCAL_EDIT',
};
const STAGE: Record<PortalAction, ScriptedPortalRecord['stage']> = {
  search: 'admitted', open: 'located', download: 'opened', save: 'downloaded_temporary',
};
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;

/** Fixture-specific host authority. A model-selected ID is never permission:
 * only this object can issue an exact, short-lived, one-use action permit.
 * In-process identity is not OS peer authentication or a production worker. */
export class PortalActionAuthority {
  readonly #admission: TaskAdmission;
  readonly #clock: () => number;
  readonly #newId: () => string;
  #pending: PortalActionPermit | undefined;
  #closed = false;
  #lastTime = -Infinity;

  constructor(admission: TaskAdmission, clock: () => number = () => performance.now(),
    newId: () => string = randomUUID) {
    this.#admission = admission;
    this.#clock = clock;
    this.#newId = newId;
  }

  static sameObservation(before: PortalObservation, after: PortalObservation): boolean {
    return digest(observationRecord(before)) === digest(observationRecord(after));
  }

  issue(task: ScriptedPortalRecord, action: PortalAction,
    observed: PortalObservation, observationId?: string): PortalActionPermit {
    if (this.#closed || this.#pending) throw new ContractError('portal authority closed or permit outstanding');
    this.#validate(task, action, observed);
    const now = this.#now();
    const observation = observationRecord(observed);
    if (observationId !== undefined && !ID.test(observationId)) {
      throw new ContractError('invalid host observation ID');
    }
    const actionValue = actionRecord(task, action, observation);
    const executionId = this.#newId();
    const permitRef = this.#newId();
    if (!ID.test(executionId) || !ID.test(permitRef) || executionId === permitRef) {
      throw new ContractError('invalid or duplicate portal permit ID');
    }
    const expiresAtMonotonic = now + 5_000;
    if (!Number.isFinite(expiresAtMonotonic) || expiresAtMonotonic <= now) {
      throw new ContractError('invalid portal permit deadline');
    }
    const permit: PortalActionPermit = Object.freeze({
      executionId, permitRef, taskId: task.taskId,
      taskEpoch: this.#admission.taskEpoch,
      goalRevision: this.#admission.goalRevision,
      scopeRef: this.#admission.scopeRef,
      observationId: observationId ?? `portal-${digest(observation).slice(0, 32)}`,
      candidateId: `scripted-${action}`,
      candidateSetDigest: digest([actionValue]),
      actionDigest: digest(actionValue),
      policyRevision: this.#admission.policyRevision,
      leaseGeneration: 1, action,
      observationDigest: digest(observation),
      expiresAtMonotonic,
    });
    this.#pending = permit;
    return permit;
  }

  consume(permit: PortalActionPermit, task: ScriptedPortalRecord,
    action: PortalAction, observed: PortalObservation): void {
    if (this.#closed || this.#pending !== permit) {
      throw new ContractError('portal permit missing, cloned or replayed');
    }
    if (this.#now() >= permit.expiresAtMonotonic) {
      this.#pending = undefined;
      throw new ContractError('portal permit expired');
    }
    this.#validate(task, action, observed);
    if (permit.action !== action || permit.observationDigest !== digest(observationRecord(observed))) {
      throw new ContractError('portal permit action or observation changed');
    }
    this.#pending = undefined;
  }

  stop(): void { this.#closed = true; this.#pending = undefined; }

  #validate(task: ScriptedPortalRecord, action: PortalAction,
    observed: PortalObservation): void {
    const admission = this.#admission;
    if (task.taskId !== admission.taskId || task.outcomeKind !== admission.outcomeKind
      || admission.scopeRef !== 'synthetic-portal-only'
      || admission.policyRevision !== 'portal-policy-1'
      || task.state !== 'active' || task.stage !== STAGE[action]
      || task.inFlight !== null || !admission.approvedEffects.includes(EFFECT[action])) {
      throw new ContractError('portal action is outside the admitted task or stage');
    }
    if (!Number.isSafeInteger(observed.revision) || observed.revision < 0) {
      throw new ContractError('invalid portal observation revision');
    }
    let url: URL;
    try { url = new URL(observed.url); }
    catch { throw new ContractError('invalid portal observation URL'); }
    const expectedPath = observed.kind === 'home' ? '/'
      : observed.kind === 'results' ? '/invoices' : `/invoices/${task.invoiceId}`;
    if (url.origin !== task.origin || url.username || url.password
      || url.pathname !== expectedPath || url.hash
      || (observed.kind !== 'results' && url.search)
      || (observed.kind === 'results' && (url.searchParams.size > 1
        || (url.searchParams.size === 1 && !url.searchParams.has('q'))))) {
      throw new ContractError('portal observation URL changed');
    }
    if (action === 'open' && url.searchParams.get('q') !== task.query) {
      throw new ContractError('portal result query changed');
    }
    if (action === 'open' && (observed.kind !== 'results'
      || observed.rows.filter(row => row.id === task.invoiceId
        && row.title === task.title && row.account === task.account).length !== 1)) {
      throw new ContractError('portal open target is not in the current observation');
    }
    if ((action === 'download' || action === 'save')
      && (observed.kind !== 'detail' || observed.invoiceId !== task.invoiceId
        || observed.title !== task.title || observed.account !== task.account)) {
      throw new ContractError('portal detail target changed');
    }
    if (action === 'search' && observed.kind !== 'home' && observed.kind !== 'results') {
      throw new ContractError('portal search is not available here');
    }
  }

  #now(): number {
    const now = this.#clock();
    if (!Number.isFinite(now) || now < 0 || now < this.#lastTime) {
      this.stop();
      throw new ContractError('portal monotonic clock invalid');
    }
    this.#lastTime = now;
    return now;
  }
}

function observationRecord(observed: PortalObservation) {
  if (observed.kind === 'results') {
    return { kind: observed.kind, revision: observed.revision, url: observed.url,
      rows: observed.rows.map(row => ({ id: row.id, title: row.title, account: row.account })) };
  }
  if (observed.kind === 'detail') {
    return { kind: observed.kind, revision: observed.revision, url: observed.url,
      invoiceId: observed.invoiceId, title: observed.title, account: observed.account };
  }
  return { kind: observed.kind, revision: observed.revision, url: observed.url };
}

function actionRecord(task: ScriptedPortalRecord, action: PortalAction,
  observation: ReturnType<typeof observationRecord>) {
  return { action, taskId: task.taskId, origin: task.origin,
    invoiceId: task.invoiceId, query: task.query,
    destinationPath: task.destinationPath ?? null, observation };
}
