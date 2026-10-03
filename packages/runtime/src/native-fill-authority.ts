import { randomUUID } from 'node:crypto';
import { ContractError, digest } from '../../protocol/src/json.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { AttemptJournal } from './attempt-journal.ts';
import { CommittedInputSession } from './committed-input.ts';
import { bindCommandValue } from './command-value-span.ts';
import { parseScopedNativeFill } from './scoped-native-command.ts';
import { TaskAdmissionRegistry } from './task-authority.ts';
import { buildActionCandidates, fromNativeObservation,
  selectBoundCandidate } from './action-candidates.ts';
import type { JSONValue } from '../../protocol/src/json.ts';
import type { PreparedAttempt } from './attempt-journal.ts';
import { PersistentTaskActor } from './persistent-task-actor.ts';
import { NativeFieldTask } from './native-field-task.ts';
import { NativeActorRecovery } from './native-actor-recovery.ts';
import type { NativeRecoveryPrompt } from './native-fixture-authority.ts';
import type { TaskProgressLimits } from './task-progress.ts';

const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const BUNDLE_ID = /^[A-Za-z0-9.-]{3,160}$/;
const MAX_VALUE_BYTES = 1_024;

export interface NativeFieldCandidate {
  readonly id: string;
  readonly role: 'AXTextField' | 'AXTextArea';
  readonly label: string;
  readonly enabled: boolean;
  readonly secure: boolean;
  readonly canSetValue: boolean;
}

export interface NativeFieldObservation {
  readonly observationId: string;
  readonly scopeRef: string;
  readonly bundleId: string;
  readonly complete: boolean;
  readonly controls: readonly NativeFieldCandidate[];
}

export interface NativeFieldWorker {
  /** Effect-free, bounded AX observation. Values must not cross this boundary. */
  observe(input: { readonly taskId: string; readonly bundleId: string;
    readonly targetPid?: number; readonly targetLaunchMillis?: number;
    readonly signal: AbortSignal }): Promise<NativeFieldObservation>;
  /** Effect-free revalidation. The worker retains the value and one handle. */
  prepare(input: { readonly taskId: string; readonly observationId: string;
    readonly candidateId: string; readonly value: string;
    readonly executionId: string; readonly permitRef: string;
    readonly actionDigest: string; readonly candidateSetDigest: string;
    readonly policyRevision: string;
    readonly signal: AbortSignal }): Promise<
      { readonly kind: 'ready'; readonly preparationRef: string }
      | { readonly kind: 'matched_at_preflight' }
      | { readonly kind: 'unsupported' }>;
  /** A one-use worker-side permit check and AX setter, after host journaling. */
  commit(input: { readonly taskId: string; readonly executionId: string;
    readonly permitRef: string; readonly preparationRef: string;
    readonly permit: PreparedAttempt }): Promise<
      'verified' | 'not_dispatched' | 'unknown'>;
  /** Independent current-value read for a no-effect preflight match. */
  verify(input: { readonly taskId: string; readonly observationId: string;
    readonly candidateId: string; readonly value: string }): Promise<boolean>;
  /** Must fence queued setters and wait for an entered setter before ack. */
  stop(taskId: string): Promise<boolean>;
}

export interface NativeFillRequest {
  readonly requestId: string;
  readonly bundleId: string;
  readonly targetPid?: number;
  readonly targetLaunchMillis?: number;
  readonly fieldLabel: string;
  readonly value: string;
  readonly command: Record<string, JSONValue>;
}

export type NativeFillResult = 'verified' | 'already_matched' | 'unsupported'
  | 'uncertain' | 'stopped' | 'error';

export function validNativeFillRequest(request: NativeFillRequest): boolean {
  return ID.test(request.requestId) && BUNDLE_ID.test(request.bundleId)
    && (request.targetPid === undefined && request.targetLaunchMillis === undefined
      || Number.isSafeInteger(request.targetPid) && request.targetPid! > 0
        && Number.isSafeInteger(request.targetLaunchMillis)
        && request.targetLaunchMillis! > 0)
    && typeof request.fieldLabel === 'string'
    && request.fieldLabel.length > 0 && request.fieldLabel.length <= 160
    && request.fieldLabel.isWellFormed()
    && typeof request.value === 'string' && request.value.isWellFormed()
    && Buffer.byteLength(request.value, 'utf8') <= MAX_VALUE_BYTES;
}

export function validNativeFieldObservation(value: NativeFieldObservation, bundleId: string): boolean {
  if (!ID.test(value.observationId) || !ID.test(value.scopeRef)
    || value.bundleId !== bundleId || typeof value.complete !== 'boolean'
    || !Array.isArray(value.controls) || value.controls.length > 80) return false;
  const seen = new Set<string>();
  for (const control of value.controls) {
    if (!ID.test(control.id) || seen.has(control.id)
      || !['AXTextField', 'AXTextArea'].includes(control.role)
      || typeof control.label !== 'string' || control.label.length > 160
      || !control.label.isWellFormed()
      || typeof control.enabled !== 'boolean'
      || typeof control.secure !== 'boolean'
      || typeof control.canSetValue !== 'boolean') return false;
    seen.add(control.id);
  }
  return true;
}


interface Pending {
  readonly requestId: string;
  readonly abort: AbortController;
  stopped: boolean;
  touched: boolean;
  actor?: PersistentTaskActor;
}

/** Exact native field command intake; the persistent actor owns execution,
 * interruption and recovery after its fresh scoped admission. */
export class NativeFillAuthority {
  readonly #journal: AttemptJournal;
  readonly #worker: NativeFieldWorker;
  readonly #limits: TaskProgressLimits | undefined;
  readonly #seen = new Set<string>();
  #pending: Pending | undefined;
  #actor: PersistentTaskActor | undefined;
  #recovery: NativeActorRecovery | undefined;
  #recovering = false;
  #fenceFailed = false;
  #requiresRecovery = false;
  #stopping = false;
  #stopPromise: Promise<{ workerFenced: boolean; unresolvedExecutionIds: readonly string[] }> | undefined;
  constructor(journal: AttemptJournal, worker: NativeFieldWorker, limits?: TaskProgressLimits) {
    this.#journal = journal; this.#worker = worker; this.#limits = limits ? Object.freeze({ ...limits }) : undefined;
  }
  get taskId(): string | undefined { return this.#pending?.requestId ?? this.#actor?.taskId; }
  get needsRecovery(): boolean { return this.#fenceFailed || this.#requiresRecovery || this.#stopping
    || this.#actor?.needsRecovery === true || this.#journal.unresolvedAttempts().length > 0; }
  async start(request: NativeFillRequest): Promise<NativeFillResult | 'paused'> {
    if (!validNativeFillRequest(request) || this.#seen.has(request.requestId) || this.#seen.size >= 1000
      || this.#pending || this.#recovering) return 'error';
    this.#seen.add(request.requestId);
    if (this.needsRecovery || this.#journal.pendingTaskIds().length) return 'uncertain';
    const pending: Pending = { requestId: request.requestId, abort: new AbortController(), stopped: false, touched: false };
    this.#pending = pending; this.#stopPromise = undefined; this.#actor = undefined;
    this.#recovery?.close(); this.#recovery = undefined;
    try {
      const command = request.command;
      const canonicalPrefix = `Fill ${request.fieldLabel} in ${request.bundleId} with text: `;
      const scoped = typeof command.text === 'string' && !command.text.startsWith(canonicalPrefix)
        ? parseScopedNativeFill(command.text) : undefined;
      const valuePrefix = scoped?.prefix ?? canonicalPrefix;
      if ((scoped && (request.targetPid === undefined || request.targetLaunchMillis === undefined))
        || !['text', 'voice'].includes(String(command.source)) || command.mode !== 'command'
        || command.taskId !== request.requestId || command.taskEpoch !== 1 || command.goalRevision !== 1
        || (scoped ? scoped.fieldLabel !== request.fieldLabel || scoped.value !== request.value
          : command.text !== canonicalPrefix + request.value)
        || !command.originSurface || typeof command.originSurface !== 'object' || Array.isArray(command.originSurface)
        || command.originSurface.appBundleId !== 'com.aurium.systemone.dev') return 'error';
      const revision = { taskId: request.requestId, taskEpoch: 1, goalRevision: 1 };
      const endpoint = bindEndpoint(['command']); const session = new CommittedInputSession(endpoint, revision);
      const route = session.accept(endpoint, Buffer.from(JSON.stringify(command)));
      if (route.kind !== 'interpret_command') return 'error';
      const valueParameter = bindCommandValue(route.input, 'fill-value', valuePrefix, request.value);
      const captured = Object.freeze({ ...request, command: route.input });
      pending.touched = true;
      const observed = await this.#worker.observe({ taskId: request.requestId, bundleId: request.bundleId,
        ...(request.targetPid === undefined ? {} : { targetPid: request.targetPid, targetLaunchMillis: request.targetLaunchMillis! }),
        signal: pending.abort.signal });
      if (pending.stopped) return 'stopped';
      if (!validNativeFieldObservation(observed, request.bundleId)) return 'error';
      const matching = observed.controls.filter(c => c.label === request.fieldLabel && c.enabled && !c.secure && c.canSetValue);
      const offered = buildActionCandidates({ source: fromNativeObservation(observed),
        text: { textRef: 'fill-value', source: 'final_command', allowedTargetRefs: matching.map(c => c.id) },
        policyRevision: 'native-ax-policy-v1' });
      if (!selectBoundCandidate(offered, 'set_value', matching.map(c => c.id)) || matching.length !== 1) return 'unsupported';
      const registry = new TaskAdmissionRegistry(revision, session);
      const admission = registry.admit(route.input, { admissionId: randomUUID(), goal: route.input.text,
        outcomeKind: 'FILL', scopeRef: observed.scopeRef, completionVerifierRef: 'native-ax-value-v1',
        policyRevision: 'native-ax-policy-v1', approvedEffects: ['READ', 'LOCAL_EDIT'], parameters: [valueParameter,
          { parameterRef: 'fill-field', sourceRef: `utterance.${route.input.utteranceId}.r${route.input.utteranceRevision}`,
            valueDigest: digest(request.fieldLabel), sourceStart: 5, sourceEnd: 5 + Buffer.byteLength(request.fieldLabel), offsetUnit: 'utf8_bytes' }] });
      const workflow = NativeFieldTask.start(this.#journal, this.#worker, registry, admission, captured, observed, this.#limits);
      const actor = new PersistentTaskActor(this.#journal, workflow, 3000);
      pending.actor = actor; this.#actor = actor; this.#recovery = new NativeActorRecovery(actor);
      return this.#result(await actor.run(), pending.stopped);
    } catch { return pending.stopped ? 'stopped' : this.#journal.unresolvedAttempts().length ? 'uncertain' : 'error'; }
    finally {
      if (pending.touched && !pending.actor && !pending.stopped) await this.#fence(pending.requestId);
      if (this.#pending === pending) this.#pending = undefined;
    }
  }
  #result(record: PersistentTaskActor['snapshot'], stopped: boolean): NativeFillResult | 'paused' {
    if (stopped || record.state === 'cancelled') return 'stopped';
    if (this.#journal.unresolvedAttempts(record.taskId).length) return 'uncertain';
    if (record.state === 'paused') return 'paused';
    if (record.state !== 'completed' || !record.completion) return 'error';
    return record.progress?.checkpoints.some(c => c.executionId) ? 'verified' : 'already_matched';
  }
  #require(taskId: string): NativeActorRecovery {
    if (!this.#actor || this.#actor.taskId !== taskId || !this.#recovery || this.#pending || this.#recovering
      || this.#actor.busy || this.#stopping || this.#fenceFailed || this.#requiresRecovery
      || this.#actor.snapshot.state !== 'paused') throw new ContractError('no settled paused field actor');
    return this.#recovery;
  }
  async prepareRecovery(taskId: string, uiSessionRef: string): Promise<NativeRecoveryPrompt> {
    const recovery = this.#require(taskId); this.#recovering = true;
    try { return await recovery.prepare(uiSessionRef); } finally { this.#recovering = false; }
  }
  presented(taskId: string, promptId: string, presentationDigest: string, uiSessionRef: string): void {
    this.#require(taskId).presented(promptId, presentationDigest, uiSessionRef);
  }
  dismiss(taskId: string, promptId: string, uiSessionRef: string): void { this.#require(taskId).dismiss(promptId, uiSessionRef); }
  async resume(taskId: string, bytes: Uint8Array): Promise<NativeFillResult | 'paused'> {
    this.#require(taskId).activate(bytes);
    const pending: Pending = { requestId: taskId, abort: new AbortController(), stopped: false, touched: true, actor: this.#actor! };
    this.#pending = pending; this.#stopPromise = undefined;
    try { return this.#result(await this.#actor!.run(), pending.stopped); }
    finally { if (this.#pending === pending) this.#pending = undefined; }
  }
  stop(): Promise<{ workerFenced: boolean; unresolvedExecutionIds: readonly string[] }> {
    this.#recovery?.close();
    if (this.#stopPromise) return this.#stopPromise;
    const pending = this.#pending; if (pending) { pending.stopped = true; pending.abort.abort(); }
    const actor = pending ? pending.actor : this.#actor;
    const taskId = pending?.requestId ?? actor?.taskId;
    if (taskId && this.#journal.attemptsForTask(taskId).some(a => a.phase === 'at_dispatch_boundary'
      || a.outcome?.deliveryStatus === 'dispatched' || a.outcome?.deliveryStatus === 'unknown')) this.#requiresRecovery = true;
    this.#stopping = true;
    this.#stopPromise = (async () => {
      const workerFenced = actor ? (await actor.stop()).workerFenced : taskId ? await this.#fence(taskId) : !this.#fenceFailed;
      if (!workerFenced) this.#fenceFailed = true;
      return { workerFenced, unresolvedExecutionIds: this.#journal.unresolvedAttempts().map(a => a.executionId) };
    })().finally(() => { this.#stopping = false; });
    return this.#stopPromise;
  }
  async settleBeforeClose(): Promise<void> { this.#recovery?.close(); await this.#actor?.settleOperation(); }
  async #fence(taskId: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([this.#worker.stop(taskId).then(v => v === true, () => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
      if (!result) this.#fenceFailed = true; return result;
    } catch { this.#fenceFailed = true; return false; }
    finally { if (timer) clearTimeout(timer); }
  }
}
