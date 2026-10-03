import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { schema } from '../../protocol/src/contract.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { AttemptJournal } from '../src/attempt-journal.ts';
import { CommittedInputSession } from '../src/committed-input.ts';
import { TaskAdmissionRegistry } from '../src/task-authority.ts';

function harness(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'systemone-task-replacement-'));
  const path = join(root, 'journal.sqlite'); const journal = new AttemptJournal(path);
  t.after(() => { journal.close(); rmSync(root, { recursive: true, force: true }); });
  const endpoint = bindEndpoint(['command']);
  const revision = { taskId: 'original-task', taskEpoch: 1, goalRevision: 2 };
  const session = new CommittedInputSession(endpoint, revision);
  const input = session.accept(endpoint, Buffer.from(JSON.stringify({ ...schema.examples[0], ...revision }))).input;
  const draft = { admissionId: 'admission', goal: input.text, outcomeKind: 'NAVIGATE' as const,
    scopeRef: 'scope', completionVerifierRef: 'verifier', policyRevision: 'policy',
    approvedEffects: ['READ' as const], parameters: [] };
  const target = { taskId: 'replacement-task', taskEpoch: 1, goalRevision: 2 };
  function admission() {
    const transferred = session.transferClaimedCorrection(input, target);
    const registry = new TaskAdmissionRegistry(target, transferred.session);
    return { registry, admitted: registry.admit(transferred.input, draft) };
  }
  return { journal, path, endpoint, revision, session, input, draft, target, admission };
}
test('transferred command without matching durable correction cannot install any task or lineage', t => {
  const h = harness(t);
  h.journal.startTask(h.input.taskId, 1, 1); h.journal.cancelTask(h.input.taskId);
  h.session.claimForCorrection(h.input);
  const { registry, admitted } = h.admission();
  assert.throws(() => h.journal.startAdmittedTask(registry, admitted), /cancelled correction/);
  assert.equal(h.journal.getTaskRecord(h.target.taskId), undefined);
  assert.equal(h.journal.getTaskRecord(h.input.taskId)!.replacement, null);
});
test('durable lineage and source correction survive restart without resurrecting authority', t => {
  const h = harness(t);
  h.journal.startTask(h.input.taskId, 1, 1);
  h.journal.cancelTaskForCorrection(h.input.taskId, h.session, h.input);
  const { registry, admitted } = h.admission();
  assert.throws(() => h.journal.startAdmittedTask(registry, { ...admitted }), /issued/);
  assert.equal(h.journal.getTaskRecord(h.target.taskId), undefined);
  h.journal.startAdmittedTask(registry, admitted);
  assert.deepEqual(h.journal.getTaskRecord(h.input.taskId)!.replacement, { taskId: h.target.taskId });
  const reopened = new AttemptJournal(h.path);
  try {
    reopened.recoverAfterRestart();
    assert.equal(reopened.getTaskState(h.target.taskId), 'paused');
    assert.deepEqual(reopened.getTaskRecord(h.target.taskId)!.replaces, { taskId: h.input.taskId });
    assert.equal(reopened.getTaskRecord(h.input.taskId)!.goalRevision, 1);
    assert.equal(reopened.getTaskRecord(h.input.taskId)!.state, 'cancelled');
  } finally { reopened.close(); }
});
test('altered source command digest refuses lineage even with matching message and revision IDs', t => {
  const h = harness(t); h.journal.startTask(h.input.taskId, 1, 1);
  h.journal.cancelTaskForCorrection(h.input.taskId, h.session, h.input);
  const forgedSession = new CommittedInputSession(h.endpoint, h.revision);
  const forgedInput = forgedSession.accept(h.endpoint,
    Buffer.from(JSON.stringify({ ...h.input, text: 'A different goal' }))).input;
  forgedSession.claimForCorrection(forgedInput);
  const transfer = forgedSession.transferClaimedCorrection(forgedInput, h.target);
  const registry = new TaskAdmissionRegistry(h.target, transfer.session);
  const admitted = registry.admit(transfer.input, { ...h.draft, goal: forgedInput.text });
  assert.throws(() => h.journal.startAdmittedTask(registry, admitted), /cancelled correction/);
  assert.equal(h.journal.getTaskRecord(h.target.taskId), undefined);
});

test('a second replacement for the same source cannot rewrite lineage or install another task', t => {
  const h = harness(t); h.journal.startTask(h.input.taskId, 1, 1);
  h.journal.cancelTaskForCorrection(h.input.taskId, h.session, h.input);
  const first = h.admission(); h.journal.startAdmittedTask(first.registry, first.admitted);
  h.journal.cancelTask(h.target.taskId);
  const session = new CommittedInputSession(h.endpoint, h.revision);
  const input = session.accept(h.endpoint, Buffer.from(JSON.stringify(h.input))).input;
  session.claimForCorrection(input);
  const target = { ...h.target, taskId: 'second-replacement' };
  const transfer = session.transferClaimedCorrection(input, target);
  const registry = new TaskAdmissionRegistry(target, transfer.session);
  const admitted = registry.admit(transfer.input, { ...h.draft, admissionId: 'different-admission' });
  assert.throws(() => h.journal.startAdmittedTask(registry, admitted), /UNIQUE/);
  assert.equal(h.journal.getTaskRecord(target.taskId), undefined);
  assert.deepEqual(h.journal.getTaskRecord(h.input.taskId)!.replacement, { taskId: h.target.taskId });
});
test('unrelated paused history blocks derived replacement admission transactionally', t => {
  const h = harness(t); h.journal.startTask(h.input.taskId, 1, 1);
  h.journal.cancelTaskForCorrection(h.input.taskId, h.session, h.input);
  h.journal.startTask('other-paused-task', 1, 1); h.journal.pauseTask('other-paused-task', 'manual');
  const { registry, admitted } = h.admission();
  assert.throws(() => h.journal.startAdmittedTask(registry, admitted), /cancelled correction/);
  assert.equal(h.journal.getTaskRecord(h.target.taskId), undefined);
  assert.equal(h.journal.getTaskRecord(h.input.taskId)!.replacement, null);
});
