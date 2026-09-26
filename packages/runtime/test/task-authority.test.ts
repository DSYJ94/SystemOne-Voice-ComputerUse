import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schema } from '../../protocol/src/contract.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { CommittedInputSession } from '../src/committed-input.ts';
import { ApprovalLedger, TaskAdmissionRegistry } from '../src/task-authority.ts';
import type { ApprovalBinding, TaskAdmissionDraft } from '../src/task-authority.ts';

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const commandRevision = { taskId: 'task-001', taskEpoch: 1, goalRevision: 1 };
const approvalRevision = { taskId: 'task-approval-fixture', taskEpoch: 4, goalRevision: 2 };
const wallBase = Date.parse('2026-09-25T17:00:02Z');

function committedInput(mode: 'command' | 'dictation' = 'command', messageId = 'm1') {
  const endpoint = bindEndpoint(['command']);
  const session = new CommittedInputSession(endpoint, commandRevision);
  return session.accept(endpoint, bytes({ ...structuredClone(schema.examples[0]), mode,
    messageId, utteranceId: `utterance-${messageId}` })).input;
}

function admissionDraft(): TaskAdmissionDraft {
  return {
    admissionId: 'admission-1',
    goal: 'Locate Budget.xlsx without opening it',
    outcomeKind: 'LOCATE',
    scopeRef: 'scope-task-001',
    completionVerifierRef: 'verifier.locate.v1',
    policyRevision: 'policy.finder-navigation.v1',
    approvedEffects: ['READ', 'NAVIGATE'],
    parameters: [{
      parameterRef: 'filename',
      sourceRef: 'utterance.utt-1.r3',
      valueDigest: 'd'.repeat(64),
    }],
  };
}

function approvalMessage() {
  return structuredClone(schema.examples.at(-1));
}

function approvalBinding(): ApprovalBinding {
  const approval = approvalMessage();
  return {
    promptId: approval.promptId,
    presentationDigest: approval.presentationDigest,
    scopeRef: approval.scopeRef,
    candidateId: approval.candidateId,
    observationId: approval.observationId,
    candidateSetDigest: approval.candidateSetDigest,
    actionDigest: approval.actionDigest,
    policyRevision: approval.policyRevision,
    approvedEffects: [...approval.approvedEffects],
  };
}

function approvalFixture() {
  let monotonic = 100;
  let wall = wallBase;
  const endpoint = bindEndpoint(['approval']);
  const ledger = new ApprovalLedger(endpoint, approvalRevision,
    'local-user-fixture', 'native-ui-fixture', () => monotonic, () => wall);
  const binding = approvalBinding();
  ledger.present(binding, 50);
  return {
    endpoint, ledger, binding,
    setMonotonic(value: number) { monotonic = value; },
    setWall(value: number) { wall = value; },
  };
}

test('task admission binds a final command to outcome, provenance and policy', () => {
  const registry = new TaskAdmissionRegistry(commandRevision);
  const draft = admissionDraft();
  const admission = registry.admit(committedInput(), draft);
  assert.equal(admission.commandMessageId, 'm1');
  assert.equal(admission.outcomeKind, 'LOCATE');
  assert.deepEqual(admission.parameters, draft.parameters);
  assert.ok(Object.isFrozen(admission));
  assert.ok(Object.isFrozen(admission.parameters));
  assert.ok(Object.isFrozen(admission.parameters[0]));
});

test('dictation, stale commands and replay cannot admit a task', () => {
  assert.throws(() => new TaskAdmissionRegistry(commandRevision)
    .admit(committedInput('dictation'), admissionDraft()), /dictation/);
  const stale = committedInput();
  stale.goalRevision = 2;
  assert.throws(() => new TaskAdmissionRegistry(commandRevision).admit(stale, admissionDraft()), /revision/);
  const registry = new TaskAdmissionRegistry(commandRevision);
  registry.admit(committedInput(), admissionDraft());
  assert.throws(() => registry.admit(committedInput(), { ...admissionDraft(), admissionId: 'other' }), /replay/);
  assert.throws(() => registry.admit(committedInput('command', 'm-other'),
    { ...admissionDraft(), admissionId: 'other' }), /already admitted/);
});

test('task admission rejects unsupported effects and unbound parameter provenance', () => {
  const input = committedInput();
  assert.throws(() => new TaskAdmissionRegistry(commandRevision).admit(input, {
    ...admissionDraft(), approvedEffects: ['UNKNOWN'],
  }), /effect/);
  assert.throws(() => new TaskAdmissionRegistry(commandRevision).admit(input, {
    ...admissionDraft(), parameters: [{ parameterRef: 'filename', sourceRef: '', valueDigest: 'd'.repeat(64) }],
  }), /parameter source/);
});

test('a task with no permitted effects can be admitted for confirmation only', () => {
  const admission = new TaskAdmissionRegistry(commandRevision).admit(committedInput(), {
    ...admissionDraft(), outcomeKind: 'USER_CONFIRMATION', approvedEffects: [],
  });
  assert.deepEqual(admission.approvedEffects, []);
});

test('approval from the exact UI endpoint is accepted and consumed once', () => {
  const { endpoint, ledger, binding } = approvalFixture();
  const accepted = ledger.accept(binding.promptId, endpoint, bytes(approvalMessage()));
  assert.equal(accepted.approvalRef, 'approval-upload-1');
  assert.ok(Object.isFrozen(accepted));
  assert.ok(Object.isFrozen(accepted.approvedEffects));
  assert.deepEqual(ledger.consume(accepted.approvalRef, binding), accepted);
  assert.throws(() => ledger.consume(accepted.approvalRef, binding), /consumed/);
});

test('issuer text cannot let another endpoint mint an approval', () => {
  const { endpoint, ledger, binding } = approvalFixture();
  const impostor = bindEndpoint(['approval']);
  assert.throws(() => ledger.accept(binding.promptId, impostor, bytes(approvalMessage())), /endpoint/);
  assert.equal(ledger.accept(binding.promptId, endpoint, bytes(approvalMessage())).type, 'approval');
});

for (const key of ['promptId', 'presentationDigest', 'scopeRef', 'candidateId', 'observationId',
  'candidateSetDigest', 'actionDigest', 'policyRevision', 'actorRef', 'uiSessionRef',
  'taskId', 'taskEpoch', 'goalRevision'] as const) {
  test(`approval rejects changed ${key} without consuming the prompt`, () => {
    const { endpoint, ledger, binding } = approvalFixture();
    const changed = approvalMessage();
    changed[key] = typeof changed[key] === 'number' ? changed[key] + 1
      : key.endsWith('Digest') ? 'f'.repeat(64) : 'different';
    assert.throws(() => ledger.accept(binding.promptId, endpoint, bytes(changed)));
    assert.equal(ledger.accept(binding.promptId, endpoint, bytes(approvalMessage())).type, 'approval');
  });
}

test('approval effects match the presentation exactly regardless of order', () => {
  const { endpoint, ledger, binding } = approvalFixture();
  const reordered = approvalMessage();
  reordered.approvedEffects.reverse();
  const accepted = ledger.accept(binding.promptId, endpoint, bytes(reordered));
  assert.equal(ledger.consume(accepted.approvalRef, { ...binding,
    approvedEffects: [...binding.approvedEffects].reverse() }).approvalRef, accepted.approvalRef);

  const second = approvalFixture();
  const incomplete = approvalMessage();
  incomplete.approvedEffects = ['UPLOAD'];
  assert.throws(() => second.ledger.accept(second.binding.promptId, second.endpoint, bytes(incomplete)), /approvedEffects/);
});

test('approval wire lifetime and monotonic prompt lifetime both fail closed', () => {
  for (const mutation of [
    (message: any) => { message.issuedAt = '2026-09-25T17:00:03Z'; },
    (message: any) => { message.expiresAt = '2026-09-25T17:00:02Z'; },
    (message: any) => { message.expiresAt = '2026-09-25T17:02:00Z'; },
  ]) {
    const { endpoint, ledger, binding } = approvalFixture();
    const message = approvalMessage(); mutation(message);
    assert.throws(() => ledger.accept(binding.promptId, endpoint, bytes(message)), /lifetime/);
  }
  const fixture = approvalFixture();
  fixture.setMonotonic(150);
  assert.throws(() => fixture.ledger.accept(fixture.binding.promptId, fixture.endpoint,
    bytes(approvalMessage())), /expired/);
});

test('accepted approval expires before consumption and cannot be revived', () => {
  const fixture = approvalFixture();
  const accepted = fixture.ledger.accept(fixture.binding.promptId, fixture.endpoint, bytes(approvalMessage()));
  fixture.setWall(Date.parse('2026-09-25T17:00:05Z'));
  assert.throws(() => fixture.ledger.consume(accepted.approvalRef, fixture.binding), /expired/);
  fixture.setWall(wallBase);
  assert.throws(() => fixture.ledger.consume(accepted.approvalRef, fixture.binding), /consumed/);
});

test('registered prompt is copied, bounded and fenced by closure', () => {
  let now = 0;
  const endpoint = bindEndpoint(['approval']);
  const ledger = new ApprovalLedger(endpoint, approvalRevision, 'local-user-fixture',
    'native-ui-fixture', () => now, () => wallBase);
  const mutable: any = approvalBinding();
  ledger.present(mutable, 50);
  mutable.actionDigest = 'f'.repeat(64);
  mutable.approvedEffects.pop();
  assert.equal(ledger.accept(approvalBinding().promptId, endpoint, bytes(approvalMessage())).type, 'approval');
  assert.throws(() => ledger.present(approvalBinding(), 50), /replay/);
  ledger.close();
  now++;
  assert.throws(() => ledger.consume('approval-upload-1', approvalBinding()), /closed/);
});
