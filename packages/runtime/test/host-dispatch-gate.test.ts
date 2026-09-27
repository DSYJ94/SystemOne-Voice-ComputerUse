import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AttemptJournal } from '../src/attempt-journal.ts';
import { HostDispatchGate } from '../src/host-dispatch-gate.ts';
import type { AttemptOutcome } from '../src/attempt-journal.ts';
import type { PreparedDelivery, SetValueCandidate, TargetBinding } from '../src/host-dispatch-gate.ts';
import type { TaskAdmission } from '../src/task-authority.ts';

const admission: TaskAdmission = {
  taskId: 'task-1', taskEpoch: 1, goalRevision: 1,
  admissionId: 'admission-1', commandMessageId: 'command-1',
  goal: 'Fill the synthetic fixture field', outcomeKind: 'FILL',
  scopeRef: 'fixture-only', completionVerifierRef: 'fixture-value',
  policyRevision: 'fixture-policy-1', approvedEffects: ['LOCAL_EDIT'], parameters: [],
};

const target: TargetBinding = {
  targetRef: 'fixture.name', surfaceId: 'fixture-window',
  identityFingerprint: 'fixture-field-1', currentValueDigest: 'b'.repeat(64),
  visible: true, enabled: true, capabilities: ['set_value'],
};

const candidate: SetValueCandidate = {
  candidateId: 'candidate-1', description: 'Set the synthetic Fixture Name field',
  scopeRef: 'fixture-only', policyRevision: 'fixture-policy-1',
  effect: 'LOCAL_EDIT', operation: 'set_value', target,
  value: 'fixture-123', valueSourceRef: 'committed-input-1',
};

const matched: AttemptOutcome = {
  deliveryStatus: 'dispatched', effectStatus: 'applied',
  verification: 'matched', evidenceRef: 'fixture-observation-2',
};

async function withGate(run: (gate: HostDispatchGate, journal: AttemptJournal) => Promise<void>,
  overrides: { admission?: TaskAdmission; candidate?: SetValueCandidate;
    clock?: () => number } = {}): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'systemone-gate-'));
  const journal = new AttemptJournal(join(dir, 'attempts.sqlite'));
  let id = 0;
  const gate = new HostDispatchGate(journal, overrides.admission ?? admission,
    { observationId: 'observation-1', candidates: [overrides.candidate ?? candidate] },
    overrides.clock ?? (() => 100), () => `host-id-${++id}`);
  try { await run(gate, journal); }
  finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
}

function select(gate: HostDispatchGate) {
  return { observationId: 'observation-1', candidateSetDigest: gate.candidateSetDigest,
    candidateId: 'candidate-1' };
}

function delivery(liveTarget: TargetBinding = target,
  outcome: AttemptOutcome = matched): PreparedDelivery {
  return { target: liveTarget, send: async () => outcome };
}

test('host permit sends one observed action after durable boundary', () => withGate(async (gate, journal) => {
  const permit = gate.issuePermit(select(gate), 1_000);
  let sends = 0;
  const result = await gate.dispatch(permit, {
    async prepare(seen, signal) {
      assert.equal(seen.value, 'fixture-123');
      assert.equal(signal.aborted, false);
      return { target, send: async () => {
        sends++;
        assert.equal(journal.getAttempt(permit.executionId)?.phase, 'at_dispatch_boundary');
        return matched;
      } };
    },
  });
  assert.equal(sends, 1);
  assert.equal(result.outcome?.verification, 'matched');
  assert.equal(result.actionDigest, permit.actionDigest);
  assert.equal(result.candidateSetDigest, permit.candidateSetDigest);
  assert.deepEqual(journal.eventKinds(permit.executionId),
    ['prepared', 'dispatch_boundary', 'outcome']);
  assert.throws(() => gate.issuePermit(select(gate), 1_000), /another permit/);
}));

test('a proposal ID is not permission and a cloned permit cannot dispatch', () => withGate(async gate => {
  assert.throws(() => gate.issuePermit({ ...select(gate), candidateId: 'invented' }, 1_000),
    /not observed/);
  assert.throws(() => gate.issuePermit({ ...select(gate), observationId: 'stale' }, 1_000),
    /stale/);
  assert.throws(() => gate.issuePermit({ ...select(gate), candidateSetDigest: 'f'.repeat(64) }, 1_000),
    /stale/);
  const permit = gate.issuePermit(select(gate), 1_000);
  await assert.rejects(gate.dispatch({ ...permit }, { async prepare() { return delivery(); } }),
    /not host issued/);
  const result = await gate.dispatch(permit, { async prepare() { return delivery(); } });
  assert.equal(result.outcome?.verification, 'matched');
}));

test('Stop during effect-free preflight prevents later send', () => withGate(async (gate, journal) => {
  const permit = gate.issuePermit(select(gate), 1_000);
  let release!: (value: PreparedDelivery) => void;
  const pending = new Promise<PreparedDelivery>(resolve => { release = resolve; });
  let signal: AbortSignal | undefined;
  let sends = 0;
  const work = gate.dispatch(permit, {
    prepare(_candidate, givenSignal) { signal = givenSignal; return pending; },
  });
  assert.equal(journal.getAttempt(permit.executionId)?.phase, 'prepared');
  const stopped = gate.stop();
  assert.deepEqual(stopped.unresolvedExecutionIds, []);
  assert.equal(signal?.aborted, true);
  release({ target, send: async () => { sends++; return matched; } });
  const result = await work;
  assert.equal(sends, 0);
  assert.equal(result.outcome?.deliveryStatus, 'not_dispatched');
  assert.equal(journal.getTaskState('task-1'), 'cancelled');
}));

test('Stop after send reports in-flight; late result cannot resume task', () => withGate(async (gate, journal) => {
  const permit = gate.issuePermit(select(gate), 1_000);
  let release!: (outcome: AttemptOutcome) => void;
  const pending = new Promise<AttemptOutcome>(resolve => { release = resolve; });
  let started!: () => void;
  const sent = new Promise<void>(resolve => { started = resolve; });
  const work = gate.dispatch(permit, { async prepare() {
    return { target, send: () => { started(); return pending; } };
  } });
  await sent;
  assert.deepEqual(gate.stop().unresolvedExecutionIds, [permit.executionId]);
  release(matched);
  const result = await work;
  assert.equal(result.outcome?.verification, 'matched');
  assert.equal(journal.getTaskState('task-1'), 'cancelled');
  assert.deepEqual(gate.stop().unresolvedExecutionIds, []);
}));

test('changed target value or identity is not dispatched', async () => {
  for (const changedTarget of [
    { ...target, currentValueDigest: 'c'.repeat(64) },
    { ...target, identityFingerprint: 'replacement-field' },
  ]) {
    await withGate(async (gate, journal) => {
      const permit = gate.issuePermit(select(gate), 1_000);
      let sends = 0;
      const result = await gate.dispatch(permit, { async prepare() {
        return { target: changedTarget,
          send: async () => { sends++; return matched; } };
      } });
      assert.equal(sends, 0);
      assert.equal(result.outcome?.deliveryStatus, 'not_dispatched');
      assert.deepEqual(journal.eventKinds(permit.executionId), ['prepared', 'not_dispatched']);
    });
  }
});

test('send failure stays uncertain and cannot be replayed', () => withGate(async (gate, journal) => {
  const permit = gate.issuePermit(select(gate), 1_000);
  const result = await gate.dispatch(permit, { async prepare() {
    return { target, send: () => { throw new Error('synthetic send failure'); } };
  } });
  assert.equal(result.outcome?.deliveryStatus, 'unknown');
  assert.equal(result.outcome?.effectStatus, 'unknown');
  assert.equal(journal.getAttempt(permit.executionId)?.phase, 'settled');
  await assert.rejects(gate.dispatch(permit, { async prepare() { return delivery(); } }), /replayed/);
}));

test('expired permit cannot prepare or dispatch an action', () => {
  let now = 100;
  return withGate(async (gate, journal) => {
    const permit = gate.issuePermit(select(gate), 10);
    now = 110;
    await assert.rejects(gate.dispatch(permit, { async prepare() { return delivery(); } }),
      /expired/);
    assert.equal(journal.getAttempt(permit.executionId), undefined);
  }, { clock: () => now });
});

test('permit expiry during preparation prevents later send', () => {
  let now = 100;
  return withGate(async (gate, journal) => {
    const permit = gate.issuePermit(select(gate), 10);
    let release!: (value: PreparedDelivery) => void;
    const pending = new Promise<PreparedDelivery>(resolve => { release = resolve; });
    let sends = 0;
    const work = gate.dispatch(permit, { prepare() { return pending; } });
    now = 110;
    release({ target, send: async () => { sends++; return matched; } });
    const result = await work;
    assert.equal(sends, 0);
    assert.equal(result.outcome?.deliveryStatus, 'not_dispatched');
    assert.deepEqual(journal.eventKinds(permit.executionId), ['prepared', 'not_dispatched']);
  }, { clock: () => now });
});

test('invalid driver receipt becomes uncertain, never verified success', () => withGate(async gate => {
  const permit = gate.issuePermit(select(gate), 1_000);
  const result = await gate.dispatch(permit, { async prepare() {
    return delivery(target, { deliveryStatus: 'dispatched', effectStatus: 'applied',
      verification: 'matched' });
  } });
  assert.equal(result.outcome?.verification, 'unavailable');
  assert.equal(result.outcome?.effectStatus, 'unknown');
}));

test('task policy blocks a local edit without explicit effect admission', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'systemone-gate-'));
  const journal = new AttemptJournal(join(dir, 'attempts.sqlite'));
  try {
    assert.throws(() => new HostDispatchGate(journal,
      { ...admission, approvedEffects: ['READ'] },
      { observationId: 'observation-1', candidates: [candidate] }, () => 100),
    /did not admit/);
    assert.equal(journal.getTaskState('task-1'), undefined);
    assert.throws(() => new HostDispatchGate(journal,
      { ...admission, scopeRef: 'other-app' },
      { observationId: 'observation-1', candidates: [candidate] }, () => 100),
    /synthetic fixture/);
    assert.throws(() => new HostDispatchGate(journal, admission,
      { observationId: 'observation-1', candidates: [{ ...candidate,
        target: { ...target, targetRef: 'other.field' } }] }, () => 100),
    /outside the synthetic fixture/);
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});
