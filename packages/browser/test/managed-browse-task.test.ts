import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { startPortalFixture } from '../../fixtures/portal.ts';
import { schema } from '../../protocol/src/contract.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { AttemptJournal } from '../../runtime/src/attempt-journal.ts';
import { bindCommandValue } from '../../runtime/src/command-value-span.ts';
import { CommittedInputSession } from '../../runtime/src/committed-input.ts';
import { PersistentTaskActor } from '../../runtime/src/persistent-task-actor.ts';
import { parseScopedBrowse } from '../../runtime/src/scoped-native-command.ts';
import { TaskAdmissionRegistry } from '../../runtime/src/task-authority.ts';
import { BROWSE_POLICY, BROWSE_VERIFIER, ManagedBrowseTask } from '../src/managed-browse-task.ts';
import type { BrowseConfirmation, BrowseDecision, BrowseProposal } from '../src/managed-browse-task.ts';
import { ManagedObservationSession } from '../src/managed-observation.ts';

async function harness(t: TestContext, decision: BrowseDecision, confirmation: BrowseConfirmation) {
  const portal = await startPortalFixture();
  const root = mkdtempSync(join(tmpdir(), 'systemone-browse-'));
  const journal = new AttemptJournal(join(root, 'attempts.sqlite'));
  const text = `go to ${new URL(portal.url).host} and search for April`;
  const parsed = parseScopedBrowse(text);
  const session = await ManagedObservationSession.launch(parsed.startUrl, {
    allowedOrigins: [new URL(parsed.startUrl).origin], headless: true });
  t.after(async () => { await session.close().catch(() => {}); journal.close(); await portal.close();
    rmSync(root, { recursive: true, force: true }); });
  const revision = { taskId: 'browse-task', taskEpoch: 1, goalRevision: 1 };
  const endpoint = bindEndpoint(['command']);
  const input = new CommittedInputSession(endpoint, revision);
  const command = input.accept(endpoint, Buffer.from(JSON.stringify({ ...structuredClone(schema.examples[0]),
    ...revision, messageId: 'browse-command', utteranceId: 'browse-utterance', source: 'voice', text }))).input;
  const registry = new TaskAdmissionRegistry(revision, input);
  const admission = registry.admit(command, { admissionId: 'browse-admission', goal: command.text,
    outcomeKind: 'USER_CONFIRMATION', scopeRef: session.scopeRef, completionVerifierRef: BROWSE_VERIFIER,
    policyRevision: BROWSE_POLICY, approvedEffects: ['READ', 'NAVIGATE', 'EXTERNAL_READ', 'LOCAL_EDIT', 'EXTERNAL_WRITE'],
    parameters: [bindCommandValue(command, 'search-text', parsed.prefix!, parsed.searchText!)] });
  const task = ManagedBrowseTask.start(journal, registry, admission, session,
    { searchText: parsed.searchText, decision, confirmation });
  return { journal, session, task, actor: new PersistentTaskActor(journal, task, 60_000) };
}

/** Picks by operation and observed label; never sees handles or invents IDs. */
function scripted(plan: { operation: string; label?: RegExp }[]): BrowseDecision {
  let index = 0;
  return { async select(set, observed) {
    const want = plan[index++];
    const match = set.candidates.find(candidate => candidate.operation === want?.operation
      && (!want?.label || want.label.test(String(candidate.description))));
    assert.ok(set.candidates.every(candidate => !String(candidate.description).includes(observed.observationId)));
    return (match?.candidateId as string | undefined) ?? null;
  } };
}

test('a voice browse goal fills, submits, follows a result and finishes only on user confirmation', async t => {
  const proposals: BrowseProposal[] = [];
  const h = await harness(t, scripted([{ operation: 'set_value' }, { operation: 'invoke' },
    { operation: 'navigate', label: /Open INV-/u }, { operation: 'finish' }]),
  { async confirm(proposal) { proposals.push(proposal); return true; } });
  assert.equal((await h.actor.run()).state, 'completed');
  assert.deepEqual(proposals.map(p => p.kind), ['fill', 'submit', 'navigate', 'finish']);
  assert.equal(proposals[0]?.label, 'Find invoice');
  assert.match(proposals[2]?.destinationUrl ?? '', /\/invoices\/INV-/u);
  const attempts = h.journal.attemptsForTask('browse-task');
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every(a => a.outcome?.verification === 'matched'));
  assert.match((await h.session.observe()).url, /\/invoices\/INV-/u);
});

test('a declined or stopped confirmation dispatches nothing', async t => {
  const declined = await harness(t, scripted([{ operation: 'set_value' }]), { async confirm() { return false; } });
  assert.equal((await declined.actor.run()).state, 'paused');
  assert.equal(declined.journal.attemptsForTask('browse-task').length, 0);

  let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
  const stopped = await harness(t, scripted([{ operation: 'set_value' }]), { confirm(_p, signal) {
    entered();
    return new Promise(resolve => signal.addEventListener('abort', () => resolve(true), { once: true }));
  } });
  const run = stopped.actor.run(); await waiting; await stopped.actor.stop();
  assert.equal((await run).state, 'cancelled');
  assert.equal(stopped.journal.attemptsForTask('browse-task').length, 0);
});

test('abstention and non-effect choices pause without any page effect', async t => {
  for (const operation of ['request_help', 'wait', 'none']) {
    const h = await harness(t, scripted([{ operation }]), { async confirm() { return true; } });
    assert.equal((await h.actor.run()).state, 'paused');
    assert.equal(h.journal.attemptsForTask('browse-task').length, 0);
  }
});
