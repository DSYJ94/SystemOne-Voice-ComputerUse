import { randomUUID } from 'node:crypto';
import { ContractError } from '../../protocol/src/json.ts';
import type { JSONValue } from '../../protocol/src/json.ts';

const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const EXTENSION_ID = /^[a-p]{32}$/;
const MAX_LABELS = 80;

function record(value: JSONValue): value is Record<string, JSONValue> {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}

function keys(value: Record<string, JSONValue>, expected: string): boolean {
  return Object.keys(value).sort().join(',') === expected;
}

export interface ChromeBinding {
  readonly grantId: string;
  readonly extensionId: string;
  readonly profileInstallId: string;
  readonly workerSessionId: string;
  readonly portSessionId: string;
  readonly tabId: number;
  readonly windowId: number;
  readonly frameId: 0;
  readonly documentId: string;
  readonly origin: string;
  readonly url: string;
  readonly connected: boolean;
}

export interface ChromeReadSnapshot {
  readonly observationId: string;
  readonly title: string;
  readonly url: string;
  readonly complete: boolean;
  readonly elements: readonly { readonly id: string; readonly role: string;
    readonly label: string; readonly disabled: boolean;
    readonly editable: boolean }[];
}

function binding(value: JSONValue, extensionId: string,
  connected: boolean): ChromeBinding {
  if (!record(value) || !keys(value,
    'connected,documentId,extensionId,frameId,grantId,origin,portSessionId,profileInstallId,tabId,url,windowId,workerSessionId')
    || value.extensionId !== extensionId || value.connected !== connected
    || typeof value.grantId !== 'string' || !ID.test(value.grantId)
    || typeof value.profileInstallId !== 'string' || !ID.test(value.profileInstallId)
    || typeof value.workerSessionId !== 'string' || !ID.test(value.workerSessionId)
    || typeof value.portSessionId !== 'string' || !ID.test(value.portSessionId)
    || typeof value.documentId !== 'string' || !ID.test(value.documentId)
    || !Number.isSafeInteger(value.tabId) || (value.tabId as number) < 0
    || !Number.isSafeInteger(value.windowId) || (value.windowId as number) < 0
    || value.frameId !== 0 || typeof value.url !== 'string'
    || value.url.length > 4_096 || typeof value.origin !== 'string') {
    throw new ContractError('invalid Chrome grant binding');
  }
  let parsed: URL;
  try { parsed = new URL(value.url); }
  catch { throw new ContractError('invalid Chrome tab URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username
    || parsed.password || parsed.origin !== value.origin) {
    throw new ContractError('unsupported Chrome tab origin');
  }
  return Object.freeze({ ...value }) as unknown as ChromeBinding;
}

function sameBinding(left: ChromeBinding, right: ChromeBinding): boolean {
  return left.grantId === right.grantId && left.extensionId === right.extensionId
    && left.profileInstallId === right.profileInstallId
    && left.workerSessionId === right.workerSessionId
    && left.portSessionId === right.portSessionId
    && left.tabId === right.tabId && left.windowId === right.windowId
    && left.frameId === right.frameId && left.documentId === right.documentId
    && left.origin === right.origin && left.url === right.url;
}

function snapshot(value: JSONValue, expectedURL: string): ChromeReadSnapshot {
  if (!record(value) || !keys(value, 'complete,elements,observationId,title,url')
    || typeof value.observationId !== 'string' || !ID.test(value.observationId)
    || typeof value.title !== 'string' || value.title.length > 160
    || !value.title.isWellFormed() || value.url !== expectedURL
    || typeof value.complete !== 'boolean'
    || !Array.isArray(value.elements) || value.elements.length > MAX_LABELS) {
    throw new ContractError('invalid Chrome observation');
  }
  const seen = new Set<string>();
  for (const item of value.elements) {
    if (!record(item) || !keys(item, 'disabled,editable,id,label,role')
      || typeof item.id !== 'string' || !ID.test(item.id)
      || !item.id.startsWith(`${value.observationId}:`)
      || seen.has(item.id)
      || typeof item.role !== 'string' || item.role.length < 1
      || item.role.length > 40
      || !item.role.isWellFormed() || typeof item.label !== 'string'
      || item.label.length < 1 || item.label.length > 160
      || !item.label.isWellFormed()
      || typeof item.disabled !== 'boolean'
      || typeof item.editable !== 'boolean'
      || (item.disabled && item.editable)) {
      throw new ContractError('invalid Chrome control');
    }
    seen.add(item.id);
  }
  return value as unknown as ChromeReadSnapshot;
}

interface PendingRead {
  readonly binding: ChromeBinding;
  readonly deadline: number;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve?: (view: ChromeReadSnapshot) => void;
  readonly reject?: (error: Error) => void;
}

export type ChromeFillStatus = 'matched' | 'already_matched'
  | 'not_dispatched' | 'unknown';

interface PendingAction {
  readonly binding: ChromeBinding;
  readonly permitRef: string;
  readonly resolve: (status: ChromeFillStatus) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingStop {
  readonly grantId: string;
  readonly targetRequestId: string;
  readonly resolve: (fenced: boolean) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** One OS-authenticated host connection's scoped tab claims. The caller must
 * authenticate the host peer before constructing this session. A signed host
 * by itself does not prove Chrome launched it or grant execution authority. */
export class ChromeReadSession {
  readonly #extensionId: string;
  readonly #send: (value: Record<string, JSONValue>) => void;
  readonly #report: (binding: ChromeBinding, view: ChromeReadSnapshot) => void;
  readonly #now: () => number;
  readonly #grants = new Map<string, ChromeBinding>();
  readonly #pending = new Map<string, PendingRead>();
  readonly #latest = new Map<string, ChromeReadSnapshot>();
  readonly #actions = new Map<string, PendingAction>();
  readonly #stops = new Map<string, PendingStop>();
  readonly #seenPermits = new Set<string>();
  readonly #seenActions = new Set<string>();
  readonly #seen = new Set<string>();
  #profileInstallId: string | undefined;
  #workerSessionId: string | undefined;
  #portSessionId: string | undefined;
  #closed = false;

  constructor(extensionId: string,
    send: (value: Record<string, JSONValue>) => void,
    report: (binding: ChromeBinding, view: ChromeReadSnapshot) => void,
    now = () => performance.now()) {
    if (!EXTENSION_ID.test(extensionId)) throw new ContractError('invalid extension ID');
    this.#extensionId = extensionId;
    this.#send = send;
    this.#report = report;
    this.#now = now;
  }

  receive(value: JSONValue): void {
    if (this.#closed) throw new ContractError('Chrome port closed');
    try {
      if (!record(value) || typeof value.type !== 'string') {
        throw new ContractError('invalid Chrome port message');
      }
      switch (value.type) {
      case 'hello': this.#hello(value); return;
      case 'observation': this.#observation(value); return;
      case 'unavailable': this.#unavailable(value); return;
      case 'revoked': this.#revoked(value); return;
      case 'action_result': this.#actionResult(value); return;
      case 'stop_ack': this.#stopAck(value); return;
      default: throw new ContractError('unsupported Chrome port message');
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    this.#closed = true;
    this.#grants.clear();
    this.#latest.clear();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject?.(new ContractError('Chrome port closed'));
    }
    this.#pending.clear();
    for (const pending of this.#actions.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ContractError('Chrome action reply lost'));
    }
    this.#actions.clear();
    for (const pending of this.#stops.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ContractError('Chrome Stop reply lost'));
    }
    this.#stops.clear();
  }

  get activeGrantCount(): number { return this.#grants.size; }

  getGrant(grantId: string): ChromeBinding | undefined {
    return this.#grants.get(grantId);
  }

  observeGrant(grantId: string): Promise<ChromeReadSnapshot> {
    const grant = this.#grants.get(grantId);
    if (this.#closed || !grant) {
      return Promise.reject(new ContractError('Chrome grant unavailable'));
    }
    return new Promise((resolve, reject) => {
      try { this.#requestRead(grant, resolve, reject); }
      catch (error) { reject(error as Error); }
    });
  }

  fill(input: { readonly grantId: string; readonly observation: ChromeReadSnapshot;
    readonly candidateId: string; readonly value: string;
    readonly permitRef: string; readonly taskId: string;
    readonly requestId: string }): Promise<ChromeFillStatus> {
    const grant = this.#grants.get(input.grantId);
    const candidate = input.observation.elements.find(item =>
      item.id === input.candidateId && item.editable && !item.disabled);
    if (this.#closed || !grant || !candidate || !input.observation.complete
      || this.#latest.get(input.grantId) !== input.observation
      || input.observation.url !== grant.url
      || ![input.permitRef, input.taskId, input.requestId].every(value => ID.test(value))
      || !input.value.isWellFormed() || Buffer.byteLength(input.value, 'utf8') > 1_024
      || this.#actions.size >= 1 || this.#seenPermits.size >= 1_000
      || this.#seenPermits.has(input.permitRef)
      || this.#seenActions.has(input.requestId)) {
      return Promise.reject(new ContractError('Chrome fill outside fresh grant'));
    }
    this.#seenPermits.add(input.permitRef);
    this.#seenActions.add(input.requestId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#actions.delete(input.requestId);
        reject(new ContractError('Chrome action reply timed out'));
      }, 10_000);
      this.#actions.set(input.requestId, { binding: grant,
        permitRef: input.permitRef, resolve, reject, timer });
      try {
        this.#send({ type: 'action', operation: 'fill',
          requestId: input.requestId, taskId: input.taskId,
          permitRef: input.permitRef, grantId: grant.grantId,
          binding: { ...grant }, observationId: input.observation.observationId,
          candidateId: candidate.id, role: candidate.role,
          label: candidate.label, url: grant.url, value: input.value });
      } catch {
        clearTimeout(timer);
        this.#actions.delete(input.requestId);
        reject(new ContractError('Chrome action send failed'));
      }
    });
  }

  stopAction(grantId: string, targetRequestId: string): Promise<boolean> {
    if (this.#closed || !ID.test(grantId) || !ID.test(targetRequestId)) {
      return Promise.reject(new ContractError('Chrome Stop unavailable'));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#stops.delete(requestId);
        reject(new ContractError('Chrome Stop timed out'));
      }, 3_000);
      this.#stops.set(requestId, { grantId, targetRequestId,
        resolve, reject, timer });
      try { this.#send({ type: 'stop_action', requestId,
        targetRequestId, grantId }); }
      catch {
        clearTimeout(timer);
        this.#stops.delete(requestId);
        reject(new ContractError('Chrome Stop send failed'));
      }
    });
  }

  #hello(value: Record<string, JSONValue>): void {
    if (!keys(value, 'binding,challenge,type')
      || typeof value.challenge !== 'string' || !ID.test(value.challenge)) {
      throw new ContractError('invalid Chrome hello');
    }
    const grant = binding(value.binding!, this.#extensionId, false);
    if (this.#grants.size >= 8 || this.#seen.size >= 1_000
      || this.#seen.has(grant.grantId)) throw new ContractError('Chrome grant replay or budget');
    if (this.#profileInstallId !== undefined
      && (grant.profileInstallId !== this.#profileInstallId
        || grant.workerSessionId !== this.#workerSessionId
        || grant.portSessionId !== this.#portSessionId)) {
      throw new ContractError('Chrome port session identity changed');
    }
    this.#profileInstallId = grant.profileInstallId;
    this.#workerSessionId = grant.workerSessionId;
    this.#portSessionId = grant.portSessionId;
    this.#seen.add(grant.grantId);
    for (const [id, existing] of this.#grants) {
      if (existing.tabId === grant.tabId) this.#drop(id);
    }
    this.#grants.set(grant.grantId, grant);
    this.#send({ type: 'hello_ack', grantId: grant.grantId,
      challenge: value.challenge, binding: { ...grant } });
    this.#requestRead(grant);
  }

  #requestRead(grant: ChromeBinding,
    resolve?: (view: ChromeReadSnapshot) => void,
    reject?: (error: Error) => void): void {
    if (this.#pending.size >= 8) throw new ContractError('Chrome read budget exhausted');
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      this.#pending.delete(requestId);
      reject?.(new ContractError('Chrome read timed out'));
    }, 5_000);
    this.#pending.set(requestId, { binding: grant, deadline: this.#now() + 5_000,
      timer, ...(resolve ? { resolve } : {}), ...(reject ? { reject } : {}) });
    try { this.#send({ type: 'observe', requestId, grantId: grant.grantId,
      binding: { ...grant } }); }
    catch {
      this.#pending.delete(requestId);
      clearTimeout(timer);
      throw new ContractError('Chrome read send failed');
    }
  }

  #observation(value: Record<string, JSONValue>): void {
    if (!keys(value, 'binding,requestId,snapshot,type')
      || typeof value.requestId !== 'string') {
      throw new ContractError('invalid Chrome observation reply');
    }
    const pending = this.#pending.get(value.requestId);
    if (!pending) throw new ContractError('Chrome observation replay');
    this.#pending.delete(value.requestId);
    clearTimeout(pending.timer);
    if (this.#now() > pending.deadline) throw new ContractError('Chrome observation expired');
    const current = this.#grants.get(pending.binding.grantId);
    const returned = binding(value.binding!, this.#extensionId, true);
    if (!current || !sameBinding(current, pending.binding)
      || !sameBinding(returned, pending.binding)) {
      throw new ContractError('Chrome document binding changed');
    }
    const view = snapshot(value.snapshot!, current.url);
    // The extension may report a connected grant only after the challenge
    // round-trip. Retain that state for host-side action admission.
    this.#grants.set(current.grantId, returned);
    this.#latest.set(current.grantId, view);
    pending.resolve?.(view);
    this.#report(current, view);
  }

  #unavailable(value: Record<string, JSONValue>): void {
    if (!keys(value, 'requestId,type') || typeof value.requestId !== 'string') {
      throw new ContractError('invalid Chrome unavailable reply');
    }
    const pending = this.#pending.get(value.requestId);
    if (!pending) throw new ContractError('Chrome unavailable replay');
    this.#pending.delete(value.requestId);
    clearTimeout(pending.timer);
    pending.reject?.(new ContractError('Chrome observation unavailable'));
    this.#drop(pending.binding.grantId);
  }

  #actionResult(value: Record<string, JSONValue>): void {
    if (!keys(value, 'binding,permitRef,requestId,status,type')
      || typeof value.requestId !== 'string'
      || typeof value.permitRef !== 'string') {
      throw new ContractError('invalid Chrome action receipt');
    }
    const pending = this.#actions.get(value.requestId);
    if (!pending) throw new ContractError('Chrome action receipt replay');
    this.#actions.delete(value.requestId);
    clearTimeout(pending.timer);
    const returned = binding(value.binding!, this.#extensionId, true);
    if (!sameBinding(returned, pending.binding)
      || value.permitRef !== pending.permitRef
      || !['matched', 'already_matched', 'not_dispatched', 'unknown']
        .includes(value.status as string)) {
      pending.reject(new ContractError('Chrome action receipt binding changed'));
      throw new ContractError('Chrome action receipt binding changed');
    }
    pending.resolve(value.status as ChromeFillStatus);
  }

  #stopAck(value: Record<string, JSONValue>): void {
    if (!keys(value, 'grantId,requestId,targetRequestId,type,workerFenced')
      || typeof value.requestId !== 'string') {
      throw new ContractError('invalid Chrome Stop acknowledgement');
    }
    const pending = this.#stops.get(value.requestId);
    if (!pending) throw new ContractError('Chrome Stop replay');
    this.#stops.delete(value.requestId);
    clearTimeout(pending.timer);
    if (value.grantId !== pending.grantId
      || value.targetRequestId !== pending.targetRequestId
      || typeof value.workerFenced !== 'boolean') {
      pending.reject(new ContractError('Chrome Stop binding changed'));
      throw new ContractError('Chrome Stop binding changed');
    }
    pending.resolve(value.workerFenced);
  }

  #revoked(value: Record<string, JSONValue>): void {
    if (!keys(value, 'grantId,reason,type') || typeof value.grantId !== 'string'
      || typeof value.reason !== 'string' || value.reason.length > 80) {
      throw new ContractError('invalid Chrome revocation');
    }
    this.#drop(value.grantId);
  }

  #drop(grantId: string): void {
    this.#grants.delete(grantId);
    this.#latest.delete(grantId);
    for (const [requestId, pending] of this.#pending) {
      if (pending.binding.grantId === grantId) {
        this.#pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.reject?.(new ContractError('Chrome grant revoked'));
      }
    }
  }
}
