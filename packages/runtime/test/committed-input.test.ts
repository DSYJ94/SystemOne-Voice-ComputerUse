import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schema } from '../../protocol/src/contract.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { CommittedInputSession } from '../src/committed-input.ts';

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const revision = { taskId: 'task-001', taskEpoch: 1, goalRevision: 1 };
const command = () => structuredClone(schema.examples[0]);
function fixture() {
  const peer = bindEndpoint(['command']);
  return { peer, session: new CommittedInputSession(peer, revision) };
}

test('voice and typed committed input enter the same route with original text', () => {
  for (const source of ['voice', 'text']) {
    const { peer, session } = fixture();
    const input = { ...command(), source, text: 'Find café e\u0301 😀.txt' };
    const routed = session.accept(peer, bytes(input));
    assert.equal(routed.kind, 'interpret_command');
    assert.equal(routed.input.text, input.text);
  }
});

test('partial stream emits no command routes; only a final revision is admitted', () => {
  const { peer, session } = fixture();
  const routes = [];
  for (let i = 0; i < 10; i++) {
    const partial = { ...command(), isFinal: false, utteranceRevision: i, text: 'delete everyth' };
    assert.throws(() => routes.push(session.accept(peer, bytes(partial))));
  }
  assert.equal(routes.length, 0);
  routes.push(session.accept(peer, bytes({ ...command(), utteranceRevision: 10 })));
  assert.equal(routes.length, 1);
});

test('dictating delete this remains literal and cannot enter command interpretation', () => {
  const { peer, session } = fixture();
  const routed = session.accept(peer, bytes({ ...command(), mode: 'dictation', text: 'delete this' }));
  assert.equal(routed.kind, 'literal_dictation');
  assert.equal(routed.input.text, 'delete this');
});

test('replayed message and re-finalized utterance cannot create a second route', () => {
  const { peer, session } = fixture();
  const original = command();
  session.accept(peer, bytes(original));
  assert.throws(() => session.accept(peer, bytes(original)), /replay/);
  assert.throws(() => session.accept(peer, bytes({ ...original, messageId: 'new', utteranceRevision: 99 })), /replay/);
  assert.throws(() => session.accept(peer, bytes({ ...original, utteranceId: 'another' })), /replay/);
});

test('old revision, unbound native channel and input after session closure are rejected', () => {
  const { peer, session } = fixture();
  assert.throws(() => session.accept(peer, bytes({ ...command(), taskEpoch: 0 })), /revision/);
  assert.throws(() => session.accept(peer, bytes({ ...command(), goalRevision: 0 })), /revision/);
  assert.throws(() => session.accept(bindEndpoint(['command']), bytes(command())), /endpoint/);
  session.close();
  assert.throws(() => session.accept(peer, bytes(command())), /closed/);
});

test('claimed correction transfers exact provenance once and rejects copied, foreign or unclaimed input', () => {
  const peer = bindEndpoint(['command']);
  const session = new CommittedInputSession(peer, { ...revision, goalRevision: 2 });
  const input = session.accept(peer, bytes({ ...command(), ...revision, goalRevision: 2,
    text: 'Locate synthetic fixture file Documents/Budget.xlsx' })).input;
  const target = { taskId: 'replacement-task', taskEpoch: 1, goalRevision: 2 };
  assert.throws(() => session.transferClaimedCorrection(input, target));
  session.claimForCorrection(input);
  assert.throws(() => session.transferClaimedCorrection({ ...input }, target));
  assert.throws(() => session.transferClaimedCorrection(input, { ...target, goalRevision: 3 }));
  assert.throws(() => session.transferClaimedCorrection(input, { ...target, taskId: input.taskId }));
  const transfer = session.transferClaimedCorrection(input, target);
  assert.equal(transfer.input.text, input.text);
  assert.equal(transfer.input.messageId, input.messageId);
  assert.equal(transfer.input.utteranceId, input.utteranceId);
  assert.equal(transfer.input.taskId, target.taskId);
  assert.equal(transfer.session.correctionSource!.taskId, input.taskId);
  assert.throws(() => transfer.session.claimForAdmission({ ...transfer.input }));
  transfer.session.claimForAdmission(transfer.input);
  assert.throws(() => transfer.session.claimForAdmission(transfer.input));
  assert.throws(() => session.transferClaimedCorrection(input, { ...target, taskId: 'another' }));
  assert.throws(() => transfer.session.accept(peer, bytes(transfer.input)), /replay/);
});

test('ordinary admission claim cannot be mistaken for a correction handoff', () => {
  const peer = bindEndpoint(['command']);
  const session = new CommittedInputSession(peer, { ...revision, goalRevision: 2 });
  const input = session.accept(peer, bytes({ ...command(), ...revision, goalRevision: 2 })).input;
  session.claimForAdmission(input);
  assert.throws(() => session.transferClaimedCorrection(input,
    { taskId: 'different-task', taskEpoch: 1, goalRevision: 2 }));
});
