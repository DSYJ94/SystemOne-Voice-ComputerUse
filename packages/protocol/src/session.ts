import { decodeMessage } from './contract.ts';
import type { Message, MessageType } from './contract.ts';
import { ContractError } from './json.ts';

export interface TaskRevision {
  readonly taskId: string;
  readonly taskEpoch: number;
  readonly goalRevision: number;
}

/** Created by the trusted supervisor after authenticating its pipe/peer.
 * This object is an in-process capability, never decoded from message metadata.
 * It does not authenticate OS processes by itself.
 */
export interface Endpoint {
  readonly allowedTypes: readonly MessageType[];
}

export function bindEndpoint(allowedTypes: readonly MessageType[]): Endpoint {
  return Object.freeze({ allowedTypes: Object.freeze([...allowedTypes]) });
}

export function receive(endpoint: Endpoint, bytes: Uint8Array): Message {
  const message = decodeMessage(bytes);
  if (!endpoint.allowedTypes.includes(message.type)) throw new ContractError('producer cannot send this message type');
  return message;
}

interface PendingReply {
  readonly endpoint: Endpoint;
  readonly type: MessageType;
  readonly deadline: number;
  readonly expected: Readonly<Record<string, string>>;
}

/** Bounded, one-session reply ledger. All state changes are synchronous.
 * Deadline is on the injected monotonic clock, not a provider's wall clock.
 * This rejects late replies; it does not cancel already-dispatched effects.
 */
export class ReplyLedger {
  readonly #revision: TaskRevision;
  readonly #clock: () => number;
  readonly #pending = new Map<string, PendingReply>();
  readonly #seen = new Set<string>();
  #lastTime = -Infinity;
  #closed = false;

  constructor(revision: TaskRevision, clock: () => number) {
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(revision.taskId)
      || ![revision.taskEpoch, revision.goalRevision].every(n => Number.isSafeInteger(n) && n >= 0)) {
      throw new ContractError('invalid task revision');
    }
    this.#revision = Object.freeze({ ...revision });
    this.#clock = clock;
  }

  expect(requestId: string, endpoint: Endpoint, type: MessageType,
    timeoutMs: number, expected: Readonly<Record<string, string>> = {}): void {
    this.#assertOpen();
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(requestId) || this.#seen.has(requestId)) {
      throw new ContractError('invalid or reused request ID');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new ContractError('invalid reply timeout');
    if (this.#seen.size >= 1_000 || this.#pending.size >= 64) throw new ContractError('reply ledger budget exceeded');
    if (!endpoint.allowedTypes.includes(type)) throw new ContractError('reply type not allowed on endpoint');
    const deadline = this.#now() + timeoutMs;
    if (!Number.isFinite(deadline)) throw new ContractError('invalid reply deadline');
    this.#pending.set(requestId, { endpoint, type, deadline, expected: Object.freeze({ ...expected }) });
    this.#seen.add(requestId);
  }

  accept(requestId: string, endpoint: Endpoint, bytes: Uint8Array): Message {
    this.#assertOpen();
    const pending = this.#pending.get(requestId);
    if (!pending || pending.endpoint !== endpoint) throw new ContractError('unregistered reply or wrong endpoint');
    if (this.#now() >= pending.deadline) {
      this.#pending.delete(requestId);
      throw new ContractError('reply deadline expired');
    }
    const message = receive(endpoint, bytes);
    if (message.type !== pending.type || message.requestId !== requestId) throw new ContractError('reply correlation mismatch');
    for (const key of ['taskId', 'taskEpoch', 'goalRevision'] as const) {
      if (message[key] !== this.#revision[key]) throw new ContractError('stale reply revision');
    }
    for (const [key, value] of Object.entries(pending.expected)) {
      if (message[key] !== value) throw new ContractError(`reply binding mismatch: ${key}`);
    }
    if (this.#now() >= pending.deadline) {
      this.#pending.delete(requestId);
      throw new ContractError('reply deadline expired during validation');
    }
    this.#pending.delete(requestId);
    return message;
  }

  expire(): number {
    this.#assertOpen();
    const now = this.#now();
    let count = 0;
    for (const [id, pending] of this.#pending) {
      if (now >= pending.deadline) { this.#pending.delete(id); count++; }
    }
    return count;
  }

  close(): void {
    this.#closed = true;
    this.#pending.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw new ContractError('reply session closed');
  }

  #now(): number {
    const value = this.#clock();
    if (!Number.isFinite(value) || value < this.#lastTime) {
      this.close();
      throw new ContractError('monotonic clock invalid');
    }
    this.#lastTime = value;
    return value;
  }
}
