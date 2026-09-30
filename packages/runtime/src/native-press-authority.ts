import { randomUUID } from 'node:crypto';
import { digest } from '../../protocol/src/json.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { AttemptJournal } from './attempt-journal.ts';
import { buildActionCandidates, selectBoundCandidate } from './action-candidates.ts';
import { bindCommandValue } from './command-value-span.ts';
import { CommittedInputSession } from './committed-input.ts';
import { TaskAdmissionRegistry } from './task-authority.ts';
import type { JSONValue } from '../../protocol/src/json.ts';
import type { PreparedAttempt } from './attempt-journal.ts';

const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const FIXTURE_BUNDLE = 'com.aurium.systemone.fixture';
const FOLDER = 'Documents';
const EXPECTED_TITLE = 'SystemOne Fixture — Documents';
const FILE = 'Budget.xlsx';
const SELECTED_TITLE = 'SystemOne Fixture — Documents — Budget.xlsx selected';
const OPEN_CONTROL = 'Open selected file';
const OPENED_TITLE = 'SystemOne Fixture — Documents — Budget.xlsx opened';
const POLICY = 'native-ax-press-fixture-v1';

export interface NativePressControl {
  readonly id: string;
  readonly role: 'AXButton' | 'AXMenuItem';
  readonly label: string;
  readonly enabled: boolean;
  readonly secure: boolean;
  readonly canPress: boolean;
}

export interface NativePressObservation {
  readonly observationId: string;
  readonly scopeRef: string;
  readonly bundleId: string;
  readonly complete: boolean;
  readonly controls: readonly NativePressControl[];
  readonly windowTitles: readonly string[];
}

export interface NativePressWorker {
  observePress(input: { readonly taskId: string; readonly bundleId: string;
    readonly signal: AbortSignal }): Promise<NativePressObservation>;
  preparePress(input: { readonly taskId: string;
    readonly observationId: string; readonly candidateId: string;
    readonly expectedWindowTitle: string; readonly executionId: string;
    readonly permitRef: string; readonly actionDigest: string;
    readonly candidateSetDigest: string; readonly policyRevision: string;
    readonly signal: AbortSignal }): Promise<
      { readonly kind: 'ready'; readonly preparationRef: string }
      | { readonly kind: 'unsupported' }>;
  commitPress(input: { readonly taskId: string;
    readonly executionId: string; readonly permitRef: string;
    readonly preparationRef: string; readonly permit: PreparedAttempt }): Promise<
      'returned_unverified' | 'not_dispatched' | 'unknown'>;
  verifyPress(input: { readonly taskId: string;
    readonly expectedWindowTitle: string }): Promise<boolean>;
  stop(taskId: string): Promise<boolean>;
}

export interface NativePressRequest {
  readonly requestId: string;
  readonly bundleId: string;
  readonly folderName: string;
  readonly expectedWindowTitle: string;
  readonly command: Record<string, JSONValue>;
}

export interface NativeLocateRequest {
  readonly requestId: string;
  readonly bundleId: string;
  readonly folderName: string;
  readonly fileName: string;
  readonly expectedWindowTitle: string;
  readonly command: Record<string, JSONValue>;
}

export interface NativeOpenRequest extends NativeLocateRequest {}

export type NativePressResult = 'verified_navigation' | 'already_matched'
  | 'verified_locate' | 'verified_open' | 'unsupported' | 'uncertain'
  | 'stopped' | 'error';

type StepResult = 'verified' | 'unsupported' | 'uncertain' | 'stopped';

interface Active {
  readonly requestId: string;
  readonly abort: AbortController;
  stopped: boolean;
  journalStarted: boolean;
  workerTouched: boolean;
  done: Promise<NativePressResult>;
}

function validObservation(value: NativePressObservation): boolean {
  if (!ID.test(value.observationId) || !ID.test(value.scopeRef)
    || value.bundleId !== FIXTURE_BUNDLE || typeof value.complete !== 'boolean'
    || !Array.isArray(value.controls) || value.controls.length > 80
    || !Array.isArray(value.windowTitles) || value.windowTitles.length > 16
    || !value.windowTitles.every(title => typeof title === 'string'
      && title.length > 0 && title.length <= 160 && title.isWellFormed())) {
    return false;
  }
  const seen = new Set<string>();
  for (const control of value.controls) {
    if (!ID.test(control.id) || seen.has(control.id)
      || !['AXButton', 'AXMenuItem'].includes(control.role)
      || typeof control.label !== 'string' || control.label.length > 160
      || !control.label.isWellFormed()
      || typeof control.enabled !== 'boolean'
      || typeof control.secure !== 'boolean'
      || typeof control.canPress !== 'boolean') return false;
    seen.add(control.id);
  }
  return true;
}

/** Only fixed synthetic Documents navigation, file selection and Open are admitted.
 * The model cannot widen the target, operation or expected outcome. */
export class NativePressAuthority {
  readonly #journal: AttemptJournal;
  readonly #worker: NativePressWorker;
  readonly #seen = new Set<string>();
  #active: Active | undefined;
  #workerFenceFailed = false;
  #requiresRecovery = false;

  constructor(journal: AttemptJournal, worker: NativePressWorker) {
    this.#journal = journal;
    this.#worker = worker;
  }

  get needsRecovery(): boolean {
    return this.#workerFenceFailed || this.#requiresRecovery
      || this.#journal.unresolvedAttempts().length > 0;
  }

  start(request: NativePressRequest): Promise<NativePressResult> {
    if (!ID.test(request.requestId) || request.bundleId !== FIXTURE_BUNDLE
      || request.folderName !== FOLDER
      || request.expectedWindowTitle !== EXPECTED_TITLE) {
      return Promise.resolve('error');
    }
    return this.#start(request, 'navigate');
  }

  startLocate(request: NativeLocateRequest): Promise<NativePressResult> {
    if (!ID.test(request.requestId) || request.bundleId !== FIXTURE_BUNDLE
      || request.folderName !== FOLDER || request.fileName !== FILE
      || request.expectedWindowTitle !== SELECTED_TITLE) {
      return Promise.resolve('error');
    }
    return this.#start(request, 'locate');
  }

  startOpen(request: NativeOpenRequest): Promise<NativePressResult> {
    if (!ID.test(request.requestId) || request.bundleId !== FIXTURE_BUNDLE
      || request.folderName !== FOLDER || request.fileName !== FILE
      || request.expectedWindowTitle !== OPENED_TITLE) {
      return Promise.resolve('error');
    }
    return this.#start(request, 'open');
  }

  #start(request: NativePressRequest | NativeLocateRequest | NativeOpenRequest,
    mode: 'navigate' | 'locate' | 'open'): Promise<NativePressResult> {
    if (this.#seen.has(request.requestId) || this.#seen.size >= 1_000) {
      return Promise.resolve('error');
    }
    this.#seen.add(request.requestId);
    if (this.#active) return Promise.resolve('error');
    if (this.needsRecovery) return Promise.resolve('uncertain');
    const active: Active = { requestId: request.requestId,
      abort: new AbortController(), stopped: false, journalStarted: false,
      workerTouched: false, done: Promise.resolve('error') };
    this.#active = active;
    active.done = this.#run(request, active, mode).finally(() => {
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
          && attempt.outcome.deliveryStatus !== 'not_dispatched'
          && attempt.outcome.verification !== 'matched'))) {
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

  async #run(request: NativePressRequest | NativeLocateRequest | NativeOpenRequest,
    active: Active, mode: 'navigate' | 'locate' | 'open'):
    Promise<NativePressResult> {
    if (mode !== 'navigate') {
      return this.#runFileWorkflow(request as NativeLocateRequest, active, mode);
    }
    let executionId: string | undefined;
    try {
      const command = request.command;
      if (command.type !== 'command' || command.source !== 'text'
        || command.mode !== 'command' || command.isFinal !== true
        || command.taskId !== request.requestId || command.taskEpoch !== 1
        || command.goalRevision !== 1
        || command.text !== `Navigate synthetic fixture to ${request.folderName}`
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
      const folder = bindCommandValue(route.input, 'folder-name',
        'Navigate synthetic fixture to ', request.folderName);
      active.workerTouched = true;
      const observation = await this.#worker.observePress({
        taskId: request.requestId, bundleId: request.bundleId,
        signal: active.abort.signal,
      });
      if (active.stopped) return 'stopped';
      if (!validObservation(observation) || !observation.complete) {
        return 'unsupported';
      }
      const matching = observation.controls.filter(control =>
        control.role === 'AXButton' && control.label === request.folderName
        && control.enabled && !control.secure && control.canPress);
      const offered = buildActionCandidates({
        source: { surface: 'native',
          observationId: observation.observationId,
          complete: observation.complete,
          controls: observation.controls.map(control => ({
            targetRef: control.id, role: control.role, label: control.label,
            context: '', visible: true, enabled: control.enabled,
            editable: false, invokable: !control.secure && control.canPress,
            destinationUrl: null,
          })) },
        invocations: matching.map(control => ({ targetRef: control.id,
          expectedRef: 'documents-window', expectedDescription: 'Documents folder identity' })),
        policyRevision: POLICY,
      });
      const selected = selectBoundCandidate(offered, 'invoke',
        matching.map(control => control.id));
      if (observation.windowTitles.length !== 1 || !selected
        || matching.length !== 1) return 'unsupported';
      const registry = new TaskAdmissionRegistry(revision, input);
      const admission = registry.admit(route.input, {
        admissionId: randomUUID(), goal: route.input.text,
        outcomeKind: 'NAVIGATE', scopeRef: observation.scopeRef,
        completionVerifierRef: 'native-fixture-window-title-v1',
        policyRevision: POLICY, approvedEffects: ['READ', 'NAVIGATE'],
        parameters: [folder],
      });
      this.#journal.startAdmittedTask(registry, admission);
      active.journalStarted = true;
      if (active.stopped) return 'stopped';
      if (observation.windowTitles[0] === EXPECTED_TITLE) {
        const matched = await this.#worker.verifyPress({ taskId: request.requestId,
          expectedWindowTitle: EXPECTED_TITLE });
        if (active.stopped) return 'stopped';
        if (!matched) return 'unsupported';
        this.#journal.completeTask(request.requestId,
          `native-current-${request.requestId}`);
        return 'already_matched';
      }
      const candidate = matching[0]!;
      const action = { taskId: request.requestId,
        scopeRef: observation.scopeRef, observationId: observation.observationId,
        candidateId: candidate.id, role: candidate.role, label: candidate.label,
        expectedWindowTitle: EXPECTED_TITLE, policyRevision: POLICY };
      const permit: PreparedAttempt = Object.freeze({
        executionId: randomUUID(), permitRef: randomUUID(),
        taskId: request.requestId, taskEpoch: 1, goalRevision: 1,
        scopeRef: observation.scopeRef,
        observationId: observation.observationId,
        candidateId: candidate.id,
        candidateSetDigest: digest(observation.controls.map(control => ({
          id: control.id, role: control.role, label: control.label,
          enabled: control.enabled, secure: control.secure,
          canPress: control.canPress,
        }))),
        actionDigest: digest(action), policyRevision: POLICY,
        leaseGeneration: 1,
      });
      const prepared = await this.#worker.preparePress({
        taskId: request.requestId,
        observationId: observation.observationId,
        candidateId: candidate.id, expectedWindowTitle: EXPECTED_TITLE,
        executionId: permit.executionId, permitRef: permit.permitRef,
        actionDigest: permit.actionDigest,
        candidateSetDigest: permit.candidateSetDigest,
        policyRevision: permit.policyRevision,
        signal: active.abort.signal,
      });
      if (active.stopped) return 'stopped';
      if (prepared.kind !== 'ready' || !ID.test(prepared.preparationRef)) {
        return 'unsupported';
      }
      this.#journal.prepare(permit);
      executionId = permit.executionId;
      if (active.stopped) return 'stopped';
      this.#journal.markDispatchBoundary(permit.executionId);
      const result = await this.#worker.commitPress({
        taskId: request.requestId, executionId: permit.executionId,
        permitRef: permit.permitRef,
        preparationRef: prepared.preparationRef, permit,
      });
      let matched = false;
      if (result === 'returned_unverified' && !active.stopped) {
        matched = await this.#worker.verifyPress({ taskId: request.requestId,
          expectedWindowTitle: EXPECTED_TITLE });
      }
      const outcome = result === 'not_dispatched'
        ? { deliveryStatus: 'not_dispatched' as const,
          effectStatus: 'not_applied' as const,
          verification: 'unavailable' as const }
        : matched && !active.stopped
          ? { deliveryStatus: 'dispatched' as const,
            effectStatus: 'applied' as const,
            verification: 'matched' as const,
            evidenceRef: `native-window-${permit.executionId}` }
          : { deliveryStatus: result === 'unknown' ? 'unknown' as const
            : 'dispatched' as const,
            effectStatus: 'unknown' as const,
            verification: 'unavailable' as const };
      this.#journal.recordOutcome(permit.executionId, outcome);
      if (active.stopped) return 'stopped';
      if (result === 'not_dispatched') return 'unsupported';
      if (!matched) return 'uncertain';
      this.#journal.completeTask(request.requestId, outcome.evidenceRef!);
      return 'verified_navigation';
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

  async #runFileWorkflow(request: NativeLocateRequest, active: Active,
    mode: 'locate' | 'open'): Promise<NativePressResult> {
    try {
      const command = request.command;
      const commandPrefix = mode === 'open'
        ? 'Open synthetic fixture file ' : 'Locate synthetic fixture file ';
      const expectedCommand = commandPrefix + 'Documents/Budget.xlsx';
      if (command.type !== 'command' || command.source !== 'text'
        || command.mode !== 'command' || command.isFinal !== true
        || command.taskId !== request.requestId || command.taskEpoch !== 1
        || command.goalRevision !== 1 || command.text !== expectedCommand
        || command.originSurface === undefined || command.originSurface === null
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
      const path = bindCommandValue(route.input, 'synthetic-file-path',
        commandPrefix, 'Documents/Budget.xlsx');
      active.workerTouched = true;
      const first = await this.#worker.observePress({
        taskId: request.requestId, bundleId: request.bundleId,
        signal: active.abort.signal,
      });
      if (active.stopped) return 'stopped';
      if (!validObservation(first) || !first.complete
        || first.windowTitles.length !== 1) return 'unsupported';
      const initialTitle = first.windowTitles[0];
      if (![ 'SystemOne Fixture', 'SystemOne Fixture — Downloads',
        EXPECTED_TITLE, SELECTED_TITLE, OPENED_TITLE ].includes(initialTitle!)
        || (mode === 'locate' && initialTitle === OPENED_TITLE)) {
        return 'unsupported';
      }
      const registry = new TaskAdmissionRegistry(revision, input);
      const admission = registry.admit(route.input, {
        admissionId: randomUUID(), goal: route.input.text,
        outcomeKind: mode === 'open' ? 'OPEN' : 'LOCATE',
        scopeRef: first.scopeRef,
        completionVerifierRef: mode === 'open'
          ? 'native-fixture-opened-title-v1'
          : 'native-fixture-selected-title-v1',
        policyRevision: POLICY, approvedEffects: ['READ', 'NAVIGATE'],
        parameters: [path],
      });
      this.#journal.startAdmittedTask(registry, admission);
      active.journalStarted = true;
      if (active.stopped) return 'stopped';
      if (initialTitle === request.expectedWindowTitle) {
        const matched = await this.#worker.verifyPress({
          taskId: request.requestId,
          expectedWindowTitle: request.expectedWindowTitle,
        });
        if (active.stopped) return 'stopped';
        if (!matched) return 'unsupported';
        this.#journal.completeTask(request.requestId,
          'native-current-' + request.requestId);
        return 'already_matched';
      }
      let stageObservation = first;
      let currentTitle = initialTitle;
      if (currentTitle !== EXPECTED_TITLE
        && currentTitle !== SELECTED_TITLE) {
        const folderResult = await this.#locateStep(request.requestId, first,
          FOLDER, EXPECTED_TITLE, active);
        if (folderResult === 'stopped') return 'stopped';
        if (folderResult !== 'verified') return folderResult;
        if (active.stopped) return 'stopped';
        stageObservation = await this.#worker.observePress({
          taskId: request.requestId, bundleId: request.bundleId,
          signal: active.abort.signal,
        });
        if (active.stopped) return 'stopped';
        if (!validObservation(stageObservation) || !stageObservation.complete
          || stageObservation.scopeRef !== first.scopeRef
          || stageObservation.observationId === first.observationId
          || stageObservation.windowTitles.length !== 1
          || stageObservation.windowTitles[0] !== EXPECTED_TITLE) {
          return 'unsupported';
        }
        currentTitle = EXPECTED_TITLE;
      }
      if (currentTitle === EXPECTED_TITLE) {
        const fileResult = await this.#locateStep(request.requestId,
          stageObservation, FILE, SELECTED_TITLE, active);
        if (fileResult === 'stopped') return 'stopped';
        if (fileResult !== 'verified') return fileResult;
        if (active.stopped) return 'stopped';
        if (mode === 'locate') {
          return this.#completeFileWorkflow(request.requestId,
            'verified_locate');
        }
        const priorObservationId = stageObservation.observationId;
        stageObservation = await this.#worker.observePress({
          taskId: request.requestId, bundleId: request.bundleId,
          signal: active.abort.signal,
        });
        if (active.stopped) return 'stopped';
        if (!validObservation(stageObservation) || !stageObservation.complete
          || stageObservation.scopeRef !== first.scopeRef
          || stageObservation.observationId === priorObservationId
          || stageObservation.windowTitles.length !== 1
          || stageObservation.windowTitles[0] !== SELECTED_TITLE) {
          return 'unsupported';
        }
        currentTitle = SELECTED_TITLE;
      }
      if (mode !== 'open' || currentTitle !== SELECTED_TITLE) {
        return 'unsupported';
      }
      const openResult = await this.#locateStep(request.requestId,
        stageObservation, OPEN_CONTROL, OPENED_TITLE, active);
      if (openResult === 'stopped') return 'stopped';
      if (openResult !== 'verified') return openResult;
      if (active.stopped) return 'stopped';
      return this.#completeFileWorkflow(request.requestId, 'verified_open');
    } catch {
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

  #completeFileWorkflow(taskId: string,
    result: 'verified_locate' | 'verified_open'): NativePressResult {
    const finalAttempt = this.#journal.attemptsForTask(taskId).at(-1);
    const evidenceRef = finalAttempt?.outcome?.evidenceRef;
    if (!evidenceRef) return 'uncertain';
    this.#journal.completeTask(taskId, evidenceRef);
    return result;
  }

  async #locateStep(taskId: string, observation: NativePressObservation,
    label: string, expectedTitle: string, active: Active): Promise<StepResult> {
    let executionId: string | undefined;
    try {
      if (active.stopped) return 'stopped';
      if (observation.windowTitles.length !== 1
        || (label === FILE && observation.windowTitles[0] !== EXPECTED_TITLE)
        || (label === OPEN_CONTROL
          && observation.windowTitles[0] !== SELECTED_TITLE)) {
        return 'unsupported';
      }
      const matching = observation.controls.filter(control =>
        control.role === 'AXButton' && control.label === label
        && control.enabled && !control.secure && control.canPress);
      const offered = buildActionCandidates({
        source: { surface: 'native', observationId: observation.observationId,
          complete: observation.complete,
          controls: observation.controls.map(control => ({
            targetRef: control.id, role: control.role, label: control.label,
            context: '', visible: true, enabled: control.enabled,
            editable: false, invokable: !control.secure && control.canPress,
            destinationUrl: null,
          })) },
        invocations: matching.map(control => ({ targetRef: control.id,
          expectedRef: label === OPEN_CONTROL ? 'opened-file'
            : label === FILE ? 'selected-file' : 'documents-window',
          expectedDescription: label === OPEN_CONTROL
            ? 'Documents/Budget.xlsx opened'
            : label === FILE ? 'Documents/Budget.xlsx selected and closed'
              : 'Documents folder identity' })),
        policyRevision: POLICY,
      });
      const selected = selectBoundCandidate(offered, 'invoke',
        matching.map(control => control.id));
      if (!selected || matching.length !== 1) return 'unsupported';
      const candidate = matching[0]!;
      const action = { taskId, scopeRef: observation.scopeRef,
        observationId: observation.observationId,
        candidateId: candidate.id, role: candidate.role, label: candidate.label,
        expectedWindowTitle: expectedTitle, policyRevision: POLICY };
      const permit: PreparedAttempt = Object.freeze({
        executionId: randomUUID(), permitRef: randomUUID(),
        taskId, taskEpoch: 1, goalRevision: 1,
        scopeRef: observation.scopeRef, observationId: observation.observationId,
        candidateId: candidate.id,
        candidateSetDigest: digest(observation.controls.map(control => ({
          id: control.id, role: control.role, label: control.label,
          enabled: control.enabled, secure: control.secure,
          canPress: control.canPress,
        }))),
        actionDigest: digest(action), policyRevision: POLICY,
        leaseGeneration: 1,
      });
      const prepared = await this.#worker.preparePress({
        taskId, observationId: observation.observationId,
        candidateId: candidate.id, expectedWindowTitle: expectedTitle,
        executionId: permit.executionId, permitRef: permit.permitRef,
        actionDigest: permit.actionDigest,
        candidateSetDigest: permit.candidateSetDigest,
        policyRevision: permit.policyRevision, signal: active.abort.signal,
      });
      if (active.stopped) return 'stopped';
      if (prepared.kind !== 'ready' || !ID.test(prepared.preparationRef)) {
        return 'unsupported';
      }
      this.#journal.prepare(permit);
      executionId = permit.executionId;
      if (active.stopped) return 'stopped';
      this.#journal.markDispatchBoundary(permit.executionId);
      const result = await this.#worker.commitPress({
        taskId, executionId: permit.executionId, permitRef: permit.permitRef,
        preparationRef: prepared.preparationRef, permit,
      });
      let matched = false;
      if (result === 'returned_unverified' && !active.stopped) {
        matched = await this.#worker.verifyPress({
          taskId, expectedWindowTitle: expectedTitle,
        });
      }
      const outcome = result === 'not_dispatched'
        ? { deliveryStatus: 'not_dispatched' as const,
          effectStatus: 'not_applied' as const,
          verification: 'unavailable' as const }
        : matched && !active.stopped
          ? { deliveryStatus: 'dispatched' as const,
            effectStatus: 'applied' as const, verification: 'matched' as const,
            evidenceRef: 'native-window-' + permit.executionId }
          : { deliveryStatus: result === 'unknown' ? 'unknown' as const
            : 'dispatched' as const, effectStatus: 'unknown' as const,
            verification: 'unavailable' as const };
      this.#journal.recordOutcome(permit.executionId, outcome);
      if (active.stopped) return 'stopped';
      if (result === 'not_dispatched') return 'unsupported';
      return matched ? 'verified' : 'uncertain';
    } catch {
      if (executionId && this.#journal.getAttempt(executionId)?.phase
        === 'at_dispatch_boundary') {
        this.#journal.recordOutcome(executionId, { deliveryStatus: 'unknown',
          effectStatus: 'unknown', verification: 'unavailable' });
        return 'uncertain';
      }
      return active.stopped ? 'stopped' : 'unsupported';
    }
  }
}
