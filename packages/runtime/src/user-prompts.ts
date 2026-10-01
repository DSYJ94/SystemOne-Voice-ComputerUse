import { ContractError } from '../../protocol/src/json.ts';
import { receive } from '../../protocol/src/session.ts';
import type { Message } from '../../protocol/src/contract.ts';
import type { Endpoint, TaskRevision } from '../../protocol/src/session.ts';

const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export interface PromptIdentity {
  readonly promptId: string;
  readonly presentationDigest: string;
}

export interface ClarificationPrompt extends PromptIdentity {
  readonly observationId: string;
  readonly optionIds: readonly string[];
}

export interface ResumePrompt extends PromptIdentity {
  readonly state: 'paused';
  readonly checkpointRef: string;
  readonly checkpointDigest: string;
  readonly recoveryObservationId: string;
}

export interface ClarificationReply extends Message {
  readonly type: 'clarification_reply';
  readonly issuer: 'native_ui';
  readonly actorRef: string;
  readonly uiSessionRef: string;
  readonly promptId: string;
  readonly presentationDigest: string;
  readonly observationId: string;
  readonly selectedOptionId: string;
  readonly createdAt: string;
}

export interface ResumeRequest extends Message {
  readonly type: 'resume_request';
  readonly issuer: 'native_ui';
  readonly actorRef: string;
  readonly uiSessionRef: string;
  readonly promptId: string;
  readonly presentationDigest: string;
  readonly checkpointRef: string;
  readonly checkpointDigest: string;
  readonly recoveryObservationId: string;
  readonly createdAt: string;
}

type PendingPrompt =
  | { readonly kind: 'clarification'; readonly binding: ClarificationPrompt; readonly deadline: number }
  | { readonly kind: 'resume'; readonly binding: ResumePrompt; readonly deadline: number };

/** Native UI replies are intent records. A trusted host must register exactly
 * what it displayed, then use the returned option/checkpoint only through task
 * admission or recovery. This ledger never mints a permit or dispatches an action.
 */
export class UserPromptLedger {
  readonly #endpoint: Endpoint;
  readonly #revision: TaskRevision;
  readonly #actorRef: string;
  readonly #uiSessionRef: string;
  readonly #clock: () => number;
  readonly #seenPrompts = new Set<string>();
  readonly #seenMessages = new Set<string>();
  readonly #resumes = new WeakMap<object, { deadline: number; generation: number }>();
  readonly #claimedResumes = new WeakSet<object>();
  #generation = 0;
  #pending: PendingPrompt | undefined;
  #lastTime = -Infinity;
  #closed = false;

  constructor(endpoint: Endpoint, revision: TaskRevision, actorRef: string,
    uiSessionRef: string, clock: () => number) {
    if (!endpoint.allowedTypes.includes('clarification_reply')
      || !endpoint.allowedTypes.includes('resume_request')) {
      throw new ContractError('native UI endpoint missing prompt reply types');
    }
    if (!ID.test(revision.taskId)
      || ![revision.taskEpoch, revision.goalRevision].every(x => Number.isSafeInteger(x) && x >= 0)
      || !ID.test(actorRef) || !ID.test(uiSessionRef)) {
      throw new ContractError('invalid user prompt identity');
    }
    this.#endpoint = endpoint;
    this.#revision = Object.freeze({ ...revision });
    this.#actorRef = actorRef;
    this.#uiSessionRef = uiSessionRef;
    this.#clock = clock;
  }

  presentClarification(binding: ClarificationPrompt, timeoutMs: number): void {
    checkPromptIdentity(binding);
    checkId(binding.observationId, 'observation ID');
    if (binding.optionIds.length < 2 || binding.optionIds.length > 10
      || new Set(binding.optionIds).size !== binding.optionIds.length) {
      throw new ContractError('invalid clarification options');
    }
    for (const optionId of binding.optionIds) checkId(optionId, 'clarification option ID');
    this.#present({ kind: 'clarification', binding: Object.freeze({
      ...binding, optionIds: Object.freeze([...binding.optionIds]),
    }), deadline: 0 }, timeoutMs);
  }

  presentResume(binding: ResumePrompt, timeoutMs: number): void {
    checkPromptIdentity(binding);
    if (binding.state !== 'paused') throw new ContractError('resume requires paused checkpoint');
    checkId(binding.checkpointRef, 'checkpoint reference');
    if (!DIGEST.test(binding.checkpointDigest)) throw new ContractError('invalid checkpoint digest');
    checkId(binding.recoveryObservationId, 'recovery observation ID');
    this.#present({ kind: 'resume', binding: Object.freeze({ ...binding }), deadline: 0 }, timeoutMs);
  }

  acceptClarification(endpoint: Endpoint, bytes: Uint8Array,
    currentObservationId: string): ClarificationReply {
    const { message, pending } = this.#accept(endpoint, bytes, 'clarification', currentObservationId);
    if (!isClarificationReply(message) || pending.kind !== 'clarification') {
      throw new ContractError('expected clarification reply');
    }
    if (message.observationId !== pending.binding.observationId
      || !pending.binding.optionIds.includes(message.selectedOptionId)) {
      throw new ContractError('stale or unoffered clarification choice');
    }
    this.#consume(message.messageId);
    return Object.freeze({ ...message });
  }

  /** Exact, short-lived, one-use proof of a reply accepted by this ledger.
   * Copies and persisted messages are intent history, never recovery authority. */
  claimForRecovery(intent: ResumeRequest): void {
    this.#assertOpen();
    const issued = this.#resumes.get(intent);
    if (!issued || this.#claimedResumes.has(intent) || issued.generation !== this.#generation) {
      throw new ContractError('resume intent was not issued by this ledger or was claimed/invalidated');
    }
    if (this.#now() >= issued.deadline) throw new ContractError('resume intent expired');
    this.#claimedResumes.add(intent);
  }

  /** A changed presentation or interruption invalidates accepted but unused intent. */
  invalidate(): void {
    this.#assertOpen();
    this.#pending = undefined;
    this.#generation++;
  }

  acceptResume(endpoint: Endpoint, bytes: Uint8Array,
    currentObservationId: string): ResumeRequest {
    const { message, pending } = this.#accept(endpoint, bytes, 'resume', currentObservationId);
    if (!isResumeRequest(message) || pending.kind !== 'resume') {
      throw new ContractError('expected resume request');
    }
    for (const key of ['checkpointRef', 'checkpointDigest', 'recoveryObservationId'] as const) {
      if (message[key] !== pending.binding[key]) throw new ContractError(`resume binding mismatch: ${key}`);
    }
    this.#consume(message.messageId);
    const intent = Object.freeze({ ...message });
    this.#resumes.set(intent, { deadline: pending.deadline, generation: this.#generation });
    return intent;
  }

  close(): void {
    this.#closed = true;
    this.#pending = undefined;
  }

  expire(): boolean {
    this.#assertOpen();
    if (this.#pending && this.#now() >= this.#pending.deadline) {
      this.#pending = undefined;
      return true;
    }
    return false;
  }

  #present(pending: PendingPrompt, timeoutMs: number): void {
    this.#assertOpen();
    this.expire();
    if (this.#pending) throw new ContractError('another user prompt is active');
    if (this.#seenPrompts.has(pending.binding.promptId)) throw new ContractError('prompt ID replay');
    if (this.#seenPrompts.size >= 1_000) throw new ContractError('user prompt budget exceeded');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
      throw new ContractError('invalid user prompt timeout');
    }
    const deadline = this.#now() + timeoutMs;
    if (!Number.isFinite(deadline)) throw new ContractError('invalid user prompt deadline');
    this.#generation++;
    this.#pending = { ...pending, deadline };
    this.#seenPrompts.add(pending.binding.promptId);
  }

  #accept(endpoint: Endpoint, bytes: Uint8Array, kind: PendingPrompt['kind'],
    currentObservationId: string): { message: Message; pending: PendingPrompt } {
    this.#assertOpen();
    const pending = this.#pending;
    if (!pending || pending.kind !== kind || endpoint !== this.#endpoint) {
      throw new ContractError('unregistered prompt reply or wrong endpoint');
    }
    if (this.#now() >= pending.deadline) {
      this.#pending = undefined;
      throw new ContractError('user prompt expired');
    }
    const message = receive(endpoint, bytes);
    const expectedType = kind === 'clarification' ? 'clarification_reply' : 'resume_request';
    if (message.type !== expectedType) throw new ContractError('user prompt type mismatch');
    for (const key of ['taskId', 'taskEpoch', 'goalRevision'] as const) {
      if (message[key] !== this.#revision[key]) throw new ContractError('user prompt revision mismatch');
    }
    if (message.issuer !== 'native_ui' || message.actorRef !== this.#actorRef
      || message.uiSessionRef !== this.#uiSessionRef) {
      throw new ContractError('user prompt actor or session mismatch');
    }
    if (message.promptId !== pending.binding.promptId
      || message.presentationDigest !== pending.binding.presentationDigest) {
      throw new ContractError('user prompt presentation mismatch');
    }
    const expectedObservation = kind === 'clarification'
      ? (pending.binding as ClarificationPrompt).observationId
      : (pending.binding as ResumePrompt).recoveryObservationId;
    if (currentObservationId !== expectedObservation) {
      this.#pending = undefined;
      throw new ContractError('user prompt observation changed');
    }
    if (this.#seenMessages.has(message.messageId)) throw new ContractError('user prompt message replay');
    if (this.#now() >= pending.deadline) {
      this.#pending = undefined;
      throw new ContractError('user prompt expired during validation');
    }
    return { message, pending };
  }

  #consume(messageId: string): void {
    this.#seenMessages.add(messageId);
    this.#pending = undefined;
  }

  #assertOpen(): void {
    if (this.#closed) throw new ContractError('user prompt ledger closed');
  }

  #now(): number {
    const value = this.#clock();
    if (!Number.isFinite(value) || value < this.#lastTime) {
      this.close();
      throw new ContractError('invalid monotonic user prompt clock');
    }
    this.#lastTime = value;
    return value;
  }
}

function checkPromptIdentity(value: PromptIdentity): void {
  checkId(value.promptId, 'prompt ID');
  if (!DIGEST.test(value.presentationDigest)) throw new ContractError('invalid presentation digest');
}

function checkId(value: string, label: string): void {
  if (!ID.test(value)) throw new ContractError(`invalid ${label}`);
}

function isClarificationReply(message: Message): message is ClarificationReply {
  return message.type === 'clarification_reply'
    && typeof message.selectedOptionId === 'string'
    && typeof message.observationId === 'string';
}

function isResumeRequest(message: Message): message is ResumeRequest {
  return message.type === 'resume_request'
    && typeof message.checkpointRef === 'string'
    && typeof message.checkpointDigest === 'string'
    && typeof message.recoveryObservationId === 'string';
}
