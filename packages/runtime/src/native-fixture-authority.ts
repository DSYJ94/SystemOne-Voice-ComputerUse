import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ContractError, digest } from '../../protocol/src/json.ts';
import { UserPromptLedger } from './user-prompts.ts';
import type { TaskRecoveryBinding } from './task-recovery.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { AttemptJournal } from './attempt-journal.ts';
import type { CommittedInput } from './committed-input.ts';
import { CommittedInputSession } from './committed-input.ts';
import { bindCommandValue } from './command-value-span.ts';
import { NativeFixtureTask } from './native-fixture-task.ts';
import type { NativeFixtureDecision } from './native-fixture-task.ts';
import { validNativePressObservation } from './native-press-authority.ts';
import type { NativeLocateRequest, NativeOpenRequest, NativePressRequest,
  NativePressResult, NativePressWorker } from './native-press-authority.ts';
import { PersistentTaskActor } from './persistent-task-actor.ts';
import { TaskAdmissionRegistry } from './task-authority.ts';
import type { TaskProgressLimits } from './task-progress.ts';

const BUNDLE = 'com.aurium.systemone.fixture';
const TITLES = { navigate: 'SystemOne Fixture — Documents',
  locate: 'SystemOne Fixture — Documents — Budget.xlsx selected',
  open: 'SystemOne Fixture — Documents — Budget.xlsx opened' };
export type NativeFixtureMode = keyof typeof TITLES;
type Mode = NativeFixtureMode;
export interface NativeRecoveryPrompt extends TaskRecoveryBinding {
  readonly promptId: string;
  readonly presentationDigest: string;
  readonly uiSessionRef: string;
  readonly actorRef: 'native-dev-ui';
  readonly presentation: Readonly<{ title: string; text: string; resumeLabel: string; cancelLabel: string }>;
}
interface Pending {
  requestId: string;
  readonly abort: AbortController;
  stopped: boolean;
  touched: boolean;
  actor?: PersistentTaskActor;
}

/** Native controller intake for the existing fixed fixture commands. The actor
 * owns execution after admission; this wrapper never reconstructs a capability
 * from persisted JSON or enables a model/general native action. */
export class NativeFixtureAuthority {
  readonly #journal: AttemptJournal;
  readonly #worker: NativePressWorker;
  readonly #limits: TaskProgressLimits | undefined;
  readonly #seen = new Set<string>();
  #pending: Pending | undefined;
  #actor: PersistentTaskActor | undefined;
  #recovering = false;
  #mode: Mode | undefined;
  #prompt: { descriptor: NativeRecoveryPrompt; endpoint: ReturnType<typeof bindEndpoint>;
    ledger: UserPromptLedger; presented: boolean } | undefined;
  #fenceFailed = false;
  #stopping = false;
  #stopPromise: Promise<{ workerFenced: boolean; unresolvedExecutionIds: readonly string[] }> | undefined;

  constructor(journal: AttemptJournal, worker: NativePressWorker, limits?: TaskProgressLimits) {
    this.#journal = journal; this.#worker = worker;
    this.#limits = limits ? Object.freeze({ ...limits }) : undefined;
  }

  get taskId(): string | undefined { return this.#pending?.requestId ?? this.#actor?.taskId; }
  get needsRecovery(): boolean {
    return this.#fenceFailed || this.#stopping || this.#actor?.needsRecovery === true
      || this.#journal.unresolvedAttempts().length > 0;
  }

  /** An optional decision selects each step; without one the fixed script does. */
  start(request: NativePressRequest, decision?: NativeFixtureDecision): Promise<NativePressResult | 'paused'> {
    return this.#start(request, 'navigate', decision);
  }
  startLocate(request: NativeLocateRequest, decision?: NativeFixtureDecision): Promise<NativePressResult | 'paused'> {
    return this.#start(request, 'locate', decision);
  }
  startOpen(request: NativeOpenRequest, decision?: NativeFixtureDecision): Promise<NativePressResult | 'paused'> {
    return this.#start(request, 'open', decision);
  }

  async #start(request: NativePressRequest | NativeLocateRequest, mode: Mode,
    decision?: NativeFixtureDecision): Promise<NativePressResult | 'paused'> {
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(request.requestId)
      || request.bundleId !== BUNDLE || request.folderName !== 'Documents'
      || (mode !== 'navigate' && (!('fileName' in request) || request.fileName !== 'Budget.xlsx'))
      || request.expectedWindowTitle !== TITLES[mode]
      || this.#seen.has(request.requestId) || this.#seen.size >= 1000 || this.#pending || this.#recovering) return 'error';
    this.#seen.add(request.requestId);
    if (this.needsRecovery || this.#journal.pendingTaskIds().length) return 'uncertain';
    const pending: Pending = { requestId: request.requestId, abort: new AbortController(), stopped: false, touched: false };
    this.#pending = pending; this.#stopPromise = undefined; this.#actor = undefined;
    try {
      const { session, input } = this.#acceptCommand(request, mode, request.requestId, 1);
      return await this.#execute(pending, mode, session, input, decision);
    } catch {
      return pending.stopped ? 'stopped' : this.#journal.unresolvedAttempts(request.requestId).length ? 'uncertain' : 'error';
    } finally {
      // Paused actors remain retained for explicit Stop/recovery. Their aborted
      // workflow cannot execute; unfinished operations retain actor ownership.
      if (pending.touched && !pending.actor && !pending.stopped) await this.#fence(request.requestId);
      if (this.#pending === pending) this.#pending = undefined;
    }
  }

  #acceptCommand(request: NativePressRequest | NativeLocateRequest, mode: Mode,
    taskId: string, goalRevision: number): { session: CommittedInputSession; input: CommittedInput } {
    const prefix = mode === 'navigate' ? 'Navigate synthetic fixture to '
      : `${mode === 'open' ? 'Open' : 'Locate'} synthetic fixture file `;
    const value = mode === 'navigate' ? 'Documents' : 'Documents/Budget.xlsx';
    const command = request.command; const surface = command.originSurface;
    if (request.bundleId !== BUNDLE || request.folderName !== 'Documents'
      || (mode !== 'navigate' && (!('fileName' in request) || request.fileName !== 'Budget.xlsx'))
      || request.expectedWindowTitle !== TITLES[mode]
      || command.source !== 'text' || command.text !== prefix + value || command.mode !== 'command'
      || command.taskId !== taskId || command.taskEpoch !== 1 || command.goalRevision !== goalRevision
      || !surface || Array.isArray(surface) || typeof surface !== 'object'
      || surface.appBundleId !== 'com.aurium.systemone.dev') throw new ContractError('invalid fixture command');
    const endpoint = bindEndpoint(['command']);
    const session = new CommittedInputSession(endpoint, { taskId, taskEpoch: 1, goalRevision });
    const route = session.accept(endpoint, Buffer.from(JSON.stringify(command)));
    if (route.kind !== 'interpret_command') throw new ContractError('expected final command');
    bindCommandValue(route.input, mode === 'navigate' ? 'folder-name' : 'synthetic-file-path', prefix, value);
    return { session, input: route.input };
  }

  async #execute(pending: Pending, mode: Mode, session: CommittedInputSession,
    commandInput: CommittedInput, decision?: NativeFixtureDecision): Promise<NativePressResult | 'paused'> {
    pending.touched = true;
    const observed = await this.#worker.observePress({ taskId: pending.requestId,
      bundleId: BUNDLE, signal: pending.abort.signal });
    if (pending.stopped) return 'stopped';
    if (!validNativePressObservation(observed) || !observed.complete || observed.windowTitles.length !== 1) return 'unsupported';
    const registry = new TaskAdmissionRegistry({ taskId: commandInput.taskId,
      taskEpoch: commandInput.taskEpoch, goalRevision: commandInput.goalRevision }, session);
    const admission = registry.admit(commandInput, { admissionId: randomUUID(), goal: commandInput.text,
      outcomeKind: mode === 'navigate' ? 'NAVIGATE' : mode === 'locate' ? 'LOCATE' : 'OPEN',
      scopeRef: observed.scopeRef, completionVerifierRef: mode === 'navigate' ? 'native-fixture-window-title-v1'
        : mode === 'locate' ? 'native-fixture-selected-title-v1' : 'native-fixture-opened-title-v1',
      policyRevision: 'native-ax-press-fixture-v1', approvedEffects: ['READ', 'NAVIGATE'], parameters: [bindCommandValue(commandInput,
        mode === 'navigate' ? 'folder-name' : 'synthetic-file-path',
        mode === 'navigate' ? 'Navigate synthetic fixture to ' : `${mode === 'open' ? 'Open' : 'Locate'} synthetic fixture file `,
        mode === 'navigate' ? 'Documents' : 'Documents/Budget.xlsx')] });
    const workflow = NativeFixtureTask.start(this.#journal, this.#worker, registry, admission,
      this.#limits, decision, observed);
    const actor = new PersistentTaskActor(this.#journal, workflow, 3_000);
    pending.actor = actor; this.#actor = actor; this.#mode = mode;
    const result = await actor.run();
    return this.#result(result, mode, pending.stopped);
  }

  /** Explicit changed fixture goal, admitted only after the old actor settles
   * and its worker fence succeeds. No source command is reparsed or reissued. */
  async replace(taskId: string, request: NativePressRequest | NativeLocateRequest,
    mode: Mode): Promise<NativePressResult | 'paused'> {
    const actor = this.#requireActor(taskId);
    const replacementId = request.requestId;
    if (!Object.hasOwn(TITLES, mode) || mode === this.#mode || replacementId === taskId
      || !/^[A-Za-z0-9_.:-]{1,160}$/.test(replacementId) || this.#seen.has(replacementId)
      || this.#seen.size >= 1_000 || this.#journal.getTaskRecord(replacementId)) throw new ContractError('invalid replacement identity/goal');
    const accepted = this.#acceptCommand(request, mode, taskId, actor.snapshot.goalRevision + 1);
    this.#seen.add(replacementId); this.#clearPrompt();
    const pending: Pending = { requestId: taskId, abort: new AbortController(), stopped: false, touched: false, actor };
    this.#pending = pending; this.#stopPromise = undefined;
    try {
      const report = await actor.correct(accepted.session, accepted.input);
      if (!report.workerFenced) this.#fenceFailed = true;
      if (pending.stopped) return 'stopped';
      if (!report.workerFenced || !report.operationSettled || report.unresolvedExecutionIds.length
        || this.#journal.unresolvedAttempts().length || this.#journal.pendingTaskIds().length) return 'uncertain';
      const revision = { taskId: replacementId, taskEpoch: 1, goalRevision: accepted.input.goalRevision };
      const transfer = accepted.session.transferClaimedCorrection(accepted.input, revision);
      pending.requestId = replacementId; delete pending.actor;
      return await this.#execute(pending, mode, transfer.session, transfer.input);
    } catch {
      return pending.stopped ? 'stopped' : this.#journal.unresolvedAttempts().length ? 'uncertain' : 'error';
    } finally {
      if (pending.touched && !pending.actor && !pending.stopped) await this.#fence(pending.requestId);
      if (this.#pending === pending) this.#pending = undefined;
    }
  }

  /** A fresh read can only recover the exact actor retained in this process. */
  async prepareRecovery(taskId: string, uiSessionRef: string): Promise<NativeRecoveryPrompt> {
    const actor = this.#requireActor(taskId);
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(uiSessionRef)) throw new ContractError('invalid UI session');
    this.#clearPrompt(); this.#recovering = true;
    try {
      const binding = await actor.prepareRecovery();
      const presentation = Object.freeze({ title: 'Resume synthetic fixture task?',
        text: `${actor.snapshot.admission!.goal}\nCheckpoint: ${binding.checkpointRef}\nRevision: ${binding.goalRevision}. Original limits still apply.`,
        resumeLabel: 'Resume', cancelLabel: 'Keep Paused' });
      const descriptor: NativeRecoveryPrompt = Object.freeze({ ...binding, promptId: randomUUID(),
        actorRef: 'native-dev-ui', uiSessionRef, presentation, presentationDigest: digest(presentation) });
      const endpoint = bindEndpoint(['clarification_reply', 'resume_request']);
      const ledger = new UserPromptLedger(endpoint, binding, descriptor.actorRef, uiSessionRef, () => performance.now());
      this.#prompt = { descriptor, endpoint, ledger, presented: false };
      return descriptor;
    } finally { this.#recovering = false; }
  }

  /** Register only after the trusted parent confirms the exact sheet is visible. */
  presented(taskId: string, promptId: string, presentationDigest: string, uiSessionRef: string): void {
    const actor = this.#requireActor(taskId);
    const prompt = this.#prompt;
    if (!prompt || prompt.presented || prompt.descriptor.promptId !== promptId
      || prompt.descriptor.presentationDigest !== presentationDigest || prompt.descriptor.uiSessionRef !== uiSessionRef) {
      throw new ContractError('recovery presentation mismatch');
    }
    prompt.ledger.presentResume(prompt.descriptor, 20_000);
    actor.bindPrompt(prompt.ledger); prompt.presented = true;
  }

  dismiss(taskId: string, promptId: string, uiSessionRef: string): void {
    if (taskId !== this.taskId || this.#prompt?.descriptor.promptId !== promptId
      || this.#prompt.descriptor.uiSessionRef !== uiSessionRef) throw new ContractError('stale recovery dismissal');
    this.#clearPrompt();
  }

  async resume(taskId: string, bytes: Uint8Array): Promise<NativePressResult | 'paused'> {
    const actor = this.#requireActor(taskId);
    const prompt = this.#prompt;
    if (!prompt?.presented || !this.#mode) throw new ContractError('no displayed recovery prompt');
    const intent = prompt.ledger.acceptResume(prompt.endpoint, bytes, prompt.descriptor.recoveryObservationId);
    actor.resume(prompt.ledger, intent);
    this.#prompt = undefined;
    const pending: Pending = { requestId: taskId, abort: new AbortController(), stopped: false, touched: true, actor };
    this.#pending = pending; this.#stopPromise = undefined;
    try { return this.#result(await actor.run(), this.#mode, pending.stopped); }
    finally { if (this.#pending === pending) this.#pending = undefined; }
  }

  #requireActor(taskId: string): PersistentTaskActor {
    if (!this.#actor || this.#actor.taskId !== taskId || this.#pending || this.#recovering
      || this.#stopping || this.#fenceFailed || this.#actor.busy || this.#actor.snapshot.state !== 'paused') {
      throw new ContractError('no settled paused native actor');
    }
    return this.#actor;
  }
  #clearPrompt(): void { this.#prompt?.ledger.close(); this.#prompt = undefined; }
  #result(result: PersistentTaskActor['snapshot'], mode: Mode, stopped: boolean): NativePressResult | 'paused' {
    if (stopped || result.state === 'cancelled') return 'stopped';
    if (this.#journal.unresolvedAttempts(result.taskId).length) return 'uncertain';
    if (result.state === 'paused') return 'paused';
    if (result.state !== 'completed' || !result.completion) return 'error';
    return result.progress?.checkpoints.every(c => !c.executionId) ? 'already_matched'
      : mode === 'navigate' ? 'verified_navigation' : mode === 'locate' ? 'verified_locate' : 'verified_open';
  }

  stop(): Promise<{ workerFenced: boolean; unresolvedExecutionIds: readonly string[] }> {
    this.#clearPrompt();
    if (this.#stopPromise) return this.#stopPromise;
    const pending = this.#pending;
    if (pending) { pending.stopped = true; pending.abort.abort(); }
    const actor = pending ? pending.actor : this.#actor;
    this.#stopping = true;
    this.#stopPromise = (async () => {
      const workerFenced = actor ? (await actor.stop()).workerFenced
        : pending ? await this.#fence(pending.requestId) : !this.#fenceFailed;
      if (!workerFenced) this.#fenceFailed = true;
      return { workerFenced, unresolvedExecutionIds: this.#journal.unresolvedAttempts()
        .map(attempt => attempt.executionId) };
    })().finally(() => { this.#stopping = false; });
    return this.#stopPromise;
  }

  async settleBeforeClose(): Promise<void> { this.#clearPrompt(); await this.#actor?.settleOperation(); }

  async #fence(taskId: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const fenced = await Promise.race([this.#worker.stop(taskId).then(value => value === true, () => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 3_000); })]);
      if (!fenced) this.#fenceFailed = true;
      return fenced;
    } catch { this.#fenceFailed = true; return false; }
    finally { if (timer) clearTimeout(timer); }
  }
}
