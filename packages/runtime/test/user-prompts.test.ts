import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schema } from '../../protocol/src/contract.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { UserPromptLedger } from '../src/user-prompts.ts';

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const clarification = () => structuredClone(schema.examples.find((x: any) => x.type === 'clarification_reply'));
const resume = () => structuredClone(schema.examples.find((x: any) => x.type === 'resume_request'));

function fixture(kind: 'clarification' | 'resume') {
  let now = 100;
  const endpoint = bindEndpoint(['clarification_reply', 'resume_request']);
  const source = kind === 'clarification' ? clarification() : resume();
  const ledger = new UserPromptLedger(endpoint, {
    taskId: source.taskId, taskEpoch: source.taskEpoch, goalRevision: source.goalRevision,
  }, source.actorRef, source.uiSessionRef, () => now);
  if (kind === 'clarification') {
    ledger.presentClarification({
      promptId: source.promptId, presentationDigest: source.presentationDigest,
      observationId: source.observationId, optionIds: ['file-documents', 'file-downloads'],
    }, 50);
  } else {
    ledger.presentResume({
      state: 'paused', promptId: source.promptId,
      presentationDigest: source.presentationDigest,
      checkpointRef: source.checkpointRef, checkpointDigest: source.checkpointDigest,
      recoveryObservationId: source.recoveryObservationId,
    }, 50);
  }
  return { endpoint, ledger, source, setTime(value: number) { now = value; } };
}

test('clarification selects only a displayed option at the current observation', () => {
  const { endpoint, ledger, source } = fixture('clarification');
  const result = ledger.acceptClarification(endpoint, bytes(source), source.observationId);
  assert.equal(result.selectedOptionId, 'file-documents');
  assert.ok(Object.isFrozen(result));
  assert.throws(() => ledger.acceptClarification(endpoint, bytes(source), source.observationId), /unregistered/);
});

test('unoffered choices, changed presentation and stale observation fail closed', () => {
  for (const changed of [
    { selectedOptionId: 'file-secret' },
    { presentationDigest: 'f'.repeat(64) },
    { observationId: 'obs-new' },
  ]) {
    const { endpoint, ledger, source } = fixture('clarification');
    assert.throws(() => ledger.acceptClarification(endpoint,
      bytes({ ...source, ...changed }), source.observationId));
    assert.equal(ledger.acceptClarification(endpoint, bytes(source), source.observationId)
      .selectedOptionId, 'file-documents');
  }
  const { endpoint, ledger, source } = fixture('clarification');
  assert.throws(() => ledger.acceptClarification(endpoint, bytes(source), 'obs-new'), /observation changed/);
  assert.throws(() => ledger.acceptClarification(endpoint, bytes(source), source.observationId), /unregistered/);
});

test('resume is one intent bound to a paused checkpoint and fresh recovery observation', () => {
  const { endpoint, ledger, source } = fixture('resume');
  const result = ledger.acceptResume(endpoint, bytes(source), source.recoveryObservationId);
  assert.equal(result.checkpointRef, 'checkpoint-1');
  assert.ok(Object.isFrozen(result));
  assert.throws(() => ledger.acceptResume(endpoint, bytes(source), source.recoveryObservationId), /unregistered/);
});

test('resume refuses changed checkpoint, observation and non-paused presentation', () => {
  for (const changed of [
    { checkpointRef: 'another' },
    { checkpointDigest: 'a'.repeat(64) },
    { recoveryObservationId: 'old' },
  ]) {
    const { endpoint, ledger, source } = fixture('resume');
    assert.throws(() => ledger.acceptResume(endpoint,
      bytes({ ...source, ...changed }), source.recoveryObservationId));
  }
  const { endpoint, ledger, source } = fixture('resume');
  assert.throws(() => ledger.acceptResume(endpoint, bytes(source), 'new-observation'), /observation changed/);
  const empty = new UserPromptLedger(endpoint, {
    taskId: source.taskId, taskEpoch: source.taskEpoch, goalRevision: source.goalRevision,
  }, source.actorRef, source.uiSessionRef, () => 100);
  assert.throws(() => empty.acceptResume(endpoint, bytes(source), source.recoveryObservationId), /unregistered/);
  assert.throws(() => empty.presentResume({ state: 'ready', promptId: source.promptId,
    presentationDigest: source.presentationDigest, checkpointRef: source.checkpointRef,
    checkpointDigest: source.checkpointDigest,
    recoveryObservationId: source.recoveryObservationId } as any, 50), /paused/);
});

test('native UI endpoint, actor, session and task revision must match', () => {
  for (const kind of ['clarification', 'resume'] as const) {
    const source = kind === 'clarification' ? clarification() : resume();
    const accept = (ledger: UserPromptLedger, endpoint: ReturnType<typeof bindEndpoint>, value: unknown) =>
      kind === 'clarification'
        ? ledger.acceptClarification(endpoint, bytes(value), source.observationId)
        : ledger.acceptResume(endpoint, bytes(value), source.recoveryObservationId);
    const peer = fixture(kind);
    assert.throws(() => accept(peer.ledger, bindEndpoint(['clarification_reply', 'resume_request']),
      source), /endpoint/);
    for (const [key, value] of [['actorRef', 'other'], ['uiSessionRef', 'other'],
      ['taskEpoch', source.taskEpoch + 1], ['goalRevision', source.goalRevision + 1]] as const) {
      const current = fixture(kind);
      assert.throws(() => accept(current.ledger, current.endpoint, { ...source, [key]: value }));
    }
  }
});

test('prompt IDs cannot be reused; expiry and closure reject delayed replies', () => {
  const { endpoint, ledger, source, setTime } = fixture('clarification');
  assert.throws(() => ledger.presentClarification({ promptId: source.promptId,
    presentationDigest: source.presentationDigest, observationId: source.observationId,
    optionIds: ['one', 'two'] }, 50), /active/);
  setTime(150);
  assert.throws(() => ledger.acceptClarification(endpoint, bytes(source), source.observationId), /expired/);
  assert.throws(() => ledger.presentClarification({ promptId: source.promptId,
    presentationDigest: source.presentationDigest, observationId: source.observationId,
    optionIds: ['one', 'two'] }, 50), /replay/);
  ledger.presentClarification({ promptId: 'new-prompt',
    presentationDigest: source.presentationDigest, observationId: source.observationId,
    optionIds: ['one', 'two'] }, 50);
  ledger.close();
  assert.throws(() => ledger.acceptClarification(endpoint, bytes(source), source.observationId), /closed/);
});

test('expired prompt can be replaced without a late reply', () => {
  const { ledger, source, setTime } = fixture('resume');
  setTime(150);
  assert.equal(ledger.expire(), true);
  assert.equal(ledger.expire(), false);
  ledger.presentResume({ state: 'paused', promptId: 'fresh-prompt',
    presentationDigest: source.presentationDigest,
    checkpointRef: source.checkpointRef, checkpointDigest: source.checkpointDigest,
    recoveryObservationId: source.recoveryObservationId }, 50);
});

test('presentation options are copied and an invalid clock closes the ledger', () => {
  const source = clarification();
  let now = 100;
  const endpoint = bindEndpoint(['clarification_reply', 'resume_request']);
  const ledger = new UserPromptLedger(endpoint, {
    taskId: source.taskId, taskEpoch: source.taskEpoch, goalRevision: source.goalRevision,
  }, source.actorRef, source.uiSessionRef, () => now);
  const options = ['file-documents', 'file-downloads'];
  ledger.presentClarification({ promptId: source.promptId,
    presentationDigest: source.presentationDigest, observationId: source.observationId,
    optionIds: options }, 50);
  options[0] = 'changed';
  assert.equal(ledger.acceptClarification(endpoint, bytes(source), source.observationId)
    .selectedOptionId, 'file-documents');
  now = 99;
  assert.throws(() => ledger.presentResume({ state: 'paused', promptId: 'new',
    presentationDigest: 'a'.repeat(64), checkpointRef: 'check',
    checkpointDigest: 'b'.repeat(64), recoveryObservationId: 'fresh' }, 50), /clock/);
  assert.throws(() => ledger.presentClarification({ promptId: 'another',
    presentationDigest: 'a'.repeat(64), observationId: 'fresh',
    optionIds: ['one', 'two'] }, 50), /closed/);
});
