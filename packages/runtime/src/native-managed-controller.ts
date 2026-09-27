import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ManagedFillTask } from '../../browser/src/managed-fill-task.ts';
import { ManagedLaunchFailure, ManagedObservationSession } from '../../browser/src/managed-observation.ts';
import { ContractError, digest, parseJSON } from '../../protocol/src/json.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { CommittedInputSession } from './committed-input.ts';
import { AttemptJournal } from './attempt-journal.ts';
import { TaskAdmissionRegistry } from './task-authority.ts';
import type { JSONValue } from '../../protocol/src/json.ts';

const MAX_LINE_BYTES = 16_384;
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const MAX_VALUE_BYTES = 1_024;

interface StartFill {
  readonly type: 'start_fill';
  readonly requestId: string;
  readonly url: string;
  readonly fieldLabel: string;
  readonly value: string;
  readonly command: Record<string, JSONValue>;
}

interface Stop {
  readonly type: 'stop';
  readonly requestId: string;
  readonly targetRequestId: string;
}

type NativeRequest = StartFill | Stop;
type Phase = 'ready' | 'starting' | 'observing' | 'dispatching'
  | 'verified_dom_fill' | 'unsupported' | 'uncertain' | 'stopping'
  | 'stopped' | 'busy' | 'error' | 'blocked_recovery';

function isRecord(value: JSONValue): value is Record<string, JSONValue> {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}

function requestFromLine(line: Uint8Array): NativeRequest {
  if (line.byteLength > MAX_LINE_BYTES) throw new ContractError('native request too large');
  const value = parseJSON(line);
  if (!isRecord(value) || !ID.test(String(value.requestId ?? ''))) {
    throw new ContractError('invalid native request');
  }
  if (value.type === 'stop') {
    if (Object.keys(value).sort().join(',') !== 'requestId,targetRequestId,type'
      || typeof value.targetRequestId !== 'string'
      || !ID.test(value.targetRequestId)) {
      throw new ContractError('invalid native Stop request');
    }
    return { type: 'stop', requestId: value.requestId as string,
      targetRequestId: value.targetRequestId };
  }
  if (value.type !== 'start_fill'
    || Object.keys(value).sort().join(',') !== 'command,fieldLabel,requestId,type,url,value'
    || typeof value.url !== 'string' || value.url.length > 2_048
    || typeof value.fieldLabel !== 'string' || value.fieldLabel.length < 1
    || value.fieldLabel.length > 160 || !value.fieldLabel.isWellFormed()
    || typeof value.value !== 'string' || !value.value.isWellFormed()
    || Buffer.byteLength(value.value, 'utf8') > MAX_VALUE_BYTES
    || value.command === undefined || !isRecord(value.command)) {
    throw new ContractError('invalid native fill request');
  }
  return { type: 'start_fill', requestId: value.requestId as string,
    url: value.url, fieldLabel: value.fieldLabel, value: value.value,
    command: value.command };
}

function approvedOrigin(urlText: string): string {
  let url: URL;
  try { url = new URL(urlText); }
  catch { throw new ContractError('invalid managed URL'); }
  if (url.username || url.password || (url.protocol !== 'https:'
    && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))) {
    throw new ContractError('managed URL is not approved');
  }
  return url.origin;
}

interface ActiveTask {
  readonly requestId: string;
  cancelled: boolean;
  keepOpen: boolean;
  launchFenceUnconfirmed: boolean;
  session?: ManagedObservationSession;
  task?: ManagedFillTask;
  browserFenced: boolean;
  done: Promise<void>;
}

/** Development pipe integration for the planned Node controller topology.
 * The native parent owns this private inherited pipe; this process never
 * listens on a network port or accepts model-originated execution requests. */
export class NativeManagedController {
  readonly #journal: AttemptJournal;
  readonly #send: (requestId: string, phase: Phase) => void;
  readonly #headless: boolean;
  readonly #seen = new Set<string>();
  #active: ActiveTask | undefined;
  #workerFenceFailed = false;

  constructor(journal: AttemptJournal, send: (requestId: string, phase: Phase) => void,
    headless = false) {
    this.#journal = journal;
    this.#send = send;
    this.#headless = headless;
    journal.recoverAfterRestart();
  }

  receive(line: Uint8Array): void {
    let request: NativeRequest;
    try { request = requestFromLine(line); }
    catch { this.#send('invalid', 'error'); return; }
    if (this.#seen.has(request.requestId) || this.#seen.size >= 1_000) {
      this.#send(request.requestId, 'error');
      return;
    }
    this.#seen.add(request.requestId);
    if (request.type === 'stop') {
      void this.#stop(request);
      return;
    }
    if (this.#active) { this.#send(request.requestId, 'busy'); return; }
    if (this.#workerFenceFailed || this.#journal.unresolvedAttempts().length) {
      this.#send(request.requestId, 'blocked_recovery');
      return;
    }
    const active: ActiveTask = { requestId: request.requestId,
      cancelled: false, keepOpen: false, launchFenceUnconfirmed: false,
      browserFenced: false, done: Promise.resolve() };
    this.#active = active;
    this.#send(request.requestId, 'starting');
    active.done = this.#run(request, active).finally(() => {
      if (this.#active === active && !active.keepOpen && !active.cancelled) {
        this.#active = undefined;
        this.#send(request.requestId,
          this.#workerFenceFailed || this.#journal.unresolvedAttempts().length
            ? 'blocked_recovery' : 'ready');
      }
    });
  }

  async close(): Promise<void> {
    const active = this.#active;
    if (active) {
      active.cancelled = true;
      const result = await active.task?.stop().catch(() => undefined);
      if (result) active.browserFenced = result.browserFenced;
      await active.done;
      if (active.session && !active.browserFenced) {
        try { await active.session.close(); active.browserFenced = true; }
        catch { this.#workerFenceFailed = true; }
      }
      this.#active = undefined;
    }
    this.#journal.close();
  }

  async #run(request: StartFill, active: ActiveTask): Promise<void> {
    try {
      const command = request.command;
      if (command.type !== 'command' || command.source !== 'text'
        || command.mode !== 'command' || command.isFinal !== true
        || command.taskId !== request.requestId || command.taskEpoch !== 1
        || command.goalRevision !== 1
        || command.text !== `Fill ${request.fieldLabel} on ${request.url} with supplied text`
        || command.originSurface === undefined || !isRecord(command.originSurface)
        || command.originSurface.appBundleId !== 'com.aurium.systemone.dev') {
        throw new ContractError('native command binding changed');
      }
      const revision = { taskId: request.requestId, taskEpoch: 1, goalRevision: 1 };
      const endpoint = bindEndpoint(['command']);
      const input = new CommittedInputSession(endpoint, revision);
      const route = input.accept(endpoint, Buffer.from(JSON.stringify(command)));
      if (route.kind !== 'interpret_command') throw new ContractError('not a command');
      const origin = approvedOrigin(request.url);
      const session = await ManagedObservationSession.launch(request.url, {
        allowedOrigins: [origin], headless: this.#headless,
      });
      active.session = session;
      if (active.cancelled) return;
      this.#send(request.requestId, 'observing');
      const observed = await session.observe();
      if (active.cancelled) return;
      const matching = observed.controls.filter(control => control.editable
        && control.enabled && control.label === request.fieldLabel);
      if (matching.length !== 1 || !observed.coverage.complete) {
        this.#send(request.requestId, 'unsupported');
        return;
      }
      const registry = new TaskAdmissionRegistry(revision, input);
      const admission = registry.admit(route.input, {
        admissionId: randomUUID(), goal: route.input.text,
        outcomeKind: 'FILL', scopeRef: session.scopeRef,
        completionVerifierRef: 'managed-field-v1',
        policyRevision: 'managed-policy-v1', approvedEffects: ['READ', 'LOCAL_EDIT'],
        parameters: [{ parameterRef: 'fill-value',
          sourceRef: request.requestId, valueDigest: digest(request.value) }],
      });
      if (active.cancelled) return;
      const task = new ManagedFillTask(this.#journal, registry, admission,
        session, observed, matching[0]!.id, request.value, 'fill-value');
      active.task = task;
      if (active.cancelled) { await task.stop(); return; }
      this.#send(request.requestId, 'dispatching');
      const attempt = await task.execute(task.issuePermit());
      if (active.cancelled) return;
      if (attempt.outcome?.verification === 'matched'
        && this.#journal.getTaskState(request.requestId) === 'completed') {
        active.keepOpen = true;
        this.#send(request.requestId, 'verified_dom_fill');
      } else { this.#send(request.requestId, 'uncertain'); }
    } catch (error) {
      if (error instanceof ManagedLaunchFailure) {
        active.launchFenceUnconfirmed = true;
        this.#workerFenceFailed = true;
      }
      if (!active.cancelled) this.#send(request.requestId, 'error');
      await active.task?.stop().catch(() => {});
    } finally {
      if (!active.keepOpen || active.cancelled) {
        try {
          await active.session?.close();
          active.browserFenced = !active.launchFenceUnconfirmed;
        } catch { this.#workerFenceFailed = true; }
      }
    }
  }

  async #stop(request: Stop): Promise<void> {
    const active = this.#active;
    if (!active || active.requestId !== request.targetRequestId) {
      this.#send(request.requestId, active ? 'error'
        : this.#workerFenceFailed || this.#journal.unresolvedAttempts().length
          ? 'uncertain' : 'stopped');
      return;
    }
    active.cancelled = true;
    this.#send(request.requestId, 'stopping');
    const result = await active.task?.stop().catch(() => undefined);
    if (result) active.browserFenced = result.browserFenced;
    await active.done;
    if (active.session && !active.browserFenced) {
      try { await active.session.close(); active.browserFenced = true; }
      catch { this.#workerFenceFailed = true; }
    }
    if (!active.browserFenced) this.#workerFenceFailed = true;
    if (this.#active === active) this.#active = undefined;
    this.#send(request.requestId,
      active.browserFenced ? 'stopped' : 'uncertain');
    this.#send(active.requestId,
      this.#workerFenceFailed || this.#journal.unresolvedAttempts().length
        ? 'blocked_recovery' : 'ready');
  }
}

async function main(): Promise<void> {
  process.umask(0o077);
  const journalPath = process.argv[2];
  if (!journalPath || !isAbsolute(journalPath)) throw new Error('absolute journal path required');
  mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
  const journal = new AttemptJournal(journalPath);
  const write = (requestId: string, phase: Phase) => {
    process.stdout.write(`${JSON.stringify({ type: 'status', requestId, phase })}\n`);
  };
  const controller = new NativeManagedController(journal, write,
    process.env.SYSTEMONE_MANAGED_HEADLESS === '1');
  write('startup', 'ready');
  let pending = Buffer.alloc(0);
  process.stdin.on('data', chunk => {
    const incoming = Buffer.from(chunk);
    if (pending.length + incoming.length > MAX_LINE_BYTES * 2) {
      write('invalid', 'error');
      process.stdin.destroy();
      return;
    }
    pending = Buffer.concat([pending, incoming]);
    while (true) {
      const index = pending.indexOf(10);
      if (index < 0) break;
      const line = pending.subarray(0, index);
      pending = Buffer.from(pending.subarray(index + 1));
      controller.receive(line);
    }
  });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void controller.close().catch(() => { process.exitCode = 1; });
  };
  process.stdin.on('end', close);
  process.stdin.on('close', close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.exitCode = 1; });
}
