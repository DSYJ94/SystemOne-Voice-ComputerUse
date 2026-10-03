import { ContractError } from '../../protocol/src/json.ts';
import { AttemptJournal } from './attempt-journal.ts';
import type { CommittedInput, CommittedInputSession } from './committed-input.ts';
import type { JournalTaskRecord } from './attempt-journal.ts';
import type { TaskRecoveryBinding } from './task-recovery.ts';
import type { ResumeRequest, UserPromptLedger } from './user-prompts.ts';

const OWNERS = new WeakMap<AttemptJournal, PersistentTaskActor>();

/** Trusted workflow implementation, never supplied by UI content or a model.
 * advance owns fresh observations, decisions, permits and independent predicates.
 * pause revokes queued authority; stop must fence its actual adapter too. */
export interface PersistentTaskWorkflow {
  readonly taskId: string;
  advance(): Promise<unknown>;
  pause(reasonRef: string): { readonly workerFenced: boolean };
  prepareRecovery(): Promise<TaskRecoveryBinding>;
  resume(ledger: UserPromptLedger, intent: ResumeRequest): void;
  stop(): Promise<{ readonly workerFenced: boolean }>;
}

export interface ActorStopReport {
  readonly journalFenced: boolean;
  readonly workerFenced: boolean;
  readonly operationSettled: boolean;
  readonly unresolvedExecutionIds: readonly string[];
}

/** One persistent admitted task, including interruption and explicit recovery.
 * Lifecycle/status comes from durable history, never workflow return strings.
 * Timed-out operations retain ownership until they settle: timeout is not a
 * cancellation barrier and cannot authorize another dispatch or recovery read. */
export class PersistentTaskActor {
  readonly #journal: AttemptJournal;
  readonly #workflow: PersistentTaskWorkflow;
  readonly #timeoutMs: number;
  #operation: Promise<unknown> | undefined;
  #running = false;
  #generation = 0;
  #prompt: UserPromptLedger | undefined;
  #fenceFailed = false;
  #stopPromise: Promise<ActorStopReport> | undefined;
  #stopSettled = false;

  constructor(journal: AttemptJournal, workflow: PersistentTaskWorkflow, timeoutMs = 15_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new ContractError('invalid actor operation timeout');
    }
    const record = journal.getTaskRecord(workflow.taskId);
    if (!record?.admission || !record.progress || !['active', 'paused'].includes(record.state)) {
      throw new ContractError('actor requires an admitted progress-tracked task');
    }
    const owner = OWNERS.get(journal);
    if (owner && (owner.busy || owner.#fenceFailed
      || ['active', 'paused'].includes(owner.snapshot.state)
      || (owner.#stopPromise && !owner.#stopSettled))) {
      throw new ContractError('another persistent actor owns this journal');
    }
    this.#journal = journal; this.#workflow = workflow; this.#timeoutMs = timeoutMs;
    OWNERS.set(journal, this);
  }

  get taskId(): string { return this.#workflow.taskId; }
  get busy(): boolean { return this.#running || this.#operation !== undefined; }
  get needsRecovery(): boolean { return this.#fenceFailed || this.busy
    || this.#journal.unresolvedAttempts().length > 0 || this.snapshot.state === 'paused'; }
  get snapshot(): JournalTaskRecord { return this.#journal.getTaskRecord(this.taskId)!; }

  async run(onProgress?: (record: JournalTaskRecord) => void): Promise<JournalTaskRecord> {
    if (this.busy || this.#fenceFailed || this.snapshot.state !== 'active') {
      throw new ContractError('actor is busy, fenced or not active');
    }
    this.#running = true;
    const generation = this.#generation;
    try {
      while (generation === this.#generation && this.snapshot.state === 'active') {
        const before = this.snapshot;
        await this.#bounded(() => this.#workflow.advance());
        const after = this.snapshot;
        if (generation !== this.#generation) break;
        if (after.state === 'active' && (after.progress!.observationsUsed <= before.progress!.observationsUsed
          || after.progress!.decisionsUsed <= before.progress!.decisionsUsed)) {
          this.pause('workflow_made_no_bounded_decision');
          break;
        }
        onProgress?.(after);
      }
    } catch {
      if (this.snapshot.state === 'active') this.pause('workflow_unavailable');
    } finally { this.#running = false; }
    return this.snapshot;
  }

  pause(reasonRef = 'manual_interruption'): ActorStopReport {
    this.#generation++;
    this.#prompt?.close(); this.#prompt = undefined;
    const state = this.snapshot.state;
    if (['active', 'paused'].includes(state)) this.#journal.pauseTask(this.taskId, reasonRef);
    let workerFenced = false;
    try { workerFenced = this.#workflow.pause(reasonRef).workerFenced === true; }
    catch { this.#fenceFailed = true; }
    if (!workerFenced && !this.#operation) this.#fenceFailed = true;
    return this.#report(workerFenced && !this.#operation);
  }

  async prepareRecovery(): Promise<TaskRecoveryBinding> {
    if (this.busy || this.#fenceFailed || this.snapshot.state !== 'paused') {
      throw new ContractError('actor must be paused and settled before recovery');
    }
    this.#prompt?.close(); this.#prompt = undefined;
    const generation = this.#generation;
    const binding = await this.#bounded(() => this.#workflow.prepareRecovery());
    if (generation !== this.#generation || this.snapshot.state !== 'paused'
      || binding.taskId !== this.taskId) throw new ContractError('actor recovery was interrupted');
    return binding;
  }

  bindPrompt(ledger: UserPromptLedger): void {
    if (this.busy || this.snapshot.state !== 'paused') throw new ContractError('actor is not ready for a prompt');
    this.#prompt?.close(); this.#prompt = ledger;
  }

  resume(ledger: UserPromptLedger, intent: ResumeRequest): void {
    if (ledger !== this.#prompt || this.busy || this.#fenceFailed || this.snapshot.state !== 'paused') {
      throw new ContractError('actor resume has no current prompt or settled fence');
    }
    this.#workflow.resume(ledger, intent);
    if (this.#journal.getTaskState(this.taskId) !== 'active') throw new ContractError('workflow did not durably resume');
    this.#prompt.close(); this.#prompt = undefined;
    this.#generation++;
  }

  /** A correction fences the old revision. Replacement admission must still
   * transfer a separately validated, exact command and cannot replay uncertainty. */
  async correct(session: CommittedInputSession, command: CommittedInput): Promise<ActorStopReport> {
    this.#journal.cancelTaskForCorrection(this.taskId, session, command);
    return this.stop();
  }

  stop(): Promise<ActorStopReport> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#generation++;
    this.#prompt?.close(); this.#prompt = undefined;
    if (['active', 'paused'].includes(this.snapshot.state)) this.#journal.cancelTask(this.taskId);
    this.#stopPromise = this.#boundedStop();
    return this.#stopPromise;
  }

  async #boundedStop(): Promise<ActorStopReport> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let workerFenced = false;
    try {
      workerFenced = await Promise.race([
        this.#workflow.stop().then(value => value.workerFenced === true, () => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), this.#timeoutMs); }),
      ]);
    } catch { /* Durable cancellation and uncertainty remain. */ }
    finally { if (timer) clearTimeout(timer); }
    if (!workerFenced) this.#fenceFailed = true;
    this.#stopSettled = true;
    return this.#report(workerFenced);
  }

  #report(workerFenced: boolean): ActorStopReport {
    return Object.freeze({ journalFenced: this.snapshot.state === 'cancelled', workerFenced,
      operationSettled: !this.#operation,
      unresolvedExecutionIds: Object.freeze(this.#journal.unresolvedAttempts(this.taskId)
        .map(attempt => attempt.executionId)) });
  }

  async #bounded<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#operation) throw new ContractError('actor operation already pending');
    const generation = this.#generation;
    const pending = Promise.resolve().then(() => {
      if (generation !== this.#generation) throw new ContractError('actor operation was interrupted before starting');
      return operation();
    });
    this.#operation = pending;
    void pending.then(() => { if (this.#operation === pending) this.#operation = undefined; },
      () => { if (this.#operation === pending) this.#operation = undefined; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          this.pause('adapter_operation_timeout');
          reject(new ContractError('actor operation timed out'));
        }, this.#timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
