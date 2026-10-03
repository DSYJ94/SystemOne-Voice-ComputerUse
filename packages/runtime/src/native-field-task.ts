import { randomUUID } from 'node:crypto';
import { ContractError, digest } from '../../protocol/src/json.ts';
import { AttemptJournal } from './attempt-journal.ts';
import { buildActionCandidates, fromNativeObservation, selectBoundCandidate } from './action-candidates.ts';
import { validNativeFieldObservation } from './native-fill-authority.ts';
import type { NativeFieldObservation, NativeFieldWorker, NativeFillRequest } from './native-fill-authority.ts';
import type { TaskAdmission, TaskAdmissionRegistry } from './task-authority.ts';
import type { PreparedAttempt } from './attempt-journal.ts';
import type { TaskProgressLimits } from './task-progress.ts';
import type { TaskRecoveryBinding } from './task-recovery.ts';
import type { ResumeRequest, UserPromptLedger } from './user-prompts.ts';

/** One exact admitted field/value; host-private values never enter semantic
 * state digests. A setter receipt cannot replace the final predicate read. */
export class NativeFieldTask {
  readonly taskId: string;
  readonly #journal: AttemptJournal;
  readonly #worker: NativeFieldWorker;
  readonly #request: NativeFillRequest;
  #initial: NativeFieldObservation | undefined;
  #abort = new AbortController();
  #generation = 0;
  #advancing = false;
  #recovering = false;

  static start(journal: AttemptJournal, worker: NativeFieldWorker, registry: TaskAdmissionRegistry,
    admission: TaskAdmission, request: NativeFillRequest, observed: NativeFieldObservation,
    limits?: TaskProgressLimits): NativeFieldTask {
    validate(admission, request);
    journal.startAdmittedTask(registry, admission);
    try { journal.enableTaskProgress(admission.taskId, admission.scopeRef, admission.completionVerifierRef, limits); }
    catch (error) { journal.pauseTask(admission.taskId, 'native_field_progress_failed'); throw error; }
    return new NativeFieldTask(journal, worker, request, observed);
  }
  constructor(journal: AttemptJournal, worker: NativeFieldWorker, request: NativeFillRequest,
    initial?: NativeFieldObservation) {
    const record = journal.getTaskRecord(request.requestId);
    if (!record?.admission || !record.progress || !['active', 'paused'].includes(record.state)) {
      throw new ContractError('field task requires admitted progress');
    }
    validate(record.admission, request);
    this.taskId = request.requestId; this.#journal = journal; this.#worker = worker;
    this.#request = Object.freeze({ ...request });
    if (initial) this.#initial = Object.freeze({ ...initial,
      controls: Object.freeze(initial.controls.map(control => Object.freeze({ ...control }))) });
  }
  pause(reason: string): { workerFenced: boolean } {
    this.#initial = undefined; this.#generation++; this.#abort.abort();
    if (['active', 'paused'].includes(this.#journal.getTaskState(this.taskId) ?? '')) this.#journal.pauseTask(this.taskId, reason);
    return { workerFenced: !this.#advancing };
  }
  async stop(): Promise<{ workerFenced: boolean }> {
    this.#initial = undefined; this.#generation++; this.#abort.abort();
    if (['active', 'paused'].includes(this.#journal.getTaskState(this.taskId) ?? '')) this.#journal.cancelTask(this.taskId);
    return { workerFenced: await this.#worker.stop(this.taskId) === true };
  }
  async advance(): Promise<void> {
    if (this.#advancing || this.#recovering) throw new ContractError('field operation already pending');
    this.#advancing = true; const generation = this.#generation;
    let executionId: string | undefined;
    try {
      const admission = this.#active(generation);
      const ticket = this.#journal.reserveTaskObservation(this.taskId);
      const initial = this.#initial; this.#initial = undefined;
      const observed = initial ?? await this.#observe(this.#abort.signal);
      this.#active(generation); const candidate = this.#candidate(observed, admission);
      this.#journal.recordTaskObservation(this.taskId, ticket, { observationId: observed.observationId,
        scopeRef: observed.scopeRef, stateDigest: digest(semantic(observed)) });
      this.#journal.consumeTaskDecision(this.taskId, observed.observationId);
      this.#journal.recordTaskCheckpoint(this.taskId, { checkpointId: randomUUID(),
        observationId: observed.observationId, stageRef: 'field_ready', predicateRef: 'native-field-eligible-v1',
        evidenceRef: randomUUID(), terminal: false });
      const permit: PreparedAttempt = Object.freeze({ taskId: this.taskId,
        taskEpoch: admission.taskEpoch, goalRevision: admission.goalRevision,
        executionId: randomUUID(), permitRef: randomUUID(), scopeRef: observed.scopeRef,
        observationId: observed.observationId, candidateId: candidate.id,
        candidateSetDigest: digest(observed.controls.map(control => ({ ...control }))),
        actionDigest: digest({ taskId: this.taskId, scopeRef: observed.scopeRef,
          observationId: observed.observationId, candidateId: candidate.id, label: candidate.label,
          valueDigest: digest(this.#request.value), policyRevision: admission.policyRevision }),
        policyRevision: admission.policyRevision, leaseGeneration: 1 });
      const prepared = await this.#worker.prepare({ taskId: this.taskId, observationId: observed.observationId,
        candidateId: candidate.id, value: this.#request.value, executionId: permit.executionId,
        permitRef: permit.permitRef, actionDigest: permit.actionDigest, candidateSetDigest: permit.candidateSetDigest,
        policyRevision: permit.policyRevision, signal: this.#abort.signal });
      this.#active(generation);
      if (prepared.kind === 'matched_at_preflight') { await this.#verify(observed, candidate.id, generation); return; }
      if (prepared.kind !== 'ready' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(prepared.preparationRef)) {
        throw new ContractError('field preparation unavailable');
      }
      this.#journal.prepare(permit); executionId = permit.executionId;
      this.#journal.markDispatchBoundary(executionId);
      const result = await this.#worker.commit({ taskId: this.taskId, executionId,
        permitRef: permit.permitRef, preparationRef: prepared.preparationRef, permit });
      const evidenceRef = randomUUID();
      this.#journal.recordOutcome(executionId, result === 'verified'
        ? { deliveryStatus: 'dispatched', effectStatus: 'applied', verification: 'matched', evidenceRef }
        : result === 'not_dispatched'
          ? { deliveryStatus: 'not_dispatched', effectStatus: 'not_applied', verification: 'unavailable' }
          : { deliveryStatus: 'unknown', effectStatus: 'unknown', verification: 'unavailable' });
      this.#active(generation);
      if (result !== 'verified') throw new ContractError('field effect is not verified');
      await this.#verify(observed, candidate.id, generation, executionId, evidenceRef);
    } catch (error) {
      if (executionId && this.#journal.getAttempt(executionId)?.phase === 'at_dispatch_boundary') {
        this.#journal.recordOutcome(executionId, { deliveryStatus: 'unknown', effectStatus: 'unknown', verification: 'unavailable' });
      }
      throw error;
    } finally { this.#advancing = false; }
  }
  async #verify(observed: NativeFieldObservation, candidateId: string, generation: number,
    executionId?: string, evidenceRef = randomUUID()): Promise<void> {
    const ticket = this.#journal.reserveTaskObservation(this.taskId, false);
    const matched = await this.#worker.verify({ taskId: this.taskId, observationId: observed.observationId,
      candidateId, value: this.#request.value });
    this.#active(generation);
    if (matched !== true) throw new ContractError('field current-value predicate changed');
    const observationId = randomUUID();
    this.#journal.recordTaskObservation(this.taskId, ticket, { observationId, scopeRef: observed.scopeRef,
      stateDigest: digest({ kind: 'native-field-value-predicate', fieldDigest: digest(this.#request.fieldLabel),
        valueDigest: digest(this.#request.value), matched }) });
    this.#journal.recordTaskCheckpoint(this.taskId, { checkpointId: randomUUID(), observationId,
      stageRef: 'field_filled', predicateRef: 'native-ax-value-v1', evidenceRef, terminal: true,
      ...(executionId ? { executionId } : {}) });
    this.#journal.completeTask(this.taskId, evidenceRef);
  }
  async prepareRecovery(): Promise<TaskRecoveryBinding> {
    if (this.#advancing || this.#recovering) throw new ContractError('field operation pending');
    const record = this.#journal.getTaskRecord(this.taskId)!;
    const checkpoint = record.progress?.checkpoints.at(-1);
    if (record.state !== 'paused' || !record.admission || checkpoint?.stageRef !== 'field_ready'
      || checkpoint.predicateRef !== 'native-field-eligible-v1') throw new ContractError('no recoverable field checkpoint');
    this.#recovering = true;
    try {
      const ticket = this.#journal.reserveTaskRecoveryObservation(this.taskId);
      const observed = await this.#observe(new AbortController().signal);
      this.#candidate(observed, record.admission);
      const after = await this.#observe(new AbortController().signal);
      this.#candidate(after, record.admission);
      if (digest(semantic(observed)) !== digest(semantic(after))) throw new ContractError('field checkpoint changed');
      return this.#journal.recordTaskRecoveryObservation(this.taskId, ticket,
        { observationId: randomUUID(), scopeRef: after.scopeRef, stateDigest: digest(semantic(after)) },
        { checkpointRef: checkpoint.checkpointId, predicateRef: checkpoint.predicateRef, evidenceRef: randomUUID() });
    } finally { this.#recovering = false; }
  }
  resume(ledger: UserPromptLedger, intent: ResumeRequest): void {
    if (intent.taskId !== this.taskId || this.#advancing || this.#recovering) throw new ContractError('stale field recovery');
    this.#journal.resumeTask(ledger, intent); this.#generation++; this.#abort = new AbortController();
  }
  #active(generation: number): TaskAdmission {
    const record = this.#journal.getTaskRecord(this.taskId)!;
    if (generation !== this.#generation || record.state !== 'active' || !record.admission) throw new ContractError('field task interrupted');
    validate(record.admission, this.#request); return record.admission;
  }
  #candidate(observed: NativeFieldObservation, admission: TaskAdmission) {
    if (!validNativeFieldObservation(observed, this.#request.bundleId) || !observed.complete
      || observed.scopeRef !== admission.scopeRef) throw new ContractError('field observation identity changed');
    const matching = observed.controls.filter(c => c.label === this.#request.fieldLabel && c.enabled && !c.secure && c.canSetValue);
    const offered = buildActionCandidates({ source: fromNativeObservation(observed),
      text: { textRef: 'fill-value', source: 'final_command', allowedTargetRefs: matching.map(c => c.id) },
      policyRevision: admission.policyRevision });
    if (matching.length !== 1 || !selectBoundCandidate(offered, 'set_value', matching.map(c => c.id))) {
      throw new ContractError('field missing, unsafe or ambiguous');
    }
    return matching[0]!;
  }
  #observe(signal: AbortSignal) {
    return this.#worker.observe({ taskId: this.taskId, bundleId: this.#request.bundleId, signal,
      ...(this.#request.targetPid === undefined ? {} : { targetPid: this.#request.targetPid,
        targetLaunchMillis: this.#request.targetLaunchMillis! }) });
  }
}
function validate(admission: TaskAdmission, request: NativeFillRequest): void {
  if (admission.taskId !== request.requestId || admission.outcomeKind !== 'FILL'
    || admission.policyRevision !== 'native-ax-policy-v1' || admission.completionVerifierRef !== 'native-ax-value-v1'
    || admission.approvedEffects.join(',') !== 'READ,LOCAL_EDIT' || admission.parameters.length !== 2
    || admission.parameters.find(p => p.parameterRef === 'fill-value')?.valueDigest !== digest(request.value)
    || admission.parameters.find(p => p.parameterRef === 'fill-field')?.valueDigest !== digest(request.fieldLabel)) {
    throw new ContractError('field task does not match admission');
  }
}
function semantic(observed: NativeFieldObservation) {
  return { bundleId: observed.bundleId, complete: observed.complete,
    controls: observed.controls.map(({ id: _id, ...control }) => control)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
}
