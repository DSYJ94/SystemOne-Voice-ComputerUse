import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostLifecycleGate } from '../src/host-lifecycle.ts';
const snapshot = (sequence: number, sleeping = false, sessionActive = true) =>
  ({ type: 'host_lifecycle', requestId: 'host', sequence, sleeping, sessionActive });
test('full snapshots keep sleeping and session availability independent and reject stale wake', () => {
  const gate = new HostLifecycleGate(true);
  assert.equal(gate.available, false);
  gate.accept(snapshot(1)); assert.equal(gate.available, true);
  assert.equal(gate.accept(snapshot(2, true)).interrupted, true);
  gate.accept(snapshot(4, false, false)); gate.accept(snapshot(3));
  assert.equal(gate.available, false); assert.equal(gate.sequence, 4);
  gate.accept(snapshot(5, true, true)); assert.equal(gate.available, false);
  gate.accept(snapshot(6)); assert.equal(gate.available, true);
});
test('malformed host authority never mutates availability or sequence', () => {
  const gate = new HostLifecycleGate(); gate.accept(snapshot(2, true));
  for (const invalid of [snapshot(0), snapshot(2.5), snapshot(Number.MAX_SAFE_INTEGER + 1),
    { ...snapshot(3), requestId: '' }, { ...snapshot(3), sessionActive: 'true' },
    { ...snapshot(3), resume: true }, null, []]) assert.throws(() => gate.accept(invalid));
  assert.equal(gate.available, false); assert.equal(gate.sequence, 2);
  assert.deepEqual(gate.accept(snapshot(2)), { accepted: false, interrupted: false });
});
