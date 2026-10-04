import { randomUUID } from 'node:crypto';
import { validateCandidate } from '../../protocol/src/contract.ts';
import { ContractError, digest } from '../../protocol/src/json.ts';
import type { JSONValue } from '../../protocol/src/json.ts';
import type { BuiltCandidateSet, ResolvedCandidate } from './action-candidates.ts';
import type { AgentAXClient, AgentElement, AgentSnapshot, AgentWindow } from './agent-ax-client.ts';
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
/** Built-in steps and the steps that would undo them. A toggled control (its label
 * flipped, e.g. Play → Pause) is its own inverse; that is detected from the screen. */
const INVERSE: Readonly<Record<string, readonly string[]>> = {
  'scroll:scroll-up': ['scroll:scroll-down', 'key:space'], 'scroll:scroll-down': ['scroll:scroll-up'],
  'key:space': ['key:space', 'scroll:scroll-up'], 'key:back': ['key:forward'], 'key:forward': ['key:back'],
  'key:nexttab': ['key:prevtab'], 'key:prevtab': ['key:nexttab'], 'key:newtab': ['key:closetab'],
  'key:undo': ['key:undo'], 'media:playpause': ['media:playpause'], 'media:mute': ['media:mute'],
  'media:volumeup': ['media:volumedown'], 'media:volumedown': ['media:volumeup'],
  'media:next': ['media:previous'], 'media:previous': ['media:next'],
  'media:brightnessup': ['media:brightnessdown'], 'media:brightnessdown': ['media:brightnessup'],
  'system:darkmode': ['system:darkmode'], 'system:wifi_on': ['system:wifi_off'], 'system:wifi_off': ['system:wifi_on'],
  'window_action:fullscreen': ['window_action:fullscreen'], 'window_action:zoom': ['window_action:zoom'],
};
const MEDIA: readonly [string, string][] = [
  ['playpause', 'play or pause whatever is playing sound, in whichever app is playing it'],
  ['next', 'skip to the next track in whatever is playing'],
  ['previous', 'go back to the previous track in whatever is playing'],
  ['volumeup', 'turn the Mac\'s volume up'], ['volumedown', 'turn the Mac\'s volume down'],
  ['mute', 'mute or unmute the Mac\'s sound'],
  ['brightnessup', 'make the screen brighter'], ['brightnessdown', 'make the screen dimmer'],
];
/** Steps that end an app or the user's session; offered only when the request asks to quit or close. */
const ENDS_APP = /^(?:quit|force quit|close window|close all|hide|log ?out|sign ?out|shut down|restart)\b/iu;
const BROWSERS = new Set(['com.google.Chrome', 'com.apple.Safari', 'company.thebrowser.Browser', 'com.microsoft.edgemac',
  'com.brave.Browser', 'org.mozilla.firefox', 'com.google.Chrome.canary', 'com.operasoftware.Opera']);
/** Agent tasks are longer and more exploratory than scripted fixtures. */
/** Long chores (inbox triage, forms) need many steps; runaway loops are
 * caught by the same-screen limit, so the step cap can be generous. */
const AGENT_LIMITS = Object.freeze({ maxObservations: 120, maxDecisions: 40, maxStateVisits: 6 });
/** What a step is judged against: everything visible, including text such as a song title. */
const content = (view: AgentSnapshot) => view.contentSignature || view.signature;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** One step proposal, shown to the user with exact observed labels only. */
export interface AgentProposal {
  readonly step: number;
  readonly kind: 'press' | 'type' | 'key' | 'scroll' | 'open_url' | 'open_app' | 'copy' | 'paste' | 'close' | 'quit_app'
    | 'focus_window' | 'window_action' | 'media' | 'open_file' | 'system' | 'answer' | 'open_settings' | 'menu' | 'status'
  | 'notifications' | 'look' | 'finish';
  readonly label: string;
  readonly destinationUrl: string | null;
  readonly pageUrl: string;
  readonly app: string;
  /** Needs an explicit yes even when steps are auto-allowed. */
  readonly risky: boolean;
}

/** `origin` says what was in front when the user asked, so "this tab" or "this
 * email" keeps meaning the same thing after the screen changes. */
export interface AgentDecision {
  select(set: BuiltCandidateSet, view: AgentSnapshot, signal: AbortSignal, history: readonly string[],
    origin?: string): Promise<string | null>;
  bestActions?(set: BuiltCandidateSet, view: AgentSnapshot, signal: AbortSignal,
    history: readonly string[], origin?: string): Promise<readonly string[]>;
  /** Picks which candidate piece of the request answers `question` (index), or null for none. */
  pickSpan?(request: string, role: 'typed' | 'file', spans: readonly string[], signal?: AbortSignal): Promise<number | null>;
  /** Which of `texts` (visible on screen) answers the user's question: its index, -1 when several
   * together do (read them all), or null when none does. */
  findAnswer?(view: AgentSnapshot, texts: readonly string[], signal: AbortSignal, history: readonly string[],
    origin?: string): Promise<number | null>;
  /** Picks one of `items` for the user's request (e.g. which Settings pane), or null. */
  chooseOne?(question: string, items: readonly string[], signal: AbortSignal): Promise<number | null>;
  /** Whether the user wants to be told something rather than have something done. */
  asksForAnswer?(request: string, signal?: AbortSignal): Promise<boolean>;
  /** Probability (0–1) that the whole goal is already achieved. */
  done?(view: AgentSnapshot, signal: AbortSignal, history: readonly string[], origin?: string): Promise<number>;
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
  /** Interrupts everything (sleep, lock): always asks first when "Ask before…" is on. */
  readonly risky?: boolean;
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
  readonly #openedUrls = new Set<string>();
  /** Tabs closed so far: a second close in one task asks first (repeated closing is how a
   * confused task does damage; one close is easily undone). */
  #closes = 0;
  #openedApp = false;
  #openedFile = false;
  #typedAt = new Set<string>();
  #waits = 0;
  #origin: string | undefined;
  readonly #say: ((text: string) => void) | undefined;
  /** The last step acted on the whole Mac, which the screen cannot confirm. */
  #lastOffScreen = false;
  /** Loop prevention, three general rules (no per-app special cases):
   * 1. never undo the previous step (its inverse, or re-pressing a control it flipped);
   * 2. on a screen seen before, don't repeat a step already taken from it (that led round a cycle);
   * 3. a step that changed nothing is not offered on that screen again (`#noEffect`).
   * Repeating a step that makes progress (Next, Next) stays allowed. */
  #undo = new Set<string>();
  readonly #takenFrom = new Map<string, Set<string>>();
  /** Text this task copied, available to paste. */
  #clipboard: string | null = null;
  /** Steps that changed nothing on a given screen are not offered there again. */
  readonly #noEffect = new Set<string>();
  readonly #trace: ((event: Record<string, JSONValue>) => void) | undefined;
  #lastView: AgentSnapshot = EMPTY_SNAPSHOT;
  /** The settled screen read after the last step, reused as the next observation. */
  #nextView: AgentSnapshot | undefined;

  /** What happened, for a follow-up request's context. */
  get summary(): { readonly history: readonly string[]; readonly app: string; readonly url: string } {
    return { history: [...this.#history], app: this.#lastView.app, url: this.#lastView.url };
  }

  static start(journal: AttemptJournal, registry: TaskAdmissionRegistry, admission: TaskAdmission,
    ax: AgentAXClient, options: { readonly goal: AgentGoal; readonly decision: AgentDecision;
      readonly confirmation: AgentConfirmation; readonly trace?: (event: Record<string, JSONValue>) => void;
      /** Shows and speaks an answer to the user. */
      readonly say?: (text: string) => void;
      /** A screen read already taken while the request was being understood. */
      readonly initialView?: AgentSnapshot }): UniversalAgentTask {
    const typed = admission.parameters.find(item => item.parameterRef === 'typed-text');
    const file = admission.parameters.find(item => item.parameterRef === 'file-name');
    if (admission.outcomeKind !== 'USER_CONFIRMATION' || admission.policyRevision !== AGENT_POLICY
      || admission.completionVerifierRef !== AGENT_VERIFIER
      || (options.goal.typedText === null) !== (typed === undefined)
      || (typed && typed.valueDigest !== digest(options.goal.typedText!.text))
      || (options.goal.fileName === null) !== (file === undefined)
      || (file && file.valueDigest !== digest(options.goal.fileName!.text))) {
      throw new ContractError('agent admission differs from the request');
    }
    journal.startAdmittedTask(registry, admission);
    try { journal.enableTaskProgress(admission.taskId, admission.scopeRef, admission.completionVerifierRef, AGENT_LIMITS); }
    catch (error) { journal.pauseTask(admission.taskId, 'agent_progress_failed'); throw error; }
    return new UniversalAgentTask(journal, admission, ax, options);
  }

  private constructor(journal: AttemptJournal, admission: TaskAdmission, ax: AgentAXClient,
    options: { readonly goal: AgentGoal; readonly decision: AgentDecision; readonly confirmation: AgentConfirmation;
      readonly trace?: (event: Record<string, JSONValue>) => void; readonly initialView?: AgentSnapshot;
      readonly say?: (text: string) => void }) {
    this.#trace = options.trace;
    this.#say = options.say;
    this.#nextView = options.initialView;
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
      const observeStarted = performance.now();
      const view = this.#nextView ?? await this.#observe();
      this.#nextView = undefined;
      const observeMs = Math.round(performance.now() - observeStarted);
      this.#lastView = view;
      this.#origin ??= view.pid ? `${view.app}${view.url ? `, on the browser tab “${view.windowTitle}” (${view.url.slice(0, 160)})`
        : view.windowTitle ? `, window “${view.windowTitle}”` : ''}` : 'no app';
      this.#active(generation);
      const observationId = randomUUID();
      this.#journal.recordTaskObservation(this.taskId, ticket, { observationId, scopeRef: admission.scopeRef,
        stateDigest: digest({ app: view.bundleId, title: view.windowTitle, url: view.url, signature: view.signature }) });
      this.#journal.consumeTaskDecision(this.taskId, observationId);
      const step = ++this.#step;
      const all = this.#options(view);
      // Answers are judged by their own question ("which text answers it?"), not mixed with actions.
      const told = new Set(this.#history.flatMap(item => /^Told the user: “(.*)”\.$/u.exec(item)?.[1] ?? []));
      const answers = all.filter(option => option.kind === 'answer' && option.ref !== 'read-page'
        && !told.has(option.label.slice(0, 160))).slice(0, 60);
      const options = all.filter(option => !answers.includes(option));
      const decideStarted = performance.now();
      // "Is it done?" and "is the answer on screen?" are asked separately, in parallel.
      const [chosen0, doneProbability, answerIndex] = await Promise.all([
        this.#choose(observationId, view, options, step, generation),
        this.#history.length && this.#decision.done
          ? this.#decision.done(view, this.#abort.signal, [...this.#history], this.#origin).catch(() => 0) : Promise.resolve(0),
        answers.length && this.#decision.findAnswer
          ? this.#decision.findAnswer(view, answers.map(option => option.label), this.#abort.signal, [...this.#history],
            this.#origin).catch(() => null) : Promise.resolve(null),
      ]);
      this.#active(generation);
      let { set, chosenId: proposedId, byId } = chosen0;
      let answer = answerIndex === null ? undefined : answerIndex === -1
        ? all.find(option => option.kind === 'answer' && option.ref === 'read-page') : answers[answerIndex];
      if (answer) ({ set, byId } = this.#set(observationId, [answer], step));
      // "Open a Settings pane…", "use a menu command…", "click a menu-bar icon…" are resolved
      // to one concrete item from the Mac's own list before anything is proposed.
      const general = !answer && proposedId ? byId.get(proposedId) : undefined;
      if (general && general.ref === 'choose' && this.#decision.chooseOne) {
        const concrete = await this.#resolve(general, view);
        this.#active(generation);
        if (!concrete) throw new ContractError(`nothing in the list fits: ${general.label}`);
        answer = concrete;
        ({ set, byId } = this.#set(observationId, [concrete], step));
      }
      // Once the user has been answered, a few more steps may look for the rest, not more.
      const lastTold = this.#history.findLastIndex(item => item.startsWith('Told the user'));
      const lookedLong = lastTold >= 0 && this.#history.length - 1 - lastTold >= 2;
      // Only a clear "yes" overrides the chooser; it can still choose to finish itself.
      const chosenId = answer ? 'c0' : doneProbability >= 0.8 || lookedLong ? 'finish' : proposedId;
      const decideMs = Math.round(performance.now() - decideStarted);
      // After a step on the whole Mac (dark mode, volume, media) the screen cannot show the
      // result; with nothing confident to do next, that step was the task, so finish.
      const finishing = set.candidates.find(item => item.operation === 'finish');
      let candidate = (chosenId ? set.candidates.find(item => item.candidateId === chosenId) : undefined)
        ?? (this.#lastOffScreen ? finishing : undefined);
      if (!candidate) throw new ContractError('no confident agent step');
      // Waiting cannot show a whole-Mac change either; once the waits are used up, it was done.
      if (candidate.operation === 'wait' && this.#waits >= 3 && this.#lastOffScreen && finishing) candidate = finishing;
      if (candidate.operation === 'wait' && this.#waits < 3) {
        // Waiting is a real step: let the screen settle, then look again.
        this.#waits++;
        this.#history.push('Waited for the screen to settle.');
        await new Promise(resolve => setTimeout(resolve, 1_000));
        return;
      }
      const option = chosenId ? byId.get(chosenId) : undefined;
      const finish = candidate.operation === 'finish';
      if (!finish && !option) throw new ContractError('agent choice does not resolve');
      const proposal: AgentProposal = Object.freeze({ step, kind: finish ? 'finish' : option!.kind,
        label: finish ? (view.windowTitle || view.app) : option!.label,
        destinationUrl: option?.kind === 'open_url' ? option.label : null, pageUrl: view.url, app: view.app,
        risky: !finish && (option!.risky === true || RISKY.test(`${option!.label} ${option!.element?.context ?? ''}`)) });
      this.#trace?.({ kind: 'step', step, app: view.app, window: view.windowTitle, url: view.url,
        elements: view.elements.length, options: options.length, chosen: proposal.kind, label: proposal.label,
        risky: proposal.risky, history: [...this.#history], observeMs, decideMs,
        readMs: view.readMs ?? null, visited: view.visited ?? null, via: view.via ?? null,
        done: Math.round(doneProbability * 100) / 100 });
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
      const actionKey = `${chosen.kind}:${chosen.ref}`;
      const permit: PreparedAttempt = Object.freeze({ taskId: this.taskId, taskEpoch: admission.taskEpoch,
        goalRevision: admission.goalRevision, executionId: randomUUID(), permitRef: randomUUID(),
        scopeRef: admission.scopeRef, observationId,
        candidateId: chosen.ref.replace(/[^A-Za-z0-9_.:-]/gu, '-').slice(0, 160) || 'step', candidateSetDigest: set.candidateSetDigest,
        actionDigest: digest({ kind: chosen.kind, ref: chosen.ref, label: chosen.label, app: view.bundleId,
          policyRevision: AGENT_POLICY }), policyRevision: AGENT_POLICY, leaseGeneration: 1 });
      this.#journal.prepare(permit); executionId = permit.executionId;
      if (generation !== this.#generation) {
        this.#journal.recordNotDispatched(permit.executionId); executionId = undefined;
        throw new ContractError('agent task was stopped');
      }
      this.#journal.markDispatchBoundary(permit.executionId);
      let copied: string | null = null;
      if (chosen.kind === 'look') {
        // Not an action on the Mac: the next reads of this screen include its image text.
        this.#lookAt = `${view.bundleId}|${view.windowTitle}`;
        this.#nextView = undefined;
        this.#journal.recordOutcome(permit.executionId, { deliveryStatus: 'dispatched', effectStatus: 'applied',
          verification: 'matched', evidenceRef: `agent-look-${permit.executionId}` });
        executionId = undefined;
        this.#history.push(`Read ${view.app}'s window from its screen image.`);
        this.#trace?.({ kind: 'result', step, changed: true, actMs: 0, verifyMs: 0, after: null });
        return;
      }
            if (chosen.kind === 'answer') {
        // Telling the user is not an action on the Mac: shown and spoken, then recorded.
        this.#say?.(chosen.ref === 'read-page' ? readable(view) : chosen.label);
        this.#journal.recordOutcome(permit.executionId, { deliveryStatus: 'dispatched', effectStatus: 'applied',
          verification: 'matched', evidenceRef: `agent-answer-${permit.executionId}` });
        executionId = undefined;
        // Told once per screen: never repeated from the same screen.
        this.#takenFrom.set(content(view), (this.#takenFrom.get(content(view)) ?? new Set<string>()).add(actionKey));
        // Reading the screen out is an answer too: what was read counts as told.
        this.#history.push(`Told the user: “${(chosen.ref === 'read-page' ? readable(view) : chosen.label).slice(0, 160)}”.`);
        this.#trace?.({ kind: 'result', step, changed: true, actMs: 0, verifyMs: 0, after: null });
        return;
      }
      const actStarted = performance.now();
      try {
        const result = await this.#act(chosen);
        if (chosen.kind === 'copy' && typeof result === 'string' && result) { copied = result; this.#clipboard = result; }
      }
      catch (error) {
        // The executor reported that the step could not be performed.
        this.#journal.recordOutcome(permit.executionId, { deliveryStatus: 'not_dispatched', effectStatus: 'not_applied',
          verification: 'unavailable' });
        executionId = undefined;
        const reason = error instanceof Error ? error.message.replace(/^agent step failed: /u, '') : '';
        // A step that failed is not retried on the same screen, like one that changed nothing.
        this.#noEffect.add(`${content(view)}|${actionKey}`);
        this.#history.push(`Tried to ${describeKind(chosen)} but it could not be performed${
          reason && !/unsupported|timed out|cancelled/u.test(reason) ? ` (${reason.slice(0, 80)})` : ''}.`);
        this.#active(generation);
        return;
      }
      const actMs = Math.round(performance.now() - actStarted);
      // Settle by watching, not by fixed pauses: read about every 120 ms until the screen has
      // changed and its layout held for one read (a loading page keeps changing), or until a
      // deadline when nothing changes. Steps whose effect is elsewhere get one quick look.
      const verifyStarted = performance.now();
      const opening = ['open_url', 'open_app', 'focus_window', 'open_file', 'open_settings', 'notifications'].includes(chosen.kind);
      const elsewhere = chosen.kind === 'copy' || ['media', 'system', 'window_action', 'menu', 'status'].includes(chosen.kind);
      const quiet = elsewhere ? 150 : opening ? 1_500 : 700;
      const deadline = verifyStarted + (opening ? 3_000 : elsewhere ? 600 : 1_500);
      await sleep(elsewhere ? 100 : 80);
      let after: AgentSnapshot | undefined;
      let previous: AgentSnapshot | undefined;
      for (;;) {
        after = await this.#observe().catch(() => undefined);
        const moved = !!after && content(after) !== content(view);
        if (moved && previous && previous.signature === after!.signature) break;
        if (elsewhere && after) break;
        const now = performance.now();
        if ((!moved && now - verifyStarted >= quiet) || now >= deadline) break;
        previous = moved ? after : undefined;
        await sleep(120);
      }
      const verifyMs = Math.round(performance.now() - verifyStarted);
      this.#nextView = after;
      // Copying changes the clipboard and media keys act on whichever app plays sound, so
      // neither shows on this screen; they count as done rather than "nothing changed".
      // Media keys and whole-Mac settings (dark mode, Wi‑Fi, brightness) act outside the app on screen.
      const offScreen = chosen.kind === 'media' || chosen.kind === 'system';
      // Window moves are checked by the executor (it reads the frame back and fails if the
      // window did not land), and an app's contents do not change when its window moves.
      // Menu commands and menu-bar clicks are confirmed by macOS accepting the press; their effect
      // (a bookmark saved, a window opened behind) need not show on the screen being read.
      const verified = offScreen || ['window_action', 'menu', 'status'].includes(chosen.kind);
      const changed = copied !== null || verified || (!!after && content(after) !== content(view));
      this.#lastOffScreen = offScreen;
      const evidenceRef = `agent-${chosen.kind}-${permit.executionId}`;
      this.#journal.recordOutcome(permit.executionId, changed
        ? { deliveryStatus: 'dispatched', effectStatus: 'applied', verification: 'matched', evidenceRef }
        : { deliveryStatus: 'dispatched', effectStatus: 'not_applied', verification: 'not_matched' });
      executionId = undefined;
      if (chosen.kind === 'type' && changed) this.#typedAt.add(`${view.signature}|${chosen.ref}`);
      if (!changed) this.#noEffect.add(`${content(view)}|${actionKey}`);
      else {
        const taken = this.#takenFrom.get(content(view)) ?? new Set<string>();
        this.#takenFrom.set(content(view), taken.add(actionKey));
      }
      // Whatever this step flipped (its own label, or a twin control's) must not be flipped straight back.
      // Ids are positions, so labels are compared only on the same page of the same app with the same layout.
      const samePage = !!after && after.bundleId === view.bundleId && after.url === view.url
        && after.elements.length === view.elements.length;
      const before = new Map(view.elements.map(item => [item.id, item]));
      this.#undo = new Set([...(INVERSE[actionKey] ?? []), ...(samePage ? after!.elements : [])
        .filter(item => item.pressable && before.get(item.id)?.role === item.role && before.get(item.id)!.label !== item.label)
        .map(item => `press:${item.id}`)]);
      if (chosen.kind === 'open_url') this.#openedUrls.add(chosen.label);
      if (chosen.kind === 'close' || (chosen.kind === 'menu' && /close tab/iu.test(chosen.label))) this.#closes++;
      if (chosen.kind === 'open_app' && chosen.ref === 'goal-app') this.#openedApp = true;
      const relabelled = chosen.element && after?.elements.find(item => item.id === chosen.element!.id
        && item.role === chosen.element!.role && item.label !== chosen.element!.label);
      this.#trace?.({ kind: 'result', step, changed, actMs, verifyMs, after: after ? { app: after.app,
        window: after.windowTitle, url: after.url } : null });
      this.#history.push(`${capitalize(describeKind(chosen))}${offScreen ? ` (it acts on the whole Mac or whichever app is playing, so it may not show on screen${macChange(view, after)})` : ` in ${view.app}`}${!changed ? '; nothing visibly changed'
        : relabelled ? `; it now reads “${relabelled.label}”` : ''}${
        after?.frontmost === false ? `; ${after.app} is open but behind other windows` : ''}.`);
      if (chosen.kind === 'open_file') this.#openedFile = true;
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
      // Why the task stopped (no confident step, declined, limits), for the trace.
      this.#trace?.({ kind: 'stopped', step: this.#step, reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
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
    let view: AgentSnapshot;
    try { view = await this.#ax.snapshot(this.taskId); } catch { return EMPTY_SNAPSHOT; }
    // Stage D: a window that exposes almost nothing (a canvas, some Electron apps, a remote
    // desktop) is also read from its pixels; "look" asks for the same on any screen.
    const readable = view.elements.filter(element => element.role !== 'AXStaticText' && element.label.trim()).length;
    const where = `${view.bundleId}|${view.windowTitle}`;
    if (view.vision && view.pid && (readable < 5 || this.#lookAt === where)) {
      const found = await this.#ax.call(this.taskId, 'vision_read', {}, 8_000).catch(() => []) as AgentElement[];
      if (Array.isArray(found) && found.length) {
        const labels = found.map(element => element.label).join('|');
        return { ...view, elements: [...view.elements, ...found],
          contentSignature: `${content(view)}|vision:${labels}` };
      }
    }
    return view;
  }

  /** The screen ("app|window") whose image should be read on the next looks. */
  #lookAt: string | undefined;

  async #act(option: Option): Promise<unknown> {
    const params: Record<string, JSONValue> = option.kind === 'press' || option.kind === 'copy' || option.kind === 'paste'
      || option.kind === 'close'
      ? { id: option.ref }
      : option.kind === 'type' ? { id: option.ref, text: this.#goal.typedText!.text }
        : option.kind === 'key' ? { name: option.ref }
          : option.kind === 'scroll' ? { down: option.ref === 'scroll-down' }
            : option.kind === 'open_url' ? { url: option.label, newTab: this.#newTab(this.#lastView) }
              : option.kind === 'quit_app' ? { name: option.label.replace(/[\u200e\u200f]/gu, '').trim() }
                : option.kind === 'focus_window' ? { id: option.ref }
                  : option.kind === 'window_action' ? { action: option.ref.split('@')[0]!, window: option.ref.split('@')[1] ?? '' }
                    : option.kind === 'media' || option.kind === 'system' ? { name: option.ref }
                      : option.kind === 'open_file' ? { name: this.#goal.fileName!.text }
                        : option.kind === 'open_settings' || option.kind === 'status' ? { id: option.ref }
                          : option.kind === 'menu' ? { path: option.ref }
                : { name: option.label };
    const op = option.kind === 'menu' ? 'menu_press' : option.kind === 'status' ? 'status_press'
      : option.kind as Exclude<Option['kind'], 'finish' | 'answer' | 'menu' | 'status' | 'look'>;
    return await this.#ax.call(this.taskId, op as Exclude<typeof op, 'look'>, params,
      ['open_url', 'open_app', 'open_file', 'open_settings'].includes(option.kind) ? 20_000 : 10_000);
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
          description: `In ${view.app}${view.windowTitle ? ` (showing “${view.windowTitle.slice(0, 60)}”)` : ''}: type “${this.#goal.typedText.text}” into the ${role(element.role)} “${element.label}”${where(element)}${
            element.role === 'AXTextArea' && element.value ? ` (adds after its existing text “${element.value.slice(0, 40)}”)`
              : element.value ? ` (replaces “${element.value.slice(0, 40)}”)` : ''}.`,
          score: score(element.label) + 3 });
      }
      if (this.#goal.clipboard && element.label.length <= 160 && !element.editable) {
        options.push({ kind: 'copy', ref: element.id, element, label: element.label,
          description: `In ${view.app}: copy the text “${element.label}”${where(element)} to the clipboard.`,
          score: score(element.label) * 2 + (/\d/u.test(element.label) ? 1 : 0) });
      }
      if (element.editable && this.#clipboard) {
        options.push({ kind: 'paste', ref: element.id, element, label: element.label,
          description: `In ${view.app}: paste the copied text “${this.#clipboard.slice(0, 60)}” into the ${role(element.role)} “${element.label}”${where(element)}.`,
          score: score(element.label) + 4 });
      }
      if (element.role === 'AXTab' && element.closable) {
        const where = element.url ? ` (${element.url.slice(0, 120)})` : '';
        options.push({ kind: 'press', ref: element.id, element, label: element.label,
          description: `Switch to the browser tab “${element.label}”${where}${element.selected ? ' (already the current tab)' : ''}.`,
          score: score(`${element.label} ${element.url ?? ''}`) * 2 });
        // Closing a tab is always offered: it is easily undone (Command-Shift-T), unlike quitting an app.
        options.push({ kind: 'close', ref: element.id, element, label: element.label,
          description: `Close the browser tab “${element.label}”${where}${element.selected ? ' (the current tab)' : ''}.`,
          score: score(`${element.label} ${element.url ?? ''}`), risky: this.#closes > 0 });
        continue;
      }
      if (!this.#goal.quit && ENDS_APP.test(element.label.replace(/^\u200e/u, ''))) continue;
      if (element.role === 'AXImageText') {
        // Read from the screen image: clicked (or clicked then typed into) at its place.
        options.push({ kind: 'press', ref: element.id, element, label: element.label, score: score(element.label),
          description: `In ${view.app}: click the text “${element.label}” (read from the screen image).` });
        if (this.#goal.typedText) {
          options.push({ kind: 'type', ref: element.id, element, label: element.label, score: score(element.label) + 1,
            description: `In ${view.app}: click on “${element.label}” (read from the screen image) and type “${this.#goal.typedText.text}” there.` });
        }
        continue;
      }
      if (element.role !== 'AXStaticText' && (element.pressable || !element.editable)) {
        options.push({ kind: 'press', ref: element.id, element, label: element.label,
          description: `In ${view.app}: ${['AXRow', 'AXCell', 'AXLink'].includes(element.role) ? 'open' : 'click'} the ${
            role(element.role)} “${element.label}”${where(element)}${
            element.url ? ` (goes to ${element.url.slice(0, 160)})` : ''}${element.selected ? ' (currently selected)' : ''}.`,
          score: score(`${element.label} ${element.context}`) });
      }
    }
    {
      // Identical tabs ("New Tab" ×3) are closed together; one at a time, they look alike and some get missed.
      const groups = new Map<string, AgentElement[]>();
      for (const tab of view.elements.filter(element => element.role === 'AXTab' && element.closable)) {
        const key = tab.url || tab.label;
        groups.set(key, [...(groups.get(key) ?? []), tab]);
      }
      for (const tabs of groups.values()) {
        if (tabs.length < 2) continue;
        options.push({ kind: 'close', ref: tabs.map(tab => tab.id).join(','), label: `${tabs.length} tabs “${tabs[0]!.label}”`,
          description: `Close all ${tabs.length} browser tabs titled “${tabs[0]!.label}”${tabs[0]!.url ? ` (${tabs[0]!.url.slice(0, 120)})` : ''} at once.`,
          score: score(`${tabs[0]!.label} ${tabs[0]!.url ?? ''} all`) + 2, risky: this.#closes > 0 });
      }
    }
    this.#goal.urls.forEach((url, index) => {
      if (this.#openedUrls.has(url) || view.url.includes(new URL(url).hostname.replace(/^www\./u, ''))) return;
      const inBrowser = view.pid > 0 && BROWSERS.has(view.bundleId);
      options.push({ kind: 'open_url', ref: `goal-url-${index}`, label: url,
        description: !inBrowser ? `Open ${url} in the web browser.`
          : this.#newTab(view) ? `Open ${url} in a new browser tab.`
            : `Go to ${url} in this browser tab (replacing “${view.windowTitle.slice(0, 60)}”).`, score: 10 });
    });
    const plain = (name: string) => name.replace(/[\u200e\u200f]/gu, '').trim().toLowerCase();
    const named = this.#goal.app ? plain(this.#goal.app) : null;
    if (this.#goal.quit) {
      // Quit by name directly; no need to bring the app forward first.
      const apps = [...new Set([...(view.pid ? [view.app] : []), ...(view.runningApps ?? []).slice(0, 20)])];
      for (const name of apps) {
        if (named && plain(name) !== named) continue;
        options.push({ kind: 'quit_app', ref: `quit:${name}`, label: name,
          description: `Quit the app ${plain(name) === plain(view.app) ? `${name} (in front now)` : name} completely, as Command-Q does.`,
          score: 10 + score(name) * 3 });
      }
    }
    // The whole Mac, not just the app in front: any open window can be brought forward.
    // The front window is the one whose title is the window being read (list order is not reliable).
    // Window titles often carry extras ("Page - Google Chrome – Profile"), so containment counts.
    const isFrontWindow = (window: AgentWindow) => plain(window.app) === plain(view.app)
      && (view.windowTitle ? window.title === view.windowTitle || window.title.includes(view.windowTitle)
        || (window.front === true && view.windowTitle.includes(window.title)) : window.front === true);
    const withWindows = new Set<string>();
    for (const window of (view.windows ?? []).slice(0, 60)) {
      withWindows.add(plain(window.app));
      if (isFrontWindow(window) && view.frontmost !== false) continue;
      options.push({ kind: 'focus_window', ref: window.id, label: `${window.app}: ${window.title || 'untitled window'}`,
        description: `Bring ${window.app}'s window “${(window.title || 'untitled').slice(0, 100)}”${
          (view.displays?.length ?? 0) > 1 && window.display ? ` (on “${window.display}”)` : ''} to the front${
          window.minimized ? ' (it is minimised)' : ''}${window.hidden ? ' (the app is hidden)' : ''}.`,
        score: score(`${window.app} ${window.title}`) * 2 });
    }
    for (const [name, text] of MEDIA) {
      options.push({ kind: 'media', ref: name, label: text, score: score(text),
        description: `Press the Mac's media key to ${text} (it may be a different app from ${view.app || 'the one in front'}).` });
    }
    if (this.#goal.fileName && !this.#openedFile) {
      options.push({ kind: 'open_file', ref: 'goal-file', label: this.#goal.fileName.text, score: 10,
        description: `Find the file or folder named “${this.#goal.fileName.text}” on this Mac and open it.` });
    }
    if (this.#goal.wantsAnswer) {
      // The answer is read from the screen: any visible text can be told to the user, and
      // Jev may first navigate to where the answer is. Nothing is made up.
      for (const element of view.elements) {
        const text = element.role === 'AXStaticText' ? element.label
          : element.value && !element.secure ? `${element.label}: ${element.value}` : '';
        if (!text || text.length > 300) continue;
        options.push({ kind: 'answer', ref: element.id, label: text, score: score(text) + 1,
          description: `Tell the user: “${text}”${element.context && element.context !== text ? ` (from “${element.context.slice(0, 60)}”)` : ''}.` });
      }
    }
    if (view.elements.some(element => element.role === 'AXStaticText')) {
      // Always available: reading out is never mistaken for an action on the Mac.
      options.push({ kind: 'answer', ref: 'read-page', label: 'read the page aloud', score: 1,
        description: `Read the text on screen in ${view.app} aloud to the user.` });
    }
    // Whole-Mac actions; the ones that interrupt everything ask first.
    for (const [name, text, risky] of [['sleep', 'put the Mac to sleep', true], ['lock', 'lock the screen', true],
      ['displaysleep', 'turn the display off', true], ['screenshot', 'take a screenshot of the whole screen (saved to the Desktop)', false],
      ['darkmode', 'switch the Mac between light and dark mode', false], ['wifi_on', 'turn Wi‑Fi on', false],
      ['wifi_off', 'turn Wi‑Fi off (this also cuts SystemOne off from Jev)', true]] as const) {
      options.push({ kind: 'system', ref: name, label: text, risky, score: score(text),
        description: `On the Mac: ${text}.` });
    }
    if (view.pid) {
      options.push({ kind: 'menu', ref: 'choose', label: `a menu command of ${view.app}`, score: 1,
        description: `Use one of ${view.app}'s own menu commands (its File, Edit, View, Window or Help menus); only for things inside ${view.app} itself, not other apps or the Mac's System Settings.` });
    }
    if (view.vision && view.pid && this.#lookAt !== `${view.bundleId}|${view.windowTitle}`) {
      options.push({ kind: 'look', ref: 'screen-image', label: 'read the screen image', score: 0,
        description: `Read ${view.app}'s window from its screen image, to find buttons and text the app does not expose (slower).` });
    }
        if (view.bundleId !== 'com.apple.notificationcenterui') {
      options.push({ kind: 'notifications', ref: 'centre', label: 'Notification Centre', score: 1,
        description: 'Open Notification Centre to see, read or open notifications (messages, reminders, alerts).' });
    }
    options.push({ kind: 'status', ref: 'choose', label: 'a menu-bar icon', score: 1,
      description: 'Click an icon on the right of the menu bar (e.g. Wi‑Fi, Bluetooth, Battery, Control Centre, Focus, Spotlight, other apps’ icons).' });
    if (view.settingsPanes?.length && view.bundleId !== 'com.apple.systempreferences') {
      const some = view.settingsPanes.map(pane => pane.name).filter(name => !/settings|extension|intents/iu.test(name)).slice(0, 14);
      options.push({ kind: 'open_settings', ref: 'choose', label: 'a System Settings pane', score: 1,
        description: `Open a specific System Settings pane (there are ${view.settingsPanes.length}, e.g. ${some.join(', ')}).` });
    }
    // Apps that are installed but not open: the closest name matches, plus the system's own.
    const running = new Set([...(view.runningApps ?? []), view.app].map(plain));
    const closed = (view.installedApps ?? []).filter(name => !running.has(plain(name)) && name !== this.#goal.app);
    const picked = [...closed].map((name, index) => ({ name, index, match: score(name) }))
      .sort((a, b) => b.match - a.match || a.index - b.index).filter(item => item.match > 0).slice(0, 12).map(item => item.name);
    for (const name of new Set([...picked, ...closed.filter(name => ['System Settings', 'Finder'].includes(name))])) {
      options.push({ kind: 'open_app', ref: `app:${name}`, label: name, score: score(name) * 3,
        description: `Open the app ${name} (installed, not open yet).` });
    }
    if (this.#goal.windows) {
      // Placement for the front window and for other windows of the same app or named in the
      // request ("both VS Code windows side by side"); each is checked after it moves.
      const PLACES: [string, string][] = [['left_half', 'to the left half of its screen'],
        ['right_half', 'to the right half of its screen'], ['top_half', 'to the top half of its screen'],
        ['bottom_half', 'to the bottom half of its screen'], ['maximize', 'to fill its screen (not full-screen mode)'],
        ['center', 'to the centre of its screen'], ['next_display', 'to the other display (monitor), if there is one'],
        ['mouse_display', 'to the display where the pointer is ("this monitor")'],
        // With several displays, each can be named ("move it to the LG").
        ...((view.displays?.length ?? 0) > 1 ? view.displays!.map(display => [`display_${display.index}`,
          `to the display “${display.name}”${display.pointer ? ' (where the pointer is)' : ''}`] as [string, string]) : [])];
      if (view.pid) {
        // The front window is named too, so it reads like the other windows' options.
        const front = `the front window${view.windowTitle ? ` (${view.app}'s “${view.windowTitle.slice(0, 60)}”)` : ''}`;
        const actions: [string, string][] = [['minimize', `minimise ${front} to the Dock`],
          ...PLACES.map(([action, where]) => [action, `move ${front} ${where}`] as [string, string]),
          ['fullscreen', 'make the front window full screen (or leave full screen)'],
          ['zoom', 'zoom the front window'],
          ...(this.#goal.quit ? [['close', 'close the front window (the app keeps running)'] as [string, string]] : []),
          ['hide_app', `hide the app ${view.app}`]];
        for (const [action, text] of actions) {
          options.push({ kind: 'window_action', ref: action, label: text, description: `In ${view.app}: ${text}.`, score: score(text) });
        }
      }
      const others = (view.windows ?? []).filter(window => !isFrontWindow(window)
        && (plain(window.app) === plain(view.app) || score(`${window.app} ${window.title}`) > 0)).slice(0, 6);
      for (const window of others) {
        const name = `${window.app}'s window “${(window.title || 'untitled').slice(0, 60)}”`;
        for (const [action, where] of [...PLACES, ['minimize', 'to the Dock (minimise)'] as [string, string]]) {
          options.push({ kind: 'window_action', ref: `${action}@${window.id}`, label: `move ${name} ${where}`,
            description: `Move ${name} ${where}.`, score: score(`${window.app} ${window.title} ${where}`) });
        }
      }
    }
    for (const name of (view.runningApps ?? []).slice(0, 20)) {
      if (plain(name) === plain(view.app) && view.frontmost !== false || name === this.#goal.app
        || withWindows.has(plain(name)) || (this.#goal.quit && named && plain(name) === named)) continue;
      options.push({ kind: 'open_app', ref: `app:${name}`, label: name,
        description: `Switch to the app ${name} (already open).`, score: score(name) * 3 });
    }
    // An app in front with no window open ("open Finder" with only its menu bar showing) still
    // needs opening: that opens a new window, as clicking it in the Dock does.
    const windowless = !!named && plain(view.app) === named && !!view.windows
      && !view.windows.some(window => plain(window.app) === named && !window.minimized);
    if (this.#goal.app && !this.#openedApp && (plain(view.app) !== named || windowless) && !this.#goal.quit) {
      options.push({ kind: 'open_app', ref: 'goal-app', label: this.#goal.app,
        description: windowless ? `Open a new ${this.#goal.app} window (it has none open).` : `Open the app ${this.#goal.app}.`, score: 10 });
    }
    if (view.pid) {
      // With a real tab list, tabs are switched and closed by name, never by blind cycling.
      const listedTabs = view.elements.some(element => element.role === 'AXTab' && element.closable);
      const browserKeys = BROWSERS.has(view.bundleId)
        ? BROWSER_KEYS.filter(([name]) => !listedTabs || !['nexttab', 'prevtab', 'closetab'].includes(name)) : [];
      const keys = [...browserKeys, ...KEYS,
        ...(this.#goal.undo ? [['undo', 'Undo the last change (Command-Z)'] as [string, string]] : [])];
      for (const [name, text] of keys) {
        options.push({ kind: 'key', ref: name, label: text, description: `In ${view.app}: ${text}.`,
          score: score(text) });
      }
      options.push({ kind: 'scroll', ref: 'scroll-down', label: 'Scroll down', description: `In ${view.app}: scroll down to see more.`, score: 0 });
      options.push({ kind: 'scroll', ref: 'scroll-up', label: 'Scroll up', description: `In ${view.app}: scroll up.`, score: 0 });
    }
    return options.filter(option => this.#allowed(view, `${option.kind}:${option.ref}`))
      .map((option, index) => ({ option, index }))
      .sort((a, b) => b.option.score - a.option.score || a.index - b.index)
      .slice(0, MAX_OPTIONS).map(item => item.option);
  }

  /** The three loop rules, for any option key on this screen. */
  #allowed(view: AgentSnapshot, key: string): boolean {
    return !this.#noEffect.has(`${content(view)}|${key}`) && !this.#undo.has(key)
      && !this.#takenFrom.get(content(view))?.has(key);
  }

  /** Turns a general "pick from a list" option into one concrete item, chosen by Jev. */
  async #resolve(general: Option, view: AgentSnapshot): Promise<Option | undefined> {
    const choose = (question: string, items: readonly string[]) =>
      this.#decision.chooseOne!(question, items, this.#abort.signal).catch(() => null);
    if (general.kind === 'open_settings') {
      const panes = (view.settingsPanes ?? []).filter(item => this.#allowed(view, `open_settings:${item.id}`));
      const pane = panes[await choose('Which System Settings pane does the user need?', panes.map(item => item.name)) ?? -1];
      return pane && { kind: 'open_settings', ref: pane.id, label: pane.name, score: 0,
        description: `Open System Settings at the “${pane.name}” pane.` };
    }
    if (general.kind === 'menu') {
      const listed = await this.#ax.call(this.taskId, 'menu_items').catch(() => []) as string[];
      const paths = Array.isArray(listed) ? listed.filter(path => this.#allowed(view, `menu:${path}`)) : [];
      const path = paths[await choose(`Which of ${view.app}'s own menu commands does the user need? Choose none if what they`
        + ` want is not a command of ${view.app} itself (for example another app, or the Mac's System Settings).`, paths) ?? -1];
      return path === undefined ? undefined : { kind: 'menu', ref: path, label: path, score: 0,
        description: `In ${view.app}: choose the menu command ${path}.` };
    }
    if (general.kind === 'status') {
      const listed = await this.#ax.call(this.taskId, 'status_items').catch(() => []) as { id: string; name: string }[];
      const items = Array.isArray(listed) ? listed.filter(item => this.#allowed(view, `status:${item.id}`)) : [];
      const item = Array.isArray(items) ? items[await choose('Which menu-bar icon does the user need?', items.map(entry => entry.name)) ?? -1] : undefined;
      return item && { kind: 'status', ref: item.id, label: item.name, score: 0,
        description: `Click the menu-bar icon “${item.name}”.` };
    }
    return undefined;
  }

  /** A new tab only when asked for one and the tab in front isn't already a blank new tab. */
  #newTab(view: AgentSnapshot): boolean {
    return this.#goal.newTab && !/^(?:chrome|edge|brave|vivaldi):\/\/new-?tab|^about:(?:blank|newtab)|^favorites:/u.test(view.url);
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
      const candidate: Record<string, JSONValue> = ['focus_window', 'window_action', 'media', 'open_file', 'system', 'answer',
        'open_settings', 'menu', 'status', 'notifications', 'look'].includes(option.kind)
        ? { ...base, operation: 'invoke', targetRef: `${option.kind}:${option.ref}`.replace(/[^A-Za-z0-9_.:-]/gu, '-').slice(0, 160),
          parameters: {}, effects: ['NAVIGATE', 'EXTERNAL_WRITE'] }
        : option.kind === 'quit_app'
        ? { ...base, operation: 'invoke', targetRef: option.ref.replace(/[^A-Za-z0-9_.:-]/gu, '-').slice(0, 160),
          parameters: {}, effects: ['EXTERNAL_WRITE'] }
        : option.kind === 'close'
        ? { ...base, operation: 'tab_operation', parameters: { tabOperation: 'close', tabRef: option.ref.replaceAll(',', '_') }, effects: ['NAVIGATE'] }
        : option.kind === 'copy'
        ? { ...base, operation: 'copy', targetRef: option.ref, parameters: {}, effects: ['READ', 'CLIPBOARD_WRITE'] }
        : option.kind === 'paste'
          ? { ...base, operation: 'set_value', targetRef: option.ref, parameters: { textRef: 'clipboard-text' },
            effects: ['LOCAL_EDIT', 'CLIPBOARD_READ', 'EXTERNAL_WRITE'] }
        : option.kind === 'press'
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
        operation: option.kind === 'type' || option.kind === 'paste' ? 'set_value' : option.kind === 'open_url' ? 'navigate' : 'invoke',
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
      // Preliminary rounds are independent, so they run in parallel.
      const picks = await Promise.all(rounds.map(async round => {
        const { set, byId } = this.#set(observationId, round, step);
        const ids = this.#decision.bestActions
          ? await this.#decision.bestActions(set, view, this.#abort.signal, [...this.#history], this.#origin)
          : [await this.#decision.select(set, view, this.#abort.signal, [...this.#history], this.#origin)];
        return ids.slice(0, 2).map(id => (id ? byId.get(id) : undefined)).filter((item): item is Option => !!item);
      }));
      this.#active(generation);
      finalists = [...new Set(picks.flat())];
    }
    const { set, byId } = this.#set(observationId, finalists, step);
    const chosenId = await this.#decision.select(set, view, this.#abort.signal, [...this.#history], this.#origin);
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
    AXTab: 'tab', AXCell: 'item', AXDisclosureTriangle: 'disclosure', AXSlider: 'slider',
    AXImageText: 'text on screen' } as Record<string, string>)[axRole]
    ?? axRole.replace(/^AX/u, '').toLowerCase();
}

/** What a whole-Mac step changed, e.g. "; volume 50% → 60%". */
function macChange(before: AgentSnapshot, after: AgentSnapshot | undefined): string {
  const a = before.mac;
  const b = after?.mac;
  if (!a || !b) return '';
  const parts = [a.darkMode !== b.darkMode ? `dark mode ${b.darkMode ? 'now on' : 'now off'}` : '',
    a.wifiOn !== b.wifiOn ? `Wi‑Fi ${b.wifiOn ? 'now on' : 'now off'}` : '',
    a.volume !== b.volume ? `volume ${a.volume}% → ${b.volume}%` : '',
    a.muted !== b.muted ? (b.muted ? 'now muted' : 'now unmuted') : ''].filter(Boolean);
  return parts.length ? `; ${parts.join(', ')}` : '';
}

/** The visible text of a screen, in reading order, for "read this to me". */
function readable(view: AgentSnapshot): string {
  return view.elements.filter(element => element.role === 'AXStaticText').map(element => element.label)
    .join('. ').replace(/\.\s*\./gu, '.').slice(0, 3_000);
}

function describeKind(option: Option): string {
  switch (option.kind) {
    case 'press': return option.element?.role === 'AXTab' ? `switched to the tab “${option.label.slice(0, 60)}”`
      : `clicked “${option.label}”${option.element?.context && option.element.context !== option.label
        ? ` (in “${option.element.context.slice(0, 80)}”)` : ''}`;
    case 'type': return `typed the user's text into “${option.label}”`;
    case 'key': return option.label.split(' (')[0]!.toLowerCase();
    case 'scroll': return option.label.toLowerCase();
    case 'open_url': return `opened ${option.label}${option.description.includes('new browser tab') ? ' in a new tab'
      : option.description.includes('this browser tab') ? ' in the same tab' : ''}`;
    case 'open_app': return `opened the app ${option.label}`;
    case 'copy': return `copied “${option.label.slice(0, 60)}”`;
    case 'paste': return `pasted the copied text into “${option.label}”`;
    case 'close': return `closed the tab “${option.label.slice(0, 60)}”`;
    case 'quit_app': return `quit the app ${option.label}`;
    case 'focus_window': return `brought the window “${option.label.slice(0, 80)}” to the front`;
    case 'window_action': return option.label;
    case 'media': return `pressed the media key to ${option.label}`;
    case 'open_file': return `opened the file or folder “${option.label}”`;
    case 'system': return option.label;
    case 'answer': return `told the user “${option.label.slice(0, 80)}”`;
    case 'open_settings': return `opened System Settings at “${option.label}”`;
    case 'menu': return `chose the menu command ${option.label}`;
    case 'status': return `clicked the menu-bar icon “${option.label}”`;
    case 'notifications': return 'opened Notification Centre';
    case 'look': return 'read the screen image';
    default: return 'finished';
  }
}

function capitalize(text: string): string { return text.charAt(0).toUpperCase() + text.slice(1); }
