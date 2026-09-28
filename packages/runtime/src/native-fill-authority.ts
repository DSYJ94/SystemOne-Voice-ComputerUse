import { randomUUID } from 'node:crypto';
import { ContractError, digest } from '../../protocol/src/json.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { AttemptJournal } from './attempt-journal.ts';
import { CommittedInputSession } from './committed-input.ts';
import { TaskAdmissionRegistry } from './task-authority.ts';
import type { JSONValue } from '../../protocol/src/json.ts';
import type { PreparedAttempt } from './attempt-journal.ts';

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
  observe(bundleId: string, signal: AbortSignal): Promise<NativeFieldObservation>;
  /** Effect-free revalidation. The worker retains the value and one handle. */
  prepare(input: { readonly taskId: string; readonly observationId: string;
    readonly candidateId: string; readonly value: string;
    readonly signal: AbortSignal }): Promise<
      { readonly kind: 'ready'; readonly preparationRef: string }
      | { readonly kind: 'matched_at_preflight' }
      | { readonly kind: 'unsupported' }>;
  /** A one-use worker-side permit check and AX setter, after host journaling. */
  commit(input: { readonly taskId: string; readonly executionId: string;
    readonly permitRef: string; readonly preparationRef: string }): Promise<
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
  readonly fieldLabel: string;
  readonly value: string;
  readonly command: Record<string, JSONValue>;
}

export type NativeFillResult = 'verified' | 'already_matched' | 'unsupported'
  | 'uncertain' | 'stopped' | 'error';

interface Active {
  readonly requestId: string;
  readonly abort: AbortController;
  stopped: boolean;
  journalStarted: boolean;
  workerTouched: boolean;
  done: Promise<NativeFillResult>;
}

function validRequest(request: NativeFillRequest): boolean {
  return ID.test(request.requestId) && BUNDLE_ID.test(request.bundleId)
    && typeof request.fieldLabel === 'string'
    && request.fieldLabel.length > 0 && request.fieldLabel.length <= 160
    && request.fieldLabel.isWellFormed()
    && typeof request.value === 'string' && request.value.isWellFormed()
    && Buffer.byteLength(request.value, 'utf8') <= MAX_VALUE_BYTES;
}

function validObservation(value: NativeFieldObservation, bundleId: string): boolean {
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

/** One host-owned native task at a time. The worker interface is trusted only
 * inside the development process; release IPC must authenticate its OS peer
 * and verify permits on the worker side. */
export class NativeFillAuthority {
  readonly #journal: AttemptJournal;
  readonly #worker: NativeFieldWorker;
  readonly #seen = new Set<string>();
  #active: Active | undefined;
  #workerFenceFailed = false;
  #requiresRecovery = false;

  constructor(journal: AttemptJournal, worker: NativeFieldWorker) {
    this.#journal = journal;
    this.#worker = worker;
  }

  start(request: NativeFillRequest): Promise<NativeFillResult> {
    if (!validRequest(request) || this.#seen.has(request.requestId)
      || this.#seen.size >= 1_000) return Promise.resolve('error');
    this.#seen.add(request.requestId);
    if (this.#active) return Promise.resolve('error');
    if (this.#workerFenceFailed || this.#requiresRecovery
      || this.#journal.unresolvedAttempts().length) {
      return Promise.resolve('uncertain');
    }
    const active: Active = { requestId: request.requestId,
      abort: new AbortController(), stopped: false, journalStarted: false,
      workerTouched: false,
      done: Promise.resolve('error') };
    this.#active = active;
    active.done = this.#run(request, active).finally(() => {
      if (this.#active === active) this.#active = undefined;
    });
    return active.done;
  }

  async stop(): Promise<{ readonly workerFenced: boolean;
    readonly unresolvedExecutionIds: readonly string[] }> {
    const active = this.#active;
    if (!active) return { workerFenced: !this.#workerFenceFailed,
      unresolvedExecutionIds: this.#journal.unresolvedAttempts()
        .map(item => item.executionId) };
    active.stopped = true;
    active.abort.abort();
    if (active.journalStarted
      && this.#journal.getTaskState(active.requestId) === 'active') {
      this.#journal.cancelTask(active.requestId);
    }
    if (active.journalStarted && this.#journal.attemptsForTask(active.requestId)
      .some(attempt => attempt.phase === 'at_dispatch_boundary'
        || (attempt.outcome?.deliveryStatus !== undefined
          && attempt.outcome.deliveryStatus !== 'not_dispatched'))) {
      // A late verified receipt can settle the attempt without authorizing a
      // retry of a stopped goal. Fresh recovery observation is still required.
      this.#requiresRecovery = true;
    }
    const workerFenced = await this.#boundedStop(active.requestId);
    if (!workerFenced) this.#workerFenceFailed = true;
    return { workerFenced, unresolvedExecutionIds: this.#journal
      .unresolvedAttempts(active.requestId).map(item => item.executionId) };
  }

  async #boundedStop(taskId: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.#worker.stop(taskId).then(value => value === true, () => false),
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(false), 3_000);
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async #run(request: NativeFillRequest, active: Active): Promise<NativeFillResult> {
    let executionId: string | undefined;
    try {
      const command = request.command;
      if (command.type !== 'command' || command.source !== 'text'
        || command.mode !== 'command' || command.isFinal !== true
        || command.taskId !== request.requestId || command.taskEpoch !== 1
        || command.goalRevision !== 1
        || command.text !== `Fill ${request.fieldLabel} in ${request.bundleId} with supplied text`
        || command.originSurface === undefined
        || command.originSurface === null
        || typeof command.originSurface !== 'object'
        || Array.isArray(command.originSurface)
        || command.originSurface.appBundleId !== 'com.aurium.systemone.dev') {
        return 'error';
      }
      const revision = { taskId: request.requestId, taskEpoch: 1, goalRevision: 1 };
      const endpoint = bindEndpoint(['command']);
      const input = new CommittedInputSession(endpoint, revision);
      const route = input.accept(endpoint, Buffer.from(JSON.stringify(command)));
      if (route.kind !== 'interpret_command') return 'error';
      active.workerTouched = true;
      const observation = await this.#worker.observe(request.bundleId,
        active.abort.signal);
      if (active.stopped) return 'stopped';
      if (!validObservation(observation, request.bundleId)) return 'error';
      const matching = observation.controls.filter(control =>
        control.label === request.fieldLabel && control.enabled
        && !control.secure && control.canSetValue);
      if (!observation.complete || matching.length !== 1) return 'unsupported';
      const candidate = matching[0]!;
      const registry = new TaskAdmissionRegistry(revision, input);
      const admission = registry.admit(route.input, {
        admissionId: randomUUID(), goal: route.input.text,
        outcomeKind: 'FILL', scopeRef: observation.scopeRef,
        completionVerifierRef: 'native-ax-value-v1',
        policyRevision: 'native-ax-policy-v1',
        approvedEffects: ['READ', 'LOCAL_EDIT'],
        parameters: [{ parameterRef: 'fill-value',
          sourceRef: request.requestId, valueDigest: digest(request.value) }],
      });
      registry.claimForTask(admission);
      this.#journal.startTask(request.requestId, 1, 1);
      active.journalStarted = true;
      if (active.stopped) return 'stopped';
      const action = { taskId: request.requestId,
        scopeRef: observation.scopeRef, observationId: observation.observationId,
        candidateId: candidate.id, label: candidate.label,
        valueDigest: digest(request.value), policyRevision: admission.policyRevision };
      const permit: PreparedAttempt = Object.freeze({
        executionId: randomUUID(), permitRef: randomUUID(),
        taskId: request.requestId, taskEpoch: 1, goalRevision: 1,
        scopeRef: observation.scopeRef,
        observationId: observation.observationId,
        candidateId: candidate.id,
        candidateSetDigest: digest(observation.controls.map(control => ({
          id: control.id, role: control.role, label: control.label,
          enabled: control.enabled, secure: control.secure,
          canSetValue: control.canSetValue,
        }))),
        actionDigest: digest(action),
        policyRevision: admission.policyRevision, leaseGeneration: 1,
      });
      const prepared = await this.#worker.prepare({
        taskId: request.requestId,
        observationId: observation.observationId,
        candidateId: candidate.id, value: request.value,
        signal: active.abort.signal,
      });
      if (active.stopped) return 'stopped';
      if (prepared.kind === 'unsupported') return 'unsupported';
      if (prepared.kind === 'matched_at_preflight') {
        const matched = await this.#worker.verify({ taskId: request.requestId,
          observationId: observation.observationId,
          candidateId: candidate.id, value: request.value });
        if (active.stopped) return 'stopped';
        if (!matched) return 'unsupported';
        this.#journal.completeTask(request.requestId,
          `native-current-${request.requestId}`);
        return 'already_matched';
      }
      if (prepared.kind !== 'ready' || !ID.test(prepared.preparationRef)) {
        return 'error';
      }
      this.#journal.prepare(permit);
      executionId = permit.executionId;
      if (active.stopped) return 'stopped';
      // The durable marker precedes the private worker message. No await or
      // second action can interleave before the worker commit call is issued.
      this.#journal.markDispatchBoundary(permit.executionId);
      const result = await this.#worker.commit({ taskId: request.requestId,
        executionId: permit.executionId, permitRef: permit.permitRef,
        preparationRef: prepared.preparationRef });
      const outcome = result === 'verified'
        ? { deliveryStatus: 'dispatched' as const, effectStatus: 'applied' as const,
          verification: 'matched' as const,
          evidenceRef: `native-ax-${permit.executionId}` }
        : result === 'not_dispatched'
          ? { deliveryStatus: 'not_dispatched' as const,
            effectStatus: 'not_applied' as const, verification: 'unavailable' as const }
          : { deliveryStatus: 'unknown' as const,
            effectStatus: 'unknown' as const, verification: 'unavailable' as const };
      this.#journal.recordOutcome(permit.executionId, outcome);
      if (active.stopped) return 'stopped';
      if (result !== 'verified') return result === 'not_dispatched'
        ? 'unsupported' : 'uncertain';
      this.#journal.completeTask(request.requestId, outcome.evidenceRef!);
      return 'verified';
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
      if (active.workerTouched && !active.stopped
        && (!active.journalStarted
          || this.#journal.getTaskState(active.requestId) !== 'completed')) {
        if (!await this.#boundedStop(active.requestId)) {
          this.#workerFenceFailed = true;
        }
      }
    }
  }
}
