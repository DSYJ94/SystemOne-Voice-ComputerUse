import { randomUUID } from 'node:crypto';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { AttemptJournal } from './attempt-journal.ts';
import { CommittedInputSession } from './committed-input.ts';
import { bindCommandValue } from './command-value-span.ts';
import { NativeFixtureTask } from './native-fixture-task.ts';
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
type Mode = keyof typeof TITLES;
interface Pending {
  readonly requestId: string;
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

  start(request: NativePressRequest): Promise<NativePressResult | 'paused'> { return this.#start(request, 'navigate'); }
  startLocate(request: NativeLocateRequest): Promise<NativePressResult | 'paused'> { return this.#start(request, 'locate'); }
  startOpen(request: NativeOpenRequest): Promise<NativePressResult | 'paused'> { return this.#start(request, 'open'); }

  async #start(request: NativePressRequest | NativeLocateRequest, mode: Mode): Promise<NativePressResult | 'paused'> {
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(request.requestId)
      || request.bundleId !== BUNDLE || request.folderName !== 'Documents'
      || (mode !== 'navigate' && (!('fileName' in request) || request.fileName !== 'Budget.xlsx'))
      || request.expectedWindowTitle !== TITLES[mode]
      || this.#seen.has(request.requestId) || this.#seen.size >= 1000 || this.#pending) return 'error';
    this.#seen.add(request.requestId);
    if (this.needsRecovery || this.#journal.pendingTaskIds().length) return 'uncertain';
    const pending: Pending = { requestId: request.requestId, abort: new AbortController(), stopped: false, touched: false };
    this.#pending = pending; this.#stopPromise = undefined; this.#actor = undefined;
    try {
      const prefix = mode === 'navigate' ? 'Navigate synthetic fixture to '
        : `${mode === 'open' ? 'Open' : 'Locate'} synthetic fixture file `;
      const value = mode === 'navigate' ? 'Documents' : 'Documents/Budget.xlsx';
      const command = request.command;
      const surface = command.originSurface;
      if (command.source !== 'text' || command.text !== prefix + value
        || command.mode !== 'command' || command.taskId !== request.requestId
        || command.taskEpoch !== 1 || command.goalRevision !== 1
        || !surface || Array.isArray(surface) || typeof surface !== 'object'
        || surface.appBundleId !== 'com.aurium.systemone.dev') return 'error';
      const revision = { taskId: request.requestId, taskEpoch: 1, goalRevision: 1 };
      const endpoint = bindEndpoint(['command']);
      const input = new CommittedInputSession(endpoint, revision);
      const route = input.accept(endpoint, Buffer.from(JSON.stringify(command)));
      if (route.kind !== 'interpret_command') return 'error';
      const parameter = bindCommandValue(route.input,
        mode === 'navigate' ? 'folder-name' : 'synthetic-file-path', prefix, value);
      pending.touched = true;
      const observed = await this.#worker.observePress({ taskId: request.requestId,
        bundleId: BUNDLE, signal: pending.abort.signal });
      if (pending.stopped) return 'stopped';
      if (!validNativePressObservation(observed) || !observed.complete || observed.windowTitles.length !== 1) return 'unsupported';
      const registry = new TaskAdmissionRegistry(revision, input);
      const admission = registry.admit(route.input, { admissionId: randomUUID(), goal: route.input.text,
        outcomeKind: mode === 'navigate' ? 'NAVIGATE' : mode === 'locate' ? 'LOCATE' : 'OPEN',
        scopeRef: observed.scopeRef, completionVerifierRef: mode === 'navigate' ? 'native-fixture-window-title-v1'
          : mode === 'locate' ? 'native-fixture-selected-title-v1' : 'native-fixture-opened-title-v1',
        policyRevision: 'native-ax-press-fixture-v1', approvedEffects: ['READ', 'NAVIGATE'], parameters: [parameter] });
      const workflow = NativeFixtureTask.start(this.#journal, this.#worker, registry, admission,
        this.#limits, undefined, observed);
      const actor = new PersistentTaskActor(this.#journal, workflow, 3_000);
      pending.actor = actor; this.#actor = actor;
      const result = await actor.run();
      if (pending.stopped || result.state === 'cancelled') return 'stopped';
      if (this.#journal.unresolvedAttempts(request.requestId).length) return 'uncertain';
      if (result.state === 'paused') return 'paused';
      if (result.state !== 'completed' || !result.completion) return 'error';
      return result.progress?.checkpoints.every(c => !c.executionId) ? 'already_matched'
        : mode === 'navigate' ? 'verified_navigation' : mode === 'locate' ? 'verified_locate' : 'verified_open';
    } catch {
      return pending.stopped ? 'stopped' : this.#journal.unresolvedAttempts(request.requestId).length ? 'uncertain' : 'error';
    } finally {
      // Paused actors remain retained for explicit Stop/recovery. Their aborted
      // workflow cannot execute; unfinished operations retain actor ownership.
      if (pending.touched && !pending.actor && !pending.stopped) await this.#fence(request.requestId);
      if (this.#pending === pending) this.#pending = undefined;
    }
  }

  stop(): Promise<{ workerFenced: boolean; unresolvedExecutionIds: readonly string[] }> {
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

  async settleBeforeClose(): Promise<void> { await this.#actor?.settleOperation(); }

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
