import { randomUUID } from 'node:crypto';
import { ContractError, digest } from '../../protocol/src/json.ts';
import { buildActionCandidates, fromManagedObservation } from '../../runtime/src/action-candidates.ts';
import type { BuiltCandidateSet } from '../../runtime/src/action-candidates.ts';
import { AttemptJournal } from '../../runtime/src/attempt-journal.ts';
import type { PreparedAttempt } from '../../runtime/src/attempt-journal.ts';
import type { PersistentTaskWorkflow } from '../../runtime/src/persistent-task-actor.ts';
import { TaskAdmissionRegistry } from '../../runtime/src/task-authority.ts';
import type { TaskAdmission } from '../../runtime/src/task-authority.ts';
import type { TaskProgressLimits } from '../../runtime/src/task-progress.ts';
import type { TaskRecoveryBinding } from '../../runtime/src/task-recovery.ts';
import type { ResumeRequest, UserPromptLedger } from '../../runtime/src/user-prompts.ts';
import { ManagedObservationSession } from './managed-observation.ts';
import type { ManagedObservation } from './managed-observation.ts';

export const BROWSE_POLICY = 'managed-browse-confirmed-v1';
export const BROWSE_VERIFIER = 'user-confirmed-browse-goal-v1';
const MAX_LINKS = 40;

/** Chooses one offered candidate ID, or null to abstain. Never supplies URLs or text. */
export interface BrowseDecision {
  /** history: host-written summaries of verified steps, oldest first. */
  select(set: BuiltCandidateSet, observed: ManagedObservation, signal: AbortSignal,
    history: readonly string[]): Promise<string | null>;
}

export interface BrowseProposal {
  readonly step: number;
  readonly kind: 'navigate' | 'fill' | 'submit' | 'finish';
  /** Exact observed text shown to the user; never model-authored. */
  readonly label: string;
  readonly destinationUrl: string | null;
  readonly pageUrl: string;
}

/** User intent for one proposed step. A yes is never a permit by itself. */
export interface BrowseConfirmation {
  confirm(proposal: BrowseProposal, signal: AbortSignal): Promise<boolean>;
}

/** Multi-step browsing inside one approved site. Every step is observed, chosen
 * from host-built candidates, confirmed by the user, journaled behind a one-use
 * permit and independently verified; completion is the user's confirmation. */
export class ManagedBrowseTask implements PersistentTaskWorkflow {
  readonly taskId: string;
  readonly #journal: AttemptJournal;
  readonly #session: ManagedObservationSession;
  readonly #decision: BrowseDecision;
  readonly #confirmation: BrowseConfirmation;
  readonly #goalWords: readonly string[];
  readonly #searchText: string | null;
  #abort = new AbortController();
  #generation = 0;
  #advancing = false;
  #step = 0;
  readonly #history: string[] = [];
  /** Fields verified to hold the search words, keyed by page URL and label. */
  readonly #filled = new Set<string>();
  #stopPromise: Promise<{ readonly workerFenced: boolean }> | undefined;

  static start(journal: AttemptJournal, registry: TaskAdmissionRegistry, admission: TaskAdmission,
    session: ManagedObservationSession, options: { readonly searchText: string | null;
      readonly decision: BrowseDecision; readonly confirmation: BrowseConfirmation;
      readonly limits?: TaskProgressLimits }): ManagedBrowseTask {
    const search = admission.parameters.find(item => item.parameterRef === 'search-text');
    if (admission.outcomeKind !== 'USER_CONFIRMATION' || admission.policyRevision !== BROWSE_POLICY
      || admission.completionVerifierRef !== BROWSE_VERIFIER || admission.scopeRef !== session.scopeRef
      || (options.searchText === null) !== (search === undefined)
      || (search && search.valueDigest !== digest(options.searchText))) {
      throw new ContractError('browse admission differs from the request');
    }
    journal.startAdmittedTask(registry, admission);
    try { journal.enableTaskProgress(admission.taskId, admission.scopeRef, admission.completionVerifierRef, options.limits); }
    catch (error) { journal.pauseTask(admission.taskId, 'browse_progress_failed'); throw error; }
    return new ManagedBrowseTask(journal, admission, session, options);
  }

  private constructor(journal: AttemptJournal, admission: TaskAdmission, session: ManagedObservationSession,
    options: { readonly searchText: string | null; readonly decision: BrowseDecision;
      readonly confirmation: BrowseConfirmation }) {
    this.taskId = admission.taskId; this.#journal = journal; this.#session = session;
    this.#decision = options.decision; this.#confirmation = options.confirmation;
    this.#searchText = options.searchText;
    this.#goalWords = Object.freeze(admission.goal.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2));
  }

  async advance(): Promise<void> {
    if (this.#advancing) throw new ContractError('browse step already pending');
    const generation = this.#generation;
    const admission = this.#active(generation);
    this.#advancing = true;
    let executionId: string | undefined;
    try {
      const ticket = this.#journal.reserveTaskObservation(this.taskId);
      const observed = await this.#session.observe();
      this.#active(generation);
      this.#journal.recordTaskObservation(this.taskId, ticket, { observationId: observed.observationId,
        scopeRef: admission.scopeRef, stateDigest: digest(semantic(observed)) });
      this.#journal.consumeTaskDecision(this.taskId, observed.observationId);
      const step = ++this.#step;
      const set = this.#candidates(observed, step);
      const chosenId = await this.#decision.select(set, observed, this.#abort.signal, [...this.#history]);
      this.#active(generation);
      const candidate = chosenId ? set.candidates.find(item => item.candidateId === chosenId) : undefined;
      if (!candidate) throw new ContractError('no confident browse step');
      if (candidate.operation === 'finish') {
        const confirmed = await this.#confirmation.confirm(Object.freeze({ step, kind: 'finish',
          label: observed.title || observed.url, destinationUrl: null, pageUrl: observed.url }), this.#abort.signal);
        this.#active(generation);
        if (!confirmed) throw new ContractError('user did not confirm completion');
        const evidenceRef = `user-confirmed-${randomUUID()}`;
        this.#journal.recordTaskCheckpoint(this.taskId, { checkpointId: randomUUID(),
          observationId: observed.observationId, stageRef: `browse-finish-${step}`,
          predicateRef: BROWSE_VERIFIER, evidenceRef, terminal: true });
        this.#journal.completeTask(this.taskId, evidenceRef);
        return;
      }
      const resolved = chosenId ? set.resolve(chosenId, observed.observationId, set.candidateSetDigest) : undefined;
      const control = observed.controls.find(item => item.id === resolved?.targetRef);
      if (!resolved || !control) throw new ContractError('browse choice does not resolve');
      const kind = resolved.operation === 'navigate' ? 'navigate' : resolved.operation === 'set_value' ? 'fill' : 'submit';
      if ((kind === 'fill' && this.#searchText === null) || (kind === 'navigate' && !control.destinationUrl)) {
        throw new ContractError('browse choice lacks a bound value');
      }
      const confirmed = await this.#confirmation.confirm(Object.freeze({ step, kind, label: control.label,
        destinationUrl: kind === 'navigate' ? control.destinationUrl : null, pageUrl: observed.url }), this.#abort.signal);
      this.#active(generation);
      if (!confirmed) throw new ContractError('user declined the browse step');
      const permit: PreparedAttempt = Object.freeze({ taskId: this.taskId, taskEpoch: admission.taskEpoch,
        goalRevision: admission.goalRevision, executionId: randomUUID(), permitRef: randomUUID(),
        scopeRef: admission.scopeRef, observationId: observed.observationId, candidateId: control.id,
        candidateSetDigest: set.candidateSetDigest,
        actionDigest: digest({ operation: kind, taskId: this.taskId, observationId: observed.observationId,
          controlId: control.id, label: control.label, destinationUrl: control.destinationUrl,
          textRef: kind === 'fill' ? 'search-text' : null, policyRevision: BROWSE_POLICY }),
        policyRevision: BROWSE_POLICY, leaseGeneration: 1 });
      this.#journal.prepare(permit); executionId = permit.executionId;
      let prepared;
      try {
        prepared = kind === 'navigate'
          ? await this.#session.prepareNavigate(observed.observationId, control.id, control.destinationUrl!,
            this.#abort.signal, { acceptInScopeRedirect: true })
          : kind === 'fill'
            ? await this.#session.prepareFill(observed.observationId, control.id, this.#searchText!, this.#abort.signal)
            : await this.#session.prepareSubmit(observed.observationId, control.id, this.#abort.signal);
      } catch (error) {
        this.#journal.recordNotDispatched(permit.executionId); executionId = undefined;
        throw error;
      }
      if (generation !== this.#generation) {
        prepared.release(); this.#journal.recordNotDispatched(permit.executionId); executionId = undefined;
        throw new ContractError('browse task was stopped');
      }
      this.#journal.markDispatchBoundary(permit.executionId);
      const matched = await prepared.send();
      const evidenceRef = `browse-${kind}-${permit.executionId}`;
      this.#journal.recordOutcome(permit.executionId, matched
        ? { deliveryStatus: 'dispatched', effectStatus: 'applied', verification: 'matched', evidenceRef }
        : { deliveryStatus: 'unknown', effectStatus: 'unknown', verification: 'unavailable' });
      executionId = undefined;
      if (!matched) throw new ContractError('browse step was not verified');
      if (kind === 'fill') this.#filled.add(`${observed.url}\n${control.label}`);
      this.#history.push(kind === 'fill' ? `Typed the user's search words into “${control.label}” on ${observed.url}.`
        : kind === 'submit' ? `Submitted the form with “${control.label}” on ${observed.url}.`
          : `Followed the link “${control.label}” to ${control.destinationUrl}.`);
      const verifyTicket = this.#journal.reserveTaskObservation(this.taskId, false);
      const verificationId = randomUUID();
      this.#journal.recordTaskObservation(this.taskId, verifyTicket, { observationId: verificationId,
        scopeRef: admission.scopeRef, stateDigest: digest({ kind: 'browse-step-verified', step, evidenceRef }) });
      this.#journal.recordTaskCheckpoint(this.taskId, { checkpointId: randomUUID(), observationId: verificationId,
        stageRef: `browse-step-${step}`, predicateRef: 'browse-step-verified-v1', evidenceRef,
        executionId: permit.executionId, terminal: false });
    } catch (error) {
      if (executionId && this.#journal.getAttempt(executionId)?.phase === 'at_dispatch_boundary') {
        this.#journal.recordOutcome(executionId, { deliveryStatus: 'unknown', effectStatus: 'unknown',
          verification: 'unavailable' });
      }
      throw error;
    } finally { this.#advancing = false; }
  }

  #candidates(observed: ManagedObservation, step: number): BuiltCandidateSet {
    const origin = new URL(observed.url).origin;
    const seen = new Set<string>([observed.url]);
    const links = observed.controls.filter(control => {
      if (!control.enabled || !control.destinationUrl || seen.has(control.destinationUrl)
        || new URL(control.destinationUrl).origin !== origin || control.destinationUrl.length > 512) return false;
      seen.add(control.destinationUrl);
      return true;
    }).map((control, index) => ({ control, index,
      score: this.#goalWords.filter(word => `${control.label} ${control.destinationUrl}`.toLowerCase()
        .includes(word)).length }))
      .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, MAX_LINKS).map(item => item.control);
    const editable = observed.controls.filter(control => control.editable && control.enabled
      && !this.#filled.has(`${observed.url}\n${control.label}`));
    return buildActionCandidates({ policyRevision: BROWSE_POLICY, allowPartialCoverage: true,
      source: { ...fromManagedObservation(observed),
        controls: fromManagedObservation(observed).controls.filter(control =>
          links.some(link => link.id === control.targetRef) || control.invokable
          || editable.some(field => field.id === control.targetRef)) },
      destinations: links.map((link, index) => ({ urlRef: `u${index}`, exactUrl: link.destinationUrl! })),
      ...(this.#searchText !== null ? { text: { textRef: 'search-text', source: 'final_command' as const,
        allowedTargetRefs: editable.map(control => control.id) } } : {}),
      submissions: observed.controls.filter(control => control.submittable).map(control => control.id),
      finishEvidenceRef: `browse-finish-${step}` });
  }

  pause(reasonRef: string): { readonly workerFenced: boolean } {
    this.#generation++; this.#abort.abort();
    if (['active', 'paused'].includes(this.#journal.getTaskState(this.taskId) ?? '')) {
      this.#journal.pauseTask(this.taskId, reasonRef);
    }
    return { workerFenced: !this.#advancing };
  }

  stop(): Promise<{ readonly workerFenced: boolean }> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#generation++; this.#abort.abort();
    if (['active', 'paused'].includes(this.#journal.getTaskState(this.taskId) ?? '')) {
      this.#journal.cancelTask(this.taskId);
    }
    this.#stopPromise = this.#session.close().then(() => ({ workerFenced: true }), () => ({ workerFenced: false }));
    return this.#stopPromise;
  }

  async prepareRecovery(): Promise<TaskRecoveryBinding> {
    throw new ContractError('browse tasks do not resume; start a new request');
  }

  resume(_ledger: UserPromptLedger, _intent: ResumeRequest): void {
    throw new ContractError('browse tasks do not resume; start a new request');
  }

  #active(generation: number): TaskAdmission {
    const record = this.#journal.getTaskRecord(this.taskId)!;
    if (generation !== this.#generation || record.state !== 'active' || !record.admission) {
      throw new ContractError('browse task is paused or stopped');
    }
    return record.admission;
  }
}

function semantic(observed: ManagedObservation) {
  return { url: observed.url, title: observed.title,
    controls: observed.controls.map(({ id: _id, ...control }) => control) };
}
