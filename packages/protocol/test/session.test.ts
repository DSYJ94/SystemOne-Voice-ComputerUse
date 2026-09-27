import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schema } from '../src/contract.ts';
import { bindEndpoint, receive, ReplyLedger } from '../src/session.ts';

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const revision = { taskId: 'task-001', taskEpoch: 1, goalRevision: 1 };
const proposal = () => structuredClone(schema.examples[3]);
function fixture() {
  let now = 100;
  const peer = bindEndpoint(['decision_proposal']);
  const ledger = new ReplyLedger(revision, () => now);
  const reply = proposal();
  ledger.expect(reply.requestId, peer, 'decision_proposal', 50, {
    observationId: reply.observationId,
    candidateSetDigest: reply.candidateSetDigest,
    providerViewDigest: reply.providerViewDigest,
  });
  return { peer, ledger, reply, setTime(value: number) { now = value; } };
}

test('channel allowlist rejects forged host permit regardless of issuer string', () => {
  const model = bindEndpoint(['decision_proposal']);
  assert.throws(() => receive(model, bytes(schema.examples[7])), /producer/);
  assert.throws(() => receive(model, bytes(schema.examples[0])), /producer/);
  assert.equal(receive(model, bytes(proposal())).type, 'decision_proposal');
});

test('endpoint allowlist is copied and immutable', () => {
  const allowed: ['decision_proposal'] = ['decision_proposal'];
  const peer = bindEndpoint(allowed);
  allowed.pop();
  assert.deepEqual(peer.allowedTypes, ['decision_proposal']);
  assert.ok(Object.isFrozen(peer.allowedTypes));
});

test('matching reply is accepted exactly once and request IDs cannot be reused', () => {
  const { peer, ledger, reply } = fixture();
  assert.deepEqual(ledger.accept(reply.requestId, peer, bytes(reply)), reply);
  assert.throws(() => ledger.accept(reply.requestId, peer, bytes(reply)), /unregistered/);
  assert.throws(() => ledger.expect(reply.requestId, peer, 'decision_proposal', 50), /reused/);
});

test('another endpoint with identical permissions cannot answer a pending request', () => {
  const { peer, ledger, reply } = fixture();
  assert.throws(() => ledger.accept(reply.requestId, bindEndpoint(['decision_proposal']), bytes(reply)), /endpoint/);
  assert.deepEqual(ledger.accept(reply.requestId, peer, bytes(reply)), reply);
});

for (const key of ['taskId', 'taskEpoch', 'goalRevision', 'requestId', 'observationId', 'candidateSetDigest', 'providerViewDigest']) {
  test(`reply rejects changed ${key} without consuming the valid pending request`, () => {
    const { peer, ledger, reply } = fixture();
    const changed = structuredClone(reply);
    changed[key] = typeof changed[key] === 'number' ? 2 : key.endsWith('Digest') ? 'f'.repeat(64) : 'different';
    assert.throws(() => ledger.accept(reply.requestId, peer, bytes(changed)));
    assert.deepEqual(ledger.accept(reply.requestId, peer, bytes(reply)), reply);
  });
}

test('monotonic deadline expires at its boundary even with valid wire timestamps', () => {
  const { peer, ledger, reply, setTime } = fixture();
  setTime(150);
  assert.throws(() => ledger.accept(reply.requestId, peer, bytes(reply)), /expired/);
  assert.equal(ledger.expire(), 0);
});

test('closing a session fences late replies and new requests', () => {
  const { peer, ledger, reply } = fixture();
  ledger.close(); ledger.close();
  assert.throws(() => ledger.accept(reply.requestId, peer, bytes(reply)), /closed/);
  assert.throws(() => ledger.expect('new', peer, 'decision_proposal', 50), /closed/);
});

test('a reply whose validation crosses the deadline is not delivered', () => {
  const ticks = [100, 149, 150];
  const peer = bindEndpoint(['decision_proposal']);
  const ledger = new ReplyLedger(revision, () => ticks.shift()!);
  const reply = proposal();
  ledger.expect(reply.requestId, peer, 'decision_proposal', 50);
  assert.throws(() => ledger.accept(reply.requestId, peer, bytes(reply)), /during validation/);
});

test('backward or nonfinite clocks permanently close the session', () => {
  for (const invalid of [99, NaN, Infinity]) {
    const { peer, ledger, reply, setTime } = fixture();
    setTime(invalid);
    assert.throws(() => ledger.accept(reply.requestId, peer, bytes(reply)), /clock/);
    setTime(110);
    assert.throws(() => ledger.accept(reply.requestId, peer, bytes(reply)), /closed/);
  }
});

test('ledger bounds pending requests and rejects invalid timeout values', () => {
  const peer = bindEndpoint(['decision_proposal']);
  const ledger = new ReplyLedger(revision, () => 0);
  for (const timeout of [0, -1, Infinity, NaN, 60_001]) {
    assert.throws(() => ledger.expect('invalid', peer, 'decision_proposal', timeout), /timeout/);
  }
  for (let i = 0; i < 64; i++) ledger.expect(`request-${i}`, peer, 'decision_proposal', 10);
  assert.throws(() => ledger.expect('overflow', peer, 'decision_proposal', 10), /budget/);
});

test('expiration releases pending capacity while retaining replay protection', () => {
  const { peer, ledger, reply, setTime } = fixture();
  setTime(150);
  assert.equal(ledger.expire(), 1);
  assert.throws(() => ledger.expect(reply.requestId, peer, 'decision_proposal', 50), /reused/);
  ledger.expect('fresh-request', peer, 'decision_proposal', 50);
});
