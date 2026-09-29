import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ManagedFillTask } from '../../browser/src/managed-fill-task.ts';
import { ManagedNavigateTask } from '../../browser/src/managed-navigate-task.ts';
import { ManagedPortalLaunchFailure, ManagedPortalSession } from '../../browser/src/managed-portal.ts';
import { ScriptedPortalStore, ScriptedPortalTask } from '../../browser/src/scripted-portal-task.ts';
import { ManagedLaunchFailure, ManagedObservationSession } from '../../browser/src/managed-observation.ts';
import { ContractError, digest, parseJSON } from '../../protocol/src/json.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { CommittedInputSession } from './committed-input.ts';
import { bindCommandValue } from './command-value-span.ts';
import { parseScopedManagedFill } from './scoped-native-command.ts';
import { AttemptJournal } from './attempt-journal.ts';
import { TaskAdmissionRegistry } from './task-authority.ts';
import { NativeFillAuthority } from './native-fill-authority.ts';
import { NativePressAuthority } from './native-press-authority.ts';
import { NativeFieldPipeWorker } from './native-field-pipe-worker.ts';
import { ChromeReadSession } from './chrome-read-session.ts';
import { ChromeFillAuthority } from './chrome-fill-authority.ts';
import { ExclusiveTaskSlot } from './exclusive-task-slot.ts';
import { buildActionCandidates, fromManagedObservation,
  selectBoundCandidate } from './action-candidates.ts';
import type { JSONValue } from '../../protocol/src/json.ts';

const MAX_LINE_BYTES = 65_536;
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

interface StartNavigate {
  readonly type: 'start_navigate';
  readonly requestId: string;
  readonly url: string;
  readonly linkLabel: string;
  readonly destinationUrl: string;
  readonly command: Record<string, JSONValue>;
}

interface Stop {
  readonly type: 'stop';
  readonly requestId: string;
  readonly targetRequestId: string;
}

interface StartNativeFill {
  readonly type: 'start_native_fill';
  readonly requestId: string;
  readonly bundleId: string;
  readonly targetPid?: number;
  readonly targetLaunchMillis?: number;
  readonly fieldLabel: string;
  readonly value: string;
  readonly command: Record<string, JSONValue>;
}

interface StartNativePress {
  readonly type: 'start_native_press';
  readonly requestId: string;
  readonly bundleId: string;
  readonly folderName: string;
  readonly expectedWindowTitle: string;
  readonly command: Record<string, JSONValue>;
}

interface StartNativeLocate {
  readonly type: 'start_native_locate';
  readonly requestId: string;
  readonly bundleId: string;
  readonly folderName: string;
  readonly fileName: string;
  readonly expectedWindowTitle: string;
  readonly command: Record<string, JSONValue>;
}

interface StartNativeOpen {
  readonly type: 'start_native_open';
  readonly requestId: string;
  readonly bundleId: string;
  readonly folderName: string;
  readonly fileName: string;
  readonly expectedWindowTitle: string;
  readonly command: Record<string, JSONValue>;
}

interface StartChromeFill {
  readonly type: 'start_chrome_fill';
  readonly requestId: string;
  readonly connectionId: string;
  readonly grantId: string;
  readonly fieldLabel: string;
  readonly value: string;
  readonly command: Record<string, JSONValue>;
}

interface StartPortalWorkflow {
  readonly type: 'start_portal_workflow';
  readonly requestId: string;
  readonly url: string;
  readonly command: Record<string, JSONValue>;
}

type NativeRequest = StartFill | StartNavigate | StartNativeFill | StartNativePress
  | StartNativeLocate | StartNativeOpen
  | StartChromeFill | StartPortalWorkflow | Stop;
type Phase = 'ready' | 'starting' | 'observing' | 'dispatching'
  | 'verified_dom_fill' | 'unsupported' | 'uncertain' | 'stopping'
  | 'stopped' | 'busy' | 'error' | 'blocked_recovery'
  | 'observing_native' | 'verified_native_fill' | 'already_matched'
  | 'observing_native_navigation' | 'verified_native_navigation'
  | 'observing_native_locate' | 'verified_native_locate'
  | 'observing_native_open' | 'verified_native_open'
  | 'observing_chrome' | 'verified_chrome_dom_fill' | 'verified_navigation'
  | 'portal_located' | 'portal_opened' | 'portal_downloaded'
  | 'verified_portal_download' | 'portal_paused';

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
  if (value.type === 'start_portal_workflow') {
    if (Object.keys(value).sort().join(',') !== 'command,requestId,type,url'
      || typeof value.url !== 'string' || value.url.length > 200
      || value.command === undefined || !isRecord(value.command)) {
      throw new ContractError('invalid fixture workflow request');
    }
    return { type: 'start_portal_workflow', requestId: value.requestId as string,
      url: value.url, command: value.command };
  }
  if (value.type === 'start_native_fill') {
    const keys = Object.keys(value).sort().join(',');
    const scoped = keys
      === 'bundleId,command,fieldLabel,requestId,targetLaunchMillis,targetPid,type,value';
    if (keys !== 'bundleId,command,fieldLabel,requestId,type,value'
        && !scoped
      || typeof value.bundleId !== 'string'
      || !/^[A-Za-z0-9.-]{3,160}$/.test(value.bundleId)
      || typeof value.fieldLabel !== 'string' || value.fieldLabel.length < 1
      || value.fieldLabel.length > 160 || !value.fieldLabel.isWellFormed()
      || typeof value.value !== 'string' || !value.value.isWellFormed()
      || Buffer.byteLength(value.value, 'utf8') > MAX_VALUE_BYTES
      || (scoped && (!Number.isSafeInteger(value.targetPid)
        || !Number.isSafeInteger(value.targetLaunchMillis)
        || (value.targetPid as number) <= 0
        || (value.targetLaunchMillis as number) <= 0))
      || value.command === undefined || !isRecord(value.command)) {
      throw new ContractError('invalid native field request');
    }
    return { type: 'start_native_fill', requestId: value.requestId as string,
      bundleId: value.bundleId, fieldLabel: value.fieldLabel,
      value: value.value, command: value.command,
      ...(scoped ? { targetPid: value.targetPid as number,
        targetLaunchMillis: value.targetLaunchMillis as number } : {}) };
  }
  if (value.type === 'start_native_press') {
    if (Object.keys(value).sort().join(',')
        !== 'bundleId,command,expectedWindowTitle,folderName,requestId,type'
      || value.bundleId !== 'com.aurium.systemone.fixture'
      || value.folderName !== 'Documents'
      || value.expectedWindowTitle !== 'SystemOne Fixture — Documents'
      || value.command === undefined || !isRecord(value.command)) {
      throw new ContractError('invalid native press request');
    }
    return { type: 'start_native_press', requestId: value.requestId as string,
      bundleId: value.bundleId, folderName: value.folderName,
      expectedWindowTitle: value.expectedWindowTitle, command: value.command };
  }
  if (value.type === 'start_native_locate') {
    if (Object.keys(value).sort().join(',')
        !== 'bundleId,command,expectedWindowTitle,fileName,folderName,requestId,type'
      || value.bundleId !== 'com.aurium.systemone.fixture'
      || value.folderName !== 'Documents' || value.fileName !== 'Budget.xlsx'
      || value.expectedWindowTitle
        !== 'SystemOne Fixture — Documents — Budget.xlsx selected'
      || value.command === undefined || !isRecord(value.command)) {
      throw new ContractError('invalid native locate request');
    }
    return { type: 'start_native_locate', requestId: value.requestId as string,
      bundleId: value.bundleId, folderName: value.folderName,
      fileName: value.fileName, expectedWindowTitle: value.expectedWindowTitle,
      command: value.command };
  }
  if (value.type === 'start_native_open') {
    if (Object.keys(value).sort().join(',')
        !== 'bundleId,command,expectedWindowTitle,fileName,folderName,requestId,type'
      || value.bundleId !== 'com.aurium.systemone.fixture'
      || value.folderName !== 'Documents' || value.fileName !== 'Budget.xlsx'
      || value.expectedWindowTitle
        !== 'SystemOne Fixture — Documents — Budget.xlsx opened'
      || value.command === undefined || !isRecord(value.command)) {
      throw new ContractError('invalid native open request');
    }
    return { type: 'start_native_open', requestId: value.requestId as string,
      bundleId: value.bundleId, folderName: value.folderName,
      fileName: value.fileName, expectedWindowTitle: value.expectedWindowTitle,
      command: value.command };
  }
  if (value.type === 'start_chrome_fill') {
    if (Object.keys(value).sort().join(',')
        !== 'command,connectionId,fieldLabel,grantId,requestId,type,value'
      || typeof value.connectionId !== 'string' || !ID.test(value.connectionId)
      || typeof value.grantId !== 'string' || !ID.test(value.grantId)
      || typeof value.fieldLabel !== 'string' || value.fieldLabel.length < 1
      || value.fieldLabel.length > 160 || !value.fieldLabel.isWellFormed()
      || typeof value.value !== 'string' || !value.value.isWellFormed()
      || Buffer.byteLength(value.value, 'utf8') > MAX_VALUE_BYTES
      || value.command === undefined || !isRecord(value.command)) {
      throw new ContractError('invalid Chrome field request');
    }
    return { type: 'start_chrome_fill', requestId: value.requestId as string,
      connectionId: value.connectionId, grantId: value.grantId,
      fieldLabel: value.fieldLabel, value: value.value, command: value.command };
  }
  if (value.type === 'start_navigate') {
    if (Object.keys(value).sort().join(',')
        !== 'command,destinationUrl,linkLabel,requestId,type,url'
      || typeof value.url !== 'string' || value.url.length > 2_048
      || typeof value.destinationUrl !== 'string'
      || value.destinationUrl.length > 2_048
      || typeof value.linkLabel !== 'string' || value.linkLabel.length < 1
      || value.linkLabel.length > 160 || !value.linkLabel.isWellFormed()
      || value.command === undefined || !isRecord(value.command)) {
      throw new ContractError('invalid managed navigation request');
    }
    return { type: 'start_navigate', requestId: value.requestId as string,
      url: value.url, destinationUrl: value.destinationUrl,
      linkLabel: value.linkLabel, command: value.command };
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
  session?: ManagedObservationSession | ManagedPortalSession;
  task?: ManagedFillTask | ManagedNavigateTask | ScriptedPortalTask;
  browserFenced: boolean;
  done: Promise<void>;
}

interface NativeActiveTask {
  readonly requestId: string;
  readonly authority: NativeFillAuthority | NativePressAuthority;
  done: Promise<void>;
}

interface ChromeActiveTask {
  readonly requestId: string;
  readonly authority: ChromeFillAuthority;
  done: Promise<void>;
}

type ControllerRun = { readonly requestId: string; readonly surface: 'managed';
  readonly task: ActiveTask }
  | { readonly requestId: string; readonly surface: 'native';
    readonly task: NativeActiveTask }
  | { readonly requestId: string; readonly surface: 'chrome';
    readonly task: ChromeActiveTask };

/** Development pipe integration for the planned Node controller topology.
 * The native parent owns this private inherited pipe; this process never
 * listens on a network port or accepts model-originated execution requests. */
export class NativeManagedController {
  readonly #journal: AttemptJournal;
  readonly #portalStore: ScriptedPortalStore | undefined;
  readonly #send: (requestId: string, phase: Phase) => void;
  readonly #headless: boolean;
  readonly #nativeWorker: NativeFieldPipeWorker | undefined;
  readonly #nativeAuthority: NativeFillAuthority | undefined;
  readonly #pressAuthority: NativePressAuthority | undefined;
  readonly #chromeOutput: ((value: Record<string, JSONValue>) => void) | undefined;
  readonly #chromeSessions = new Map<string, ChromeReadSession>();
  readonly #chromeAuthorities = new Map<string, ChromeFillAuthority>();
  readonly #seen = new Set<string>();
  readonly #runs = new ExclusiveTaskSlot<ControllerRun>();
  #workerFenceFailed = false;

  constructor(journal: AttemptJournal, send: (requestId: string, phase: Phase) => void,
    headless = false, nativeWorker?: NativeFieldPipeWorker,
    chromeOutput?: (value: Record<string, JSONValue>) => void,
    portalStore?: ScriptedPortalStore) {
    this.#journal = journal;
    this.#portalStore = portalStore;
    this.#send = send;
    this.#headless = headless;
    this.#nativeWorker = nativeWorker;
    this.#chromeOutput = chromeOutput;
    this.#nativeAuthority = nativeWorker
      ? new NativeFillAuthority(journal, nativeWorker) : undefined;
    this.#pressAuthority = nativeWorker
      ? new NativePressAuthority(journal, nativeWorker) : undefined;
    journal.recoverAfterRestart();
    portalStore?.recoverAfterRestart();
  }

  startupPhase(): Phase {
    return this.#journal.unresolvedAttempts().length
      || this.#portalStore?.hasBlockingTask() ? 'blocked_recovery' : 'ready';
  }

  #adapterSettled(run: ControllerRun,
    authority: NativeFillAuthority | NativePressAuthority | ChromeFillAuthority): void {
    if (this.#runs.release(run)) this.#send(run.requestId,
      this.#workerFenceFailed || authority.needsRecovery
        || this.#journal.unresolvedAttempts().length ? 'blocked_recovery' : 'ready');
  }

  #adapterStopFinished(run: ControllerRun,
    authority: NativeFillAuthority | NativePressAuthority | ChromeFillAuthority): void {
    if (this.#runs.finishStop(run)) this.#send(run.requestId,
      this.#workerFenceFailed || authority.needsRecovery
        || this.#journal.unresolvedAttempts().length ? 'blocked_recovery' : 'ready');
  }

  receive(line: Uint8Array): void {
    let request: NativeRequest;
    try {
      if (line.byteLength > MAX_LINE_BYTES) throw new ContractError('native request too large');
      const parsed = parseJSON(line);
      if (this.#nativeWorker?.receive(parsed)) return;
      if (isRecord(parsed) && typeof parsed.type === 'string'
        && parsed.type.startsWith('chrome_port_')) {
        this.#receiveChrome(parsed);
        return;
      }
      request = requestFromLine(line);
    }
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
    if (this.#runs.active) {
      this.#send(request.requestId, 'busy'); return;
    }
    if (this.#workerFenceFailed || this.#nativeAuthority?.needsRecovery
      || this.#pressAuthority?.needsRecovery
      || [...this.#chromeAuthorities.values()].some(x => x.needsRecovery)
      || this.#journal.unresolvedAttempts().length
      || this.#portalStore?.hasBlockingTask()) {
      this.#send(request.requestId, 'blocked_recovery');
      return;
    }
    if (request.type === 'start_native_fill') {
      const authority = this.#nativeAuthority;
      if (!authority) { this.#send(request.requestId, 'error'); return; }
      this.#send(request.requestId, 'observing_native');
      const active = { requestId: request.requestId, authority,
        done: Promise.resolve() };
      const run: ControllerRun = { requestId: request.requestId,
        surface: 'native', task: active };
      this.#runs.claim(run);
      active.done = authority.start(request).then(result => {
        const phase: Phase = result === 'verified' ? 'verified_native_fill'
          : result === 'already_matched' ? 'already_matched'
            : result === 'unsupported' ? 'unsupported'
              : result === 'uncertain' ? 'uncertain'
                : result === 'stopped' ? 'stopped' : 'error';
        if (result !== 'stopped') this.#send(request.requestId, phase);
      }).catch(() => {
        this.#send(request.requestId, 'uncertain');
      }).finally(() => {
        this.#adapterSettled(run, authority);
      });
      return;
    }
    if (request.type === 'start_native_press'
      || request.type === 'start_native_locate'
      || request.type === 'start_native_open') {
      const authority = this.#pressAuthority;
      if (!authority) { this.#send(request.requestId, 'error'); return; }
      this.#send(request.requestId, request.type === 'start_native_open'
        ? 'observing_native_open' : request.type === 'start_native_locate'
          ? 'observing_native_locate' : 'observing_native_navigation');
      const active = { requestId: request.requestId, authority,
        done: Promise.resolve() };
      const run: ControllerRun = { requestId: request.requestId,
        surface: 'native', task: active };
      this.#runs.claim(run);
      active.done = (request.type === 'start_native_open'
        ? authority.startOpen(request) : request.type === 'start_native_locate'
          ? authority.startLocate(request) : authority.start(request)).then(result => {
        const phase: Phase = result === 'verified_navigation'
          ? 'verified_native_navigation'
          : result === 'verified_locate' ? 'verified_native_locate'
            : result === 'verified_open' ? 'verified_native_open'
          : result === 'already_matched' ? 'already_matched'
            : result === 'unsupported' ? 'unsupported'
              : result === 'uncertain' ? 'uncertain'
                : result === 'stopped' ? 'stopped' : 'error';
        if (result !== 'stopped') this.#send(request.requestId, phase);
      }).catch(() => { this.#send(request.requestId, 'uncertain'); })
        .finally(() => {
          this.#adapterSettled(run, authority);
        });
      return;
    }
    if (request.type === 'start_chrome_fill') {
      const authority = this.#chromeAuthorities.get(request.connectionId);
      if (!authority) { this.#send(request.requestId, 'error'); return; }
      this.#send(request.requestId, 'observing_chrome');
      const active = { requestId: request.requestId, authority,
        done: Promise.resolve() };
      const run: ControllerRun = { requestId: request.requestId,
        surface: 'chrome', task: active };
      this.#runs.claim(run);
      active.done = authority.start(request).then(result => {
        const phase: Phase = result === 'verified' ? 'verified_chrome_dom_fill'
          : result === 'already_matched' ? 'already_matched'
            : result === 'unsupported' ? 'unsupported'
              : result === 'uncertain' ? 'uncertain'
                : result === 'stopped' ? 'stopped' : 'error';
        if (result !== 'stopped') this.#send(request.requestId, phase);
      }).catch(() => { this.#send(request.requestId, 'uncertain'); })
        .finally(() => {
          this.#adapterSettled(run, authority);
        });
      return;
    }
    const active: ActiveTask = { requestId: request.requestId,
      cancelled: false, keepOpen: false, launchFenceUnconfirmed: false,
      browserFenced: false, done: Promise.resolve() };
    const run: ControllerRun = { requestId: request.requestId,
      surface: 'managed', task: active };
    this.#runs.claim(run);
    this.#send(request.requestId, 'starting');
    active.done = (request.type === 'start_navigate'
      ? this.#runNavigate(request, active)
      : request.type === 'start_portal_workflow'
        ? this.#runPortal(request, active) : this.#run(request, active)).finally(() => {
      if (!active.keepOpen && !active.cancelled && this.#runs.release(run)) {
        this.#send(request.requestId,
          this.#workerFenceFailed || this.#journal.unresolvedAttempts().length
            || this.#portalStore?.hasBlockingTask()
            ? 'blocked_recovery' : 'ready');
      }
    });
  }

  async close(): Promise<void> {
    const run = this.#runs.active;
    if (run?.surface === 'chrome') {
      await run.task.authority.stop().catch(() => {});
      await run.task.done.catch(() => {});
    }
    for (const session of this.#chromeSessions.values()) session.close();
    this.#chromeSessions.clear();
    this.#chromeAuthorities.clear();
    if (run?.surface === 'native') {
      await run.task.authority.stop().catch(() => {});
      await run.task.done.catch(() => {});
    }
    this.#nativeWorker?.close();
    const active = run?.surface === 'managed' ? run.task : undefined;
    if (active) {
      active.cancelled = true;
      const result = await active.task?.stop().catch(() => undefined);
      if (result) active.browserFenced = result.browserFenced;
      await active.done;
      if (active.session && !active.browserFenced) {
        try { await active.session.close(); active.browserFenced = true; }
        catch { this.#workerFenceFailed = true; }
      }
      this.#runs.release(run!);
    }
    this.#journal.close();
    this.#portalStore?.close();
  }

  #receiveChrome(message: Record<string, JSONValue>): void {
    const output = this.#chromeOutput;
    const connectionId = message.connectionId;
    if (!output || typeof connectionId !== 'string' || !ID.test(connectionId)) {
      throw new ContractError('invalid Chrome controller connection');
    }
    try {
      if (message.type === 'chrome_port_open') {
        if (Object.keys(message).sort().join(',')
            !== 'connectionId,extensionId,type'
          || typeof message.extensionId !== 'string'
          || this.#chromeSessions.has(connectionId)
          || this.#chromeSessions.size >= 1) {
          throw new ContractError('Chrome controller port already active');
        }
        const session = new ChromeReadSession(message.extensionId,
          payload => output({ type: 'chrome_port_send', connectionId, payload }),
          (binding, snapshot) => output({ type: 'chrome_observation',
            connectionId, grantId: binding.grantId,
            origin: binding.origin, url: binding.url,
            title: snapshot.title, elements: snapshot.elements.map(item => ({ ...item })) }));
        this.#chromeSessions.set(connectionId, session);
        this.#chromeAuthorities.set(connectionId,
          new ChromeFillAuthority(this.#journal, session));
        return;
      }
      const session = this.#chromeSessions.get(connectionId);
      if (!session) throw new ContractError('Chrome controller port absent');
      if (message.type === 'chrome_port_closed') {
        if (Object.keys(message).sort().join(',') !== 'connectionId,type') {
          throw new ContractError('invalid Chrome close');
        }
        session.close();
        this.#chromeSessions.delete(connectionId);
        this.#chromeAuthorities.delete(connectionId);
        return;
      }
      if (message.type !== 'chrome_port_message'
        || Object.keys(message).sort().join(',') !== 'base64,connectionId,type'
        || typeof message.base64 !== 'string'
        || message.base64.length > 43_700
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.base64)) {
        throw new ContractError('invalid Chrome port message');
      }
      const bytes = Buffer.from(message.base64, 'base64');
      if (bytes.length === 0 || bytes.length > 32_768
        || bytes.toString('base64') !== message.base64) {
        throw new ContractError('invalid Chrome port frame');
      }
      session.receive(parseJSON(bytes));
    } catch {
      this.#chromeSessions.get(connectionId)?.close();
      this.#chromeSessions.delete(connectionId);
      this.#chromeAuthorities.delete(connectionId);
      output({ type: 'chrome_port_close', connectionId });
    }
  }

  async #run(request: StartFill, active: ActiveTask): Promise<void> {
    try {
      const command = request.command;
      const canonicalPrefix = `Fill ${request.fieldLabel} on ${request.url} with text: `;
      const scoped = typeof command.text === 'string'
        && !command.text.startsWith(canonicalPrefix)
        ? parseScopedManagedFill(command.text) : undefined;
      const valuePrefix = scoped?.prefix ?? canonicalPrefix;
      if (command.type !== 'command'
        || (command.source !== 'text' && command.source !== 'voice')
        || command.mode !== 'command' || command.isFinal !== true
        || command.taskId !== request.requestId || command.taskEpoch !== 1
        || command.goalRevision !== 1
        || (scoped !== undefined
          ? scoped.fieldLabel !== request.fieldLabel || scoped.url !== request.url
            || scoped.value !== request.value
          : command.text !== canonicalPrefix + request.value)
        || command.originSurface === undefined || !isRecord(command.originSurface)
        || command.originSurface.appBundleId !== 'com.aurium.systemone.dev') {
        throw new ContractError('native command binding changed');
      }
      const revision = { taskId: request.requestId, taskEpoch: 1, goalRevision: 1 };
      const endpoint = bindEndpoint(['command']);
      const input = new CommittedInputSession(endpoint, revision);
      const route = input.accept(endpoint, Buffer.from(JSON.stringify(command)));
      if (route.kind !== 'interpret_command') throw new ContractError('not a command');
      const fillParameter = bindCommandValue(route.input, 'fill-value',
        valuePrefix, request.value);
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
      const offered = buildActionCandidates({
        source: fromManagedObservation(observed),
        text: { textRef: 'fill-value', source: 'final_command',
          allowedTargetRefs: matching.map(control => control.id) },
        policyRevision: 'managed-policy-v1',
      });
      if (matching.length !== 1 || !selectBoundCandidate(offered, 'set_value',
        matching.map(control => control.id))) {
        this.#send(request.requestId, 'unsupported');
        return;
      }
      const registry = new TaskAdmissionRegistry(revision, input);
      const admission = registry.admit(route.input, {
        admissionId: randomUUID(), goal: route.input.text,
        outcomeKind: 'FILL', scopeRef: session.scopeRef,
        completionVerifierRef: 'managed-field-v1',
        // A page's input/change handler can issue network requests even when
        // the requested DOM operation is only a field fill.
        policyRevision: 'managed-policy-v1',
        approvedEffects: ['READ', 'LOCAL_EDIT', 'EXTERNAL_WRITE'],
        parameters: [fillParameter],
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
        if (active.task && this.#journal.getTaskState(request.requestId) === 'active') {
          const fence = await active.task.stop().catch(() => undefined);
          if (!fence?.browserFenced) this.#workerFenceFailed = true;
        }
        try {
          await active.session?.close();
          active.browserFenced = !active.launchFenceUnconfirmed;
        } catch { this.#workerFenceFailed = true; }
      }
    }
  }

  async #runNavigate(request: StartNavigate, active: ActiveTask): Promise<void> {
    try {
      const command = request.command;
      if (command.type !== 'command' || command.source !== 'text'
        || command.mode !== 'command' || command.isFinal !== true
        || command.taskId !== request.requestId || command.taskEpoch !== 1
        || command.goalRevision !== 1
        || command.text !== `Navigate via ${request.linkLabel} on ${request.url} to ${request.destinationUrl}`
        || command.originSurface === undefined || !isRecord(command.originSurface)
        || command.originSurface.appBundleId !== 'com.aurium.systemone.dev') {
        throw new ContractError('native navigation command binding changed');
      }
      const origin = approvedOrigin(request.url);
      const destinationOrigin = approvedOrigin(request.destinationUrl);
      const destination = new URL(request.destinationUrl);
      if (destinationOrigin !== origin || destination.href !== request.destinationUrl
        || destination.hash) throw new ContractError('navigation destination outside exact scope');
      const revision = { taskId: request.requestId, taskEpoch: 1, goalRevision: 1 };
      const endpoint = bindEndpoint(['command']);
      const input = new CommittedInputSession(endpoint, revision);
      const route = input.accept(endpoint, Buffer.from(JSON.stringify(command)));
      if (route.kind !== 'interpret_command') throw new ContractError('not a command');
      const destinationParameter = bindCommandValue(route.input, 'destination',
        `Navigate via ${request.linkLabel} on ${request.url} to `,
        request.destinationUrl);
      const session = await ManagedObservationSession.launch(request.url, {
        allowedOrigins: [origin], headless: this.#headless,
      });
      active.session = session;
      if (active.cancelled) return;
      this.#send(request.requestId, 'observing');
      const observed = await session.observe();
      if (active.cancelled) return;
      const matching = observed.controls.filter(control => control.enabled
        && control.label === request.linkLabel
        && control.destinationUrl === request.destinationUrl
        && control.destinationUrl !== observed.url);
      const offered = buildActionCandidates({
        source: fromManagedObservation(observed),
        destinations: [{ urlRef: 'destination',
          exactUrl: request.destinationUrl }],
        policyRevision: 'managed-policy-v1',
      });
      if (matching.length !== 1 || !selectBoundCandidate(offered, 'navigate',
        matching.map(control => control.id))) {
        this.#send(request.requestId, 'unsupported');
        return;
      }
      const registry = new TaskAdmissionRegistry(revision, input);
      const admission = registry.admit(route.input, {
        admissionId: randomUUID(), goal: route.input.text,
        outcomeKind: 'NAVIGATE', scopeRef: session.scopeRef,
        completionVerifierRef: 'managed-url-v1',
        policyRevision: 'managed-policy-v1', approvedEffects: ['READ', 'NAVIGATE'],
        parameters: [destinationParameter],
      });
      if (active.cancelled) return;
      const task = new ManagedNavigateTask(this.#journal, registry, admission,
        session, observed, matching[0]!.id, request.destinationUrl, 'destination');
      active.task = task;
      if (active.cancelled) { await task.stop(); return; }
      this.#send(request.requestId, 'dispatching');
      const attempt = await task.execute(task.issuePermit());
      if (active.cancelled) return;
      if (attempt.outcome?.verification === 'matched'
        && this.#journal.getTaskState(request.requestId) === 'completed') {
        active.keepOpen = true;
        this.#send(request.requestId, 'verified_navigation');
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
        if (active.task && this.#journal.getTaskState(request.requestId) === 'active') {
          const fence = await active.task.stop().catch(() => undefined);
          if (!fence?.browserFenced) this.#workerFenceFailed = true;
        }
        try {
          await active.session?.close();
          active.browserFenced = !active.launchFenceUnconfirmed;
        } catch { this.#workerFenceFailed = true; }
      }
    }
  }

  async #runPortal(request: StartPortalWorkflow, active: ActiveTask): Promise<void> {
    const store = this.#portalStore;
    if (!store) { this.#send(request.requestId, 'unsupported'); return; }
    try {
      const url = new URL(request.url);
      if (url.href !== request.url || url.protocol !== 'http:'
        || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/'
        || url.search || url.hash || url.username || url.password) {
        throw new ContractError('fixture workflow requires exact loopback root');
      }
      const command = request.command;
      if (command.type !== 'command' || command.source !== 'text'
        || command.mode !== 'command' || command.isFinal !== true
        || command.taskId !== request.requestId || command.taskEpoch !== 1
        || command.goalRevision !== 1
        || command.text !== `Download fixture invoice INV-105 from ${request.url}`
        || command.originSurface === undefined || !isRecord(command.originSurface)
        || command.originSurface.appBundleId !== 'com.aurium.systemone.dev') {
        throw new ContractError('fixture workflow command binding changed');
      }
      const destinationPath = store.fixtureDestination('INV-105');
      if (existsSync(destinationPath)) {
        this.#send(request.requestId, 'unsupported');
        return;
      }
      const revision = { taskId: request.requestId, taskEpoch: 1, goalRevision: 1 };
      const endpoint = bindEndpoint(['command']);
      const input = new CommittedInputSession(endpoint, revision);
      const route = input.accept(endpoint, Buffer.from(JSON.stringify(command)));
      if (route.kind !== 'interpret_command') throw new ContractError('not a command');
      const registry = new TaskAdmissionRegistry(revision, input);
      const contract = { taskId: request.requestId, origin: url.origin,
        outcomeKind: 'DOWNLOAD' as const, invoiceId: 'INV-105',
        title: 'April Service Statement', account: 'Harbor Works',
        query: 'April', destinationPath };
      const admission = registry.admit(route.input, {
        admissionId: randomUUID(), goal: route.input.text,
        outcomeKind: 'DOWNLOAD', scopeRef: 'synthetic-portal-only',
        completionVerifierRef: 'portal-download-v1',
        policyRevision: 'portal-policy-1',
        approvedEffects: ['READ', 'NAVIGATE', 'DOWNLOAD', 'LOCAL_EDIT'],
        parameters: [
          { parameterRef: 'origin', sourceRef: route.input.messageId,
            valueDigest: digest(contract.origin) },
          ...(['invoiceId', 'title', 'account', 'query'] as const).map(parameterRef => ({
            parameterRef, sourceRef: 'fixture-config',
            valueDigest: digest(contract[parameterRef]) })),
          { parameterRef: 'destinationPath', sourceRef: 'fixture-output',
            valueDigest: digest(destinationPath) },
        ],
      });
      const session = await ManagedPortalSession.launch(request.url,
        { headless: this.#headless });
      active.session = session;
      if (active.cancelled) return;
      const started = store.start(registry, admission, contract);
      const task = new ScriptedPortalTask(store, this.#journal, session,
        admission, started);
      active.task = task;
      while (!active.cancelled) {
        const record = await task.advance();
        if (active.cancelled) return;
        if (record.state === 'completed') {
          this.#send(request.requestId, 'verified_portal_download');
          return;
        }
        if (record.state !== 'active') {
          this.#send(request.requestId, 'portal_paused');
          return;
        }
        this.#send(request.requestId, record.stage === 'located' ? 'portal_located'
          : record.stage === 'opened' ? 'portal_opened' : 'portal_downloaded');
      }
    } catch (error) {
      if (error instanceof ManagedPortalLaunchFailure && !error.workerFenced) {
        active.launchFenceUnconfirmed = true;
        this.#workerFenceFailed = true;
      }
      if (!active.cancelled) {
        if (store.get(request.requestId)?.state === 'active') {
          store.pause(request.requestId, 'controller workflow outcome uncertain');
          this.#send(request.requestId, 'portal_paused');
        } else this.#send(request.requestId, 'error');
      }
    } finally {
      try {
        await active.session?.close();
        active.browserFenced = !active.launchFenceUnconfirmed;
      } catch { this.#workerFenceFailed = true; }
    }
  }

  async #stop(request: Stop): Promise<void> {
    const run = this.#runs.active;
    const chromeActive = run?.surface === 'chrome' ? run.task : undefined;
    if (chromeActive?.requestId === request.targetRequestId) {
      if (!this.#runs.beginStop(run!)) {
        this.#send(request.requestId, 'uncertain'); return;
      }
      this.#send(request.requestId, 'stopping');
      const fenced = await chromeActive.authority.stop().catch(() => false);
      // The extension Stop acknowledgement is the barrier. A delayed action
      // receipt may still settle history, but cannot delay user feedback or
      // authorize another task while the active slot remains occupied.
      if (!fenced) this.#workerFenceFailed = true;
      this.#send(request.requestId,
        fenced && !chromeActive.authority.needsRecovery ? 'stopped' : 'uncertain');
      this.#adapterStopFinished(run!, chromeActive.authority);
      return;
    }
    const nativeActive = run?.surface === 'native' ? run.task : undefined;
    if (nativeActive?.requestId === request.targetRequestId) {
      if (!this.#runs.beginStop(run!)) {
        this.#send(request.requestId, 'uncertain'); return;
      }
      this.#send(request.requestId, 'stopping');
      const result = await nativeActive.authority.stop().catch(() => ({
        workerFenced: false, unresolvedExecutionIds: [] as readonly string[],
      }));
      // Worker Stop fences the setter independently of its pending commit
      // receipt. Leave the task slot occupied until that receipt settles.
      if (!result.workerFenced) this.#workerFenceFailed = true;
      this.#send(request.requestId,
        result.workerFenced && !nativeActive.authority.needsRecovery
          ? 'stopped' : 'uncertain');
      this.#adapterStopFinished(run!, nativeActive.authority);
      return;
    }
    const active = run?.surface === 'managed' ? run.task : undefined;
    if (!active || active.requestId !== request.targetRequestId) {
      this.#send(request.requestId, run ? 'error'
        : this.#workerFenceFailed || this.#nativeAuthority?.needsRecovery
          || this.#pressAuthority?.needsRecovery
          || this.#journal.unresolvedAttempts().length
          ? 'uncertain' : 'stopped');
      return;
    }
    active.cancelled = true;
    this.#send(request.requestId, 'stopping');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const fence = active.task
        ? active.task.stop().then(result => active.task instanceof ScriptedPortalTask
          ? ('workerFenced' in result && result.workerFenced)
          : result.browserFenced, () => false)
        : active.session
          ? active.session.close().then(() => true, () => false)
          : Promise.resolve(false); // A browser launch is still in flight.
      active.browserFenced = await Promise.race([
        fence,
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(false), 3_000);
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
    if (!active.browserFenced) this.#workerFenceFailed = true;
    this.#send(request.requestId,
      active.browserFenced ? 'stopped' : 'uncertain');
    // Keep the task slot occupied until the old workflow actually settles.
    // Its late response cannot turn a cancelled goal into success.
    void active.done.then(() => {
      if (!this.#runs.release(run!)) return;
      this.#send(active.requestId,
        this.#workerFenceFailed || this.#journal.unresolvedAttempts().length
          ? 'blocked_recovery' : 'ready');
    });
  }
}

async function main(): Promise<void> {
  process.umask(0o077);
  const journalPath = process.argv[2];
  if (!journalPath || !isAbsolute(journalPath)) throw new Error('absolute journal path required');
  mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
  const journal = new AttemptJournal(journalPath);
  const outputRoot = join(dirname(journalPath), 'fixture-output');
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const portalStore = new ScriptedPortalStore(journalPath, outputRoot);
  const write = (requestId: string, phase: Phase) => {
    process.stdout.write(`${JSON.stringify({ type: 'status', requestId, phase })}\n`);
  };
  const worker = new NativeFieldPipeWorker(value => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  });
  const controller = new NativeManagedController(journal, write,
    process.env.SYSTEMONE_MANAGED_HEADLESS === '1', worker,
    value => { process.stdout.write(`${JSON.stringify(value)}\n`); }, portalStore);
  write('startup', controller.startupPhase());
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
