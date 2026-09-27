import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AttemptJournal } from '../src/attempt-journal.ts';
import type { PreparedAttempt } from '../src/attempt-journal.ts';

const attempt: PreparedAttempt = {
  executionId: 'execution-1', permitRef: 'permit-1', taskId: 'task-1',
  taskEpoch: 1, goalRevision: 1, scopeRef: 'fixture-only',
  observationId: 'observation-1', candidateId: 'candidate-1',
  candidateSetDigest: 'b'.repeat(64), actionDigest: 'a'.repeat(64),
  policyRevision: 'fixture-policy-1', leaseGeneration: 1,
};

function withDatabase(run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'systemone-journal-'));
  try { run(join(dir, 'attempts.sqlite')); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('restart makes a prepared action definitely not dispatched', () => withDatabase(path => {
  const first = new AttemptJournal(path);
  first.startTask('task-1', 1, 1);
  first.prepare(attempt);
  first.close();

  const restarted = new AttemptJournal(path);
  assert.deepEqual(restarted.recoverAfterRestart(), []);
  assert.equal(restarted.getTaskState('task-1'), 'paused');
  assert.deepEqual(restarted.taskEventKinds('task-1'), ['started', 'paused_after_restart']);
  assert.deepEqual(restarted.getAttempt('execution-1')?.outcome, {
    deliveryStatus: 'not_dispatched', effectStatus: 'not_applied',
    verification: 'unavailable',
  });
  assert.throws(() => restarted.markDispatchBoundary('execution-1'), /not prepared/);
  assert.deepEqual(restarted.eventKinds('execution-1'), [
    'prepared', 'recovered_before_dispatch',
  ]);
  restarted.close();
}));

test('restart preserves an unresolved boundary and blocks another writer', () => withDatabase(path => {
  const first = new AttemptJournal(path);
  first.startTask('task-1', 1, 1);
  first.prepare(attempt);
  first.markDispatchBoundary('execution-1');
  first.close();

  const restarted = new AttemptJournal(path);
  assert.deepEqual(restarted.recoverAfterRestart().map(item => item.executionId), ['execution-1']);
  assert.equal(restarted.getTaskState('task-1'), 'paused');
  assert.throws(() => restarted.startTask('task-2', 1, 1), /unresolved/);
  restarted.recordOutcome('execution-1', {
    deliveryStatus: 'unknown', effectStatus: 'unknown', verification: 'unavailable',
  });
  assert.deepEqual(restarted.unresolvedAttempts().map(item => item.executionId), ['execution-1']);
  assert.throws(() => restarted.startTask('task-2', 1, 1), /unknown/);
  restarted.close();
  const reopened = new AttemptJournal(path);
  assert.deepEqual(reopened.unresolvedAttempts().map(item => item.executionId), ['execution-1']);
  assert.throws(() => reopened.startTask('task-2', 1, 1), /unknown/);
  reopened.close();
}));

test('a verified multi-step task completes and releases the writer', () => withDatabase(path => {
  const journal = new AttemptJournal(path);
  journal.startTask('task-1', 1, 1);
  for (const [index, evidence] of [[1, 'search-result'], [2, 'exact-detail']] as const) {
    const item = { ...attempt, executionId: `execution-${index}`,
      permitRef: `permit-${index}`, candidateId: `candidate-${index}` };
    journal.prepare(item);
    journal.markDispatchBoundary(item.executionId);
    journal.recordOutcome(item.executionId, { deliveryStatus: 'dispatched',
      effectStatus: 'applied', verification: 'matched', evidenceRef: evidence });
  }
  journal.completeTask('task-1', 'exact-detail');
  assert.equal(journal.getTaskState('task-1'), 'completed');
  assert.deepEqual(journal.taskEventKinds('task-1'), ['started', 'completed:exact-detail']);
  assert.throws(() => journal.completeTask('task-1', 'again'), /not active/);
  assert.throws(() => journal.cancelTask('task-1'), /not active/);
  journal.startTask('task-2', 1, 1);
  assert.equal(journal.getTaskState('task-2'), 'active');
  journal.close();
  const reopened = new AttemptJournal(path);
  assert.equal(reopened.getTaskState('task-1'), 'completed');
  reopened.close();
}));

test('completion rejects unverified or uncertain effects', () => withDatabase(path => {
  const journal = new AttemptJournal(path);
  journal.startTask('task-1', 1, 1);
  assert.throws(() => journal.completeTask('task-1', 'evidence-1'), /verified attempts/);
  journal.prepare(attempt);
  assert.throws(() => journal.completeTask('task-1', 'evidence-1'), /verified attempts/);
  journal.markDispatchBoundary('execution-1');
  journal.recordOutcome('execution-1', { deliveryStatus: 'unknown',
    effectStatus: 'unknown', verification: 'unavailable' });
  assert.throws(() => journal.completeTask('task-1', 'evidence-1'), /verified attempts/);
  journal.cancelTask('task-1');
  assert.throws(() => journal.startTask('task-2', 1, 1), /unknown/);
  journal.close();
}));

test('legacy task schema migrates without losing event foreign keys', () => withDatabase(path => {
  const legacy = new DatabaseSync(path);
  legacy.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE tasks (task_id TEXT PRIMARY KEY, task_epoch INTEGER NOT NULL,
      goal_revision INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active', 'cancelled', 'paused')));
    CREATE TABLE task_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      event_kind TEXT NOT NULL, recorded_at TEXT NOT NULL);
    INSERT INTO tasks VALUES ('old-task', 1, 1, 'active');
    INSERT INTO task_events (task_id, event_kind, recorded_at)
      VALUES ('old-task', 'started', '2026-09-27T00:00:00Z');`);
  legacy.close();
  const journal = new AttemptJournal(path);
  assert.equal(journal.getTaskState('old-task'), 'active');
  assert.deepEqual(journal.taskEventKinds('old-task'), ['started']);
  journal.recoverAfterRestart();
  assert.equal(journal.getTaskState('old-task'), 'paused');
  journal.close();
  const check = new DatabaseSync(path);
  assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), []);
  check.close();
}));

test('journal cancellation fences prepared dispatch and late receipt cannot reactivate a task', () => withDatabase(path => {
  const journal = new AttemptJournal(path);
  journal.startTask('task-1', 1, 1);
  journal.prepare(attempt);
  assert.deepEqual(journal.cancelTask('task-1'), []);
  assert.deepEqual(journal.taskEventKinds('task-1'), ['started', 'cancelled']);
  assert.equal(journal.getAttempt('execution-1')?.outcome?.deliveryStatus, 'not_dispatched');
  assert.throws(() => journal.markDispatchBoundary('execution-1'), /not prepared/);

  journal.startTask('task-2', 2, 1);
  journal.prepare({ ...attempt, taskId: 'task-2', taskEpoch: 2,
    executionId: 'execution-2', permitRef: 'permit-2' });
  journal.markDispatchBoundary('execution-2');
  assert.deepEqual(journal.cancelTask('task-2').map(item => item.executionId), ['execution-2']);
  journal.recordOutcome('execution-2', {
    deliveryStatus: 'dispatched', effectStatus: 'applied',
    verification: 'matched', evidenceRef: 'observation-3',
  });
  assert.equal(journal.getTaskState('task-2'), 'cancelled');
  assert.equal(journal.getAttempt('execution-2')?.outcome?.evidenceRef, 'observation-3');
  assert.throws(() => journal.recordOutcome('execution-2', {
    deliveryStatus: 'dispatched', effectStatus: 'applied',
    verification: 'matched', evidenceRef: 'observation-3',
  }), /no unresolved/);
  journal.close();
}));

test('outcome dimensions reject false success without consuming boundary', () => withDatabase(path => {
  const journal = new AttemptJournal(path);
  journal.startTask('task-1', 1, 1);
  journal.prepare(attempt);
  journal.markDispatchBoundary('execution-1');
  assert.throws(() => journal.recordOutcome('execution-1', {
    deliveryStatus: 'not_dispatched', effectStatus: 'applied',
    verification: 'matched', evidenceRef: 'observation-1',
  }), /without dispatch/);
  assert.throws(() => journal.recordOutcome('execution-1', {
    deliveryStatus: 'unknown', effectStatus: 'unknown',
    verification: 'matched', evidenceRef: 'observation-1',
  }), /unknown effect/);
  assert.throws(() => journal.recordOutcome('execution-1', {
    deliveryStatus: 'dispatched', effectStatus: 'applied', verification: 'matched',
  }), /requires evidence/);
  assert.equal(journal.getAttempt('execution-1')?.phase, 'at_dispatch_boundary');
  journal.recordOutcome('execution-1', {
    deliveryStatus: 'dispatched', effectStatus: 'applied',
    verification: 'matched', evidenceRef: 'observation-1',
  });
  assert.deepEqual(journal.eventKinds('execution-1'), [
    'prepared', 'dispatch_boundary', 'outcome',
  ]);
  journal.close();
}));

test('changed revision and failed preflight cannot cross the boundary', () => withDatabase(path => {
  const journal = new AttemptJournal(path);
  journal.startTask('task-1', 1, 1);
  assert.throws(() => journal.prepare({ ...attempt, taskEpoch: 2 }), /revision/);
  journal.prepare(attempt);
  journal.recordNotDispatched('execution-1');
  assert.throws(() => journal.markDispatchBoundary('execution-1'), /not prepared/);
  assert.deepEqual(journal.eventKinds('execution-1'), ['prepared', 'not_dispatched']);
  journal.close();
}));
