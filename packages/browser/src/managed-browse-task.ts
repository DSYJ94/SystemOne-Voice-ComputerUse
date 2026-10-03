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
const FILLER = new Set(['and', 'the', 'for', 'search', 'look', 'find', 'open', 'visit', 'navigate',
  'then', 'page', 'please', 'www', 'com', 'org', 'net', 'http', 'https']);

/** Options per decision round; larger pages are judged in rounds. */
const ROUND_SIZE = 45;
const MAX_OPTIONS = 270;

/** Chooses one offered candidate ID, or null to abstain. Never supplies URLs or text. */
export interface BrowseDecision {
  /** history: host-written summaries of verified steps, oldest first. */
  select(set: BuiltCandidateSet, observed: ManagedObservation, signal: AbortSignal,
    history: readonly string[]): Promise<string | null>;
  /** Optional preliminary-round ranking: the most plausible effect candidates
   * (at most two) even when a non-effect choice scores higher. */
  bestActions?(set: BuiltCandidateSet, observed: ManagedObservation, signal: AbortSignal,
    history: readonly string[]): Promise<readonly string[]>;
}

export interface BrowseProposal {
  readonly step: number;
  readonly kind: 'navigate' | 'fill' | 'submit' | 'click' | 'finish';
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
      readonly limits?: TaskProgressLimits;
      /** Words of the site name (e.g. "wikipedia") never count as goal words. */
      readonly siteWords?: readonly string[] }): ManagedBrowseTask {
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
    return new ManagedBrowseTask(journal, admission, session, { ...options,
      siteWords: (options.siteWords ?? []).map(word => word.toLowerCase()) });
  }

  private constructor(journal: AttemptJournal, admission: TaskAdmission, session: ManagedObservationSession,
    options: { readonly searchText: string | null; readonly decision: BrowseDecision;
      readonly confirmation: BrowseConfirmation; readonly siteWords: readonly string[] }) {
    this.taskId = admission.taskId; this.#journal = journal; this.#session = session;
    this.#decision = options.decision; this.#confirmation = options.confirmation;
    this.#searchText = options.searchText;
    this.#goalWords = Object.freeze(admission.goal.toLowerCase().split(/[^\p{L}\p{N}]+/u)
      .filter(word => word.length > 2 && !FILLER.has(word) && !options.siteWords.includes(word)));
  }

  async advance(): Promise<void> {
    if (this.#advancing) throw new ContractError('browse step already pending');
    const generation = this.#generation;
    const admission = this.#active(generation);
    this.#advancing = true;
    let executionId: string | undefined;
    try {
      const ticket = this.#journal.reserveTaskObservation(this.taskId);
      const observed = await this.#observeSettled(generation);
      this.#active(generation);
      this.#journal.recordTaskObservation(this.taskId, ticket, { observationId: observed.observationId,
        scopeRef: admission.scopeRef, stateDigest: digest(semantic(observed)) });
      this.#journal.consumeTaskDecision(this.taskId, observed.observationId);
      const step = ++this.#step;
      const { set, chosenId } = await this.#choose(observed, step, generation);
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
      const kind = resolved.operation === 'navigate' ? 'navigate' : resolved.operation === 'set_value' ? 'fill'
        : resolved.parameterRef === 'click' ? 'click' : 'submit';
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
            : kind === 'click'
              ? await this.#session.prepareClick(observed.observationId, control.id, this.#abort.signal)
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
          : kind === 'click' ? `Clicked “${control.label}” on ${observed.url}; the page changed.`
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

  /** A late redirect can change the page mid-read; settle and retry briefly. */
  async #observeSettled(generation: number): Promise<ManagedObservation> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.#session.observe(); }
      catch (error) {
        this.#active(generation);
        if (attempt >= 2 || !String(error).includes('changed during observation')) throw error;
        await this.#session.settle();
      }
    }
  }

  /** Every eligible observed control, best lexical matches first. Ranking only
   * orders rounds; the model judges all of them. */
  #options(observed: ManagedObservation) {
    const seen = new Set<string>([observed.url]);
    const score = (text: string) => this.#goalWords.filter(word => text.toLowerCase().includes(word)).length;
    const ranked = observed.controls.filter(control => {
      if (!control.enabled) return false;
      if (control.destinationUrl) {
        if (seen.has(control.destinationUrl) || control.destinationUrl.length > 512) return false;
        seen.add(control.destinationUrl);
        return true;
      }
      return control.clickable || control.submittable
        || (control.editable && this.#searchText !== null && !this.#filled.has(`${observed.url}\n${control.label}`));
    }).map((control, index) => ({ control, index,
      score: score(`${control.label} ${control.destinationUrl ?? ''}`) + (control.editable || control.submittable ? 2 : 0)
        - (control.hidden ? 1 : 0) }))
      .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, MAX_OPTIONS).map(item => item.control);
    return ranked;
  }

  #set(observed: ManagedObservation, step: number, controls: readonly ManagedObservation['controls'][number][]): BuiltCandidateSet {
    const ids = new Set(controls.map(control => control.id));
    const source = fromManagedObservation(observed);
    // One label per editable field keeps set_value unambiguous inside a round.
    const editable = controls.filter(control => control.editable);
    return buildActionCandidates({ policyRevision: BROWSE_POLICY, allowPartialCoverage: true,
      crossOriginDestinations: true,
      source: { ...source, controls: source.controls.filter(control => ids.has(control.targetRef)) },
      destinations: controls.filter(control => control.destinationUrl)
        .map((control, index) => ({ urlRef: `u${index}`, exactUrl: control.destinationUrl! })),
      ...(this.#searchText !== null && editable.length ? { text: { textRef: 'search-text', source: 'final_command' as const,
        allowedTargetRefs: editable.map(control => control.id) } } : {}),
      submissions: controls.filter(control => control.submittable).map(control => control.id),
      clicks: controls.filter(control => control.clickable).map(control => control.id),
      finishEvidenceRef: `browse-finish-${step}` });
  }

  /** Judge every option: one round for small pages, otherwise rounds of
   * ROUND_SIZE whose winners meet in a final round. */
  async #choose(observed: ManagedObservation, step: number, generation: number) {
    const options = this.#options(observed);
    const rounds: (typeof options)[] = [];
    for (let i = 0; i < options.length; i += ROUND_SIZE) rounds.push(options.slice(i, i + ROUND_SIZE));
    if (rounds.length <= 1) {
      const set = this.#set(observed, step, options);
      const chosenId = await this.#decision.select(set, observed, this.#abort.signal, [...this.#history]);
      this.#active(generation);
      return { set, chosenId };
    }
    const winners: typeof options = [];
    for (const round of rounds) {
      const set = this.#set(observed, step, round);
      const ids = this.#decision.bestActions
        ? await this.#decision.bestActions(set, observed, this.#abort.signal, [...this.#history])
        : [await this.#decision.select(set, observed, this.#abort.signal, [...this.#history])];
      this.#active(generation);
      for (const id of ids.slice(0, 2)) {
        const ref = id ? set.resolve(id, observed.observationId, set.candidateSetDigest)?.targetRef : undefined;
        const winner = round.find(control => control.id === ref);
        if (winner && !winners.includes(winner)) winners.push(winner);
      }
    }
    const set = this.#set(observed, step, winners);
    const chosenId = await this.#decision.select(set, observed, this.#abort.signal, [...this.#history]);
    this.#active(generation);
    return { set, chosenId };
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
