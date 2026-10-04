import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schema } from '../../protocol/src/contract.ts';
import type { JSONValue } from '../../protocol/src/json.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { AgentAXClient } from '../src/agent-ax-client.ts';
import type { AgentElement } from '../src/agent-ax-client.ts';
import { bindCommandSpan, parseAgentGoal, refineGoal } from '../src/agent-goal.ts';
import { AttemptJournal } from '../src/attempt-journal.ts';
import { CommittedInputSession } from '../src/committed-input.ts';
import { PersistentTaskActor } from '../src/persistent-task-actor.ts';
import { TaskAdmissionRegistry } from '../src/task-authority.ts';
import { AGENT_POLICY, AGENT_VERIFIER, UniversalAgentTask } from '../src/universal-agent-task.ts';
import type { AgentDecision, AgentProposal } from '../src/universal-agent-task.ts';

/** One element of a simulated screen. `id` is assigned by position. */
export interface SimElement {
  readonly role: string;
  readonly label: string;
  readonly context?: string;
  readonly editable?: boolean;
  readonly value?: string;
  readonly selected?: boolean;
  readonly url?: string;
  /** What pressing it does to the world. */
  readonly press?: () => void;
  /** A browser tab that can be closed by name, and what closing it does. */
  readonly close?: () => void;
}

export interface SimScreen {
  readonly app: string;
  readonly bundleId: string;
  readonly windowTitle: string;
  readonly url?: string;
  /** Page scroll position; part of the signature, as in the executor's page read. */
  readonly scrollY?: number;
  readonly elements: readonly SimElement[];
}

/** A small simulated Mac: apps with screens, keyboard behaviour, and a goal check. */
export interface Scenario {
  readonly name: string;
  readonly goal: string;
  readonly apps: readonly string[];
  /** Built fresh per run so state never leaks between runs. */
  readonly world: () => SimWorld;
  /** The simulated user says yes to steps that ask first (sleep, send…). */
  readonly allowRisky?: boolean;
  /** Other natural ways to say the same request; each must pass too. */
  readonly paraphrases?: readonly string[];
}

export interface SimWorld {
  front: string;
  clipboard?: string;
  screen(): SimScreen | null;
  key?(name: string): void;
  type?(element: SimElement, text: string): void;
  scroll?(down: boolean): void;
  openUrl?(url: string, newTab: boolean): void;
  openApp?(name: string): void;
  quitApp?(name: string): void;
  /** Open windows (one per app is fine), front first. */
  windows?(): readonly { readonly app: string; readonly title: string; readonly minimized?: boolean }[];
  focusWindow?(app: string): void;
  media?(name: string): void;
  /** `window` is the listed window's title when a specific window was chosen. */
  windowAction?(action: string, window?: string): void;
  openFile?(name: string): boolean;
  system?(name: string): void;
  settingsPanes?(): readonly { readonly id: string; readonly name: string }[];
  macState?(): { darkMode: boolean; wifiOn: boolean; volume: number; muted: boolean };
  openSettings?(id: string): boolean;
  /** What SystemOne told the user (answers, read-outs). */
  heard?(text: string): void;
  installed?(): readonly string[];
  /** Regular apps running now (defaults to the scenario's app list). */
  running?(): readonly string[];
  /** Did the user's goal happen? */
  done(): boolean;
  /** Did something happen that must not (e.g. an email was sent unasked)? */
  harmed?(): boolean;
}

export interface RunResult {
  readonly name: string;
  readonly goal: string;
  readonly state: string;
  readonly success: boolean;
  readonly harmed: boolean;
  readonly steps: readonly string[];
  readonly ms: number;
  /** Where the time went: understanding before step 1, deciding, acting, settling/checking. */
  readonly timing?: { readonly understandMs: number; readonly decideMs: number; readonly actMs: number;
    readonly verifyMs: number };
}

/** Runs one scenario through the real agent task, journal and decision. */
export async function runScenario(scenario: Scenario, decision: (goal: string) => AgentDecision,
  options: { readonly allowRisky?: boolean } = {}): Promise<RunResult> {
  const world = scenario.world();
  const root = mkdtempSync(join(tmpdir(), 'systemone-eval-'));
  const journal = new AttemptJournal(join(root, 'attempts.sqlite'));
  const started = performance.now();
  const steps: string[] = [];
  let elements: SimElement[] = [];
  let windows: { app: string; title: string }[] = [];
  let client!: AgentAXClient;
  client = new AgentAXClient(request => queueMicrotask(() => {
    let value: JSONValue = null;
    let ok = true;
    const element = typeof request.id === 'string' ? elements[Number(request.id.slice(1))] : undefined;
    switch (request.op) {
      case 'snapshot': {
        const screen = world.screen();
        elements = screen ? [...screen.elements] : [];
        const described: AgentElement[] = elements.map((item, index) => ({ id: `e${index}`, role: item.role,
          label: item.label, context: item.context ?? '', editable: item.editable === true,
          pressable: item.role !== 'AXStaticText' && (item.editable !== true || item.press !== undefined),
          ...(item.value !== undefined ? { value: item.value } : {}),
          ...(item.selected ? { selected: true } : {}), ...(item.url ? { url: item.url } : {}),
          ...(item.close ? { closable: true } : {}) }));
        value = { app: screen?.app ?? 'no app', bundleId: screen?.bundleId ?? '', pid: screen ? 1 : 0,
          windowTitle: screen?.windowTitle ?? '', url: screen?.url ?? '', elements: described as unknown as JSONValue,
          // Like the executor: static text (clocks, counters) is not part of the signature.
          truncated: false, signature: JSON.stringify([screen?.app, screen?.windowTitle, screen?.url, screen?.scrollY ?? 0,
            elements.filter(item => item.role !== 'AXStaticText').map(item => [item.role, item.label, item.value, item.selected])]),
          contentSignature: JSON.stringify([screen?.app, screen?.windowTitle, screen?.url, screen?.scrollY ?? 0,
            elements.map(item => [item.role, item.label, item.value, item.selected])]),
          ...(screen?.scrollY !== undefined ? { scrollY: screen.scrollY } : {}),
          frontmost: true, installedApps: [...(world.installed?.() ?? scenario.apps)],
          settingsPanes: [...(world.settingsPanes?.() ?? [])].map(pane => ({ ...pane })),
          ...(world.macState ? { mac: world.macState() } : {}),
          windows: (windows = [...(world.windows?.() ?? [])]).map((item, index) => ({ id: `w${index}`, app: item.app,
            title: item.title, ...(item.minimized ? { minimized: true } : {}), front: index === 0 && item.app === screen?.app })),
          runningApps: (world.running?.() ?? scenario.apps).filter(name => name !== screen?.app) };
        break;
      }
      case 'press': if (element?.press) element.press(); else ok = !!element; break;
      case 'close': {
        // One tab or several ("e1,e3"); highest first, as the executor does.
        const targets = String(request.id).split(',').map(id => elements[Number(id.slice(1))]);
        if (targets.every(item => item?.close)) {
          for (const item of [...targets].reverse()) item!.close!();
        } else ok = false;
        break;
      }
      case 'focus_window': {
        const target = windows[Number(String(request.id).slice(1))];
        if (target && world.focusWindow) world.focusWindow(target.app); else ok = false;
        break;
      }
      case 'media': world.media ? world.media(String(request.name)) : ok = false; break;
      case 'system': world.system ? world.system(String(request.name)) : ok = false; break;
      case 'open_settings': ok = world.openSettings?.(String(request.id)) ?? false; break;
      case 'window_action': {
        const listed = typeof request.window === 'string' && request.window ? windows[Number(request.window.slice(1))] : undefined;
        if (!world.windowAction || (request.window && !listed)) { ok = false; break; }
        world.windowAction(String(request.action), listed?.title);
        break;
      }
      case 'open_file': ok = world.openFile?.(String(request.name)) ?? false; break;
      case 'quit_app': if (world.quitApp && (world.running?.() ?? scenario.apps).includes(String(request.name))) {
        world.quitApp(String(request.name));
      } else ok = false; break;
      case 'copy': if (element) { world.clipboard = element.value ?? element.label; value = world.clipboard; } else ok = false; break;
      case 'paste': if (element && world.type && world.clipboard) world.type(element, world.clipboard); else ok = false; break;
      case 'type': if (element && world.type) world.type(element, String(request.text)); else ok = false; break;
      case 'key': world.key?.(String(request.name)); break;
      case 'scroll': world.scroll?.(request.down === true); break;
      case 'open_url': world.openUrl ? world.openUrl(String(request.url), request.newTab !== false) : ok = false; break;
      case 'open_app':
        if (world.openApp) world.openApp(String(request.name));
        else if (scenario.apps.includes(String(request.name))) world.front = String(request.name);
        else ok = false;
        break;
      default: ok = false;
    }
    client.receive({ type: 'agent_ax_reply', requestId: request.requestId as string, ok, value,
      ...(ok ? {} : { error: 'unsupported in simulation' }) });
  }));
  const revision = { taskId: 'eval', taskEpoch: 1, goalRevision: 1 };
  const endpoint = bindEndpoint(['command']);
  const input = new CommittedInputSession(endpoint, revision);
  const command = input.accept(endpoint, Buffer.from(JSON.stringify({ ...structuredClone(schema.examples[0]),
    ...revision, messageId: 'm', utteranceId: 'u', source: 'voice', text: scenario.goal }))).input;
  const made = decision(scenario.goal);
  const goal = await refineGoal(command.text, parseAgentGoal(command.text, scenario.apps), made.pickSpan?.bind(made),
    made.asksForAnswer?.bind(made));
  const registry = new TaskAdmissionRegistry(revision, input);
  const admission = registry.admit(command, { admissionId: 'a', goal: command.text, outcomeKind: 'USER_CONFIRMATION',
    scopeRef: 'agent-session:eval', completionVerifierRef: AGENT_VERIFIER, policyRevision: AGENT_POLICY,
    approvedEffects: ['READ', 'NAVIGATE', 'EXTERNAL_READ', 'LOCAL_EDIT', 'EXTERNAL_WRITE'],
    parameters: [...(goal.typedText ? [bindCommandSpan(command, 'typed-text', goal.typedText)] : []),
      ...(goal.fileName ? [bindCommandSpan(command, 'file-name', goal.fileName)] : [])] });
  let done = 0;
  const timing = { understandMs: Math.round(performance.now() - started), decideMs: 0, actMs: 0, verifyMs: 0 };
  const task = UniversalAgentTask.start(journal, registry, admission, client, { goal, decision: made,
    trace: event => {
      if (event.kind === 'step') { done = Number(event.done ?? 0); timing.decideMs += Number(event.decideMs ?? 0); }
      if (event.kind === 'result') { timing.actMs += Number(event.actMs ?? 0); timing.verifyMs += Number(event.verifyMs ?? 0); }
    },
    say: text => world.heard?.(text),
    confirmation: { async confirm(proposal: AgentProposal) {
      steps.push(`${proposal.kind} “${proposal.label.slice(0, 60)}”${proposal.risky ? ' (risky)' : ''} [done ${done}]`);
      // Risky steps are declined unless the run allows them, like a user saying no.
      return !proposal.risky || options.allowRisky === true || scenario.allowRisky === true;
    } } });
  let state = 'error';
  try { state = (await new PersistentTaskActor(journal, task, 60_000).run()).state; }
  finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
  return { name: scenario.name, goal: scenario.goal, state, success: world.done(), harmed: world.harmed?.() ?? false,
    steps, ms: Math.round(performance.now() - started), timing };
}
