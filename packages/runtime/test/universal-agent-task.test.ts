import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
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

/** A fake app behind the real request/reply channel. */
class FakeApp {
  app = 'YouTube Browser';
  url = '';
  playing = false;
  query = '';
  searched = false;
  /** Extra list rows, for screens big enough to be judged in rounds. */
  rows = 0;
  calls: Record<string, JSONValue>[] = [];
  elements(): AgentElement[] {
    if (!this.url) return [];
    return [...Array.from({ length: this.rows }, (_, index): AgentElement => ({ id: `e${index + 4}`, role: 'AXRow',
      label: `Message ${index + 1}`, context: 'Message list', editable: false, pressable: true })),
      { id: 'e0', role: 'AXSearchField', label: 'Search', context: 'masthead', editable: true, pressable: false,
        value: this.query },
      { id: 'e1', role: 'AXButton', label: 'Search', context: 'masthead', editable: false, pressable: true },
      { id: 'e2', role: 'AXButton', label: this.playing ? 'Pause (k)' : 'Play (k)', context: 'player',
        editable: false, pressable: true },
      { id: 'e3', role: 'AXButton', label: 'Delete playlist', context: 'library', editable: false, pressable: true },
    ];
  }
  answer(request: Record<string, JSONValue>): JSONValue {
    this.calls.push(request);
    switch (request.op) {
      case 'snapshot': return { app: this.app, bundleId: 'com.example.browser', pid: this.url ? 42 : 0,
        windowTitle: this.url ? 'YouTube' : '', url: this.url, elements: this.elements() as unknown as JSONValue,
        truncated: false, signature: `${this.url}|${this.playing}|${this.query}|${this.searched}|${this.app}`,
        runningApps: ['Notes', 'Slack'] };
      case 'open_url': this.url = String(request.url); return null;
      case 'open_app': this.app = String(request.name); return null;
      case 'type': this.query = String(request.text); return null;
      case 'press': if (request.id === 'e2') this.playing = !this.playing; if (request.id === 'e1') this.searched = true; return null;
      default: return null;
    }
  }
}

function harness(t: TestContext, text: string, plan: ((c: Record<string, JSONValue>) => boolean)[],
  confirm: (p: AgentProposal) => boolean = () => true, custom?: AgentDecision) {
  const root = mkdtempSync(join(tmpdir(), 'systemone-agent-'));
  const journal = new AttemptJournal(join(root, 'attempts.sqlite'));
  t.after(() => { journal.close(); rmSync(root, { recursive: true, force: true }); });
  const app = new FakeApp();
  let client!: AgentAXClient;
  client = new AgentAXClient(request => {
    queueMicrotask(() => client.receive({ type: 'agent_ax_reply', requestId: request.requestId as string, ok: true,
      value: app.answer(request) }));
  });
  const revision = { taskId: 'agent-task', taskEpoch: 1, goalRevision: 1 };
  const endpoint = bindEndpoint(['command']);
  const input = new CommittedInputSession(endpoint, revision);
  const command = input.accept(endpoint, Buffer.from(JSON.stringify({ ...structuredClone(schema.examples[0]),
    ...revision, messageId: 'm', utteranceId: 'u', source: 'voice', text }))).input;
  const goal = parseAgentGoal(command.text, []);
  const registry = new TaskAdmissionRegistry(revision, input);
  const admission = registry.admit(command, { admissionId: 'a', goal: command.text, outcomeKind: 'USER_CONFIRMATION',
    scopeRef: 'agent-session:test', completionVerifierRef: AGENT_VERIFIER, policyRevision: AGENT_POLICY,
    approvedEffects: ['READ', 'NAVIGATE', 'EXTERNAL_READ', 'LOCAL_EDIT', 'EXTERNAL_WRITE'],
    parameters: goal.typedText ? [bindCommandSpan(command, 'typed-text', goal.typedText)] : [] });
  let index = 0;
  const decision: AgentDecision = custom ?? { async select(set) {
    const want = plan[index++];
    return (set.candidates.find(c => want?.(c))?.candidateId as string | undefined) ?? null;
  } };
  const proposals: AgentProposal[] = [];
  const task = UniversalAgentTask.start(journal, registry, admission, client, { goal, decision,
    confirmation: { async confirm(p) { proposals.push(p); return confirm(p); } } });
  return { app, journal, proposals, actor: new PersistentTaskActor(journal, task, 60_000) };
}

const op = (operation: string, text?: RegExp) => (c: Record<string, JSONValue>) =>
  c.operation === operation && (!text || text.test(String(c.description)));

test('a spoken goal opens a site, types only the bound words, searches, plays and finishes on confirmation', async t => {
  const h = harness(t, 'go to youtube and search for lofi beats', [op('navigate'), op('set_value'),
    op('invoke', /“Search”/u), op('invoke', /Play \(k\)/u), op('finish')]);
  assert.equal((await h.actor.run()).state, 'completed');
  assert.deepEqual(h.proposals.map(p => p.kind), ['open_url', 'type', 'press', 'press', 'finish']);
  assert.equal(h.app.url, 'https://youtube.com/');
  assert.equal(h.app.query, 'lofi beats');
  assert.equal(h.app.playing, true);
  const typed = h.app.calls.find(call => call.op === 'type');
  assert.equal(typed?.text, 'lofi beats');
  const attempts = h.journal.attemptsForTask('agent-task');
  assert.equal(attempts.length, 4);
  assert.ok(attempts.every(a => a.outcome?.verification === 'matched'));
});

test('risky labels are flagged, a declined step dispatches nothing, and no-change steps do not block', async t => {
  const risky = harness(t, 'go to youtube', [op('navigate'), op('invoke', /Delete playlist/u)], p => p.kind !== 'press');
  assert.equal((await risky.actor.run()).state, 'paused');
  assert.equal(risky.proposals.at(-1)?.risky, true);
  assert.ok(!risky.app.calls.some(call => call.op === 'press'));

  const unchanged = harness(t, 'go to youtube', [op('navigate'), op('key_chord'), op('finish')]);
  assert.equal((await unchanged.actor.run()).state, 'completed');
  const attempts = unchanged.journal.attemptsForTask('agent-task');
  assert.equal(attempts.at(-1)?.outcome?.verification, 'not_matched');
  assert.equal(unchanged.journal.unresolvedAttempts().length, 0);
});

test('without typed words no typing is offered, and abstention pauses with no effect', async t => {
  const h = harness(t, 'play the video', [op('set_value')]);
  h.app.url = 'https://youtube.com/watch';
  assert.equal((await h.actor.run()).state, 'paused');
  assert.equal(h.app.calls.filter(call => call.op !== 'snapshot').length, 0);
});

test('open apps are offered as switch targets and the agent switches by name', async t => {
  const h = harness(t, 'switch to Slack', [op('activate_app', /Slack/u), op('finish')]);
  h.app.url = 'https://youtube.com/';
  assert.equal((await h.actor.run()).state, 'completed');
  assert.deepEqual(h.proposals.map(p => p.kind), ['open_app', 'finish']);
  assert.equal(h.app.calls.find(call => call.op === 'open_app')?.name, 'Slack');
});

test('a general list with nothing that fits is ruled out on that screen and the step is decided again', async t => {
  const offered: string[][] = [];
  const decision: AgentDecision = {
    async select(set) {
      offered.push(set.candidates.map(c => String(c.description)));
      const menu = set.candidates.find(c => /own menu commands/u.test(String(c.description)));
      return String((menu ?? set.candidates.find(c => c.operation === 'finish'))!.candidateId);
    },
    async chooseOne() { return null; },
  };
  const h = harness(t, 'turn on night mode', [], () => true, decision);
  h.app.url = 'https://youtube.com/';
  assert.equal((await h.actor.run()).state, 'completed');
  assert.equal(offered.length, 2);
  assert.ok(offered[0]!.some(text => /own menu commands/u.test(text)));
  assert.ok(!offered[1]!.some(text => /own menu commands/u.test(text)));
});

test('only round picks that compete with the strongest reach the final', async t => {
  const finals: string[][] = [];
  const decision: AgentDecision = {
    // Each round: a confident row where there is one, else a weak scroll against strong fallbacks.
    async bestActions(set) {
      const row = set.candidates.find(c => /“Message 2”/u.test(String(c.description)));
      const twin = set.candidates.find(c => /“Message 3”/u.test(String(c.description)));
      const scroll = set.candidates.find(c => c.operation === 'scroll');
      return row ? [{ id: String(row.candidateId), odds: 30 }, ...(twin ? [{ id: String(twin.candidateId), odds: 4 }] : [])]
        : scroll ? [{ id: String(scroll.candidateId), odds: 6 }] : [];
    },
    async select(set) {
      finals.push(set.candidates.filter(c => c.delivery !== 'controller').map(c => String(c.description)));
      const row = set.candidates.find(c => /“Message 2”/u.test(String(c.description)));
      return String((row ?? set.candidates.find(c => c.operation === 'finish'))!.candidateId);
    },
  };
  const h = harness(t, 'open message 2', [], () => true, decision);
  h.app.url = 'https://mail.example.com/';
  h.app.rows = 80;
  await h.actor.run();
  assert.equal(finals[0]!.length, 1);
  assert.match(finals[0]![0]!, /“Message 2”/u);
});
