import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
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
import { NativeFillAuthority, validNativeFillRequest } from './native-fill-authority.ts';
import type { NativeFillRequest } from './native-fill-authority.ts';
import type { NativeFixtureMode } from './native-fixture-authority.ts';
import type { NativePressRequest, NativeLocateRequest } from './native-press-authority.ts';
import { NativeFixtureAuthority } from './native-fixture-authority.ts';
import type { NativeFixtureDecision } from './native-fixture-task.ts';
import type { BrowseDecision, BrowseProposal } from '../../browser/src/managed-browse-task.ts';
import { parseBrowseFollowUp, parseScopedBrowse } from './scoped-native-command.ts';
import { AgentAXClient } from './agent-ax-client.ts';
import { bindCommandSpan, installedApps, parseAgentGoal, refineGoal } from './agent-goal.ts';
import { LocalUnderstanding } from './local-understanding.ts';
import { writeTaskDataset } from './training-data.ts';
import type { AgentDecision } from './universal-agent-task.ts';
import { NativeFieldPipeWorker } from './native-field-pipe-worker.ts';
import { ChromeReadSession } from './chrome-read-session.ts';
import { ChromeFillAuthority } from './chrome-fill-authority.ts';
import { ExclusiveTaskSlot } from './exclusive-task-slot.ts';
import { PersistentTaskActor } from './persistent-task-actor.ts';
import { HostLifecycleGate } from './host-lifecycle.ts';
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
  readonly decisionProvider?: 'jev';
}

interface StartNativeLocate {
  readonly type: 'start_native_locate';
  readonly requestId: string;
  readonly bundleId: string;
  readonly folderName: string;
  readonly fileName: string;
  readonly expectedWindowTitle: string;
  readonly command: Record<string, JSONValue>;
  readonly decisionProvider?: 'jev';
}

interface StartNativeOpen {
  readonly type: 'start_native_open';
  readonly requestId: string;
  readonly bundleId: string;
  readonly folderName: string;
  readonly fileName: string;
  readonly expectedWindowTitle: string;
  readonly command: Record<string, JSONValue>;
  readonly decisionProvider?: 'jev';
}

interface StartBrowse {
  readonly type: 'start_browse';
  readonly requestId: string;
  readonly command: Record<string, JSONValue>;
  readonly decisionProvider: 'jev';
}

interface StartAgent {
  readonly type: 'start_agent';
  readonly requestId: string;
  readonly command: Record<string, JSONValue>;
  readonly decisionProvider: 'jev';
  /** Who picks the words to type: Jev (default) or the on-device model. */
  readonly understanding: 'jev' | 'local';
}

interface ContinueBrowse {
  readonly type: 'continue_browse';
  readonly requestId: string;
  readonly targetRequestId: string;
  readonly command: Record<string, JSONValue>;
  readonly decisionProvider: 'jev';
}

/** The user's verdict on a finished agent task (training label for its trace). */
interface AgentFeedback {
  readonly type: 'agent_feedback';
  readonly requestId: string;
  readonly targetRequestId: string;
  readonly value: 'good' | 'bad';
  /** For 👎: what kind of wrong (one tap), and optionally what it should have done. */
  readonly reason?: string;
  readonly note?: string;
}

const FEEDBACK_REASONS = new Set(['wrong_place', 'wrong_words', 'wrong_steps', 'stopped_early', 'too_slow', 'other']);

interface ConfirmStep {
  readonly type: 'confirm_step';
  readonly requestId: string;
  readonly targetRequestId: string;
  readonly proposalId: string;
  readonly allow: boolean;
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

interface ReplaceNativeFixture {
  readonly type: 'replace_native_fixture';
  readonly requestId: string;
  readonly targetRequestId: string;
  readonly mode: NativeFixtureMode;
  readonly replacement: NativePressRequest | NativeLocateRequest;
}
interface ReplaceNativeField {
  readonly type: 'replace_native_field';
  readonly requestId: string;
  readonly targetRequestId: string;
  readonly replacement: NativeFillRequest;
}

interface NativeRecoveryControl {
  readonly type: 'prepare_native_recovery' | 'native_recovery_presented' | 'resume_native_task' | 'cancel_native_recovery';
  readonly requestId: string;
  readonly targetRequestId: string;
  readonly uiSessionRef: string;
  readonly promptId?: string;
  readonly presentationDigest?: string;
  readonly intent?: Record<string, JSONValue>;
}

type NativeRequest = ReplaceNativeField | ReplaceNativeFixture | NativeRecoveryControl | StartFill | StartNavigate | StartNativeFill | StartNativePress
  | StartNativeLocate | StartNativeOpen
  | StartChromeFill | StartPortalWorkflow | StartBrowse | ContinueBrowse | StartAgent | ConfirmStep | AgentFeedback | Stop;
interface AgentProposalView {
  readonly step: number; readonly kind: string; readonly label: string; readonly destinationUrl: string | null;
  readonly pageUrl: string; readonly app: string; readonly risky: boolean;
}

type Phase = 'ready' | 'starting' | 'observing' | 'dispatching'
  | 'verified_dom_fill' | 'unsupported' | 'uncertain' | 'stopping'
  | 'stopped' | 'busy' | 'error' | 'blocked_recovery' | 'paused_budget'
  | 'observing_native' | 'verified_native_fill' | 'already_matched'
  | 'observing_native_navigation' | 'verified_native_navigation'
  | 'observing_native_locate' | 'verified_native_locate'
  | 'observing_native_open' | 'verified_native_open'
  | 'observing_chrome' | 'verified_chrome_dom_fill' | 'verified_navigation'
  | 'host_unavailable' | 'portal_located' | 'portal_opened' | 'portal_downloaded'
  | 'verified_portal_download' | 'portal_paused' | 'native_paused' | 'checking_native_recovery' | 'replacing_native_task'
  | 'browsing' | 'verified_browse' | 'browse_paused' | 'agent_working' | 'agent_done' | 'agent_paused' | 'agent_needs_text' | 'local_model_preparing';

/** Private per-task step traces for diagnosing and replaying failures. Only
 * written when SYSTEMONE_TRACE_DIR is set (the app's own support folder). */
type TraceWriter = ((event: Record<string, JSONValue>) => void) & { readonly path: string };

/** Keeps datasets/tasks/<task>.jsonl in step with the trace; never affects a task. */
function refreshDataset(tracePath: string): void {
  try { writeTaskDataset(tracePath, join(dirname(dirname(tracePath)), 'datasets')); }
  catch { /* Training data is best effort. */ }
}

function agentTraceWriter(taskId: string, goal: string): TraceWriter | undefined {
  const dir = process.env.SYSTEMONE_TRACE_DIR;
  if (!dir || !isAbsolute(dir)) return undefined;
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return undefined; }
  const path = join(dir, `${new Date().toISOString().replace(/[:.]/gu, '-')}-${taskId.slice(0, 8)}.jsonl`);
  const write = (value: Record<string, JSONValue>) => {
    try { appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`, { mode: 0o600 }); }
    catch { /* Tracing never affects the task. */ }
  };
  write({ kind: 'goal', goal });
  return Object.assign(write, { path });
}

function decisionProviderValid(value: Record<string, JSONValue>): boolean {
  return !Object.hasOwn(value, 'decisionProvider') || value.decisionProvider === 'jev';
}

let sharedLocal: LocalUnderstanding | undefined;
function localUnderstanding(): LocalUnderstanding {
  sharedLocal ??= new LocalUnderstanding(process.env.SYSTEMONE_LOCAL_MODEL_DIR
    ?? join(process.env.HOME ?? '', 'Library/Application Support/SystemOne-Dev/local-model'));
  return sharedLocal;
}

/** The on-device model's words, accepted only if they are exactly a run of what was said. */
export async function pickLocally(local: LocalUnderstanding, text: string, spans: readonly string[],
  trace?: (event: Record<string, JSONValue>) => void): Promise<number | null> {
  const { answer, ms } = await local.words(text);
  const index = answer === null ? -1 : spans.findIndex(span => span.toLowerCase() === answer.toLowerCase());
  trace?.({ kind: 'local_model', answer, ms, accepted: answer === null || index >= 0 });
  return index >= 0 ? index : null;
}

/** Per-task universal-agent selector, built only for an explicit agent request. */
export type AgentDecisionFactory = (requestId: string, goal: string, context?: string,
  judgment?: (event: Record<string, JSONValue>) => void) => Promise<AgentDecision>;

/** Per-task browse selector, built only for an explicit browse request. */
export type BrowseDecisionFactory = (requestId: string, goal: string) => Promise<BrowseDecision>;

/** Builds a per-task model selector only after an explicit request opt-in. */
export type FixtureDecisionFactory = (requestId: string, goal: string) => Promise<NativeFixtureDecision>;

function isRecord(value: JSONValue): value is Record<string, JSONValue> {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}

function requestFromLine(line: Uint8Array): NativeRequest {
  if (line.byteLength > MAX_LINE_BYTES) throw new ContractError('native request too large');
  const value = parseJSON(line);
  if (!isRecord(value) || !ID.test(String(value.requestId ?? ''))) {
    throw new ContractError('invalid native request');
  }
  if (value.type === 'replace_native_field') {
    const replacement = value.replacement;
    if (Object.keys(value).sort().join(',') !== 'replacement,requestId,targetRequestId,type'
      || typeof value.requestId !== 'string' || typeof value.targetRequestId !== 'string' || !ID.test(value.targetRequestId)
      || !replacement || !isRecord(replacement)
      || Object.keys(replacement).sort().join(',') !== (replacement.targetPid === undefined
        ? 'bundleId,command,fieldLabel,value' : 'bundleId,command,fieldLabel,targetLaunchMillis,targetPid,value')
      || !replacement.command || !isRecord(replacement.command)
      || !validNativeFillRequest({ ...replacement, requestId: value.requestId } as unknown as NativeFillRequest)) {
      throw new ContractError('invalid field replacement request');
    }
    return { type: 'replace_native_field', requestId: value.requestId,
      targetRequestId: value.targetRequestId,
      replacement: { ...replacement, requestId: value.requestId } as unknown as NativeFillRequest };
  }
  if (value.type === 'replace_native_fixture') {
    const replacement = value.replacement;
    if (Object.keys(value).sort().join(',') !== 'mode,replacement,requestId,targetRequestId,type'
      || typeof value.targetRequestId !== 'string' || !ID.test(value.targetRequestId)
      || !['navigate', 'locate', 'open'].includes(String(value.mode))
      || !replacement || !isRecord(replacement)
      || Object.keys(replacement).sort().join(',') !== (value.mode === 'navigate'
        ? 'bundleId,command,expectedWindowTitle,folderName' : 'bundleId,command,expectedWindowTitle,fileName,folderName')
      || replacement.bundleId !== 'com.aurium.systemone.fixture' || replacement.folderName !== 'Documents'
      || (value.mode !== 'navigate' && replacement.fileName !== 'Budget.xlsx')
      || replacement.expectedWindowTitle !== (value.mode === 'navigate' ? 'SystemOne Fixture — Documents'
        : value.mode === 'locate' ? 'SystemOne Fixture — Documents — Budget.xlsx selected'
          : 'SystemOne Fixture — Documents — Budget.xlsx opened')
      || !replacement.command || !isRecord(replacement.command)) throw new ContractError('invalid native replacement request');
    return { type: 'replace_native_fixture', requestId: value.requestId as string,
      targetRequestId: value.targetRequestId, mode: value.mode as NativeFixtureMode,
      replacement: { ...replacement, requestId: value.requestId } as unknown as NativePressRequest };
  }
  if (['prepare_native_recovery', 'native_recovery_presented', 'resume_native_task', 'cancel_native_recovery'].includes(String(value.type))) {
    const keys = value.type === 'prepare_native_recovery' ? 'requestId,targetRequestId,type,uiSessionRef'
      : value.type === 'resume_native_task' ? 'intent,requestId,targetRequestId,type,uiSessionRef'
      : value.type === 'native_recovery_presented' ? 'presentationDigest,promptId,requestId,targetRequestId,type,uiSessionRef'
      : 'promptId,requestId,targetRequestId,type,uiSessionRef';
    if (Object.keys(value).sort().join(',') !== keys
      || typeof value.targetRequestId !== 'string' || !ID.test(value.targetRequestId)
      || typeof value.uiSessionRef !== 'string' || !ID.test(value.uiSessionRef)
      || (value.promptId !== undefined && (typeof value.promptId !== 'string' || !ID.test(value.promptId)))
      || (value.type === 'native_recovery_presented' && (typeof value.presentationDigest !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.presentationDigest)))
      || (value.type === 'resume_native_task' && (!value.intent || !isRecord(value.intent)
        || value.intent.uiSessionRef !== value.uiSessionRef))) throw new ContractError('invalid native recovery control');
    return value as unknown as NativeRecoveryControl;
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
  if (value.type === 'start_browse') {
    if (Object.keys(value).sort().join(',') !== 'command,decisionProvider,requestId,type'
      || value.decisionProvider !== 'jev' || value.command === undefined || !isRecord(value.command)) {
      throw new ContractError('invalid browse request');
    }
    return { type: 'start_browse', requestId: value.requestId as string,
      command: value.command, decisionProvider: 'jev' };
  }
  if (value.type === 'start_agent') {
    const keys = Object.keys(value).sort().join(',');
    if ((keys !== 'command,decisionProvider,requestId,type' && keys !== 'command,decisionProvider,requestId,type,understanding')
      || value.decisionProvider !== 'jev' || value.command === undefined || !isRecord(value.command)
      || (value.understanding !== undefined && value.understanding !== 'jev' && value.understanding !== 'local')) {
      throw new ContractError('invalid agent request');
    }
    return { type: 'start_agent', requestId: value.requestId as string, command: value.command, decisionProvider: 'jev',
      understanding: value.understanding === 'local' ? 'local' : 'jev' };
  }
  if (value.type === 'continue_browse') {
    if (Object.keys(value).sort().join(',') !== 'command,decisionProvider,requestId,targetRequestId,type'
      || value.decisionProvider !== 'jev' || typeof value.targetRequestId !== 'string'
      || value.command === undefined || !isRecord(value.command)) {
      throw new ContractError('invalid browse follow-up');
    }
    return { type: 'continue_browse', requestId: value.requestId as string,
      targetRequestId: value.targetRequestId, command: value.command, decisionProvider: 'jev' };
  }
  if (value.type === 'agent_feedback') {
    const extra = Object.keys(value).filter(key => !['requestId', 'targetRequestId', 'type', 'value'].includes(key));
    if (extra.some(key => key !== 'reason' && key !== 'note')
      || typeof value.targetRequestId !== 'string' || (value.value !== 'good' && value.value !== 'bad')
      || (value.reason !== undefined && (typeof value.reason !== 'string' || !FEEDBACK_REASONS.has(value.reason)))
      || (value.note !== undefined && (typeof value.note !== 'string' || value.note.length > 1_000))) {
      throw new ContractError('invalid agent feedback');
    }
    return { type: 'agent_feedback', requestId: value.requestId as string, targetRequestId: value.targetRequestId,
      value: value.value, ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
      ...(typeof value.note === 'string' && value.note.trim() ? { note: value.note.trim() } : {}) };
  }
  if (value.type === 'confirm_step') {
    if (Object.keys(value).sort().join(',') !== 'allow,proposalId,requestId,targetRequestId,type'
      || typeof value.allow !== 'boolean' || typeof value.targetRequestId !== 'string'
      || typeof value.proposalId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value.proposalId)) {
      throw new ContractError('invalid step confirmation');
    }
    return { type: 'confirm_step', requestId: value.requestId as string,
      targetRequestId: value.targetRequestId, proposalId: value.proposalId, allow: value.allow };
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
    if (Object.keys(value).filter(k => k !== 'decisionProvider').sort().join(',')
        !== 'bundleId,command,expectedWindowTitle,folderName,requestId,type'
      || !decisionProviderValid(value)
      || value.bundleId !== 'com.aurium.systemone.fixture'
      || value.folderName !== 'Documents'
      || value.expectedWindowTitle !== 'SystemOne Fixture — Documents'
      || value.command === undefined || !isRecord(value.command)) {
      throw new ContractError('invalid native press request');
    }
    return { type: 'start_native_press', requestId: value.requestId as string,
      bundleId: value.bundleId, folderName: value.folderName,
      expectedWindowTitle: value.expectedWindowTitle, command: value.command,
      ...(value.decisionProvider === 'jev' ? { decisionProvider: 'jev' as const } : {}) };
  }
  if (value.type === 'start_native_locate') {
    if (Object.keys(value).filter(k => k !== 'decisionProvider').sort().join(',')
        !== 'bundleId,command,expectedWindowTitle,fileName,folderName,requestId,type'
      || !decisionProviderValid(value)
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
      command: value.command, ...(value.decisionProvider === 'jev' ? { decisionProvider: 'jev' as const } : {}) };
  }
  if (value.type === 'start_native_open') {
    if (Object.keys(value).filter(k => k !== 'decisionProvider').sort().join(',')
        !== 'bundleId,command,expectedWindowTitle,fileName,folderName,requestId,type'
      || !decisionProviderValid(value)
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
      command: value.command, ...(value.decisionProvider === 'jev' ? { decisionProvider: 'jev' as const } : {}) };
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
  actor?: PersistentTaskActor;
  browserFenced: boolean;
  /** Set when a confirmed browse completed and its session may take a follow-up. */
  browseCompleted?: boolean;
  /** The named site of a browse session, kept for follow-ups. */
  browseSite?: string | null;
  /** Universal agent run: nothing is open to fence before its actor exists. */
  agentRun?: boolean;
  done: Promise<void>;
}

interface NativeActiveTask {
  readonly requestId: string;
  readonly authority: NativeFillAuthority | NativeFixtureAuthority;
  statusTaskId?: string;
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
  readonly #fixtureDecisions: FixtureDecisionFactory | undefined;
  readonly #browseDecisions: BrowseDecisionFactory | undefined;
  readonly #agentDecisions: AgentDecisionFactory | undefined;
  readonly #agentAX: AgentAXClient;
  /** The previous agent request and what it did, for follow-ups (10 minutes). */
  #agentContext: { readonly text: string; readonly at: number } | undefined;
  /** Trace writers of recent agent tasks, so a later 👍/👎 lands in the right file. */
  readonly #traces = new Map<string, TraceWriter>();
  #pendingStep: { readonly requestId: string; readonly proposalId: string;
    readonly resolve: (allow: boolean) => void } | undefined;
  readonly #nativeWorker: NativeFieldPipeWorker | undefined;
  readonly #nativeAuthority: NativeFillAuthority | undefined;
  readonly #pressAuthority: NativeFixtureAuthority | undefined;
  readonly #chromeOutput: ((value: Record<string, JSONValue>) => void) | undefined;
  readonly #chromeSessions = new Map<string, ChromeReadSession>();
  readonly #chromeAuthorities = new Map<string, ChromeFillAuthority>();
  readonly #seen = new Set<string>();
  readonly #runs = new ExclusiveTaskSlot<ControllerRun>();
  readonly #hostLifecycle: HostLifecycleGate;
  #hostInterruption: Promise<void> | undefined;
  #workerFenceFailed = false;

  constructor(journal: AttemptJournal, send: (requestId: string, phase: Phase) => void,
    headless = false, nativeWorker?: NativeFieldPipeWorker,
    chromeOutput?: (value: Record<string, JSONValue>) => void,
    portalStore?: ScriptedPortalStore, requireHostSnapshot = false,
    fixtureDecisions?: FixtureDecisionFactory, browseDecisions?: BrowseDecisionFactory,
    agentDecisions?: AgentDecisionFactory) {
    this.#fixtureDecisions = fixtureDecisions;
    this.#browseDecisions = browseDecisions;
    this.#agentDecisions = agentDecisions;
    this.#agentAX = new AgentAXClient(value => this.#chromeOutput?.(value));
    this.#hostLifecycle = new HostLifecycleGate(requireHostSnapshot);
    this.#journal = journal;
    this.#portalStore = portalStore;
    this.#send = (requestId, phase) => {
      // Adapter cleanup may catch a journal refusal. Preserve the durable
      // pause instead of translating it into success or a safe retry.
      const budgetPaused = journal.getTaskState(requestId) === 'paused'
        && journal.taskEventKinds(requestId).some(event => event.startsWith('paused_budget:'));
      send(requestId, phase === 'ready' && this.#hostHeld ? 'host_unavailable'
        : budgetPaused && !['ready', 'stopped', 'stopping', 'busy', 'host_unavailable',
          'blocked_recovery'].includes(phase) ? 'paused_budget' : phase);
    };
    this.#headless = headless;
    this.#nativeWorker = nativeWorker;
    this.#chromeOutput = chromeOutput;
    this.#nativeAuthority = nativeWorker
      ? new NativeFillAuthority(journal, nativeWorker) : undefined;
    this.#pressAuthority = nativeWorker
      ? new NativeFixtureAuthority(journal, nativeWorker) : undefined;
    journal.recoverAfterRestart();
    portalStore?.recoverAfterRestart();
    this.#releaseUnresumable();
  }

  /** Browse and agent tasks never resume (the user just asks again), so a
   * paused one with no unresolved effect must not block new requests forever.
   * Fixture tasks keep their explicit recovery path. */
  #releaseUnresumable(): void {
    if (this.#runs.active) return;
    for (const taskId of this.#journal.pendingTaskIds()) {
      const record = this.#journal.getTaskRecord(taskId);
      const policy = record?.admission?.policyRevision;
      if (record?.state === 'paused' && this.#journal.unresolvedAttempts(taskId).length === 0
        && (policy === 'managed-browse-confirmed-v1' || policy === 'universal-agent-confirmed-v1')) {
        this.#journal.cancelTask(taskId);
      }
    }
  }

  startupPhase(): Phase {
    if (this.#hostHeld) return 'host_unavailable';
    return this.#workerFenceFailed || this.#nativeAuthority?.needsRecovery || this.#pressAuthority?.needsRecovery
      || this.#journal.unresolvedAttempts().length || this.#journal.pendingTaskIds().length
      || this.#portalStore?.hasBlockingTask() ? 'blocked_recovery' : 'ready';
  }

  get #hostHeld(): boolean { return !this.#hostLifecycle.available || this.#hostInterruption !== undefined; }

  #reportHost(): void {
    if (this.#hostLifecycle.sequence === 0) return;
    this.#chromeOutput?.({ type: 'host_lifecycle_status', sequence: this.#hostLifecycle.sequence,
      sessionAvailable: this.#hostLifecycle.available, interruptionSettled: this.#hostInterruption === undefined });
  }

  #receiveHost(message: Record<string, JSONValue>): void {
    const change = this.#hostLifecycle.accept(message);
    if (!change.accepted) { this.#reportHost(); return; }
    if (!this.#hostLifecycle.available && !this.#hostInterruption) {
      // Hold intake synchronously, before an observation/decision can settle.
      const pending = this.#interruptHost();
      this.#hostInterruption = pending;
      void pending.catch(() => { this.#workerFenceFailed = true; }).finally(() => {
        if (this.#hostInterruption === pending) this.#hostInterruption = undefined;
        this.#reportHost();
      });
    }
    this.#reportHost();
  }

  async #interruptHost(): Promise<void> {
    const run = this.#runs.active;
    if (run && !(run.surface === 'native'
      && this.#journal.getTaskState(run.task.authority.taskId ?? run.requestId) === 'completed')) {
      await this.#stop({ type: 'stop', requestId: randomUUID(), targetRequestId: run.requestId });
    }
    for (const authority of [this.#nativeAuthority, this.#pressAuthority]) {
      const taskId = authority?.taskId;
      if (!this.#runs.active && taskId && this.#journal.getTaskState(taskId) === 'paused') {
        await this.#stop({ type: 'stop', requestId: randomUUID(), targetRequestId: taskId });
      }
    }
    // After the existing Stop barrier, revoke grants/retained observations.
    // This closes only the host connection, never the owner's Chrome tabs.
    for (const [connectionId, session] of this.#chromeSessions) {
      session.close(); this.#chromeOutput?.({ type: 'chrome_port_close', connectionId });
    }
    this.#chromeSessions.clear(); this.#chromeAuthorities.clear();
  }

  #adapterSettled(run: ControllerRun,
    authority: NativeFillAuthority | NativeFixtureAuthority | ChromeFillAuthority): void {
    if (this.#runs.release(run)) this.#send(run.surface === 'native' ? run.task.statusTaskId ?? run.requestId : run.requestId,
      this.#workerFenceFailed || authority.needsRecovery
        || this.#journal.unresolvedAttempts().length || this.#journal.pendingTaskIds().length
        ? 'blocked_recovery' : 'ready');
  }

  #adapterStopFinished(run: ControllerRun,
    authority: NativeFillAuthority | NativeFixtureAuthority | ChromeFillAuthority): void {
    if (this.#runs.finishStop(run)) this.#send(run.surface === 'native' ? run.task.statusTaskId ?? run.requestId : run.requestId,
      this.#workerFenceFailed || authority.needsRecovery
        || this.#journal.unresolvedAttempts().length || this.#journal.pendingTaskIds().length
        ? 'blocked_recovery' : 'ready');
  }

  receive(line: Uint8Array): void {
    let request: NativeRequest;
    try {
      if (line.byteLength > MAX_LINE_BYTES) throw new ContractError('native request too large');
      const parsed = parseJSON(line);
      if (this.#nativeWorker?.receive(parsed)) return;
      if (isRecord(parsed) && parsed.type === 'agent_ax_reply') {
        this.#agentAX.receive(parsed); return;
      }
      if (isRecord(parsed) && parsed.type === 'host_lifecycle') {
        this.#receiveHost(parsed); return;
      }
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
    if (request.type === 'continue_browse') {
      this.#continueBrowse(request); return;
    }
    if (request.type === 'agent_feedback') {
      // Recorded only into that task's own private trace (and its dataset file); never acted on.
      const target = this.#traces.get(request.targetRequestId);
      target?.({ kind: 'feedback', value: request.value, ...(request.reason ? { reason: request.reason } : {}),
        ...(request.note ? { note: request.note } : {}) });
      if (target) refreshDataset(target.path);
      return;
    }
    if (request.type === 'confirm_step') {
      const pending = this.#pendingStep;
      // A confirmation is intent for one exact displayed proposal, never a permit.
      if (!pending || pending.requestId !== request.targetRequestId || pending.proposalId !== request.proposalId) {
        this.#send(request.requestId, 'error'); return;
      }
      this.#pendingStep = undefined;
      pending.resolve(request.allow);
      return;
    }
    if (this.#hostHeld && request.type !== 'cancel_native_recovery') {
      this.#send(request.requestId, 'host_unavailable'); return;
    }
    if (request.type === 'replace_native_fixture' || request.type === 'replace_native_field') {
      this.#replaceNative(request); return;
    }
    if ('targetRequestId' in request) {
      this.#recoverNative(request); return;
    }
    if (this.#runs.active) {
      this.#send(request.requestId, 'busy'); return;
    }
    this.#releaseUnresumable();
    if (this.#workerFenceFailed || this.#nativeAuthority?.needsRecovery
      || this.#pressAuthority?.needsRecovery
      || [...this.#chromeAuthorities.values()].some(x => x.needsRecovery)
      || this.#journal.unresolvedAttempts().length || this.#journal.pendingTaskIds().length
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
          : result === 'paused' ? 'native_paused'
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
      const opted = request.decisionProvider === 'jev';
      const factory = this.#fixtureDecisions;
      const goal = typeof request.command.text === 'string' ? request.command.text : '';
      // A failed opt-in (no factory, no key) refuses the task; it never falls
      // back silently to the script or to another provider.
      const decision = opted ? (factory ? factory(request.requestId, goal) : Promise.reject(new Error('jev unavailable')))
        : Promise.resolve(undefined);
      active.done = decision.then(selected => request.type === 'start_native_open'
        ? authority.startOpen(request, selected) : request.type === 'start_native_locate'
          ? authority.startLocate(request, selected) : authority.start(request, selected), () => 'error' as const)
        .then(result => {
        const phase: Phase = result === 'verified_navigation'
          ? 'verified_native_navigation'
          : result === 'paused' ? 'native_paused'
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
    active.done = (request.type === 'start_agent'
      ? this.#runAgent(request, active)
      : request.type === 'start_browse'
      ? this.#runBrowse(request, active)
      : request.type === 'start_navigate'
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

  #replaceNative(request: ReplaceNativeFixture | ReplaceNativeField): void {
    const authority = request.type === 'replace_native_field' ? this.#nativeAuthority : this.#pressAuthority;
    if (this.#runs.active) { this.#send(request.requestId, 'busy'); return; }
    if (!authority || !this.#chromeOutput || this.#workerFenceFailed
      || authority.taskId !== request.targetRequestId || this.#journal.getTaskState(request.targetRequestId) !== 'paused') {
      this.#send(request.requestId, 'blocked_recovery'); return;
    }
    const active: NativeActiveTask = { requestId: request.targetRequestId, authority, done: Promise.resolve() };
    const run: ControllerRun = { requestId: active.requestId, surface: 'native', task: active };
    this.#runs.claim(run); this.#send(active.requestId, 'replacing_native_task');
    active.done = (request.type === 'replace_native_field'
      ? this.#nativeAuthority!.replace(active.requestId, request.replacement)
      : this.#pressAuthority!.replace(active.requestId, request.replacement, request.mode)).then(result => {
      const record = this.#journal.getTaskRecord(request.requestId);
      if (record) {
        // Keep the old UI Stop target valid until the run settles. Then transfer
        // panel ownership before emitting child status; source and child IDs are
        // both accepted for Stop while this exact run owns the slot.
        active.statusTaskId = request.requestId;
        this.#chromeOutput!({ type: 'native_replacement_task', requestId: request.requestId,
          targetRequestId: active.requestId, taskId: record.taskId, taskEpoch: record.taskEpoch,
          goalRevision: record.goalRevision, mode: request.type === 'replace_native_field' ? 'fill' : request.mode });
        if (result !== 'stopped') this.#send(record.taskId, result === 'verified' ? 'verified_native_fill'
          : result === 'verified_navigation' ? 'verified_native_navigation'
          : result === 'verified_locate' ? 'verified_native_locate' : result === 'verified_open' ? 'verified_native_open'
          : result === 'paused' ? 'native_paused' : result);
      } else {
        this.#send(request.requestId, result === 'uncertain' ? 'blocked_recovery' : 'error');
      }
    }).catch(() => { this.#send(request.requestId, 'error'); })
      .finally(() => { this.#adapterSettled(run, authority); });
  }

  #recoverNative(request: NativeRecoveryControl): void {
    const taskId = request.targetRequestId;
    const authority = this.#nativeAuthority?.taskId === taskId ? this.#nativeAuthority : this.#pressAuthority;
    if (this.#runs.active) { this.#send(taskId, 'busy'); return; }
    if (!authority || !this.#chromeOutput || this.#workerFenceFailed
      || authority.taskId !== taskId || this.#journal.getTaskState(taskId) !== 'paused') {
      this.#send(taskId, 'blocked_recovery'); return;
    }
    if (request.type === 'native_recovery_presented' || request.type === 'cancel_native_recovery') {
      try {
        if (request.type === 'native_recovery_presented') authority.presented(taskId,
          request.promptId!, request.presentationDigest!, request.uiSessionRef);
        else authority.dismiss(taskId, request.promptId!, request.uiSessionRef);
      } catch { this.#send(taskId, 'error'); }
      return;
    }
    const active: NativeActiveTask = { requestId: taskId, authority, done: Promise.resolve() };
    const run: ControllerRun = { requestId: taskId, surface: 'native', task: active };
    this.#runs.claim(run);
    this.#send(taskId, 'checking_native_recovery');
    active.done = (request.type === 'prepare_native_recovery'
      ? authority.prepareRecovery(taskId, request.uiSessionRef).then(prompt => {
        this.#chromeOutput!({ type: 'native_recovery_prompt', requestId: request.requestId,
          targetRequestId: taskId, ...prompt });
      })
      : authority.resume(taskId, Buffer.from(JSON.stringify(request.intent))).then(result => {
        if (result !== 'stopped') this.#send(taskId, result === 'verified_navigation' ? 'verified_native_navigation'
          : result === 'verified_locate' ? 'verified_native_locate' : result === 'verified_open' ? 'verified_native_open'
          : result === 'paused' ? 'native_paused' : result === 'verified' ? 'verified_native_fill' : result);
      })).catch(() => { this.#send(taskId, 'blocked_recovery'); })
      .finally(() => { this.#adapterSettled(run, authority); });
  }

  async close(): Promise<void> {
    // A pending lifecycle Stop still owns journal/session cleanup. Settle it
    // before closing the transport and durable stores underneath its callback.
    await this.#hostInterruption?.catch(() => { this.#workerFenceFailed = true; });
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
    await this.#pressAuthority?.settleBeforeClose();
    await this.#nativeAuthority?.settleBeforeClose();
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
        if (this.#hostHeld || Object.keys(message).sort().join(',')
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
      const payload = parseJSON(bytes);
      if (this.#hostHeld && isRecord(payload) && ['hello', 'observation'].includes(String(payload.type))) return;
      session.receive(payload);
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

  /** Confirm-each-step browsing within one site the user named. */
  async #runBrowse(request: StartBrowse | ContinueBrowse, active: ActiveTask,
    existing?: ManagedObservationSession, existingSite: string | null = null): Promise<void> {
    try {
      const command = request.command;
      if (command.type !== 'command' || (command.source !== 'text' && command.source !== 'voice')
        || command.mode !== 'command' || command.isFinal !== true || typeof command.text !== 'string'
        || command.taskId !== request.requestId || command.taskEpoch !== 1 || command.goalRevision !== 1
        || command.originSurface === undefined || !isRecord(command.originSurface)
        || command.originSurface.appBundleId !== 'com.aurium.systemone.dev') {
        throw new ContractError('browse command binding changed');
      }
      const parsed = existing ? { site: existingSite, startUrl: '', ...parseBrowseFollowUp(command.text) }
        : parseScopedBrowse(command.text);
      active.browseSite = parsed.site;
      // Loaded on first use so controller startup stays as lean as before.
      const { ManagedBrowseTask, BROWSE_POLICY, BROWSE_VERIFIER } = await import('../../browser/src/managed-browse-task.ts');
      const factory = this.#browseDecisions;
      if (!factory) throw new ContractError('no browse decision provider');
      const revision = { taskId: request.requestId, taskEpoch: 1, goalRevision: 1 };
      const endpoint = bindEndpoint(['command']);
      const input = new CommittedInputSession(endpoint, revision);
      const route = input.accept(endpoint, Buffer.from(JSON.stringify(command)));
      if (route.kind !== 'interpret_command') throw new ContractError('not a command');
      const parameters = parsed.searchText === null ? []
        : [bindCommandValue(route.input, 'search-text', parsed.prefix!, parsed.searchText)];
      const decision = await factory(request.requestId, route.input.text);
      if (active.cancelled) return;
      const session = existing ?? await ManagedObservationSession.launch(parsed.startUrl, {
        allowedOrigins: [new URL(parsed.startUrl).origin],
        ...(parsed.site ? { allowedSites: [parsed.site] } : {}), headless: this.#headless });
      active.session = session;
      if (active.cancelled) return;
      const registry = new TaskAdmissionRegistry(revision, input);
      const admission = registry.admit(route.input, { admissionId: randomUUID(), goal: route.input.text,
        outcomeKind: 'USER_CONFIRMATION', scopeRef: session.scopeRef, completionVerifierRef: BROWSE_VERIFIER,
        policyRevision: BROWSE_POLICY,
        // Page scripts may send network requests after a fill or submit.
        approvedEffects: ['READ', 'NAVIGATE', 'EXTERNAL_READ', 'LOCAL_EDIT', 'EXTERNAL_WRITE'], parameters });
      const task = ManagedBrowseTask.start(this.#journal, registry, admission, session,
        { searchText: parsed.searchText, decision, siteWords: parsed.site?.split('.') ?? [],
          confirmation: { confirm: (proposal, signal) => this.#awaitConfirmation(request.requestId, proposal, signal) } });
      const actor = new PersistentTaskActor(this.#journal, task, 60_000);
      active.actor = actor;
      if (active.cancelled) { await actor.stop(); return; }
      this.#send(request.requestId, 'browsing');
      const result = await actor.run(record => {
        if (!active.cancelled && record.state === 'active') this.#send(request.requestId, 'browsing');
      });
      if (active.cancelled) return;
      if (result.state === 'completed') {
        // Leave the result page visible until Stop or the next request.
        active.keepOpen = true;
        active.browseCompleted = true;
        this.#send(request.requestId, 'verified_browse');
      } else this.#send(request.requestId, 'browse_paused');
    } catch (error) {
      if (error instanceof ManagedLaunchFailure) {
        active.launchFenceUnconfirmed = true;
        this.#workerFenceFailed = true;
      }
      if (!active.cancelled) this.#send(request.requestId, 'error');
    } finally {
      this.#pendingStep?.resolve(false); this.#pendingStep = undefined;
      if (!active.keepOpen || active.cancelled) {
        try {
          await active.session?.close();
          active.browserFenced = !active.launchFenceUnconfirmed;
        } catch { this.#workerFenceFailed = true; }
        if (active.actor?.busy) this.#workerFenceFailed = true;
      }
    }
  }

  /** Universal computer use on the user's own apps through Accessibility. */
  async #runAgent(request: StartAgent, active: ActiveTask): Promise<void> {
    active.agentRun = true;
    let agentTask: { readonly summary: { readonly history: readonly string[]; readonly app: string;
      readonly url: string } } | undefined;
    let trace: TraceWriter | undefined;
    let outcome = 'error';
    try {
      const command = request.command;
      if (command.type !== 'command' || (command.source !== 'text' && command.source !== 'voice')
        || command.mode !== 'command' || command.isFinal !== true || typeof command.text !== 'string'
        || command.taskId !== request.requestId || command.taskEpoch !== 1 || command.goalRevision !== 1
        || command.originSurface === undefined || !isRecord(command.originSurface)
        || command.originSurface.appBundleId !== 'com.aurium.systemone.dev') {
        throw new ContractError('agent command binding changed');
      }
      const factory = this.#agentDecisions;
      if (!factory) throw new ContractError('no agent decision provider');
      const parsed = parseAgentGoal(command.text, installedApps());
      const { UniversalAgentTask, AGENT_POLICY, AGENT_VERIFIER } = await import('./universal-agent-task.ts');
      const revision = { taskId: request.requestId, taskEpoch: 1, goalRevision: 1 };
      const endpoint = bindEndpoint(['command']);
      const input = new CommittedInputSession(endpoint, revision);
      const route = input.accept(endpoint, Buffer.from(JSON.stringify(command)));
      if (route.kind !== 'interpret_command') throw new ContractError('not a command');
      const context = this.#agentContext && Date.now() - this.#agentContext.at < 600_000
        ? this.#agentContext.text : undefined;
      trace = agentTraceWriter(request.requestId, route.input.text);
      if (trace) {
        this.#traces.set(request.requestId, trace);
        if (this.#traces.size > 20) this.#traces.delete(this.#traces.keys().next().value!);
      }
      // Read the screen while the request is being understood, not after.
      const firstView = this.#agentAX.snapshot(request.requestId).catch(() => undefined);
      const decision = await factory(request.requestId, route.input.text, context, trace);
      if (active.cancelled) return;
      // The exact words to type are picked from runs of what was said: by Jev, or by the
      // on-device model when ⚙ "Understand requests on this Mac" is on (falls back to Jev
      // until it is installed). Either way only the user's own words can be typed.
      const jevPick = decision.pickSpan?.bind(decision);
      let understanding = 'jev';
      let pick = jevPick;
      if (request.understanding === 'local' && jevPick) {
        const local = localUnderstanding();
        if (local.status === 'ready') {
          understanding = 'local';
          pick = (text, role, spans) => role === 'file' ? jevPick(text, role, spans) : pickLocally(local, text, spans, trace);
        } else {
          local.prepare();
          understanding = `jev (on-device model ${local.status}${local.problem ? `: ${local.problem}` : ''})`;
          if (local.status !== 'failed') this.#send(request.requestId, 'local_model_preparing');
        }
      }
      const goal = await refineGoal(route.input.text, parsed, pick, decision.asksForAnswer?.bind(decision));
      // The bar shows who understood the request and what will be typed (Qwen on this Mac or Jev).
      this.#chromeOutput?.({ type: 'agent_understanding', requestId: request.requestId,
        by: understanding === 'local' ? 'local' : request.understanding === 'local'
          ? (localUnderstanding().status === 'failed' ? 'local_failed' : 'local_installing') : 'jev',
        typed: goal.typedText?.text ?? null, problem: localUnderstanding().problem.slice(0, 120) });
      trace?.({ kind: 'understanding', by: understanding, answer: goal.wantsAnswer, typed: goal.typedText?.text ?? null,
        file: goal.fileName?.text ?? null });
      if (active.cancelled) return;
      // "Reply in the chat" with no words: ask, rather than guess or wander.
      if (goal.needsText) { outcome = 'needs_text'; this.#send(request.requestId, 'agent_needs_text'); return; }
      const parameters = [...(goal.typedText ? [bindCommandSpan(route.input, 'typed-text', goal.typedText)] : []),
        ...(goal.fileName ? [bindCommandSpan(route.input, 'file-name', goal.fileName)] : [])];
      const registry = new TaskAdmissionRegistry(revision, input);
      const admission = registry.admit(route.input, { admissionId: randomUUID(), goal: route.input.text,
        outcomeKind: 'USER_CONFIRMATION', scopeRef: `agent-session:${request.requestId}`,
        completionVerifierRef: AGENT_VERIFIER, policyRevision: AGENT_POLICY,
        approvedEffects: ['READ', 'NAVIGATE', 'EXTERNAL_READ', 'LOCAL_EDIT', 'EXTERNAL_WRITE'], parameters });
      const initialView = await firstView;
      const task = UniversalAgentTask.start(this.#journal, registry, admission, this.#agentAX, { goal, decision,
        ...(initialView ? { initialView } : {}),
        say: text => { this.#chromeOutput?.({ type: 'agent_answer', requestId: request.requestId, text: text.slice(0, 3_000) }); },
        ...(trace ? { trace } : {}),
        confirmation: { confirm: (proposal, signal) => this.#awaitConfirmation(request.requestId, proposal, signal) } });
      agentTask = task;
      const actor = new PersistentTaskActor(this.#journal, task, 60_000);
      active.actor = actor;
      if (active.cancelled) { await actor.stop(); return; }
      this.#send(request.requestId, 'agent_working');
      const result = await actor.run(record => {
        if (!active.cancelled && record.state === 'active') this.#send(request.requestId, 'agent_working');
      });
      if (active.cancelled) return;
      this.#send(request.requestId, result.state === 'completed' ? 'agent_done' : 'agent_paused');
      outcome = result.state;
      const done = agentTask!.summary;
      this.#agentContext = { at: Date.now(), text: `the user asked “${String(command.text).slice(0, 200)}”; `
        + `${done.history.slice(-6).join(' ') || 'nothing was done.'} It ${result.state === 'completed' ? 'finished' : 'stopped'} in ${done.app}${
          done.url ? ` at ${done.url}` : ''}.` };
    } catch {
      if (!active.cancelled) this.#send(request.requestId, 'error');
    } finally {
      trace?.({ kind: 'end', outcome: active.cancelled ? 'stopped' : outcome });
      if (trace) refreshDataset(trace.path);
      this.#pendingStep?.resolve(false); this.#pendingStep = undefined;
      this.#agentAX.cancelAll();
      active.browserFenced = true;
    }
  }

  /** Hands a finished browse's open window to a new, separately admitted task.
   * Scope stays the original site; the old task stays completed. */
  #continueBrowse(request: ContinueBrowse): void {
    const run = this.#runs.active;
    const previous = run?.surface === 'managed' ? run.task : undefined;
    if (!run || !previous || previous.requestId !== request.targetRequestId || !previous.browseCompleted
      || !previous.keepOpen || previous.cancelled || !(previous.session instanceof ManagedObservationSession)
      || this.#journal.getTaskState(previous.requestId) !== 'completed' || this.#hostHeld) {
      this.#send(request.requestId, 'error'); return;
    }
    const session = previous.session;
    const site = previous.browseSite ?? null;
    delete previous.session; previous.keepOpen = false; previous.browseCompleted = false;
    if (!this.#runs.release(run)) { this.#send(request.requestId, 'error'); return; }
    const active: ActiveTask = { requestId: request.requestId, cancelled: false, keepOpen: false,
      launchFenceUnconfirmed: false, browserFenced: false, done: Promise.resolve() };
    const next: ControllerRun = { requestId: request.requestId, surface: 'managed', task: active };
    this.#runs.claim(next);
    this.#send(request.requestId, 'starting');
    active.done = this.#runBrowse(request, active, session, site).finally(() => {
      if (!active.keepOpen && !active.cancelled && this.#runs.release(next)) {
        this.#send(request.requestId, this.#workerFenceFailed || this.#journal.unresolvedAttempts().length
          ? 'blocked_recovery' : 'ready');
      }
    });
  }

  #awaitConfirmation(requestId: string, proposal: BrowseProposal | AgentProposalView, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.#pendingStep) return Promise.resolve(false);
    const proposalId = randomUUID();
    return new Promise(resolve => {
      const settle = (allow: boolean) => { signal.removeEventListener('abort', abort); resolve(allow); };
      const abort = () => {
        if (this.#pendingStep?.proposalId === proposalId) this.#pendingStep = undefined;
        settle(false);
      };
      signal.addEventListener('abort', abort, { once: true });
      this.#pendingStep = { requestId, proposalId, resolve: settle };
      this.#chromeOutput?.({ type: 'browse_proposal', requestId, proposalId, step: proposal.step,
        kind: proposal.kind, label: proposal.label, destinationUrl: proposal.destinationUrl,
        pageUrl: proposal.pageUrl, app: 'app' in proposal ? proposal.app : '',
        risky: 'risky' in proposal ? proposal.risky : false });
    });
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
      const actor = new PersistentTaskActor(this.#journal, task);
      active.actor = actor;
      const result = await actor.run(record => {
        if (active.cancelled || record.state !== 'active') return;
        const stage = store.get(request.requestId)!.stage;
        this.#send(request.requestId, stage === 'located' ? 'portal_located'
          : stage === 'opened' ? 'portal_opened' : 'portal_downloaded');
      });
      if (!active.cancelled) this.#send(request.requestId,
        result.state === 'completed' ? 'verified_portal_download' : 'portal_paused');
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
      if (active.actor?.busy) this.#workerFenceFailed = true;
    }
  }

  async #stop(request: Stop): Promise<void> {
    const run = this.#runs.active;
    // A paused actor has settled its run and released the dispatch slot, but
    // remains the durable owner. Explicit Stop must fence that exact task too.
    const retainedAuthority = [this.#nativeAuthority, this.#pressAuthority].find(authority => authority?.taskId
      && (authority.taskId === request.targetRequestId
        || this.#journal.getTaskRecord(request.targetRequestId)?.replacement?.taskId === authority.taskId));
    const retainedId = retainedAuthority?.taskId;
    const targetMatchesRetained = retainedId && (retainedId === request.targetRequestId
      || this.#journal.getTaskRecord(request.targetRequestId)?.replacement?.taskId === retainedId);
    if (!run && targetMatchesRetained && this.#journal.getTaskState(retainedId) === 'paused') {
      this.#send(request.requestId, 'stopping');
      const authority = retainedAuthority!;
      const result = await authority.stop().catch(() => ({ workerFenced: false }));
      if (!result.workerFenced) this.#workerFenceFailed = true;
      this.#send(request.requestId, result.workerFenced && !authority.needsRecovery ? 'stopped' : 'uncertain');
      if (!authority.needsRecovery && !this.#journal.pendingTaskIds().length) {
        this.#send(retainedId, 'ready');
      }
      return;
    }
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
    if (nativeActive && (nativeActive.requestId === request.targetRequestId
      || nativeActive.authority.taskId === request.targetRequestId)) {
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
          || this.#journal.unresolvedAttempts().length || this.#journal.pendingTaskIds().length
          ? 'uncertain' : 'stopped');
      return;
    }
    active.cancelled = true;
    this.#send(request.requestId, 'stopping');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const fence = active.actor ? active.actor.stop().then(result => result.workerFenced, () => false)
        : active.task
        ? active.task.stop().then(result => active.task instanceof ScriptedPortalTask
          ? ('workerFenced' in result && result.workerFenced)
          : result.browserFenced, () => false)
        : active.session
          ? active.session.close().then(() => true, () => false)
          : Promise.resolve(active.agentRun === true); // A browser launch may still be in flight.
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
  process.env.SYSTEMONE_TRACE_DIR ??= join(dirname(journalPath), 'traces');
  process.env.SYSTEMONE_LOCAL_MODEL_DIR ??= join(dirname(journalPath), 'local-model');
  const outputRoot = join(dirname(journalPath), 'fixture-output');
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const portalStore = new ScriptedPortalStore(journalPath, outputRoot, journal);
  const write = (requestId: string, phase: Phase) => {
    process.stdout.write(`${JSON.stringify({ type: 'status', requestId, phase })}\n`);
  };
  const worker = new NativeFieldPipeWorker(value => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  });
  // Jev runs only for a request that explicitly opts in. The key is read from
  // the login Keychain at that moment and is never logged or written out.
  const fixtureDecisions: FixtureDecisionFactory = async (requestId, goal) => {
    const { execFileSync } = await import('node:child_process');
    const { createJevFixtureDecision } = await import('../../providers/src/jev-fixture-decision.ts');
    const apiKey = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'systemone-jev', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim();
    return createJevFixtureDecision({ apiKey, goal, report: event => {
      process.stdout.write(`${JSON.stringify({ type: 'decision', requestId, ...event })}\n`);
    } });
  };
  const browseDecisions: BrowseDecisionFactory = async (requestId, goal) => {
    const { execFileSync } = await import('node:child_process');
    const { createJevBrowseDecision } = await import('../../providers/src/jev-browse-decision.ts');
    const apiKey = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'systemone-jev', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim();
    return createJevBrowseDecision({ apiKey, goal, report: event => {
      process.stdout.write(`${JSON.stringify({ type: 'decision', requestId, ...event })}\n`);
    } });
  };
  const controller = new NativeManagedController(journal, write,
    process.env.SYSTEMONE_MANAGED_HEADLESS === '1', worker,
    value => { process.stdout.write(`${JSON.stringify(value)}\n`); }, portalStore,
    process.env.SYSTEMONE_HOST_LIFECYCLE_REQUIRED === '1', fixtureDecisions, browseDecisions,
    async (requestId, goal, context, judgment) => {
      const { execFileSync } = await import('node:child_process');
      const { createJevAgentDecision } = await import('../../providers/src/jev-agent-decision.ts');
      const apiKey = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'systemone-jev', '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim();
      return createJevAgentDecision({ apiKey, goal, ...(context ? { context } : {}), ...(judgment ? { judgment } : {}), report: event => {
        process.stdout.write(`${JSON.stringify({ type: 'decision', requestId, ...event })}\n`);
      } });
    });
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
