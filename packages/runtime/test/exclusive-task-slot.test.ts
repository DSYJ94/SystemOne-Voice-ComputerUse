import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExclusiveTaskSlot } from '../src/exclusive-task-slot.ts';

test('late completion cannot release a newer cross-surface task', () => {
  const slot = new ExclusiveTaskSlot<{ readonly requestId: string;
    readonly surface: string }>();
  const native = { requestId: 'task-1', surface: 'native' };
  const chrome = { requestId: 'task-2', surface: 'chrome' };
  slot.claim(native);
  assert.throws(() => slot.claim(chrome), /occupied/);
  assert.equal(slot.release(native), true);
  slot.claim(chrome);
  assert.equal(slot.release(native), false);
  assert.equal(slot.active, chrome);
  assert.equal(slot.release(chrome), true);
  assert.equal(slot.active, undefined);
});

test('settled task remains occupied until its Stop barrier returns', () => {
  const slot = new ExclusiveTaskSlot<{ readonly requestId: string }>();
  const first = { requestId: 'first' };
  const next = { requestId: 'next' };
  slot.claim(first);
  assert.equal(slot.beginStop(first), true);
  assert.equal(slot.release(first), false);
  assert.throws(() => slot.claim(next), /occupied/);
  assert.equal(slot.finishStop(first), true);
  slot.claim(next);
  assert.equal(slot.active, next);
});
