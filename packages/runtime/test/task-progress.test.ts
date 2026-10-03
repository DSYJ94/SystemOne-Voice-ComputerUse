import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { digest } from '../../protocol/src/json.ts';
import { AttemptJournal } from '../src/attempt-journal.ts';
import type { PreparedAttempt } from '../src/attempt-journal.ts';
import type { TaskProgressLimits } from '../src/task-progress.ts';

const TASK = 'fixture-task';
const SCOPE = 'fixture-scope';
const VERIFIER = 'fixture-terminal-v1';
function harness(t: { after(callback: () => void): void }, limits?: TaskProgressLimits) {
  const root = mkdtempSync(join(tmpdir(), 'systemone-progress-'));
  const path = join(root, 'journal.sqlite');
  const journal = new AttemptJournal(path);
  journal.startTask(TASK, 1, 1);
  journal.enableTaskProgress(TASK, SCOPE, VERIFIER, limits);
  t.after(() => { journal.close(); rmSync(root, { recursive: true, force: true }); });
  let serial = 0;
  return { journal, path, observe(state: string, actionable = true) {
    const ticket = journal.reserveTaskObservation(TASK, actionable);
    const observationId = `observation-${++serial}`;
    journal.recordTaskObservation(TASK, ticket, { observationId,
      scopeRef: SCOPE, stateDigest: digest(state) });
    return observationId;
  } };
}
function attempt(observationId: string): PreparedAttempt {
  return { taskId: TASK, taskEpoch: 1, goalRevision: 1,
    executionId: 'execution-1', permitRef: 'permit-1', scopeRef: SCOPE,
    observationId, candidateId: 'candidate-1', candidateSetDigest: digest('candidates'),
    actionDigest: digest('action'), policyRevision: 'fixture-v1', leaseGeneration: 1 };
}
function checkpoint(journal: AttemptJournal, observationId: string,
  stageRef = 'located', terminal = false, evidenceRef = 'evidence-1', executionId?: string) {
  journal.recordTaskCheckpoint(TASK, { checkpointId: `checkpoint-${observationId}`,
    observationId, stageRef, predicateRef: terminal ? VERIFIER : 'fixture-intermediate-v1',
    evidenceRef, terminal, ...(executionId ? { executionId } : {}) });
}

test('new reads invalidate facts before awaiting and fence out-of-order observations', t => {
  const { journal, observe } = harness(t);
  const first = observe('root');
  checkpoint(journal, first);
  const stale = journal.reserveTaskObservation(TASK);
  const latest = journal.reserveTaskObservation(TASK);
  assert.equal(journal.getTaskProgress(TASK)?.currentObservation, null);
  assert.equal(journal.getTaskProgress(TASK)?.checkpoints[0]?.current, false);
  assert.throws(() => journal.recordTaskObservation(TASK, stale,
    { observationId: 'stale', scopeRef: SCOPE, stateDigest: digest('root') }), /stale/);
  journal.recordTaskObservation(TASK, latest,
    { observationId: 'latest', scopeRef: SCOPE, stateDigest: digest('documents') });
  assert.equal(journal.getTaskProgress(TASK)?.observationsUsed, 3);
  assert.throws(() => journal.prepare(attempt(first)), /not current/);
});

test('observation exhaustion commits pause and spends failed reads', t => {
  const { journal } = harness(t, { maxObservations: 2, maxDecisions: 3, maxStateVisits: 3 });
  journal.reserveTaskObservation(TASK);
  journal.reserveTaskObservation(TASK);
  assert.throws(() => journal.reserveTaskObservation(TASK), /observations budget/);
  assert.equal(journal.getTaskState(TASK), 'paused');
  assert.equal(journal.getTaskProgress(TASK)?.pauseReason, 'observations');
  assert.equal(journal.getTaskProgress(TASK)?.observationsUsed, 2);
  assert.ok(journal.taskEventKinds(TASK).includes('paused_budget:observations'));
});

test('decision exhaustion settles unsent work and expires its observation', t => {
  const { journal, observe } = harness(t, { maxObservations: 10, maxDecisions: 1, maxStateVisits: 3 });
  const id = observe('root');
  journal.consumeTaskDecision(TASK, id);
  journal.prepare(attempt(id));
  assert.throws(() => journal.consumeTaskDecision(TASK, id), /decisions budget/);
  assert.equal(journal.getTaskState(TASK), 'paused');
  assert.equal(journal.getAttempt('execution-1')?.outcome?.deliveryStatus, 'not_dispatched');
  assert.equal(journal.getTaskProgress(TASK)?.currentObservation, null);
  assert.throws(() => journal.markDispatchBoundary('execution-1'));
});

test('changing observation IDs and cycling A-B-A do not evade no-progress limits', t => {
  const { journal, observe } = harness(t, { maxObservations: 20, maxDecisions: 20, maxStateVisits: 2 });
  observe('A'); observe('B'); observe('A'); observe('B');
  assert.throws(() => observe('A'), /no_progress/);
  assert.equal(journal.getTaskState(TASK), 'paused');
  assert.equal(journal.getTaskProgress(TASK)?.observationsUsed, 5);
  assert.equal(journal.getTaskProgress(TASK)?.pauseReason, 'no_progress');
});

test('only a newly verified stage resets repeated-state counting', t => {
  const { journal, observe } = harness(t, { maxObservations: 20, maxDecisions: 20, maxStateVisits: 2 });
  checkpoint(journal, observe('A'), 'located');
  checkpoint(journal, observe('A'), 'opened');
  checkpoint(journal, observe('A'), 'located');
  checkpoint(journal, observe('A'), 'opened');
  assert.throws(() => observe('A'), /no_progress/);
  assert.equal(journal.getTaskProgress(TASK)?.checkpoints.length, 4);
});

test('dispatch expires facts; predicate-only reads cannot authorize a new action', t => {
  const { journal, observe } = harness(t);
  const id = observe('root');
  journal.prepare(attempt(id)); journal.markDispatchBoundary('execution-1');
  assert.equal(journal.getTaskProgress(TASK)?.currentObservation, null);
  const predicate = observe('selected', false);
  assert.throws(() => journal.consumeTaskDecision(TASK, predicate), /actionable/);
  assert.throws(() => checkpoint(journal, predicate, 'located', true), /unresolved/);
  journal.recordOutcome('execution-1', { deliveryStatus: 'dispatched', effectStatus: 'applied',
    verification: 'matched', evidenceRef: 'evidence-1' });
  assert.throws(() => checkpoint(journal, predicate, 'located', true, 'other-evidence', 'execution-1'),
    /settled attempt evidence/);
  checkpoint(journal, predicate, 'located', true, 'evidence-1', 'execution-1');
  journal.completeTask(TASK, 'evidence-1');
  assert.equal(journal.getTaskState(TASK), 'completed');
  assert.equal(journal.getTaskProgress(TASK)?.currentObservation, null);
  assert.equal(journal.getTaskProgress(TASK)?.checkpoints[0]?.current, false);
});

test('terminal evidence requires the admitted verifier and a current observation', t => {
  const { journal, observe } = harness(t);
  const id = observe('selected', false);
  assert.throws(() => journal.completeTask(TASK, 'evidence-1'), /terminal checkpoint/);
  assert.throws(() => journal.recordTaskCheckpoint(TASK, { checkpointId: 'wrong-verifier',
    observationId: id, stageRef: 'located', predicateRef: 'opened-verifier',
    evidenceRef: 'evidence-1', terminal: true }), /task verifier/);
  checkpoint(journal, id, 'located', true);
  assert.throws(() => journal.completeTask(TASK, 'wrong-evidence'), /terminal checkpoint/);
  observe('changed');
  assert.throws(() => journal.completeTask(TASK, 'evidence-1'), /terminal checkpoint/);
});

test('Stop fences late reads and matched receipts while retaining history', t => {
  const { journal, observe } = harness(t);
  const id = observe('root');
  checkpoint(journal, id, 'root');
  journal.prepare(attempt(id)); journal.markDispatchBoundary('execution-1');
  const ticket = journal.reserveTaskObservation(TASK, false);
  journal.cancelTask(TASK);
  assert.throws(() => journal.recordTaskObservation(TASK, ticket,
    { observationId: 'late', scopeRef: SCOPE, stateDigest: digest('selected') }), /not active/);
  journal.recordOutcome('execution-1', { deliveryStatus: 'dispatched', effectStatus: 'applied',
    verification: 'matched', evidenceRef: 'evidence-1' });
  assert.throws(() => checkpoint(journal, 'late', 'located', true), /not active/);
  assert.equal(journal.getTaskProgress(TASK)?.checkpoints.length, 1);
  assert.equal(journal.getTaskProgress(TASK)?.currentObservation, null);
  assert.equal(journal.getTaskState(TASK), 'cancelled');
});

test('restart preserves checkpoints and counters but pauses and expires all facts', t => {
  const { journal, path, observe } = harness(t);
  const id = observe('documents');
  checkpoint(journal, id);
  journal.consumeTaskDecision(TASK, id);
  const reopened = new AttemptJournal(path);
  try {
    reopened.recoverAfterRestart();
    const progress = reopened.getTaskRecord(TASK)!.progress!;
    assert.equal(reopened.getTaskState(TASK), 'paused');
    assert.equal(progress.observationsUsed, 1);
    assert.equal(progress.decisionsUsed, 1);
    assert.equal(progress.currentObservation, null);
    assert.equal(progress.checkpoints[0]?.stageRef, 'located');
    assert.equal(progress.checkpoints[0]?.current, false);
    assert.throws(() => reopened.prepare(attempt(id)), /not active/);
  } finally { reopened.close(); }
});

test('budget pause never erases an unknown dispatched effect', t => {
  const { journal, observe } = harness(t, { maxObservations: 1, maxDecisions: 3, maxStateVisits: 3 });
  const id = observe('root');
  journal.prepare(attempt(id)); journal.markDispatchBoundary('execution-1');
  assert.throws(() => journal.reserveTaskObservation(TASK), /observations budget/);
  assert.equal(journal.getTaskState(TASK), 'paused');
  assert.equal(journal.unresolvedAttempts().length, 1);
  journal.recordOutcome('execution-1', { deliveryStatus: 'unknown', effectStatus: 'unknown',
    verification: 'unavailable' });
  assert.equal(journal.unresolvedAttempts().length, 1);
});

test('checkpoint SQL failure rolls back the checkpoint and event together', t => {
  const { journal, path, observe } = harness(t);
  const id = observe('selected', false);
  const other = new DatabaseSync(path);
  try {
    other.exec(`CREATE TRIGGER reject_checkpoint BEFORE INSERT ON task_checkpoints
      BEGIN SELECT RAISE(ABORT, 'synthetic checkpoint failure'); END;`);
    assert.throws(() => checkpoint(journal, id, 'located', true), /checkpoint failure/);
    assert.equal(journal.getTaskProgress(TASK)?.checkpoints.length, 0);
    assert.equal(journal.getTaskState(TASK), 'active');
    assert.ok(!journal.taskEventKinds(TASK).includes('checkpoint:located'));
  } finally { other.close(); }
});

test('deadline expiry refuses completion and expires prior checkpoints', t => {
  const { journal, path, observe } = harness(t);
  checkpoint(journal, observe('selected', false), 'located', true);
  const now = journal.getTaskBudget(TASK)!.deadlineMillis;
  const expired = new AttemptJournal(path, () => now);
  try {
    assert.throws(() => expired.completeTask(TASK, 'evidence-1'), /time budget/);
    assert.equal(expired.getTaskState(TASK), 'paused');
    assert.equal(expired.getTaskProgress(TASK)?.currentObservation, null);
    assert.equal(expired.getTaskProgress(TASK)?.checkpoints[0]?.current, false);
    assert.equal(expired.getTaskRecord(TASK)?.completion, null);
  } finally { expired.close(); }
});
