import { randomUUID } from 'node:crypto';
import { validateCandidate } from '../../protocol/src/contract.ts';
import { ContractError, digest } from '../../protocol/src/json.ts';
import type { JSONValue } from '../../protocol/src/json.ts';
import type { BuiltCandidateSet, ResolvedCandidate } from './action-candidates.ts';
import type { AgentAXClient, AgentElement, AgentSnapshot } from './agent-ax-client.ts';
import type { AgentGoal } from './agent-goal.ts';
import { AttemptJournal } from './attempt-journal.ts';
import type { PreparedAttempt } from './attempt-journal.ts';
import type { PersistentTaskWorkflow } from './persistent-task-actor.ts';
import { TaskAdmissionRegistry } from './task-authority.ts';
import type { TaskAdmission } from './task-authority.ts';
import type { TaskRecoveryBinding } from './task-recovery.ts';
import type { ResumeRequest, UserPromptLedger } from './user-prompts.ts';

export const AGENT_POLICY = 'universal-agent-confirmed-v1';
export const AGENT_VERIFIER = 'user-confirmed-agent-goal-v1';
const ROUND_SIZE = 45;
const MAX_OPTIONS = 300;
/** Labels that always need an explicit yes, even with auto-allow on. */
const RISKY = /\b(send|post|publish|buy|purchase|pay|checkout|check out|order|subscribe|delete|remove|trash|erase|discard|unsubscribe|sign out|log ?out|password|transfer|withdraw|donate|book now|reserve|accept|agree)\b/iu;
const FILLER = new Set(['and', 'the', 'for', 'then', 'please', 'with', 'from', 'this', 'that', 'into', 'onto', 'open', 'click']);
const KEYS: readonly [string, string][] = [
  ['space', 'Press Space (plays or pauses media, scrolls a page)'],
  ['return', 'Press Return (confirms or opens the focused item)'],
  ['escape', 'Press Escape (closes a menu, dialog or full screen)'],
  ['tab', 'Press Tab (moves focus to the next control)'],
  ['find', 'Open Find (Command-F)'],
];
const BROWSER_KEYS: readonly [string, string][] = [
  ['closetab', 'Close the current tab (Command-W)'],
  ['newtab', 'Open a new tab (Command-T)'],
  ['nexttab', 'Switch to the next tab (Control-Tab)'],
  ['prevtab', 'Switch to the previous tab (Control-Shift-Tab)'],
  ['back', 'Go back to the previous page (Command-[)'],
  ['forward', 'Go forward (Command-])'],
  ['reload', 'Reload the page (Command-R)'],
];
const BROWSERS = new Set(['com.google.Chrome', 'com.apple.Safari', 'company.thebrowser.Browser', 'com.microsoft.edgemac',
  'com.brave.Browser', 'org.mozilla.firefox', 'com.google.Chrome.canary', 'com.operasoftware.Opera']);
/** Agent tasks are longer and more exploratory than scripted fixtures. */
const AGENT_LIMITS = Object.freeze({ maxObservations: 200, maxDecisions: 60, maxStateVisits: 8 });

/** One step proposal, shown to the user with exact observed labels only. */
export interface AgentProposal {
  readonly step: number;
  readonly kind: 'press' | 'type' | 'key' | 'scroll' | 'open_url' | 'open_app' | 'finish';
  readonly label: string;
  readonly destinationUrl: string | null;
  readonly pageUrl: string;
  readonly app: string;
  /** Needs an explicit yes even when steps are auto-allowed. */
  readonly risky: boolean;
}

export interface AgentDecision {
  select(set: BuiltCandidateSet, view: AgentSnapshot, signal: AbortSignal, history: readonly string[]): Promise<string | null>;
  bestActions?(set: BuiltCandidateSet, view: AgentSnapshot, signal: AbortSignal,
    history: readonly string[]): Promise<readonly string[]>;
}

export interface AgentConfirmation {
  confirm(proposal: AgentProposal, signal: AbortSignal): Promise<boolean>;
}

interface Option {
  readonly kind: AgentProposal['kind'];
  readonly ref: string;
  readonly element?: AgentElement;
  readonly description: string;
  readonly label: string;
  readonly score: number;
}

const EMPTY_SNAPSHOT: AgentSnapshot = Object.freeze({ app: 'no app', bundleId: '', pid: 0, windowTitle: '',
  url: '', elements: [], truncated: false, signature: 'none' });

/** Voice/text computer use on the target Mac app (including the user's own
 * browser) through Accessibility. Every step is chosen from host-built
 * candidates, confirmed (or auto-allowed unless risky), permitted once,
 * journaled and checked for a visible change; completion is user-confirmed. */
export class UniversalAgentTask implements PersistentTaskWorkflow {
  readonly taskId: string;
  readonly #journal: AttemptJournal;
  readonly #ax: AgentAXClient;
  readonly #goal: AgentGoal;
  readonly #decision: AgentDecision;
  readonly #confirmation: AgentConfirmation;
  readonly #words: readonly string[];
  readonly #history: string[] = [];
  #abort = new AbortController();
  #generation = 0;
  #advancing = false;
  #step = 0;
  #openedUrl = false;
  #openedApp = false;
  #typedAt = new Set<string>();
  #waits = 0;
  /** Steps that changed nothing on a given screen are not offered there again. */
  readonly #noEffect = new Set<string>();
  readonly #trace: ((event: Record<string, JSONValue>) => void) | undefined;
  #lastView: AgentSnapshot = EMPTY_SNAPSHOT;

  /** What happened, for a follow-up request's context. */
  get summary(): { readonly history: readonly string[]; readonly app: string; readonly url: string } {
    return { history: [...this.#history], app: this.#lastView.app, url: this.#lastView.url };
  }

  static start(journal: AttemptJournal, registry: TaskAdmissionRegistry, admission: TaskAdmission,
    ax: AgentAXClient, options: { readonly goal: AgentGoal; readonly decision: AgentDecision;
      readonly confirmation: AgentConfirmation; readonly trace?: (event: Record<string, JSONValue>) => void }): UniversalAgentTask {
    const typed = admission.parameters.find(item => item.parameterRef === 'typed-text');
    if (admission.outcomeKind !== 'USER_CONFIRMATION' || admission.policyRevision !== AGENT_POLICY
      || admission.completionVerifierRef !== AGENT_VERIFIER
      || (options.goal.typedText === null) !== (typed === undefined)
      || (typed && typed.valueDigest !== digest(options.goal.typedText!.text))) {
      throw new ContractError('agent admission differs from the request');
    }
    journal.startAdmittedTask(registry, admission);
    try { journal.enableTaskProgress(admission.taskId, admission.scopeRef, admission.completionVerifierRef, AGENT_LIMITS); }
    catch (error) { journal.pauseTask(admission.taskId, 'agent_progress_failed'); throw error; }
    return new UniversalAgentTask(journal, admission, ax, options);
  }

  private constructor(journal: AttemptJournal, admission: TaskAdmission, ax: AgentAXClient,
    options: { readonly goal: AgentGoal; readonly decision: AgentDecision; readonly confirmation: AgentConfirmation;
      readonly trace?: (event: Record<string, JSONValue>) => void }) {
    this.#trace = options.trace;
    this.taskId = admission.taskId; this.#journal = journal; this.#ax = ax; this.#goal = options.goal;
    this.#decision = options.decision; this.#confirmation = options.confirmation;
    this.#words = Object.freeze(admission.goal.toLowerCase().split(/[^\p{L}\p{N}]+/u)
      .filter(word => word.length > 2 && !FILLER.has(word)));
  }

  async advance(): Promise<void> {
    if (this.#advancing) throw new ContractError('agent step already pending');
    const generation = this.#generation;
    const admission = this.#active(generation);
    this.#advancing = true;
    let executionId: string | undefined;
    try {
      const ticket = this.#journal.reserveTaskObservation(this.taskId);
      const view = await this.#observe();
      this.#lastView = view;
      this.#active(generation);
      const observationId = randomUUID();
      this.#journal.recordTaskObservation(this.taskId, ticket, { observationId, scopeRef: admission.scopeRef,
        stateDigest: digest({ app: view.bundleId, title: view.windowTitle, url: view.url, signature: view.signature }) });
      this.#journal.consumeTaskDecision(this.taskId, observationId);
      const step = ++this.#step;
      const options = this.#options(view);
      const { set, chosenId, byId } = await this.#choose(observationId, view, options, step, generation);
      const candidate = chosenId ? set.candidates.find(item => item.candidateId === chosenId) : undefined;
      if (!candidate) throw new ContractError('no confident agent step');
      if (candidate.operation === 'wait' && this.#waits < 3) {
        // Waiting is a real step: let the screen settle, then look again.
        this.#waits++;
        this.#history.push('Waited for the screen to settle.');
        await new Promise(resolve => setTimeout(resolve, 1_000));
        return;
      }
      const option = byId.get(chosenId!);
      const finish = candidate.operation === 'finish';
      if (!finish && !option) throw new ContractError('agent choice does not resolve');
      const proposal: AgentProposal = Object.freeze({ step, kind: finish ? 'finish' : option!.kind,
        label: finish ? (view.windowTitle || view.app) : option!.label,
        destinationUrl: option?.kind === 'open_url' ? this.#goal.url : null, pageUrl: view.url, app: view.app,
        risky: !finish && RISKY.test(`${option!.label} ${option!.element?.context ?? ''}`) });
      this.#trace?.({ kind: 'step', step, app: view.app, window: view.windowTitle, url: view.url,
        elements: view.elements.length, options: options.length, chosen: proposal.kind, label: proposal.label,
        risky: proposal.risky, history: [...this.#history] });
      const confirmed = await this.#confirmation.confirm(proposal, this.#abort.signal);
      this.#active(generation);
      if (!confirmed) throw new ContractError('user declined the agent step');
      if (finish) {
        const evidenceRef = `user-confirmed-${randomUUID()}`;
        this.#journal.recordTaskCheckpoint(this.taskId, { checkpointId: randomUUID(), observationId,
          stageRef: `agent-finish-${step}`, predicateRef: AGENT_VERIFIER, evidenceRef, terminal: true });
        this.#journal.completeTask(this.taskId, evidenceRef);
        return;
      }
      const chosen = option!;
      const permit: PreparedAttempt = Object.freeze({ taskId: this.taskId, taskEpoch: admission.taskEpoch,
        goalRevision: admission.goalRevision, executionId: randomUUID(), permitRef: randomUUID(),
        scopeRef: admission.scopeRef, observationId, candidateId: chosen.ref, candidateSetDigest: set.candidateSetDigest,
        actionDigest: digest({ kind: chosen.kind, ref: chosen.ref, label: chosen.label, app: view.bundleId,
          policyRevision: AGENT_POLICY }), policyRevision: AGENT_POLICY, leaseGeneration: 1 });
      this.#journal.prepare(permit); executionId = permit.executionId;
      if (generation !== this.#generation) {
        this.#journal.recordNotDispatched(permit.executionId); executionId = undefined;
        throw new ContractError('agent task was stopped');
      }
      this.#journal.markDispatchBoundary(permit.executionId);
      try { await this.#act(chosen); }
      catch (error) {
        // The executor reported that the step could not be performed.
        this.#journal.recordOutcome(permit.executionId, { deliveryStatus: 'not_dispatched', effectStatus: 'not_applied',
          verification: 'unavailable' });
        executionId = undefined;
        this.#history.push(`Tried to ${describeKind(chosen)} but it could not be performed.`);
        this.#active(generation);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, chosen.kind === 'open_url' || chosen.kind === 'open_app' ? 300 : 700));
      const after = await this.#observe().catch(() => undefined);
      const changed = !!after && after.signature !== view.signature;
      const evidenceRef = `agent-${chosen.kind}-${permit.executionId}`;
      this.#journal.recordOutcome(permit.executionId, changed
        ? { deliveryStatus: 'dispatched', effectStatus: 'applied', verification: 'matched', evidenceRef }
        : { deliveryStatus: 'dispatched', effectStatus: 'not_applied', verification: 'not_matched' });
      executionId = undefined;
      if (chosen.kind === 'type' && changed) this.#typedAt.add(`${view.signature}|${chosen.ref}`);
      if (!changed) this.#noEffect.add(`${view.signature}|${chosen.kind}:${chosen.ref}`);
      if (chosen.kind === 'open_url') this.#openedUrl = true;
      if (chosen.kind === 'open_app' && chosen.ref === 'goal-app') this.#openedApp = true;
      const relabelled = chosen.element && after?.elements.find(item => item.id === chosen.element!.id
        && item.role === chosen.element!.role && item.label !== chosen.element!.label);
      this.#trace?.({ kind: 'result', step, changed, after: after ? { app: after.app, window: after.windowTitle,
        url: after.url } : null });
      this.#history.push(`${capitalize(describeKind(chosen))} in ${view.app}${!changed ? '; nothing visibly changed'
        : relabelled ? `; it now reads “${relabelled.label}”` : ''}.`);
      if (changed) {
        const verifyTicket = this.#journal.reserveTaskObservation(this.taskId, false);
        const verificationId = randomUUID();
        this.#journal.recordTaskObservation(this.taskId, verifyTicket, { observationId: verificationId,
          scopeRef: admission.scopeRef, stateDigest: digest({ kind: 'agent-step-verified', step, evidenceRef }) });
        this.#journal.recordTaskCheckpoint(this.taskId, { checkpointId: randomUUID(), observationId: verificationId,
          stageRef: `agent-step-${step}`, predicateRef: 'agent-visible-change-v1', evidenceRef,
          executionId: permit.executionId, terminal: false });
      }
    } catch (error) {
      if (executionId && this.#journal.getAttempt(executionId)?.phase === 'at_dispatch_boundary') {
        this.#journal.recordOutcome(executionId, { deliveryStatus: 'unknown', effectStatus: 'unknown',
          verification: 'unavailable' });
      } else if (executionId && this.#journal.getAttempt(executionId)?.phase === 'prepared') {
        this.#journal.recordNotDispatched(executionId);
      }
      throw error;
    } finally { this.#advancing = false; }
  }

  async #observe(): Promise<AgentSnapshot> {
    try { return await this.#ax.snapshot(this.taskId); }
    catch { return EMPTY_SNAPSHOT; }
  }

  async #act(option: Option): Promise<void> {
    const params: Record<string, JSONValue> = option.kind === 'press' ? { id: option.ref }
      : option.kind === 'type' ? { id: option.ref, text: this.#goal.typedText!.text }
        : option.kind === 'key' ? { name: option.ref }
          : option.kind === 'scroll' ? { down: option.ref === 'scroll-down' }
            : option.kind === 'open_url' ? { url: this.#goal.url! }
              : { name: option.label };
    await this.#ax.call(this.taskId, option.kind as Exclude<Option['kind'], 'finish'>, params,
      option.kind === 'open_url' || option.kind === 'open_app' ? 20_000 : 10_000);
  }

  #options(view: AgentSnapshot): Option[] {
    const score = (text: string) => this.#words.filter(word => text.toLowerCase().includes(word)).length;
    const options: Option[] = [];
    const where = (element: AgentElement) => element.context && element.context !== element.label
      ? ` in “${element.context}”` : '';
    for (const element of view.elements) {
      if (element.secure) continue;
      if (element.editable && this.#goal.typedText && !this.#typedAt.has(`${view.signature}|${element.id}`)) {
        options.push({ kind: 'type', ref: element.id, element, label: element.label,
          description: `In ${view.app}: type “${this.#goal.typedText.text}” into the ${role(element.role)} “${element.label}”${where(element)}${
            element.role === 'AXTextArea' && element.value ? ` (adds after its existing text “${element.value.slice(0, 40)}”)`
              : element.value ? ` (replaces “${element.value.slice(0, 40)}”)` : ''}.`,
          score: score(element.label) + 3 });
      }
      if (element.pressable || !element.editable) {
        options.push({ kind: 'press', ref: element.id, element, label: element.label,
          description: `In ${view.app}: click the ${role(element.role)} “${element.label}”${where(element)}${
            element.url ? ` (goes to ${element.url.slice(0, 160)})` : ''}${element.selected ? ' (currently selected)' : ''}.`,
          score: score(`${element.label} ${element.context}`) });
      }
    }
    if (this.#goal.url && !this.#openedUrl && !view.url.includes(new URL(this.#goal.url).hostname.replace(/^www\./u, ''))) {
      options.push({ kind: 'open_url', ref: 'goal-url', label: this.#goal.url,
        description: `Open ${this.#goal.url} in the default web browser.`, score: 10 });
    }
    for (const name of (view.runningApps ?? []).slice(0, 20)) {
      if (name.toLowerCase() === view.app.toLowerCase() || name === this.#goal.app) continue;
      options.push({ kind: 'open_app', ref: `app:${name}`, label: name,
        description: `Switch to the app ${name} (already open).`, score: score(name) * 3 });
    }
    if (this.#goal.app && !this.#openedApp && view.app.toLowerCase() !== this.#goal.app.toLowerCase()) {
      options.push({ kind: 'open_app', ref: 'goal-app', label: this.#goal.app,
        description: `Open the app ${this.#goal.app}.`, score: 10 });
    }
    if (view.pid) {
      const keys = BROWSERS.has(view.bundleId) ? [...BROWSER_KEYS, ...KEYS] : KEYS;
      for (const [name, text] of keys) {
        options.push({ kind: 'key', ref: name, label: text, description: `In ${view.app}: ${text}.`,
          score: score(text) });
      }
      options.push({ kind: 'scroll', ref: 'scroll-down', label: 'Scroll down', description: `In ${view.app}: scroll down to see more.`, score: 0 });
      options.push({ kind: 'scroll', ref: 'scroll-up', label: 'Scroll up', description: `In ${view.app}: scroll up.`, score: 0 });
    }
    return options.filter(option => !this.#noEffect.has(`${view.signature}|${option.kind}:${option.ref}`))
      .map((option, index) => ({ option, index }))
      .sort((a, b) => b.option.score - a.option.score || a.index - b.index)
      .slice(0, MAX_OPTIONS).map(item => item.option);
  }

  #set(observationId: string, options: readonly Option[], step: number) {
    const candidates: Record<string, JSONValue>[] = [];
    const resolutions = new Map<string, ResolvedCandidate>();
    const byId = new Map<string, Option>();
    for (const option of options) {
      const candidateId = `c${candidates.length}`;
      const base = { candidateId, description: option.description.slice(0, 1_200), preconditions: ['fresh_observation'],
        verifier: { kind: 'content_changed' }, delivery: 'semantic', riskPolicyRef: AGENT_POLICY,
        replayPolicy: 'only_if_not_applied' };
      const candidate: Record<string, JSONValue> = option.kind === 'press'
        ? { ...base, operation: 'invoke', targetRef: option.ref, parameters: {}, effects: ['NAVIGATE', 'EXTERNAL_WRITE'] }
        : option.kind === 'type'
          ? { ...base, operation: 'set_value', targetRef: option.ref, parameters: { textRef: 'typed-text' },
            effects: ['LOCAL_EDIT', 'EXTERNAL_WRITE'] }
          : option.kind === 'key' ? { ...base, operation: 'key_chord', parameters: { keyChordRef: option.ref },
            effects: ['NAVIGATE', 'EXTERNAL_WRITE'] }
            : option.kind === 'scroll' ? { ...base, operation: 'scroll', targetRef: 'focused-window',
              parameters: { direction: option.ref === 'scroll-down' ? 'down' : 'up', amount: 'page' }, effects: ['READ'] }
              : option.kind === 'open_url' ? { ...base, operation: 'navigate', parameters: { urlRef: 'goal-url' },
                effects: ['NAVIGATE', 'EXTERNAL_READ'] }
                : { ...base, operation: 'activate_app',
                  parameters: { appRef: option.ref.replace(/[^A-Za-z0-9_.:-]/gu, '-').slice(0, 160) }, effects: ['NAVIGATE'] };
      validateCandidate(candidate);
      candidates.push(Object.freeze(candidate));
      byId.set(candidateId, option);
      resolutions.set(candidateId, Object.freeze({ candidateId,
        operation: option.kind === 'type' ? 'set_value' : option.kind === 'open_url' ? 'navigate' : 'invoke',
        targetRef: option.ref, parameterRef: option.kind }));
    }
    const fallback = (id: string, operation: string, description: string, parameters: Record<string, JSONValue>) => {
      const candidate = { candidateId: id, description, operation, parameters, preconditions: [],
        verifier: operation === 'finish' ? { kind: 'user_confirmation' } : { kind: 'no_effect_expected' },
        effects: ['READ'], delivery: 'controller', riskPolicyRef: AGENT_POLICY,
        replayPolicy: 'idempotent_verified' } as Record<string, JSONValue>;
      validateCandidate(candidate);
      candidates.push(Object.freeze(candidate));
    };
    fallback('finish', 'finish', 'Done: what the user asked for has already happened on screen, so stop here.',
      { completionEvidenceRef: `agent-finish-${step}` });
    fallback('wait', 'wait', 'Wait briefly, then look at the screen again before acting.', { timeoutMs: 1_000 });
    fallback('request_help', 'request_help', 'Pause and ask the user because no offered action can safely advance this task.',
      { reason: 'uncertain_decision' });
    const frozen = Object.freeze([...candidates]);
    const candidateSetDigest = digest([...frozen]);
    const set: BuiltCandidateSet = Object.freeze({ observationId, candidateSetDigest, candidates: frozen, abstained: false,
      resolve(candidateId: string, id: string, supplied: string) {
        return id === observationId && supplied === candidateSetDigest ? resolutions.get(candidateId) : undefined;
      } });
    return { set, byId };
  }

  async #choose(observationId: string, view: AgentSnapshot, options: readonly Option[], step: number, generation: number) {
    const rounds: Option[][] = [];
    for (let i = 0; i < options.length; i += ROUND_SIZE) rounds.push(options.slice(i, i + ROUND_SIZE));
    let finalists = options;
    if (rounds.length > 1) {
      const winners: Option[] = [];
      for (const round of rounds) {
        const { set, byId } = this.#set(observationId, round, step);
        const ids = this.#decision.bestActions
          ? await this.#decision.bestActions(set, view, this.#abort.signal, [...this.#history])
          : [await this.#decision.select(set, view, this.#abort.signal, [...this.#history])];
        this.#active(generation);
        for (const id of ids.slice(0, 2)) {
          const winner = id ? byId.get(id) : undefined;
          if (winner && !winners.includes(winner)) winners.push(winner);
        }
      }
      finalists = winners;
    }
    const { set, byId } = this.#set(observationId, finalists, step);
    const chosenId = await this.#decision.select(set, view, this.#abort.signal, [...this.#history]);
    this.#active(generation);
    return { set, chosenId, byId };
  }

  pause(reasonRef: string): { readonly workerFenced: boolean } {
    this.#generation++; this.#abort.abort();
    if (['active', 'paused'].includes(this.#journal.getTaskState(this.taskId) ?? '')) this.#journal.pauseTask(this.taskId, reasonRef);
    return { workerFenced: !this.#advancing };
  }

  async stop(): Promise<{ readonly workerFenced: boolean }> {
    this.#generation++; this.#abort.abort();
    if (['active', 'paused'].includes(this.#journal.getTaskState(this.taskId) ?? '')) this.#journal.cancelTask(this.taskId);
    return { workerFenced: true };
  }

  async prepareRecovery(): Promise<TaskRecoveryBinding> {
    throw new ContractError('agent tasks do not resume; say the request again');
  }

  resume(_ledger: UserPromptLedger, _intent: ResumeRequest): void {
    throw new ContractError('agent tasks do not resume; say the request again');
  }

  #active(generation: number): TaskAdmission {
    const record = this.#journal.getTaskRecord(this.taskId)!;
    if (generation !== this.#generation || record.state !== 'active' || !record.admission) {
      throw new ContractError('agent task is paused or stopped');
    }
    return record.admission;
  }
}

function role(axRole: string): string {
  return ({ AXButton: 'button', AXLink: 'link', AXTextField: 'text field', AXTextArea: 'text area',
    AXSearchField: 'search field', AXComboBox: 'combo box', AXCheckBox: 'checkbox', AXRadioButton: 'option',
    AXPopUpButton: 'pop-up menu', AXMenuButton: 'menu button', AXMenuItem: 'menu item', AXMenuBarItem: 'menu',
    AXTab: 'tab', AXCell: 'item', AXDisclosureTriangle: 'disclosure', AXSlider: 'slider' } as Record<string, string>)[axRole]
    ?? axRole.replace(/^AX/u, '').toLowerCase();
}

function describeKind(option: Option): string {
  switch (option.kind) {
    case 'press': return `clicked “${option.label}”`;
    case 'type': return `typed the user's text into “${option.label}”`;
    case 'key': return option.label.split(' (')[0]!.toLowerCase();
    case 'scroll': return option.label.toLowerCase();
    case 'open_url': return `opened ${option.label}`;
    case 'open_app': return `opened the app ${option.label}`;
    default: return 'finished';
  }
}

function capitalize(text: string): string { return text.charAt(0).toUpperCase() + text.slice(1); }
