import { randomUUID } from 'node:crypto';
import { ContractError } from '../../protocol/src/json.ts';
import type { JSONValue } from '../../protocol/src/json.ts';
import type { NativeFieldObservation, NativeFieldWorker } from './native-fill-authority.ts';

type Operation = 'observe' | 'prepare' | 'commit' | 'verify' | 'stop';
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;

interface Pending {
  readonly operation: Operation;
  readonly resolve: (value: JSONValue) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly abort?: () => void;
}

function record(value: JSONValue): value is Record<string, JSONValue> {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}

/** Typed private-pipe adapter. It does not authenticate an OS process; the
 * development app owns this inherited pipe and release packaging must pin the
 * signed child, peer identity and worker-side permit checks. */
export class NativeFieldPipeWorker implements NativeFieldWorker {
  readonly #write: (value: Record<string, JSONValue>) => void;
  readonly #pending = new Map<string, Pending>();
  #closed = false;

  constructor(write: (value: Record<string, JSONValue>) => void) {
    this.#write = write;
  }

  receive(value: JSONValue): boolean {
    if (!record(value) || value.type !== 'native_worker_reply') return false;
    const requestId = value.requestId;
    if (typeof requestId !== 'string' || !ID.test(requestId)) return true;
    const pending = this.#pending.get(requestId);
    if (!pending) return true; // Late or replayed worker response.
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.abort?.();
    if (value.operation !== pending.operation || !('result' in value)
      || Object.keys(value).sort().join(',') !== 'operation,requestId,result,type') {
      pending.reject(new ContractError('native worker reply binding changed'));
      return true;
    }
    pending.resolve(value.result!);
    return true;
  }

  close(): void {
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.abort?.();
      pending.reject(new ContractError('native worker pipe closed'));
    }
  }

  async observe(input: { readonly taskId: string; readonly bundleId: string;
    readonly signal: AbortSignal }): Promise<NativeFieldObservation> {
    const result = await this.#request('observe', { taskId: input.taskId,
      bundleId: input.bundleId }, 5_000, input.signal);
    if (!record(result)) throw new ContractError('invalid native observation');
    // The host authority validates exact candidate fields and limits before use.
    return result as unknown as NativeFieldObservation;
  }

  async prepare(input: { readonly taskId: string; readonly observationId: string;
    readonly candidateId: string; readonly value: string;
    readonly executionId: string; readonly permitRef: string;
    readonly actionDigest: string; readonly candidateSetDigest: string;
    readonly policyRevision: string;
    readonly signal: AbortSignal }): Promise<
      { readonly kind: 'ready'; readonly preparationRef: string }
      | { readonly kind: 'matched_at_preflight' }
      | { readonly kind: 'unsupported' }> {
    const result = await this.#request('prepare', {
      taskId: input.taskId, observationId: input.observationId,
      candidateId: input.candidateId, value: input.value,
      executionId: input.executionId, permitRef: input.permitRef,
      actionDigest: input.actionDigest,
      candidateSetDigest: input.candidateSetDigest,
      policyRevision: input.policyRevision,
    }, 5_000, input.signal);
    if (!record(result) || typeof result.kind !== 'string'
      || !['ready', 'matched_at_preflight', 'unsupported'].includes(result.kind)
      || (result.kind === 'ready'
        ? typeof result.preparationRef !== 'string' || !ID.test(result.preparationRef)
          || Object.keys(result).sort().join(',') !== 'kind,preparationRef'
        : Object.keys(result).join(',') !== 'kind')) {
      throw new ContractError('invalid native preparation reply');
    }
    return result as { kind: 'ready'; preparationRef: string }
      | { kind: 'matched_at_preflight' } | { kind: 'unsupported' };
  }

  async commit(input: { readonly taskId: string; readonly executionId: string;
    readonly permitRef: string; readonly preparationRef: string }): Promise<
      'verified' | 'not_dispatched' | 'unknown'> {
    const result = await this.#request('commit', { ...input }, 10_000);
    if (result !== 'verified' && result !== 'not_dispatched'
      && result !== 'unknown') throw new ContractError('invalid native commit reply');
    return result;
  }

  async verify(input: { readonly taskId: string; readonly observationId: string;
    readonly candidateId: string; readonly value: string }): Promise<boolean> {
    const result = await this.#request('verify', { ...input }, 5_000);
    if (typeof result !== 'boolean') throw new ContractError('invalid native verify reply');
    return result;
  }

  async stop(taskId: string): Promise<boolean> {
    const result = await this.#request('stop', { taskId }, 2_500);
    if (typeof result !== 'boolean') throw new ContractError('invalid native Stop reply');
    return result;
  }

  #request(operation: Operation, payload: Record<string, JSONValue>,
    timeoutMs: number, signal?: AbortSignal): Promise<JSONValue> {
    if (this.#closed || signal?.aborted) {
      return Promise.reject(new ContractError('native worker unavailable'));
    }
    if (this.#pending.size >= 8) {
      return Promise.reject(new ContractError('native worker request budget exhausted'));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        signal?.removeEventListener('abort', onAbort);
        reject(new ContractError('native worker timed out'));
      }, timeoutMs);
      const onAbort = () => {
        this.#pending.delete(requestId);
        clearTimeout(timer);
        reject(new ContractError('native worker request cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(requestId, { operation, resolve, reject, timer,
        ...(signal ? { abort: () => signal.removeEventListener('abort', onAbort) } : {}) });
      try {
        this.#write({ type: 'native_worker_request', requestId,
          operation, ...payload });
      } catch {
        this.#pending.delete(requestId);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new ContractError('native worker write failed'));
      }
    });
  }
}
