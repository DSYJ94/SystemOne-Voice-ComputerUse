import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schema } from '../../protocol/src/contract.ts';
import type { JSONValue } from '../../protocol/src/json.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { AgentAXClient } from '../src/agent-ax-client.ts';
import type { AgentElement } from '../src/agent-ax-client.ts';
import { bindCommandSpan, parseAgentGoal } from '../src/agent-goal.ts';
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
}

export interface SimScreen {
  readonly app: string;
  readonly bundleId: string;
  readonly windowTitle: string;
  readonly url?: string;
  readonly elements: readonly SimElement[];
}

/** A small simulated Mac: apps with screens, keyboard behaviour, and a goal check. */
export interface Scenario {
  readonly name: string;
  readonly goal: string;
  readonly apps: readonly string[];
  /** Built fresh per run so state never leaks between runs. */
  readonly world: () => SimWorld;
}

export interface SimWorld {
  front: string;
  screen(): SimScreen | null;
  key?(name: string): void;
  type?(element: SimElement, text: string): void;
  scroll?(down: boolean): void;
  openUrl?(url: string): void;
  openApp?(name: string): void;
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
          pressable: item.editable !== true || item.press !== undefined,
          ...(item.value !== undefined ? { value: item.value } : {}),
          ...(item.selected ? { selected: true } : {}), ...(item.url ? { url: item.url } : {}) }));
        value = { app: screen?.app ?? 'no app', bundleId: screen?.bundleId ?? '', pid: screen ? 1 : 0,
          windowTitle: screen?.windowTitle ?? '', url: screen?.url ?? '', elements: described as unknown as JSONValue,
          truncated: false, signature: JSON.stringify([screen?.app, screen?.windowTitle, screen?.url,
            elements.map(item => [item.label, item.value, item.selected])]),
          runningApps: scenario.apps.filter(name => name !== screen?.app) };
        break;
      }
      case 'press': if (element?.press) element.press(); else ok = !!element; break;
      case 'type': if (element && world.type) world.type(element, String(request.text)); else ok = false; break;
      case 'key': world.key?.(String(request.name)); break;
      case 'scroll': world.scroll?.(request.down === true); break;
      case 'open_url': world.openUrl ? world.openUrl(String(request.url)) : ok = false; break;
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
  const goal = parseAgentGoal(command.text, scenario.apps);
  const registry = new TaskAdmissionRegistry(revision, input);
  const admission = registry.admit(command, { admissionId: 'a', goal: command.text, outcomeKind: 'USER_CONFIRMATION',
    scopeRef: 'agent-session:eval', completionVerifierRef: AGENT_VERIFIER, policyRevision: AGENT_POLICY,
    approvedEffects: ['READ', 'NAVIGATE', 'EXTERNAL_READ', 'LOCAL_EDIT', 'EXTERNAL_WRITE'],
    parameters: goal.typedText ? [bindCommandSpan(command, 'typed-text', goal.typedText)] : [] });
  const task = UniversalAgentTask.start(journal, registry, admission, client, { goal, decision: decision(scenario.goal),
    confirmation: { async confirm(proposal: AgentProposal) {
      steps.push(`${proposal.kind} “${proposal.label.slice(0, 60)}”${proposal.risky ? ' (risky)' : ''}`);
      // Risky steps are declined unless the run allows them, like a user saying no.
      return !proposal.risky || options.allowRisky === true;
    } } });
  let state = 'error';
  try { state = (await new PersistentTaskActor(journal, task, 60_000).run()).state; }
  finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
  return { name: scenario.name, goal: scenario.goal, state, success: world.done(), harmed: world.harmed?.() ?? false,
    steps, ms: Math.round(performance.now() - started) };
}
