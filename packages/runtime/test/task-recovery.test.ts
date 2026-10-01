import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { schema } from '../../protocol/src/contract.ts';
import { digest } from '../../protocol/src/json.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { AttemptJournal } from '../src/attempt-journal.ts';
import { CommittedInputSession } from '../src/committed-input.ts';
import { TaskAdmissionRegistry } from '../src/task-authority.ts';
import { TASK_RECOVERY_READ_TTL_MS } from '../src/task-recovery.ts';
import type { TaskRecoveryBinding } from '../src/task-recovery.ts';
import { UserPromptLedger } from '../src/user-prompts.ts';

const TASK = 'recovery-fixture';
const SCOPE = 'synthetic-native';
const VERIFIER = 'fixture-terminal-v1';
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const revision = { taskId: TASK, taskEpoch: 1, goalRevision: 1 };

function command(taskId = TASK, goalRevision = 1, mode = 'command') {
  const endpoint = bindEndpoint(['command']);
  const rev = { taskId, taskEpoch: 1, goalRevision };
  const session = new CommittedInputSession(endpoint, rev);
  const input = session.accept(endpoint, bytes({ ...schema.examples[0], ...rev, mode,
    messageId: `command-${taskId}-r${goalRevision}`,
    utteranceId: `utterance-${taskId}-r${goalRevision}`, text: 'Locate Documents/Budget.xlsx' })).input;
  return { session, input };
}

function start(journal: AttemptJournal, taskId = TASK, limits = { maxSteps: 30, timeoutMs: 300_000 }) {
  const { session, input } = command(taskId);
  const registry = new TaskAdmissionRegistry({ ...revision, taskId }, session);
  const admission = registry.admit(input, { admissionId: `admission-${taskId}`,
    goal: input.text, outcomeKind: 'LOCATE', scopeRef: SCOPE,
    completionVerifierRef: VERIFIER, policyRevision: 'fixture-policy-v1',
    approvedEffects: ['READ', 'NAVIGATE'], parameters: [{ parameterRef: 'file',
      sourceRef: 'fixture-config', valueDigest: digest('Documents/Budget.xlsx') }] });
  journal.startAdmittedTask(registry, admission, limits);
}

function harness(t: TestContext, limits = { maxObservations: 30, maxDecisions: 20, maxStateVisits: 3 }) {
  const root = mkdtempSync(join(tmpdir(), 'systemone-recovery-'));
  const path = join(root, 'journal.sqlite');
  let now = 1000;
  const journal = new AttemptJournal(path, () => now);
  start(journal);
  journal.enableTaskProgress(TASK, SCOPE, VERIFIER, limits);
  const ticket = journal.reserveTaskObservation(TASK);
  journal.recordTaskObservation(TASK, ticket, { observationId: 'initial',
    scopeRef: SCOPE, stateDigest: digest('documents') });
  journal.recordTaskCheckpoint(TASK, { checkpointId: 'documents-1', observationId: 'initial',
    stageRef: 'documents', predicateRef: 'fixture-documents-v1', evidenceRef: 'initial-evidence',
    terminal: false });
  let serial = 0;
  t.after(() => { journal.close(); rmSync(root, { recursive: true, force: true }); });
  return { journal, path, clock: () => now, setTime(value: number) { now = value; },
    read(host = journal) {
      const recoveryTicket = host.reserveTaskRecoveryObservation(TASK);
      return { ticket: recoveryTicket, observed: { observationId: `recovery-${++serial}`,
        scopeRef: SCOPE, stateDigest: digest('documents') }, verified: {
        checkpointRef: 'documents-1', predicateRef: 'fixture-documents-v1',
        evidenceRef: `rechecked-${serial}` } };
    }, recover(host = journal) {
      const read = this.read(host);
      return host.recordTaskRecoveryObservation(TASK, read.ticket, read.observed, read.verified);
    } };
}

function prompt(binding: TaskRecoveryBinding, clock: () => number = () => 1000,
  messageId = 'resume-1') {
  const endpoint = bindEndpoint(['clarification_reply', 'resume_request']);
  const source = { ...schema.examples.find((value: any) => value.type === 'resume_request'),
    ...binding, messageId, promptId: `prompt-${messageId}`, presentationDigest: digest(binding as any) };
  delete (source as any).state;
  const ledger = new UserPromptLedger(endpoint, binding, source.actorRef,
    source.uiSessionRef, clock);
  ledger.presentResume({ ...binding, promptId: source.promptId,
    presentationDigest: source.presentationDigest }, 20_000);
  return { ledger, source, accept() {
    return ledger.acceptResume(endpoint, bytes(source), binding.recoveryObservationId);
  } };
}

function attempt(observationId = 'initial', executionId = 'execution-1', taskId = TASK) {
  return { ...revision, taskId, executionId, permitRef: `permit-${executionId}`, scopeRef: SCOPE,
    observationId, candidateId: 'fixture-candidate', candidateSetDigest: digest('candidates'),
    actionDigest: digest('action'), policyRevision: 'fixture-policy-v1', leaseGeneration: 1 };
}

test('explicit one-use intent reactivates a rechecked checkpoint without restoring action facts', t => {
  const f = harness(t);
  f.journal.consumeTaskDecision(TASK, 'initial');
  f.journal.prepare(attempt()); // An unsent preparation is settled by pause.
  const budget = f.journal.getTaskBudget(TASK)!;
  f.journal.pauseTask(TASK, 'interference');
  const binding = f.recover();
  const p = prompt(binding, f.clock);
  const intent = p.accept();
  assert.equal(f.journal.getTaskState(TASK), 'paused');
  assert.equal(f.journal.getTaskProgress(TASK)?.currentObservation?.actionable, false);
  f.journal.resumeTask(p.ledger, intent);
  assert.equal(f.journal.getTaskState(TASK), 'active');
  assert.equal(f.journal.getTaskProgress(TASK)?.currentObservation, null);
  assert.equal(f.journal.getTaskProgress(TASK)?.observationsUsed, 2);
  assert.equal(f.journal.getTaskProgress(TASK)?.decisionsUsed, 1);
  assert.deepEqual(f.journal.getTaskBudget(TASK), budget);
  assert.throws(() => f.journal.prepare(attempt(binding.recoveryObservationId, 'execution-2')), /current/);
  assert.throws(() => f.journal.completeTask(TASK, 'rechecked-1'), /terminal checkpoint/);
  f.journal.pauseTask(TASK, 'again');
  assert.throws(() => f.journal.resumeTask(p.ledger, intent), /current/);
  const fresh = f.journal.reserveTaskObservation.bind(f.journal);
  assert.throws(() => fresh(TASK), /not active/);
});

test('restart fences recovery reads and intents even for an already-paused task', t => {
  const f = harness(t);
  f.journal.pauseTask(TASK, 'interference');
  const binding = f.recover();
  const p = prompt(binding, f.clock);
  const intent = p.accept();
  const reopened = new AttemptJournal(f.path, f.clock);
  try {
    reopened.recoverAfterRestart();
    assert.equal(reopened.getTaskProgress(TASK)?.currentObservation, null);
    assert.throws(() => reopened.resumeTask(p.ledger, intent), /current|binding/);
    assert.equal(reopened.getTaskState(TASK), 'paused');
    const newPrompt = prompt(f.recover(reopened), f.clock, 'resume-after-restart');
    reopened.resumeTask(newPrompt.ledger, newPrompt.accept());
    assert.equal(reopened.getTaskState(TASK), 'active');
    assert.equal(reopened.getTaskProgress(TASK)?.observationsUsed, 3);
  } finally { reopened.close(); }
});

test('a reactivated synthetic task needs a fresh actionable read before completing its next step', t => {
  const f = harness(t);
  f.journal.pauseTask(TASK, 'interference');
  const p = prompt(f.recover(), f.clock);
  f.journal.resumeTask(p.ledger, p.accept());
  const ticket = f.journal.reserveTaskObservation(TASK);
  f.journal.recordTaskObservation(TASK, ticket, { observationId: 'fresh-actionable',
    scopeRef: SCOPE, stateDigest: digest('documents') });
  f.journal.consumeTaskDecision(TASK, 'fresh-actionable');
  f.journal.prepare(attempt('fresh-actionable'));
  f.journal.markDispatchBoundary('execution-1');
  f.journal.recordOutcome('execution-1', { deliveryStatus: 'dispatched', effectStatus: 'applied',
    verification: 'matched', evidenceRef: 'located-evidence' });
  const verification = f.journal.reserveTaskObservation(TASK, false);
  f.journal.recordTaskObservation(TASK, verification, { observationId: 'fresh-terminal',
    scopeRef: SCOPE, stateDigest: digest('selected') });
  f.journal.recordTaskCheckpoint(TASK, { checkpointId: 'located', observationId: 'fresh-terminal',
    stageRef: 'located', predicateRef: VERIFIER, evidenceRef: 'located-evidence',
    executionId: 'execution-1', terminal: true });
  f.journal.completeTask(TASK, 'located-evidence');
  const record = f.journal.getTaskRecord(TASK)!;
  assert.equal(record.state, 'completed');
  assert.equal(record.attempts.length, 1);
  assert.equal(record.progress?.observationsUsed, 4);
  assert.equal(record.completion?.evidenceRef, 'located-evidence');
});

test('restart fences a paused recovery read that had not yet returned', t => {
  const f = harness(t);
  f.journal.pauseTask(TASK, 'interference');
  const read = f.read();
  f.journal.recoverAfterRestart();
  assert.throws(() => f.journal.recordTaskRecoveryObservation(TASK, read.ticket,
    read.observed, read.verified), /checkpoint.*changed/);
  assert.equal(f.journal.getTaskProgress(TASK)?.observationsUsed, 2);
  assert.equal(f.journal.getTaskProgress(TASK)?.currentObservation, null);
});

test('new recovery reservations fence out-of-order reads and accepted intent', t => {
  const f = harness(t);
  f.journal.pauseTask(TASK, 'interference');
  const old = f.read();
  const latest = f.read();
  assert.throws(() => f.journal.recordTaskRecoveryObservation(TASK, old.ticket,
    old.observed, old.verified), /stale/);
  const binding = f.journal.recordTaskRecoveryObservation(TASK, latest.ticket, latest.observed, latest.verified);
  const p = prompt(binding, f.clock);
  const intent = p.accept();
  f.read();
  assert.throws(() => f.journal.resumeTask(p.ledger, intent), /current/);
  assert.equal(f.journal.getTaskProgress(TASK)?.observationsUsed, 4);
});

test('wrong scope, predicate and checkpoint never produce a recovery binding', t => {
  const f = harness(t);
  f.journal.pauseTask(TASK, 'interference');
  const read = f.read();
  assert.throws(() => f.journal.recordTaskRecoveryObservation(TASK, read.ticket,
    { ...read.observed, scopeRef: 'other' }, read.verified), /scope/);
  for (const changed of [{ predicateRef: VERIFIER }, { checkpointRef: 'other' }]) {
    assert.throws(() => f.journal.recordTaskRecoveryObservation(TASK, read.ticket, read.observed,
      { ...read.verified, ...changed }), /checkpoint|predicate/);
  }
  assert.equal(f.journal.getTaskProgress(TASK)?.currentObservation, null);
});

test('recovery TTL includes the pending read and the wait for user intent', t => {
  const f = harness(t);
  f.journal.pauseTask(TASK, 'interference');
  const read = f.read();
  f.setTime(1000 + TASK_RECOVERY_READ_TTL_MS);
  assert.throws(() => f.journal.recordTaskRecoveryObservation(TASK, read.ticket,
    read.observed, read.verified), /expired recovery/);
  const binding = f.recover();
  const p = prompt(binding); // Keep prompt time separate to exercise read freshness.
  const intent = p.accept();
  f.setTime(1000 + 2 * TASK_RECOVERY_READ_TTL_MS);
  assert.throws(() => f.journal.resumeTask(p.ledger, intent), /expired recovery/);
  assert.equal(f.journal.getTaskState(TASK), 'paused');
});

test('copied, foreign-ledger, closed, invalidated and expired intent cannot reactivate', t => {
  const f = harness(t);
  f.journal.pauseTask(TASK, 'interference');
  const binding = f.recover();
  const p = prompt(binding, f.clock);
  const intent = p.accept();
  assert.throws(() => f.journal.resumeTask(p.ledger, { ...intent }), /not issued/);
  const foreign = prompt(binding, f.clock, 'foreign');
  assert.throws(() => f.journal.resumeTask(foreign.ledger, intent), /not issued/);
  p.ledger.invalidate();
  assert.throws(() => f.journal.resumeTask(p.ledger, intent), /invalidated/);
  const closed = prompt(binding, f.clock, 'closed');
  const closedIntent = closed.accept(); closed.ledger.close();
  assert.throws(() => f.journal.resumeTask(closed.ledger, closedIntent), /closed/);
  const expired = prompt(binding, f.clock, 'expired');
  const expiredIntent = expired.accept(); f.setTime(21_000);
  assert.throws(() => f.journal.resumeTask(expired.ledger, expiredIntent), /intent expired/);
  assert.equal(f.journal.getTaskState(TASK), 'paused');
  assert.ok(!f.journal.taskEventKinds(TASK).some(value => value.startsWith('resumed:')));
});

test('Stop fences pending recovery reads and accepted replies', t => {
  const f = harness(t);
  f.journal.pauseTask(TASK, 'interference');
  const binding = f.recover();
  const p = prompt(binding, f.clock);
  const intent = p.accept();
  const read = f.read();
  f.journal.cancelTask(TASK);
  assert.throws(() => f.journal.recordTaskRecoveryObservation(TASK, read.ticket,
    read.observed, read.verified), /not paused/);
  assert.throws(() => f.journal.resumeTask(p.ledger, intent), /not paused/);
  assert.equal(f.journal.getTaskState(TASK), 'cancelled');
});

test('durable Resume message identity cannot be replayed through a new ledger and fresh read', t => {
  const f = harness(t);
  f.journal.pauseTask(TASK, 'interference');
  const first = prompt(f.recover(), f.clock);
  f.journal.resumeTask(first.ledger, first.accept());
  f.journal.pauseTask(TASK, 'again');
  const replay = prompt(f.recover(), f.clock);
  assert.throws(() => f.journal.resumeTask(replay.ledger, replay.accept()), /UNIQUE constraint/);
  assert.equal(f.journal.getTaskState(TASK), 'paused');
  assert.equal(f.journal.taskEventKinds(TASK).filter(value => value.startsWith('resumed:')).length, 1);
});

test('a native UI intent issued for another goal revision cannot resume this task', t => {
  const f = harness(t);
  f.journal.pauseTask(TASK, 'interference');
  const p = prompt({ ...f.recover(), goalRevision: 2 }, f.clock);
  assert.throws(() => f.journal.resumeTask(p.ledger, p.accept()), /revision mismatch/);
  assert.equal(f.journal.getTaskState(TASK), 'paused');
});

test('late applied or unknown outcomes do not become safe recovery checkpoints', t => {
  for (const outcome of [
    { deliveryStatus: 'unknown', effectStatus: 'unknown', verification: 'unavailable' },
    { deliveryStatus: 'dispatched', effectStatus: 'applied', verification: 'matched', evidenceRef: 'receipt' },
  ] as const) {
    const f = harness(t);
    f.journal.prepare(attempt()); f.journal.markDispatchBoundary('execution-1');
    f.journal.pauseTask(TASK, 'timeout');
    assert.throws(() => f.journal.reserveTaskRecoveryObservation(TASK), /unresolved/);
    f.journal.recordOutcome('execution-1', outcome);
    assert.throws(() => f.journal.reserveTaskRecoveryObservation(TASK), /unknown|without a verified checkpoint/);
    assert.equal(f.journal.getTaskState(TASK), 'paused');
    assert.equal(f.journal.getTaskProgress(TASK)?.observationsUsed, 1);
  }
});

test('a settled independently verified effect can recover without preparing it again', t => {
  const f = harness(t);
  f.journal.prepare(attempt()); f.journal.markDispatchBoundary('execution-1');
  f.journal.recordOutcome('execution-1', { deliveryStatus: 'dispatched', effectStatus: 'applied',
    verification: 'matched', evidenceRef: 'receipt' });
  const ticket = f.journal.reserveTaskObservation(TASK, false);
  f.journal.recordTaskObservation(TASK, ticket, { observationId: 'verified', scopeRef: SCOPE,
    stateDigest: digest('documents') });
  f.journal.recordTaskCheckpoint(TASK, { checkpointId: 'documents-2', observationId: 'verified',
    stageRef: 'documents', predicateRef: 'fixture-documents-v1', evidenceRef: 'receipt',
    executionId: 'execution-1', terminal: false });
  f.journal.pauseTask(TASK, 'interference');
  const read = f.read();
  const binding = f.journal.recordTaskRecoveryObservation(TASK, read.ticket, read.observed,
    { ...read.verified, checkpointRef: 'documents-2' });
  const p = prompt(binding, f.clock);
  f.journal.resumeTask(p.ledger, p.accept());
  assert.equal(f.journal.attemptsForTask(TASK).length, 1);
});

test('active execution elsewhere globally blocks a paused task recovery', t => {
  const f = harness(t);
  f.journal.pauseTask(TASK, 'interference');
  const binding = f.recover();
  const p = prompt(binding, f.clock);
  const intent = p.accept();
  start(f.journal, 'another-task');
  assert.throws(() => f.journal.resumeTask(p.ledger, intent), /active execution/);
  f.journal.prepare(attempt('other-observation', 'other-execution', 'another-task'));
  f.journal.markDispatchBoundary('other-execution');
  f.journal.pauseTask('another-task', 'timeout');
  assert.throws(() => f.journal.resumeTask(p.ledger, intent), /unresolved/);
  assert.equal(f.journal.getTaskState(TASK), 'paused');
});

test('observation exhaustion and repeated recovery states cannot reset limits', t => {
  const f = harness(t, { maxObservations: 2, maxDecisions: 20, maxStateVisits: 3 });
  f.journal.pauseTask(TASK, 'interference');
  const p = prompt(f.recover(), f.clock);
  assert.throws(() => f.journal.resumeTask(p.ledger, p.accept()), /observations budget/);
  assert.equal(f.journal.getTaskProgress(TASK)?.pauseReason, 'observations');
  assert.equal(f.journal.getTaskProgress(TASK)?.observationsUsed, 2);
  const looping = harness(t, { maxObservations: 20, maxDecisions: 20, maxStateVisits: 1 });
  looping.journal.pauseTask(TASK, 'interference');
  looping.recover();
  assert.throws(() => looping.recover(), /no_progress/);
  assert.equal(looping.journal.getTaskProgress(TASK)?.pauseReason, 'no_progress');
  assert.throws(() => looping.journal.reserveTaskRecoveryObservation(TASK), /no_progress/);
});

test('decision exhaustion, time expiry and backward clocks remain terminal pauses for recovery', t => {
  const f = harness(t, { maxObservations: 20, maxDecisions: 1, maxStateVisits: 3 });
  f.journal.consumeTaskDecision(TASK, 'initial');
  f.journal.pauseTask(TASK, 'interference');
  const p = prompt(f.recover(), f.clock);
  assert.throws(() => f.journal.resumeTask(p.ledger, p.accept()), /decisions budget/);
  const expired = harness(t);
  expired.journal.pauseTask(TASK, 'interference');
  const expiredPrompt = prompt(expired.recover());
  const intent = expiredPrompt.accept();
  expired.setTime(expired.journal.getTaskBudget(TASK)!.deadlineMillis);
  assert.throws(() => expired.journal.resumeTask(expiredPrompt.ledger, intent), /time budget/);
  assert.equal(expired.journal.getTaskProgress(TASK)?.currentObservation, null);
  const backward = harness(t);
  backward.journal.pauseTask(TASK, 'interference'); backward.setTime(999);
  assert.throws(() => backward.journal.reserveTaskRecoveryObservation(TASK), /clock invalid/);
  backward.setTime(2000);
  assert.throws(() => backward.journal.reserveTaskRecoveryObservation(TASK), /clock invalid/);
});

test('step exhaustion cannot be bypassed by recovery', t => {
  const f = harness(t);
  const db = new DatabaseSync(f.path);
  try { db.prepare('UPDATE task_budgets SET max_steps = 1 WHERE task_id = ?').run(TASK); }
  finally { db.close(); }
  f.journal.prepare(attempt()); f.journal.pauseTask(TASK, 'interference');
  assert.throws(() => f.journal.reserveTaskRecoveryObservation(TASK), /step budget/);
  assert.equal(f.journal.getTaskBudget(TASK)?.stepsUsed, 1);
});

test('legacy tasks, missing checkpoints and completed tasks cannot enter recovery', t => {
  const f = harness(t);
  assert.throws(() => f.journal.reserveTaskRecoveryObservation(TASK), /not paused/);
  f.journal.cancelTask(TASK);
  f.journal.startTask('legacy', 1, 1);
  f.journal.enableTaskProgress('legacy', SCOPE, VERIFIER);
  f.journal.pauseTask('legacy', 'interference');
  assert.throws(() => f.journal.reserveTaskRecoveryObservation('legacy'), /admitted task/);
  start(f.journal, 'no-checkpoint');
  f.journal.enableTaskProgress('no-checkpoint', SCOPE, VERIFIER);
  f.journal.pauseTask('no-checkpoint', 'interference');
  assert.throws(() => f.journal.reserveTaskRecoveryObservation('no-checkpoint'), /checkpoint/);
  start(f.journal, 'completed');
  f.journal.completeTask('completed', 'terminal');
  assert.throws(() => f.journal.reserveTaskRecoveryObservation('completed'), /not paused/);
});

test('changed checkpoint history or current recovery state rejects an accepted reply', t => {
  for (const sql of [
    "UPDATE task_checkpoints SET evidence_ref = 'changed' WHERE checkpoint_id = 'documents-1'",
    "UPDATE task_observations SET state_digest = '" + digest('changed') + "' WHERE observation_id = 'recovery-1'",
  ]) {
    const f = harness(t);
    f.journal.pauseTask(TASK, 'interference');
    const p = prompt(f.recover(), f.clock);
    const intent = p.accept();
    const db = new DatabaseSync(f.path);
    try { db.exec(sql); } finally { db.close(); }
    assert.throws(() => f.journal.resumeTask(p.ledger, intent), /binding changed/);
    assert.equal(f.journal.getTaskState(TASK), 'paused');
  }
});

test('failed Resume SQL rolls back activation, event and intent consumption together', t => {
  const f = harness(t);
  f.journal.pauseTask(TASK, 'interference');
  const p = prompt(f.recover(), f.clock);
  const intent = p.accept();
  const db = new DatabaseSync(f.path);
  try {
    db.exec(`CREATE TRIGGER reject_resume BEFORE INSERT ON task_events
      WHEN NEW.event_kind LIKE 'resumed:%'
      BEGIN SELECT RAISE(ABORT, 'synthetic resume failure'); END;`);
    assert.throws(() => f.journal.resumeTask(p.ledger, intent), /resume failure/);
    assert.equal(f.journal.getTaskState(TASK), 'paused');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM task_resume_intents').get() as { n: number }).n, 0);
    db.exec('DROP TRIGGER reject_resume');
    f.journal.resumeTask(p.ledger, intent);
    assert.equal(f.journal.getTaskState(TASK), 'active');
  } finally { db.close(); }
});

test('committed correction cancels the old revision, settles unsent work and preserves its admission', t => {
  const f = harness(t);
  f.journal.prepare(attempt());
  const original = f.journal.getTaskRecord(TASK)!.admission;
  const next = command(TASK, 2);
  assert.deepEqual(f.journal.cancelTaskForCorrection(TASK, next.session, next.input), []);
  const record = f.journal.getTaskRecord(TASK)!;
  assert.equal(record.state, 'cancelled');
  assert.equal(record.goalRevision, 1);
  assert.deepEqual(record.admission, original);
  assert.equal(record.correction?.replacementGoalRevision, 2);
  assert.equal(record.correction?.commandDigest, digest(next.input as any));
  assert.equal(record.progress?.currentObservation, null);
  assert.equal(record.attempts[0]?.outcome?.deliveryStatus, 'not_dispatched');
  assert.throws(() => f.journal.markDispatchBoundary('execution-1'));
  assert.throws(() => f.journal.reserveTaskRecoveryObservation(TASK), /not paused/);
  const reopened = new AttemptJournal(f.path, f.clock);
  try {
    reopened.recoverAfterRestart();
    assert.equal(reopened.getTaskState(TASK), 'cancelled');
    assert.deepEqual(reopened.getTaskRecord(TASK)?.correction, record.correction);
  } finally { reopened.close(); }
});

test('correction fences paused intent and late reads, retains uncertain effects and never undoes them', t => {
  const f = harness(t);
  f.journal.pauseTask(TASK, 'interference');
  const p = prompt(f.recover(), f.clock);
  const intent = p.accept();
  const read = f.read();
  const next = command(TASK, 2);
  f.journal.cancelTaskForCorrection(TASK, next.session, next.input);
  assert.throws(() => f.journal.resumeTask(p.ledger, intent), /not paused/);
  assert.throws(() => f.journal.recordTaskRecoveryObservation(TASK, read.ticket,
    read.observed, read.verified), /not paused/);
  const uncertain = harness(t);
  uncertain.journal.prepare(attempt()); uncertain.journal.markDispatchBoundary('execution-1');
  const corrected = command(TASK, 2);
  assert.equal(uncertain.journal.cancelTaskForCorrection(TASK, corrected.session, corrected.input).length, 1);
  uncertain.journal.recordOutcome('execution-1', { deliveryStatus: 'unknown', effectStatus: 'unknown',
    verification: 'unavailable' });
  assert.equal(uncertain.journal.unresolvedAttempts().length, 1);
  assert.equal(uncertain.journal.getTaskState(TASK), 'cancelled');
  assert.throws(() => start(uncertain.journal, 'replacement'), /unresolved/);
});

test('copies, dictation, foreign input and skipped correction revisions do not cancel', t => {
  const f = harness(t);
  const next = command(TASK, 2);
  assert.throws(() => f.journal.cancelTaskForCorrection(TASK, next.session, { ...next.input }), /not issued/);
  const foreign = command(TASK, 2);
  assert.throws(() => f.journal.cancelTaskForCorrection(TASK, foreign.session, next.input), /not issued/);
  const claimed = command(TASK, 2);
  claimed.session.claimForAdmission(claimed.input);
  assert.throws(() => f.journal.cancelTaskForCorrection(TASK, claimed.session, claimed.input), /claimed/);
  for (const other of [command(TASK, 1), command(TASK, 3), command(TASK, 2, 'dictation'), command('other', 2)]) {
    assert.throws(() => f.journal.cancelTaskForCorrection(TASK, other.session, other.input), /next goal revision/);
  }
  assert.equal(f.journal.getTaskState(TASK), 'active');
  assert.equal(f.journal.getTaskRecord(TASK)?.correction, null);
  f.journal.cancelTaskForCorrection(TASK, next.session, next.input);
});

test('correction SQL failure does not consume the command or change the old revision', t => {
  const f = harness(t);
  const next = command(TASK, 2);
  const db = new DatabaseSync(f.path);
  try {
    db.exec(`CREATE TRIGGER reject_correction BEFORE INSERT ON task_corrections
      BEGIN SELECT RAISE(ABORT, 'synthetic correction failure'); END;`);
    assert.throws(() => f.journal.cancelTaskForCorrection(TASK, next.session, next.input), /correction failure/);
    assert.equal(f.journal.getTaskState(TASK), 'active');
    db.exec('DROP TRIGGER reject_correction');
    f.journal.cancelTaskForCorrection(TASK, next.session, next.input);
  } finally { db.close(); }
});
