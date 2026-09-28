import { ContractError, digest } from '../../protocol/src/json.ts';
import { receive } from '../../protocol/src/session.ts';
import type { Message } from '../../protocol/src/contract.ts';
import type { Endpoint, TaskRevision } from '../../protocol/src/session.ts';
import { CommittedInputSession } from './committed-input.ts';
import type { CommittedInput } from './committed-input.ts';

const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export const OUTCOME_KINDS = [
  'LOCATE', 'OPEN', 'NAVIGATE', 'FILL', 'DOWNLOAD', 'UPLOAD', 'USER_CONFIRMATION',
] as const;
export type OutcomeKind = typeof OUTCOME_KINDS[number];

export const EFFECTS = [
  'READ', 'NAVIGATE', 'LOCAL_EDIT', 'EXTERNAL_READ', 'EXTERNAL_WRITE',
  'CLIPBOARD_READ', 'CLIPBOARD_WRITE', 'DOWNLOAD', 'UPLOAD', 'DESTRUCTIVE',
  'CREDENTIAL', 'OS_SECURITY_CHANGE', 'UNKNOWN',
] as const;
export type Effect = typeof EFFECTS[number];
export type ApprovalEffect = Extract<Effect,
  'LOCAL_EDIT' | 'EXTERNAL_READ' | 'EXTERNAL_WRITE' | 'CLIPBOARD_READ' |
  'CLIPBOARD_WRITE' | 'DOWNLOAD' | 'UPLOAD' |
  'DESTRUCTIVE' | 'CREDENTIAL' | 'OS_SECURITY_CHANGE'>;

export interface TaskParameter {
  readonly parameterRef: string;
  readonly sourceRef: string;
  readonly valueDigest: string;
  readonly sourceStart?: number;
  readonly sourceEnd?: number;
  readonly offsetUnit?: 'utf8_bytes';
}

export interface TaskAdmissionDraft {
  readonly admissionId: string;
  readonly goal: string;
  readonly outcomeKind: OutcomeKind;
  readonly scopeRef: string;
  readonly completionVerifierRef: string;
  readonly policyRevision: string;
  readonly approvedEffects: readonly Effect[];
  readonly parameters: readonly TaskParameter[];
}

export interface TaskAdmission extends TaskRevision, TaskAdmissionDraft {
  readonly commandMessageId: string;
}

/** Host-private admission boundary. Only a final command already accepted from
 * the bound native input session may seed a task. This class performs no model,
 * policy, permit, or driver call.
 */
export class TaskAdmissionRegistry {
  readonly #revision: TaskRevision;
  readonly #inputSession: CommittedInputSession;
  readonly #commands = new Set<string>();
  readonly #admissions = new Set<string>();
  readonly #issued = new WeakSet<object>();
  readonly #claimed = new WeakSet<object>();
  #closed = false;

  constructor(revision: TaskRevision, inputSession: CommittedInputSession) {
    assertRevision(revision);
    this.#revision = Object.freeze({ ...revision });
    this.#inputSession = inputSession;
  }

  admit(input: CommittedInput, draft: TaskAdmissionDraft): TaskAdmission {
    if (this.#closed) throw new ContractError('task admission registry closed');
    if (input.type !== 'command' || input.isFinal !== true) throw new ContractError('only final input can admit a task');
    if (input.mode !== 'command') throw new ContractError('dictation cannot admit a task');
    assertRevisionMatch(input, this.#revision, 'task admission revision mismatch');
    if (this.#commands.has(input.messageId) || this.#admissions.has(draft.admissionId)) {
      throw new ContractError('task admission replay');
    }
    if (this.#admissions.size !== 0) throw new ContractError('task revision already admitted');
    assertId(draft.admissionId, 'admission ID');
    assertId(draft.scopeRef, 'scope reference');
    assertId(draft.completionVerifierRef, 'completion verifier');
    assertId(draft.policyRevision, 'policy revision');
    if (!OUTCOME_KINDS.includes(draft.outcomeKind)) throw new ContractError('unsupported outcome kind');
    if (draft.goal.length < 1 || draft.goal.length > 4_000) throw new ContractError('invalid admitted goal');
    const effects = copyUniqueEffects(draft.approvedEffects, false, true);
    if (effects.includes('UNKNOWN')) throw new ContractError('unknown effect cannot be admitted');
    if (draft.parameters.length > 30) throw new ContractError('invalid task parameters');
    const parameters = draft.parameters.map((parameter) => {
      assertId(parameter.parameterRef, 'parameter reference');
      assertId(parameter.sourceRef, 'parameter source');
      if (!DIGEST.test(parameter.valueDigest)) throw new ContractError('invalid parameter digest');
      if (parameter.sourceStart !== undefined || parameter.sourceEnd !== undefined
        || parameter.offsetUnit !== undefined) {
        if (parameter.offsetUnit !== 'utf8_bytes'
          || !Number.isSafeInteger(parameter.sourceStart)
          || !Number.isSafeInteger(parameter.sourceEnd)
          || parameter.sourceStart! < 0
          || parameter.sourceEnd! < parameter.sourceStart!
          || parameter.sourceRef !== `utterance.${input.utteranceId}.r${input.utteranceRevision}`) {
          throw new ContractError('invalid final command value span');
        }
        const bytes = Buffer.from(input.text, 'utf8');
        if (parameter.sourceEnd! > bytes.length) {
          throw new ContractError('command value span exceeds input');
        }
        let selected: string;
        try { selected = new TextDecoder('utf-8', { fatal: true }).decode(
          bytes.subarray(parameter.sourceStart, parameter.sourceEnd)); }
        catch { throw new ContractError('command value span splits UTF-8 character'); }
        if (digest(selected) !== parameter.valueDigest) {
          throw new ContractError('command value span digest mismatch');
        }
      }
      return Object.freeze({ ...parameter });
    });
    if (new Set(parameters.map(x => x.parameterRef)).size !== parameters.length) {
      throw new ContractError('invalid task parameters');
    }
    this.#inputSession.claimForAdmission(input);
    this.#commands.add(input.messageId);
    this.#admissions.add(draft.admissionId);
    const admission = Object.freeze({
      ...this.#revision,
      admissionId: draft.admissionId,
      commandMessageId: input.messageId,
      goal: draft.goal,
      outcomeKind: draft.outcomeKind,
      scopeRef: draft.scopeRef,
      completionVerifierRef: draft.completionVerifierRef,
      policyRevision: draft.policyRevision,
      approvedEffects: Object.freeze(effects),
      parameters: Object.freeze(parameters),
    });
    this.#issued.add(admission);
    return admission;
  }

  /** One-use in-process transfer to a task controller. Object identity, not
   * admissionId text, proves this registry issued the admission. */
  claimForTask(admission: TaskAdmission): void {
    if (this.#closed || !this.#issued.has(admission) || this.#claimed.has(admission)) {
      throw new ContractError('task admission was not issued here or was claimed');
    }
    this.#claimed.add(admission);
  }

  close(): void { this.#closed = true; }
}

export interface ApprovalBinding {
  readonly promptId: string;
  readonly presentationDigest: string;
  readonly scopeRef: string;
  readonly candidateId: string;
  readonly observationId: string;
  readonly candidateSetDigest: string;
  readonly actionDigest: string;
  readonly policyRevision: string;
  readonly approvedEffects: readonly ApprovalEffect[];
}

export interface Approval extends Message, ApprovalBinding {
  readonly type: 'approval';
  readonly approvalRef: string;
  readonly issuer: 'native_ui';
  readonly actorRef: string;
  readonly uiSessionRef: string;
  readonly approvedEffects: ApprovalEffect[];
  readonly uses: 1;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

interface PendingApproval {
  readonly binding: ApprovalBinding;
  readonly deadline: number;
}

interface AcceptedApproval {
  readonly approval: Approval;
  readonly deadline: number;
}

/** One task-revision approval ledger. Endpoint object identity is the producer
 * credential in this layer; JSON issuer metadata never authenticates a sender.
 */
export class ApprovalLedger {
  readonly #endpoint: Endpoint;
  readonly #revision: TaskRevision;
  readonly #actorRef: string;
  readonly #uiSessionRef: string;
  readonly #monotonicClock: () => number;
  readonly #wallClock: () => number;
  readonly #pending = new Map<string, PendingApproval>();
  readonly #accepted = new Map<string, AcceptedApproval>();
  readonly #seenPrompts = new Set<string>();
  readonly #seenMessages = new Set<string>();
  readonly #seenApprovals = new Set<string>();
  #lastTime = -Infinity;
  #closed = false;

  constructor(endpoint: Endpoint, revision: TaskRevision, actorRef: string, uiSessionRef: string,
    monotonicClock: () => number, wallClock: () => number) {
    if (!endpoint.allowedTypes.includes('approval')) throw new ContractError('endpoint cannot produce approval');
    assertRevision(revision);
    assertId(actorRef, 'actor reference');
    assertId(uiSessionRef, 'UI session reference');
    this.#endpoint = endpoint;
    this.#revision = Object.freeze({ ...revision });
    this.#actorRef = actorRef;
    this.#uiSessionRef = uiSessionRef;
    this.#monotonicClock = monotonicClock;
    this.#wallClock = wallClock;
  }

  present(binding: ApprovalBinding, timeoutMs: number): void {
    this.#assertOpen();
    validateBinding(binding);
    if (this.#seenPrompts.has(binding.promptId)) throw new ContractError('approval prompt replay');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      throw new ContractError('invalid approval timeout');
    }
    if (this.#pending.size >= 16 || this.#seenPrompts.size >= 1_000) {
      throw new ContractError('approval ledger budget exceeded');
    }
    const deadline = this.#now() + timeoutMs;
    if (!Number.isFinite(deadline)) throw new ContractError('invalid approval deadline');
    this.#pending.set(binding.promptId, {
      binding: freezeBinding(binding),
      deadline,
    });
    this.#seenPrompts.add(binding.promptId);
  }

  accept(promptId: string, endpoint: Endpoint, bytes: Uint8Array): Approval {
    this.#assertOpen();
    const pending = this.#pending.get(promptId);
    if (!pending || endpoint !== this.#endpoint) throw new ContractError('unregistered approval or wrong endpoint');
    if (this.#now() >= pending.deadline) {
      this.#pending.delete(promptId);
      throw new ContractError('approval prompt expired');
    }
    const message = receive(endpoint, bytes);
    if (!isApproval(message)) throw new ContractError('expected approval');
    if (message.promptId !== promptId) throw new ContractError('approval prompt mismatch');
    assertRevisionMatch(message, this.#revision, 'approval revision mismatch');
    if (message.actorRef !== this.#actorRef || message.uiSessionRef !== this.#uiSessionRef) {
      throw new ContractError('approval actor or UI session mismatch');
    }
    assertBinding(message, pending.binding);
    if (this.#seenMessages.has(message.messageId) || this.#seenApprovals.has(message.approvalRef)) {
      throw new ContractError('approval replay');
    }
    const issuedAt = Date.parse(message.issuedAt);
    const expiresAt = Date.parse(message.expiresAt);
    const wallNow = this.#wallNow();
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
      || issuedAt > wallNow || wallNow >= expiresAt || expiresAt - issuedAt > 60_000) {
      throw new ContractError('approval wire lifetime invalid');
    }
    if (this.#now() >= pending.deadline) {
      this.#pending.delete(promptId);
      throw new ContractError('approval expired during validation');
    }
    this.#pending.delete(promptId);
    this.#seenMessages.add(message.messageId);
    this.#seenApprovals.add(message.approvalRef);
    const approval = freezeApproval(message);
    this.#accepted.set(approval.approvalRef, { approval, deadline: pending.deadline });
    return approval;
  }

  consume(approvalRef: string, binding: ApprovalBinding): Approval {
    this.#assertOpen();
    validateBinding(binding);
    const accepted = this.#accepted.get(approvalRef);
    if (!accepted) throw new ContractError('approval missing or already consumed');
    if (this.#now() >= accepted.deadline || this.#wallNow() >= Date.parse(accepted.approval.expiresAt)) {
      this.#accepted.delete(approvalRef);
      throw new ContractError('approval expired before consumption');
    }
    assertBinding(accepted.approval, binding);
    this.#accepted.delete(approvalRef);
    return accepted.approval;
  }

  expire(): number {
    this.#assertOpen();
    const now = this.#now();
    const wallNow = this.#wallNow();
    let removed = 0;
    for (const [promptId, pending] of this.#pending) {
      if (now >= pending.deadline) { this.#pending.delete(promptId); removed++; }
    }
    for (const [approvalRef, accepted] of this.#accepted) {
      if (now >= accepted.deadline || wallNow >= Date.parse(accepted.approval.expiresAt)) {
        this.#accepted.delete(approvalRef); removed++;
      }
    }
    return removed;
  }

  close(): void {
    this.#closed = true;
    this.#pending.clear();
    this.#accepted.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw new ContractError('approval ledger closed');
  }

  #now(): number {
    const value = this.#monotonicClock();
    if (!Number.isFinite(value) || value < this.#lastTime) {
      this.close();
      throw new ContractError('invalid monotonic approval clock');
    }
    this.#lastTime = value;
    return value;
  }

  #wallNow(): number {
    const value = this.#wallClock();
    if (!Number.isFinite(value)) {
      this.close();
      throw new ContractError('invalid approval wall clock');
    }
    return value;
  }
}

function assertRevision(revision: TaskRevision): void {
  if (!ID.test(revision.taskId)
    || ![revision.taskEpoch, revision.goalRevision].every(x => Number.isSafeInteger(x) && x >= 0)) {
    throw new ContractError('invalid task revision');
  }
}

function assertRevisionMatch(value: Message | CommittedInput, revision: TaskRevision, error: string): void {
  for (const key of ['taskId', 'taskEpoch', 'goalRevision'] as const) {
    if (value[key] !== revision[key]) throw new ContractError(error);
  }
}

function assertId(value: string, label: string): void {
  if (!ID.test(value)) throw new ContractError(`invalid ${label}`);
}

function copyUniqueEffects(values: readonly Effect[], allowOnlyApproval: boolean, allowEmpty = false): Effect[] {
  if ((!allowEmpty && values.length < 1) || values.length > EFFECTS.length || new Set(values).size !== values.length
    || values.some(value => !EFFECTS.includes(value))
    || (allowOnlyApproval && values.some(value => !isApprovalEffect(value)))) {
    throw new ContractError('invalid effect set');
  }
  return [...values];
}

function isApprovalEffect(value: Effect): value is ApprovalEffect {
  return ['LOCAL_EDIT', 'EXTERNAL_READ', 'EXTERNAL_WRITE', 'CLIPBOARD_READ',
    'CLIPBOARD_WRITE', 'DOWNLOAD', 'UPLOAD',
    'DESTRUCTIVE', 'CREDENTIAL', 'OS_SECURITY_CHANGE'].includes(value);
}

function validateBinding(binding: ApprovalBinding): void {
  for (const [label, value] of [
    ['prompt ID', binding.promptId], ['scope reference', binding.scopeRef],
    ['candidate ID', binding.candidateId], ['observation ID', binding.observationId],
    ['policy revision', binding.policyRevision],
  ] as const) assertId(value, label);
  for (const value of [binding.presentationDigest, binding.candidateSetDigest, binding.actionDigest]) {
    if (!DIGEST.test(value)) throw new ContractError('invalid approval digest');
  }
  copyUniqueEffects(binding.approvedEffects, true);
}

function freezeBinding(binding: ApprovalBinding): ApprovalBinding {
  return Object.freeze({ ...binding, approvedEffects: Object.freeze([...binding.approvedEffects]) });
}

function freezeApproval(approval: Approval): Approval {
  return Object.freeze({ ...approval, approvedEffects: Object.freeze([...approval.approvedEffects]) }) as Approval;
}

function assertBinding(actual: ApprovalBinding, expected: ApprovalBinding): void {
  for (const key of ['promptId', 'presentationDigest', 'scopeRef', 'candidateId', 'observationId',
    'candidateSetDigest', 'actionDigest', 'policyRevision'] as const) {
    if (actual[key] !== expected[key]) throw new ContractError(`approval binding mismatch: ${key}`);
  }
  if (actual.approvedEffects.length !== expected.approvedEffects.length
    || new Set(actual.approvedEffects).size !== actual.approvedEffects.length
    || actual.approvedEffects.some(effect => !expected.approvedEffects.includes(effect))) {
    throw new ContractError('approval binding mismatch: approvedEffects');
  }
}

function isApproval(message: Message): message is Approval {
  return message.type === 'approval'
    && message.issuer === 'native_ui' && message.uses === 1
    && typeof message.approvalRef === 'string' && typeof message.actorRef === 'string'
    && typeof message.uiSessionRef === 'string' && typeof message.promptId === 'string'
    && typeof message.presentationDigest === 'string' && typeof message.scopeRef === 'string'
    && typeof message.candidateId === 'string' && typeof message.observationId === 'string'
    && typeof message.candidateSetDigest === 'string' && typeof message.actionDigest === 'string'
    && typeof message.policyRevision === 'string' && Array.isArray(message.approvedEffects)
    && message.approvedEffects.every(value => typeof value === 'string'
      && EFFECTS.includes(value as Effect) && isApprovalEffect(value as Effect))
    && typeof message.issuedAt === 'string' && typeof message.expiresAt === 'string';
}
