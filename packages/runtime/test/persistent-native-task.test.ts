import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { schema } from '../../protocol/src/contract.ts';
import { digest } from '../../protocol/src/json.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { AttemptJournal } from '../src/attempt-journal.ts';
import { CommittedInputSession } from '../src/committed-input.ts';
import { NativeFixtureTask } from '../src/native-fixture-task.ts';
import type { NativeFixtureDecision } from '../src/native-fixture-task.ts';
import { CLMDecisionClient } from '../../providers/src/clm-decision-client.ts';
import { createJevFixtureDecision } from '../../providers/src/jev-fixture-decision.ts';
import type { FixtureDecisionEvent } from '../../providers/src/jev-fixture-decision.ts';
import { approveCandidateProjection } from '../src/action-candidates.ts';
import { PersistentTaskActor } from '../src/persistent-task-actor.ts';
import type { NativePressObservation, NativePressWorker } from '../src/native-press-authority.ts';
import { TaskAdmissionRegistry } from '../src/task-authority.ts';
import { UserPromptLedger } from '../src/user-prompts.ts';
import type { TaskRecoveryBinding } from '../src/task-recovery.ts';

const DOCS = 'SystemOne Fixture — Documents';
class Worker implements NativePressWorker {
  title = 'SystemOne Fixture';
  scope = 'native-fixture-scope';
  labels: string[] = [];
  observed: NativePressObservation | undefined;
  expected = '';
  stopCalls = 0;
  failVerify = false;
  duplicate = false;
  distractor = false;
  pressedId = '';
  onPrepare: (() => void) | undefined;
  onCommit: (() => Promise<void>) | undefined;
  async observePress(): Promise<NativePressObservation> {
    const label = this.title === 'SystemOne Fixture' ? 'Documents'
      : this.title === DOCS ? 'Budget.xlsx' : 'Open selected file';
    const control = { id: randomUUID(), role: 'AXButton' as const, label,
      enabled: true, secure: false, canPress: true };
    this.observed = { observationId: randomUUID(), scopeRef: this.scope,
      bundleId: 'com.aurium.systemone.fixture', complete: true, windowTitles: [this.title],
      controls: this.duplicate ? [control, { ...control, id: randomUUID() }]
        : this.distractor ? [control, { ...control, id: randomUUID(), label: 'Downloads' }] : [control] };
    return this.observed;
  }
  async preparePress(input: Parameters<NativePressWorker['preparePress']>[0]) {
    assert.equal(input.observationId, this.observed?.observationId);
    if (this.distractor) assert.ok(this.observed?.controls.some(c => c.id === input.candidateId));
    else assert.equal(input.candidateId, this.observed?.controls[0]?.id);
    this.pressedId = input.candidateId;
    this.expected = input.expectedWindowTitle; this.onPrepare?.();
    return { kind: 'ready' as const, preparationRef: randomUUID() };
  }
  async commitPress(): Promise<'returned_unverified'> {
    const pressed = this.distractor ? this.observed!.controls.find(c => c.id === this.pressedId)!
      : this.observed!.controls[0]!;
    this.labels.push(pressed.label);
    await this.onCommit?.();
    this.title = pressed === this.observed!.controls[0] ? this.expected : 'SystemOne Fixture — Downloads';
    return 'returned_unverified';
  }
  async verifyPress(input: { expectedWindowTitle: string }): Promise<boolean> {
    return !this.failVerify && this.title === input.expectedWindowTitle;
  }
  async stop(): Promise<boolean> { this.stopCalls++; return true; }
}

function harness(t: TestContext, kind: 'NAVIGATE' | 'LOCATE' | 'OPEN' = 'OPEN', decision?: NativeFixtureDecision) {
  const root = mkdtempSync(join(tmpdir(), 'systemone-native-actor-'));
  const path = join(root, 'journal.sqlite');
  const journal = new AttemptJournal(path);
  const worker = new Worker();
  const revision = { taskId: `native-${kind.toLowerCase()}`, taskEpoch: 1, goalRevision: 1 };
  const endpoint = bindEndpoint(['command']);
  const inputSession = new CommittedInputSession(endpoint, revision);
  const input = inputSession.accept(endpoint, Buffer.from(JSON.stringify({ ...schema.examples[0],
    ...revision, text: kind === 'NAVIGATE' ? 'Navigate synthetic fixture to Documents'
      : `${kind === 'OPEN' ? 'Open' : 'Locate'} synthetic fixture file Documents/Budget.xlsx` }))).input;
  const registry = new TaskAdmissionRegistry(revision, inputSession);
  const admission = registry.admit(input, { admissionId: randomUUID(), goal: input.text,
    outcomeKind: kind, scopeRef: worker.scope, policyRevision: 'native-ax-press-fixture-v1',
    completionVerifierRef: kind === 'NAVIGATE' ? 'native-fixture-window-title-v1'
      : kind === 'LOCATE' ? 'native-fixture-selected-title-v1' : 'native-fixture-opened-title-v1',
    approvedEffects: ['READ', 'NAVIGATE'], parameters: [{
      parameterRef: kind === 'NAVIGATE' ? 'folder-name' : 'synthetic-file-path', sourceRef: 'fixture-config',
      valueDigest: digest(kind === 'NAVIGATE' ? 'Documents' : 'Documents/Budget.xlsx') }] });
  const workflow = NativeFixtureTask.start(journal, worker, registry, admission, undefined, decision);
  const actor = new PersistentTaskActor(journal, workflow);
  t.after(() => { journal.close(); rmSync(root, { recursive: true, force: true }); });
  return { journal, worker, workflow, actor, path, revision };
}

function prompt(binding: TaskRecoveryBinding) {
  const endpoint = bindEndpoint(['clarification_reply', 'resume_request']);
  const message = { ...schema.examples.find((x: any) => x.type === 'resume_request'),
    taskId: binding.taskId, taskEpoch: binding.taskEpoch, goalRevision: binding.goalRevision,
    checkpointRef: binding.checkpointRef, checkpointDigest: binding.checkpointDigest,
    recoveryObservationId: binding.recoveryObservationId };
  const ledger = new UserPromptLedger(endpoint, binding, message.actorRef, message.uiSessionRef, Date.now);
  ledger.presentResume({ ...binding, promptId: message.promptId,
    presentationDigest: message.presentationDigest }, 10_000);
  return { ledger, intent: ledger.acceptResume(endpoint, Buffer.from(JSON.stringify(message)), binding.recoveryObservationId) };
}

test('native actor resumes at Documents and dispatches only the remaining LOCATE/OPEN steps', async t => {
  const h = harness(t);
  const budget = h.journal.getTaskBudget(h.actor.taskId)!;
  assert.equal((await h.actor.run(() => { h.actor.pause(); })).state, 'paused');
  assert.deepEqual(h.worker.labels, ['Documents']);
  const p = prompt(await h.actor.prepareRecovery()); h.actor.bindPrompt(p.ledger);
  h.actor.resume(p.ledger, p.intent);
  assert.equal((await h.actor.run()).state, 'completed');
  assert.deepEqual(h.worker.labels, ['Documents', 'Budget.xlsx', 'Open selected file']);
  assert.equal(h.journal.getTaskBudget(h.actor.taskId)?.deadlineMillis, budget.deadlineMillis);
  assert.deepEqual(h.actor.snapshot.progress?.checkpoints.map(x => x.stageRef), ['documents', 'located', 'opened']);
});

test('native actor NAVIGATE and LOCATE retain distinct terminal outcomes', async t => {
  const navigate = harness(t, 'NAVIGATE');
  assert.equal((await navigate.actor.run()).state, 'completed');
  assert.deepEqual(navigate.worker.labels, ['Documents']);
  const locate = harness(t, 'LOCATE');
  assert.equal((await locate.actor.run()).state, 'completed');
  assert.deepEqual(locate.worker.labels, ['Documents', 'Budget.xlsx']);
});

test('native recovery rejects changed scope, predicate state and duplicated controls', async t => {
  const h = harness(t);
  await h.actor.run(() => { h.actor.pause(); });
  h.worker.scope = 'another-scope';
  await assert.rejects(h.actor.prepareRecovery(), /identity/);
  h.worker.scope = 'native-fixture-scope'; h.worker.title = 'SystemOne Fixture';
  await assert.rejects(h.actor.prepareRecovery(), /no longer current/);
  h.worker.title = DOCS;
  const p = prompt(await h.actor.prepareRecovery()); h.actor.bindPrompt(p.ledger);
  h.actor.resume(p.ledger, p.intent); h.worker.duplicate = true;
  assert.equal((await h.actor.run()).state, 'paused');
  assert.deepEqual(h.worker.labels, ['Documents']);
});

test('Stop during native preparation fences a later ready result before dispatch', async t => {
  const h = harness(t);
  h.worker.onPrepare = () => { void h.actor.stop(); };
  assert.equal((await h.actor.run()).state, 'cancelled');
  assert.deepEqual(h.worker.labels, []);
  assert.equal(h.actor.snapshot.attempts.length, 0);
  assert.equal(h.worker.stopCalls, 1);
});

test('Stop after native dispatch preserves unknown outcome and excludes late success', async t => {
  const h = harness(t);
  h.worker.onCommit = async () => { await h.actor.stop(); };
  assert.equal((await h.actor.run()).state, 'cancelled');
  assert.equal(h.journal.unresolvedAttempts().length, 1);
  assert.equal(h.actor.snapshot.completion, null);
});

test('a single persistent actor owns native/browser execution and pending Stop', async t => {
  const h = harness(t);
  assert.throws(() => new PersistentTaskActor(h.journal, h.workflow), /another persistent actor/);
  const stop = h.actor.stop();
  assert.throws(() => new PersistentTaskActor(h.journal, h.workflow), /admitted progress-tracked/);
  assert.equal((await stop).workerFenced, true);
});

test('committed correction reaches the native actor Stop fence without replacing old history', async t => {
  const h = harness(t);
  await h.actor.run(() => { h.actor.pause(); });
  const endpoint = bindEndpoint(['command']);
  const session = new CommittedInputSession(endpoint, { ...h.revision, goalRevision: 2 });
  const command = session.accept(endpoint, Buffer.from(JSON.stringify({ ...schema.examples[0],
    ...h.revision, goalRevision: 2, text: 'Locate instead of opening' }))).input;
  const report = await h.actor.correct(session, command);
  assert.equal(report.journalFenced, true); assert.equal(report.workerFenced, true);
  assert.equal(h.actor.snapshot.correction?.replacementGoalRevision, 2);
  assert.deepEqual(h.worker.labels, ['Documents']);
});

test('native actor cannot claim success from a receipt with an unmatched independent predicate', async t => {
  const h = harness(t);
  h.worker.failVerify = true;
  assert.equal((await h.actor.run()).state, 'paused');
  assert.equal(h.actor.snapshot.completion, null);
  assert.equal(h.journal.unresolvedAttempts().length, 1);
});

test('an unconfirmed idle workflow fence blocks recovery even without a pending host operation', async t => {
  const h = harness(t);
  const pause = h.workflow.pause.bind(h.workflow);
  h.workflow.pause = reason => { pause(reason); return { workerFenced: false }; };
  assert.equal(h.actor.pause().workerFenced, false);
  await assert.rejects(h.actor.prepareRecovery(), /settled/);
  assert.equal(h.actor.needsRecovery, true);
});

test('synthetic CLM proposals pass through existing native admission, dispatch and independent verification', async t => {
  const provider = { id: 'fixture-clm', name: 'clm' as const, location: 'owned_service' as const, revision: 'synthetic-v1' };
  let calls = 0;
  const client = new CLMDecisionClient({ mode: 'owned_service', enabledProviderIds: [provider.id] }, provider,
    { revision: 'synthetic-only', temperature: 1, minProbability: 0.8, minMargin: 0.2 }, { async send(body) {
      calls++; const wire = JSON.parse(Buffer.from(body).toString());
      assert.deepEqual(Object.keys(wire.questions.next_action.criteria), ['c0', 'wait', 'request_help']);
      return { model: 'clm-latest', answers: { next_action: { type: 'choice', choice: 'c0',
        probabilities: { c0: 0.95, wait: 0.025, request_help: 0.025 } } }, usage: { input_tokens: 0 } };
    } });
  const h = harness(t, 'OPEN', { async select(set, observed, signal) {
    const projection = approveCandidateProjection({ set, stateText: `Synthetic scope: ${observed.windowTitles[0]}`,
      questionText: 'Choose the offered next step.', provider, disclosureReview: () => true });
    const proposal = await client.decide(set, projection, signal);
    assert.equal(proposal.observationId, observed.observationId);
    assert.equal(proposal.candidateSetDigest, set.candidateSetDigest);
    return proposal.status === 'selected' ? proposal.candidateId : null;
  } });
  assert.equal((await h.actor.run()).state, 'completed');
  assert.equal(calls, 3);
  assert.deepEqual(h.worker.labels, ['Documents', 'Budget.xlsx', 'Open selected file']);
  assert.equal(h.actor.snapshot.attempts.length, 3);
  assert.equal(h.actor.snapshot.progress?.checkpoints.length, 3);
});

test('abstention, invented IDs and non-effect decisions cannot prepare a native effect', async t => {
  for (const choice of [null, 'invented', 'wait', 'request_help']) {
    const h = harness(t, 'OPEN', { async select() { return choice; } });
    let prepared = 0; h.worker.onPrepare = () => { prepared++; };
    assert.equal((await h.actor.run()).state, 'paused');
    assert.equal(prepared, 0); assert.deepEqual(h.worker.labels, []); assert.equal(h.actor.snapshot.attempts.length, 0);
  }
});

test('Stop during an asynchronous decision rejects late selection before native preparation', async t => {
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const h = harness(t, 'OPEN', { async select() { entered(); await gate; return 'c0'; } });
  let prepared = 0; h.worker.onPrepare = () => { prepared++; };
  const run = h.actor.run(); await ready; await h.actor.stop(); release();
  assert.equal((await run).state, 'cancelled'); assert.equal(prepared, 0);
  assert.deepEqual(h.worker.labels, []); assert.equal(h.actor.snapshot.attempts.length, 0);
});

function jevReply(pick: (criteria: Record<string, string>) => string) {
  return (body: Uint8Array) => {
    const wire = JSON.parse(Buffer.from(body).toString());
    const criteria = wire.questions.next_action.criteria as Record<string, string>;
    const choice = pick(criteria);
    const probabilities = Object.fromEntries(Object.keys(criteria).map(k => [k, k === choice ? 0.97 : 0.03 / (Object.keys(criteria).length - 1)]));
    return { model: 'jev-1.13.0', answers: { next_action: { type: 'choice', choice, confidence: 0.9, probabilities } },
      usage: { input_tokens: 150, output_tokens: 3 } };
  };
}

test('opted-in Jev chooses among every fixture control and completes only through verified stages', async t => {
  const events: FixtureDecisionEvent[] = []; const bodies: string[] = [];
  const reply = jevReply(criteria => Object.entries(criteria).find(([, d]) => !d.includes('“Downloads”')
    && d.startsWith('Invoke'))![0]);
  const decision = createJevFixtureDecision({ goal: 'Open synthetic fixture file Documents/Budget.xlsx',
    report: event => events.push(event), transport: { async send(body) { bodies.push(Buffer.from(body).toString()); return reply(body); } } });
  const h = harness(t, 'OPEN', decision); h.worker.distractor = true;
  assert.equal((await h.actor.run()).state, 'completed');
  assert.deepEqual(h.worker.labels, ['Documents', 'Budget.xlsx', 'Open selected file']);
  assert.deepEqual(events.map(e => [e.status, e.label, e.probability]), [['selected', 'Documents', 0.97],
    ['selected', 'Budget.xlsx', 0.97], ['selected', 'Open selected file', 0.97]]);
  for (const body of bodies) {
    const wire = JSON.parse(body);
    assert.equal(wire.model, 'jev-1.13.0');
    assert.ok(Object.values(wire.questions.next_action.criteria).some(d => String(d).includes('“Downloads”')));
    // Only semantic text leaves the host: no control handles or observation IDs.
    for (const control of h.worker.observed!.controls) assert.ok(!body.includes(control.id));
  }
});

test('a wrong Jev choice is pressed once, fails stage verification and never completes', async t => {
  const reply = jevReply(criteria => Object.entries(criteria).find(([, d]) => d.includes('“Downloads”'))![0]);
  const decision = createJevFixtureDecision({ goal: 'Navigate synthetic fixture to Documents', report: () => {},
    transport: { async send(body) { return reply(body); } } });
  const h = harness(t, 'NAVIGATE', decision); h.worker.distractor = true;
  assert.notEqual((await h.actor.run()).state, 'completed');
  assert.deepEqual(h.worker.labels, ['Downloads']);
  assert.notEqual(h.journal.getTaskState(h.revision.taskId), 'completed');
});

test('Jev low confidence and unavailable service press nothing', async t => {
  for (const transport of [{ async send(body: Uint8Array) {
    const wire = JSON.parse(Buffer.from(body).toString()); const keys = Object.keys(wire.questions.next_action.criteria);
    return { model: 'jev-1.13.0', answers: { next_action: { type: 'choice', choice: keys[0], confidence: 0.1,
      probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.4 : 0.6 / (keys.length - 1)])) } },
      usage: { input_tokens: 1 } };
  } }, { async send(): Promise<unknown> { throw Object.assign(new Error('down'), { status: 529 }); } }]) {
    const events: FixtureDecisionEvent[] = [];
    const h = harness(t, 'OPEN', createJevFixtureDecision({ goal: 'Open synthetic fixture file Documents/Budget.xlsx',
      report: event => events.push(event), transport }));
    h.worker.distractor = true;
    let prepared = 0; h.worker.onPrepare = () => { prepared++; };
    assert.equal((await h.actor.run()).state, 'paused');
    assert.equal(prepared, 0); assert.equal(events[0]?.status, 'abstained');
  }
});
