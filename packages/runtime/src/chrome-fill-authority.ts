import { randomUUID } from 'node:crypto';
import { ContractError, digest } from '../../protocol/src/json.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { AttemptJournal } from './attempt-journal.ts';
import { ChromeReadSession } from './chrome-read-session.ts';
import { CommittedInputSession } from './committed-input.ts';
import { TaskAdmissionRegistry } from './task-authority.ts';
import type { JSONValue } from '../../protocol/src/json.ts';
import type { PreparedAttempt } from './attempt-journal.ts';

const ID = /^[A-Za-z0-9_.:-]{1,160}$/;

export interface ChromeFillRequest {
  readonly requestId: string;
  readonly grantId: string;
  readonly fieldLabel: string;
  readonly value: string;
  readonly command: Record<string, JSONValue>;
}

export type ChromeFillResult = 'verified' | 'already_matched' | 'unsupported'
  | 'uncertain' | 'stopped' | 'error';

interface Active {
  readonly requestId: string;
  readonly grantId: string;
  stopped: boolean;
  journalStarted: boolean;
  actionRequestId?: string;
  done: Promise<ChromeFillResult>;
}

/** The host alone admits and journals a Chrome action. This development slice
 * deliberately allows only a loopback page with the fixture's form shape.
 * Loopback and page title do not authenticate the fixture process. */
export class ChromeFillAuthority {
  readonly #journal: AttemptJournal;
  readonly #session: ChromeReadSession;
  readonly #seen = new Set<string>();
  #active: Active | undefined;
  #fenceFailed = false;
  #requiresRecovery = false;

  constructor(journal: AttemptJournal, session: ChromeReadSession) {
    this.#journal = journal;
    this.#session = session;
  }

  get needsRecovery(): boolean {
    return this.#fenceFailed || this.#requiresRecovery
      || this.#journal.unresolvedAttempts().length > 0;
  }

  start(request: ChromeFillRequest): Promise<ChromeFillResult> {
    if (!ID.test(request.requestId) || !ID.test(request.grantId)
      || !request.fieldLabel || request.fieldLabel.length > 160
      || !request.fieldLabel.isWellFormed() || !request.value.isWellFormed()
      || Buffer.byteLength(request.value, 'utf8') > 1_024
      || this.#seen.has(request.requestId) || this.#seen.size >= 1_000) {
      return Promise.resolve('error');
    }
    this.#seen.add(request.requestId);
    if (this.#active) return Promise.resolve('error');
    if (this.needsRecovery) return Promise.resolve('uncertain');
    const active: Active = { requestId: request.requestId,
      grantId: request.grantId, stopped: false, journalStarted: false,
      done: Promise.resolve('error') };
    this.#active = active;
    active.done = this.#run(request, active).finally(() => {
      if (this.#active === active) this.#active = undefined;
    });
    return active.done;
  }

  async stop(): Promise<boolean> {
    const active = this.#active;
    if (!active) return !this.#fenceFailed;
    active.stopped = true;
    if (active.journalStarted
      && this.#journal.getTaskState(active.requestId) === 'active') {
      this.#journal.cancelTask(active.requestId);
    }
    if (this.#journal.attemptsForTask(active.requestId).some(attempt =>
      attempt.phase === 'at_dispatch_boundary'
      || (attempt.outcome && attempt.outcome.deliveryStatus !== 'not_dispatched'))) {
      this.#requiresRecovery = true;
    }
    let fenced = false;
    try { fenced = await this.#session.stopAction(active.grantId,
      active.actionRequestId ?? active.requestId); }
    catch { /* A missing acknowledgement is not a barrier. */ }
    if (!fenced) this.#fenceFailed = true;
    return fenced;
  }

  async #run(request: ChromeFillRequest, active: Active): Promise<ChromeFillResult> {
    let executionId: string | undefined;
    try {
      const grant = this.#session.getGrant(request.grantId);
      if (!grant || !grant.connected) return 'unsupported';
      const url = new URL(grant.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
        || !['/', '/invoices'].includes(url.pathname)
        || request.fieldLabel !== 'Find invoice') {
        return 'unsupported';
      }
      const command = request.command;
      if (command.type !== 'command' || command.source !== 'text'
        || command.mode !== 'command' || command.isFinal !== true
        || command.taskId !== request.requestId || command.taskEpoch !== 1
        || command.goalRevision !== 1
        || command.text !== `Fill ${request.fieldLabel} in existing Chrome tab ${grant.url} with supplied text`
        || command.originSurface === null || typeof command.originSurface !== 'object'
        || Array.isArray(command.originSurface)
        || command.originSurface.appBundleId !== 'com.aurium.systemone.dev') {
        return 'error';
      }
      const revision = { taskId: request.requestId, taskEpoch: 1, goalRevision: 1 };
      const endpoint = bindEndpoint(['command']);
      const input = new CommittedInputSession(endpoint, revision);
      const route = input.accept(endpoint, Buffer.from(JSON.stringify(command)));
      if (route.kind !== 'interpret_command') return 'error';
      const observation = await this.#session.observeGrant(request.grantId);
      if (active.stopped) return 'stopped';
      if (!['Invoice Portal Fixture', 'Invoice search'].includes(observation.title)) {
        return 'unsupported';
      }
      const matches = observation.elements.filter(item => item.label === request.fieldLabel
        && item.editable && !item.disabled);
      if (!observation.complete || matches.length !== 1) return 'unsupported';
      const candidate = matches[0]!;
      const scopeRef = `chrome:${request.grantId}`;
      const registry = new TaskAdmissionRegistry(revision, input);
      const admission = registry.admit(route.input, {
        admissionId: randomUUID(), goal: route.input.text,
        outcomeKind: 'FILL', scopeRef,
        completionVerifierRef: 'chrome-dom-current-value-v1',
        policyRevision: 'chrome-loopback-fill-v1',
        // Even a synthetic input event may trigger page code that writes over
        // the network. Record that potential effect instead of calling it a
        // purely local edit.
        approvedEffects: ['READ', 'LOCAL_EDIT', 'EXTERNAL_WRITE'],
        parameters: [{ parameterRef: 'fill-value', sourceRef: request.requestId,
          valueDigest: digest(request.value) }],
      });
      registry.claimForTask(admission);
      this.#journal.startTask(request.requestId, 1, 1);
      active.journalStarted = true;
      if (active.stopped) return 'stopped';
      const action = { taskId: request.requestId, scopeRef,
        observationId: observation.observationId, candidateId: candidate.id,
        label: candidate.label, valueDigest: digest(request.value),
        policyRevision: admission.policyRevision };
      const permit: PreparedAttempt = Object.freeze({
        executionId: randomUUID(), permitRef: randomUUID(),
        taskId: request.requestId, taskEpoch: 1, goalRevision: 1,
        scopeRef, observationId: observation.observationId,
        candidateId: candidate.id,
        candidateSetDigest: digest(observation.elements.map(item => ({ ...item }))),
        actionDigest: digest(action), policyRevision: admission.policyRevision,
        leaseGeneration: 1,
      });
      this.#journal.prepare(permit);
      executionId = permit.executionId;
      if (active.stopped) return 'stopped';
      // Synchronous durable marker precedes the only extension dispatch.
      this.#journal.markDispatchBoundary(permit.executionId);
      active.actionRequestId = permit.executionId;
      const result = await this.#session.fill({ grantId: request.grantId,
        observation, candidateId: candidate.id, value: request.value,
        permitRef: permit.permitRef, taskId: request.requestId,
        requestId: permit.executionId });
      // After Stop, a late receipt may describe an effect that already
      // happened. Persist uncertainty so process or port restart cannot
      // silently re-enable the same write.
      const outcome = active.stopped
        ? { deliveryStatus: 'unknown' as const,
          effectStatus: 'unknown' as const, verification: 'unavailable' as const }
        : result === 'matched' || result === 'already_matched'
        ? { deliveryStatus: 'dispatched' as const,
          effectStatus: result === 'matched' ? 'applied' as const : 'not_applied' as const,
          verification: 'matched' as const,
          evidenceRef: `chrome-dom-${permit.executionId}` }
        : result === 'not_dispatched'
          ? { deliveryStatus: 'not_dispatched' as const,
            effectStatus: 'not_applied' as const, verification: 'unavailable' as const }
          : { deliveryStatus: 'unknown' as const,
            effectStatus: 'unknown' as const, verification: 'unavailable' as const };
      this.#journal.recordOutcome(permit.executionId, outcome);
      if (active.stopped) return 'stopped';
      if (result === 'unknown') return 'uncertain';
      if (result === 'not_dispatched') return 'unsupported';
      this.#journal.completeTask(request.requestId, outcome.evidenceRef!);
      return result === 'matched' ? 'verified' : 'already_matched';
    } catch {
      if (executionId && this.#journal.getAttempt(executionId)?.phase
        === 'at_dispatch_boundary') {
        this.#journal.recordOutcome(executionId, { deliveryStatus: 'unknown',
          effectStatus: 'unknown', verification: 'unavailable' });
        return 'uncertain';
      }
      return active.stopped ? 'stopped' : 'error';
    } finally {
      if (active.journalStarted
        && this.#journal.getTaskState(active.requestId) === 'active') {
        this.#journal.cancelTask(active.requestId);
      }
    }
  }
}
