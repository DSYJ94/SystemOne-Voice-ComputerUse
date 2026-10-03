import { randomUUID } from 'node:crypto';
import { ContractError } from '../../protocol/src/json.ts';
import type { JSONValue } from '../../protocol/src/json.ts';

export interface AgentElement {
  readonly id: string;
  readonly role: string;
  readonly label: string;
  readonly context: string;
  readonly editable: boolean;
  readonly pressable: boolean;
  readonly secure?: boolean;
  readonly value?: string;
  readonly selected?: boolean;
  readonly url?: string;
}

export interface AgentSnapshot {
  readonly app: string;
  readonly bundleId: string;
  readonly pid: number;
  readonly windowTitle: string;
  readonly url: string;
  readonly elements: readonly AgentElement[];
  readonly truncated: boolean;
  readonly signature: string;
  /** Other apps the user has open (regular apps only), for switching. */
  readonly runningApps?: readonly string[];
}

export type AgentOperation = 'snapshot' | 'press' | 'type' | 'key' | 'scroll' | 'open_url' | 'open_app' | 'copy' | 'paste';

/** Host-side end of the private pipe to the app's Accessibility executor. The
 * app accepts a request only for the active, host-admitted agent task. */
export class AgentAXClient {
  readonly #output: (value: Record<string, JSONValue>) => void;
  readonly #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> }>();

  constructor(output: (value: Record<string, JSONValue>) => void) { this.#output = output; }

  call(taskId: string, op: AgentOperation, params: Record<string, JSONValue> = {}, timeoutMs = 10_000): Promise<unknown> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(requestId); reject(new ContractError(`agent ${op} timed out`)); },
        timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer });
      this.#output({ type: 'agent_ax_request', requestId, taskId, op, ...params });
    });
  }

  async snapshot(taskId: string): Promise<AgentSnapshot> {
    const value = await this.call(taskId, 'snapshot') as AgentSnapshot;
    if (!value || typeof value !== 'object' || !Array.isArray(value.elements)
      || typeof value.signature !== 'string') throw new ContractError('invalid agent snapshot');
    return value;
  }

  /** True when the message was an executor reply (consumed). */
  receive(message: Record<string, JSONValue>): boolean {
    if (message.type !== 'agent_ax_reply' || typeof message.requestId !== 'string') return false;
    const pending = this.#pending.get(message.requestId);
    if (!pending) return true;
    this.#pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.ok === true) pending.resolve(message.value ?? null);
    else pending.reject(new ContractError(`agent step failed: ${String(message.error ?? 'unknown')}`));
    return true;
  }

  cancelAll(): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer); pending.reject(new ContractError('agent request cancelled')); this.#pending.delete(id);
    }
  }
}
