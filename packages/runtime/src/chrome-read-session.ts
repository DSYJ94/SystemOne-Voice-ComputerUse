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
  readonly title: string;
  readonly url: string;
  readonly elements: readonly { readonly role: string; readonly label: string;
    readonly disabled: boolean }[];
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
  if (!record(value) || !keys(value, 'elements,title,url')
    || typeof value.title !== 'string' || value.title.length > 160
    || !value.title.isWellFormed() || value.url !== expectedURL
    || !Array.isArray(value.elements) || value.elements.length > MAX_LABELS) {
    throw new ContractError('invalid Chrome observation');
  }
  for (const item of value.elements) {
    if (!record(item) || !keys(item, 'disabled,label,role')
      || typeof item.role !== 'string' || item.role.length < 1
      || item.role.length > 40
      || !item.role.isWellFormed() || typeof item.label !== 'string'
      || item.label.length < 1 || item.label.length > 160
      || !item.label.isWellFormed()
      || typeof item.disabled !== 'boolean') {
      throw new ContractError('invalid Chrome control');
    }
  }
  return value as unknown as ChromeReadSnapshot;
}

interface PendingRead {
  readonly binding: ChromeBinding;
  readonly deadline: number;
}

/** One OS-authenticated host connection's read-only claims. The caller must
 * authenticate the host peer before constructing this session. A signed host
 * by itself does not prove Chrome launched it or grant execution authority. */
export class ChromeReadSession {
  readonly #extensionId: string;
  readonly #send: (value: Record<string, JSONValue>) => void;
  readonly #report: (binding: ChromeBinding, view: ChromeReadSnapshot) => void;
  readonly #now: () => number;
  readonly #grants = new Map<string, ChromeBinding>();
  readonly #pending = new Map<string, PendingRead>();
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
    this.#pending.clear();
  }

  get activeGrantCount(): number { return this.#grants.size; }

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
    const requestId = randomUUID();
    this.#pending.set(requestId, { binding: grant, deadline: this.#now() + 5_000 });
    this.#send({ type: 'observe', requestId, grantId: grant.grantId,
      binding: { ...grant } });
  }

  #observation(value: Record<string, JSONValue>): void {
    if (!keys(value, 'binding,requestId,snapshot,type')
      || typeof value.requestId !== 'string') {
      throw new ContractError('invalid Chrome observation reply');
    }
    const pending = this.#pending.get(value.requestId);
    if (!pending) throw new ContractError('Chrome observation replay');
    this.#pending.delete(value.requestId);
    if (this.#now() > pending.deadline) throw new ContractError('Chrome observation expired');
    const current = this.#grants.get(pending.binding.grantId);
    const returned = binding(value.binding!, this.#extensionId, true);
    if (!current || !sameBinding(current, pending.binding)
      || !sameBinding(returned, pending.binding)) {
      throw new ContractError('Chrome document binding changed');
    }
    const view = snapshot(value.snapshot!, current.url);
    this.#report(current, view);
  }

  #unavailable(value: Record<string, JSONValue>): void {
    if (!keys(value, 'requestId,type') || typeof value.requestId !== 'string') {
      throw new ContractError('invalid Chrome unavailable reply');
    }
    const pending = this.#pending.get(value.requestId);
    if (!pending) throw new ContractError('Chrome unavailable replay');
    this.#pending.delete(value.requestId);
    this.#drop(pending.binding.grantId);
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
    for (const [requestId, pending] of this.#pending) {
      if (pending.binding.grantId === grantId) this.#pending.delete(requestId);
    }
  }
}
