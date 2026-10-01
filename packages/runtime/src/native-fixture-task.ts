import { randomUUID } from 'node:crypto';
import { ContractError, digest } from '../../protocol/src/json.ts';
import { buildActionCandidates, selectBoundCandidate } from './action-candidates.ts';
import { AttemptJournal } from './attempt-journal.ts';
import type { PreparedAttempt } from './attempt-journal.ts';
import { validNativePressObservation } from './native-press-authority.ts';
import type { NativePressObservation, NativePressWorker } from './native-press-authority.ts';
import type { TaskAdmission, TaskAdmissionRegistry } from './task-authority.ts';
import type { TaskProgressLimits } from './task-progress.ts';
import type { TaskRecoveryBinding } from './task-recovery.ts';
import type { ResumeRequest, UserPromptLedger } from './user-prompts.ts';

const BUNDLE = 'com.aurium.systemone.fixture';
const POLICY = 'native-ax-press-fixture-v1';
const HOME = 'SystemOne Fixture';
const DOCUMENTS = 'SystemOne Fixture — Documents';
const LOCATED = DOCUMENTS + ' — Budget.xlsx selected';
const OPENED = DOCUMENTS + ' — Budget.xlsx opened';
const PREDICATES = {
  [DOCUMENTS]: ['documents', 'native-fixture-window-title-v1'],
  [LOCATED]: ['located', 'native-fixture-selected-title-v1'],
  [OPENED]: ['opened', 'native-fixture-opened-title-v1'],
} as const;

/** Scripted semantic native workflow for the synthetic Documents/Budget.xlsx
 * fixture. It uses the existing signed worker boundary and shared candidates;
 * no generic AX, pointer, keyboard or file operation is enabled. */
export class NativeFixtureTask {
  readonly taskId: string;
  readonly #journal: AttemptJournal;
  readonly #worker: NativePressWorker;
  readonly #terminalTitle: string;
  #abort = new AbortController();
  #advancing = false;
  #recovering = false;
  #generation = 0;

  static start(journal: AttemptJournal, worker: NativePressWorker,
    registry: TaskAdmissionRegistry, admission: TaskAdmission, limits?: TaskProgressLimits): NativeFixtureTask {
    validateAdmission(admission);
    journal.startAdmittedTask(registry, admission);
    try { journal.enableTaskProgress(admission.taskId, admission.scopeRef, admission.completionVerifierRef, limits); }
    catch (error) { journal.pauseTask(admission.taskId, 'native_progress_failed'); throw error; }
    return new NativeFixtureTask(journal, worker, admission.taskId);
  }

  constructor(journal: AttemptJournal, worker: NativePressWorker, taskId: string) {
    const record = journal.getTaskRecord(taskId);
    if (!record?.admission || !record.progress || !['active', 'paused'].includes(record.state)) {
      throw new ContractError('native actor requires admitted tracked history');
    }
    validateAdmission(record.admission);
    this.taskId = taskId; this.#journal = journal; this.#worker = worker;
    this.#terminalTitle = record.admission.outcomeKind === 'NAVIGATE' ? DOCUMENTS
      : record.admission.outcomeKind === 'LOCATE' ? LOCATED : OPENED;
  }

  pause(reasonRef: string): { readonly workerFenced: boolean } {
    this.#generation++; this.#abort.abort();
    if (['active', 'paused'].includes(this.#journal.getTaskState(this.taskId) ?? '')) {
      this.#journal.pauseTask(this.taskId, reasonRef);
    }
    return { workerFenced: !this.#advancing };
  }

  async stop(): Promise<{ readonly workerFenced: boolean }> {
    this.#generation++; this.#abort.abort();
    if (['active', 'paused'].includes(this.#journal.getTaskState(this.taskId) ?? '')) {
      this.#journal.cancelTask(this.taskId);
    }
    return { workerFenced: await this.#worker.stop(this.taskId) === true };
  }

  async prepareRecovery(): Promise<TaskRecoveryBinding> {
    if (this.#advancing || this.#recovering) throw new ContractError('native operation has not settled');
    const record = this.#journal.getTaskRecord(this.taskId)!;
    if (record.state !== 'paused' || !record.admission) throw new ContractError('native task is not paused');
    validateAdmission(record.admission);
    const checkpoint = record.progress!.checkpoints.at(-1);
    const expectedTitle = Object.keys(PREDICATES).find(title =>
      PREDICATES[title as keyof typeof PREDICATES]?.[0] === checkpoint?.stageRef);
    if (!checkpoint || !expectedTitle
      || checkpoint.predicateRef !== PREDICATES[expectedTitle as keyof typeof PREDICATES]?.[1]) {
      throw new ContractError('native checkpoint predicate mismatch');
    }
    this.#recovering = true;
    try {
      const ticket = this.#journal.reserveTaskRecoveryObservation(this.taskId);
      const observed = await this.#worker.observePress({ taskId: this.taskId, bundleId: BUNDLE,
        signal: new AbortController().signal });
      this.#validateObservation(observed, record.admission.scopeRef);
      const matched = await this.#worker.verifyPress({ taskId: this.taskId, expectedWindowTitle: expectedTitle });
      const after = await this.#worker.observePress({ taskId: this.taskId, bundleId: BUNDLE,
        signal: new AbortController().signal });
      this.#validateObservation(after, record.admission.scopeRef);
      if (matched !== true || observed.windowTitles[0] !== expectedTitle
        || digest(semantic(observed)) !== digest(semantic(after))) {
        throw new ContractError('native checkpoint is no longer current');
      }
      return this.#journal.recordTaskRecoveryObservation(this.taskId, ticket, {
        observationId: randomUUID(), scopeRef: observed.scopeRef, stateDigest: digest(semantic(after)),
      }, { checkpointRef: checkpoint.checkpointId, predicateRef: checkpoint.predicateRef,
        evidenceRef: randomUUID() });
    } finally { this.#recovering = false; }
  }

  resume(ledger: UserPromptLedger, intent: ResumeRequest): void {
    if (intent.taskId !== this.taskId || this.#advancing || this.#recovering) {
      throw new ContractError('native recovery is stale or pending');
    }
    this.#journal.resumeTask(ledger, intent);
    this.#abort = new AbortController(); this.#generation++;
  }

  async advance(): Promise<void> {
    if (this.#advancing || this.#recovering) throw new ContractError('native step already pending');
    const generation = this.#generation;
    const admission = this.#active(generation);
    this.#advancing = true;
    let executionId: string | undefined;
    try {
      const ticket = this.#journal.reserveTaskObservation(this.taskId);
      const observed = await this.#worker.observePress({ taskId: this.taskId, bundleId: BUNDLE,
        signal: this.#abort.signal });
      this.#active(generation); this.#validateObservation(observed, admission.scopeRef);
      this.#journal.recordTaskObservation(this.taskId, ticket, { observationId: observed.observationId,
        scopeRef: observed.scopeRef, stateDigest: digest(semantic(observed)) });
      this.#journal.consumeTaskDecision(this.taskId, observed.observationId);
      const title = observed.windowTitles[0]!;
      if (title === this.#terminalTitle) {
        await this.#verify(this.#terminalTitle, generation);
        return;
      }
      const step = title === HOME || title === 'SystemOne Fixture — Downloads' ? ['Documents', DOCUMENTS]
        : title === DOCUMENTS && this.#terminalTitle !== DOCUMENTS ? ['Budget.xlsx', LOCATED]
          : title === LOCATED && this.#terminalTitle === OPENED ? ['Open selected file', OPENED] : undefined;
      if (!step) throw new ContractError('native state is outside the admitted workflow');
      const [label, expectedTitle] = step as [string, string];
      const matching = observed.controls.filter(c => c.label === label && c.enabled && !c.secure && c.canPress);
      const offered = buildActionCandidates({ policyRevision: POLICY, source: { surface: 'native',
        observationId: observed.observationId, complete: observed.complete,
        controls: observed.controls.map(c => ({ targetRef: c.id, role: c.role, label: c.label,
          context: '', visible: true, enabled: c.enabled, editable: false,
          invokable: !c.secure && c.canPress, destinationUrl: null })) },
        invocations: matching.map(c => ({ targetRef: c.id, expectedRef: 'native-stage',
          expectedDescription: expectedTitle })) });
      if (!selectBoundCandidate(offered, 'invoke', matching.map(c => c.id)) || matching.length !== 1) {
        throw new ContractError('native control is missing or ambiguous');
      }
      const control = matching[0]!;
      const permit: PreparedAttempt = Object.freeze({ taskId: this.taskId, taskEpoch: admission.taskEpoch,
        goalRevision: admission.goalRevision, executionId: randomUUID(), permitRef: randomUUID(),
        scopeRef: admission.scopeRef, observationId: observed.observationId, candidateId: control.id,
        candidateSetDigest: digest(observed.controls.map(c => ({ id: c.id, role: c.role, label: c.label,
          enabled: c.enabled, secure: c.secure, canPress: c.canPress }))),
        actionDigest: digest({ taskId: this.taskId, scopeRef: admission.scopeRef,
          observationId: observed.observationId, candidateId: control.id, role: control.role,
          label: control.label, expectedWindowTitle: expectedTitle, policyRevision: POLICY }),
        policyRevision: POLICY, leaseGeneration: 1 });
      const preparation = await this.#worker.preparePress({ taskId: this.taskId,
        observationId: observed.observationId, candidateId: control.id, expectedWindowTitle: expectedTitle,
        executionId: permit.executionId, permitRef: permit.permitRef, actionDigest: permit.actionDigest,
        candidateSetDigest: permit.candidateSetDigest, policyRevision: POLICY, signal: this.#abort.signal });
      this.#active(generation);
      if (preparation.kind !== 'ready' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(preparation.preparationRef)) {
        throw new ContractError('native preparation unavailable');
      }
      this.#journal.prepare(permit); executionId = permit.executionId;
      this.#journal.markDispatchBoundary(permit.executionId);
      const result = await this.#worker.commitPress({ taskId: this.taskId, executionId: permit.executionId,
        permitRef: permit.permitRef, preparationRef: preparation.preparationRef, permit });
      if (result === 'not_dispatched') {
        this.#journal.recordOutcome(permit.executionId, { deliveryStatus: 'not_dispatched',
          effectStatus: 'not_applied', verification: 'unavailable' });
        throw new ContractError('native action was not dispatched');
      }
      if (result !== 'returned_unverified') throw new ContractError('native action outcome unknown');
      this.#active(generation);
      await this.#verify(expectedTitle, generation, permit.executionId);
    } catch (error) {
      if (executionId && this.#journal.getAttempt(executionId)?.phase === 'at_dispatch_boundary') {
        this.#journal.recordOutcome(executionId, { deliveryStatus: 'unknown', effectStatus: 'unknown',
          verification: 'unavailable' });
      }
      throw error;
    } finally { this.#advancing = false; }
  }

  async #verify(title: string, generation: number, executionId?: string): Promise<void> {
    const ticket = this.#journal.reserveTaskObservation(this.taskId, false);
    const matched = await this.#worker.verifyPress({ taskId: this.taskId, expectedWindowTitle: title });
    this.#active(generation);
    if (matched !== true) throw new ContractError('native title predicate did not match');
    const observationId = randomUUID();
    const evidenceRef = randomUUID();
    this.#journal.recordTaskObservation(this.taskId, ticket, { observationId,
      scopeRef: this.#journal.getTaskProgress(this.taskId)!.scopeRef,
      stateDigest: digest({ kind: 'native-title-predicate', expectedTitle: title, matched }) });
    if (executionId) this.#journal.recordOutcome(executionId, { deliveryStatus: 'dispatched',
      effectStatus: 'applied', verification: 'matched', evidenceRef });
    const [stageRef, predicateRef] = PREDICATES[title as keyof typeof PREDICATES]!;
    this.#journal.recordTaskCheckpoint(this.taskId, { checkpointId: randomUUID(), observationId,
      stageRef, predicateRef, evidenceRef, terminal: title === this.#terminalTitle,
      ...(executionId ? { executionId } : {}) });
    if (title === this.#terminalTitle) this.#journal.completeTask(this.taskId, evidenceRef);
  }

  #active(generation: number): TaskAdmission {
    const record = this.#journal.getTaskRecord(this.taskId)!;
    if (generation !== this.#generation || record.state !== 'active' || !record.admission) {
      throw new ContractError('native task is paused or stopped');
    }
    validateAdmission(record.admission);
    return record.admission;
  }

  #validateObservation(observed: NativePressObservation, scopeRef: string): void {
    if (!validNativePressObservation(observed) || !observed.complete || observed.scopeRef !== scopeRef
      || observed.windowTitles.length !== 1) throw new ContractError('native observation identity/coverage mismatch');
  }
}

function semantic(observed: NativePressObservation) {
  return { bundleId: observed.bundleId, complete: observed.complete, windowTitles: [...observed.windowTitles],
    controls: observed.controls.map(({ id: _id, ...c }) => c).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
}

function validateAdmission(admission: TaskAdmission): void {
  const title = admission.outcomeKind === 'NAVIGATE' ? DOCUMENTS
    : admission.outcomeKind === 'LOCATE' ? LOCATED : admission.outcomeKind === 'OPEN' ? OPENED : undefined;
  const parameterRef = admission.outcomeKind === 'NAVIGATE' ? 'folder-name' : 'synthetic-file-path';
  if (!title || admission.policyRevision !== POLICY || admission.approvedEffects.join(',') !== 'READ,NAVIGATE'
    || admission.completionVerifierRef !== PREDICATES[title as keyof typeof PREDICATES]?.[1]
    || admission.parameters.length !== 1 || admission.parameters[0]?.parameterRef !== parameterRef
    || admission.parameters[0].valueDigest !== digest(admission.outcomeKind === 'NAVIGATE' ? 'Documents' : 'Documents/Budget.xlsx')) {
    throw new ContractError('native task admission differs from the synthetic workflow');
  }
}
