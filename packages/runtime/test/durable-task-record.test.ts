import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { schema } from '../../protocol/src/contract.ts';
import { digest } from '../../protocol/src/json.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { AttemptJournal } from '../src/attempt-journal.ts';
import type { PreparedAttempt } from '../src/attempt-journal.ts';
import { CommittedInputSession } from '../src/committed-input.ts';
import { TaskAdmissionRegistry } from '../src/task-authority.ts';

function admission(taskId = 'task-001') {
  const revision = { taskId, taskEpoch: 1, goalRevision: 1 };
  const endpoint = bindEndpoint(['command']);
  const session = new CommittedInputSession(endpoint, revision);
  const command = { ...structuredClone(schema.examples[0]), ...revision,
    text: 'Locate Documents/Budget.xlsx without opening it' };
  const input = session.accept(endpoint, Buffer.from(JSON.stringify(command))).input;
  const registry = new TaskAdmissionRegistry(revision, session);
  const issued = registry.admit(input, {
    admissionId: `admission-${taskId}`, goal: input.text,
    outcomeKind: 'LOCATE', scopeRef: 'native-fixture-only',
    completionVerifierRef: 'fixture-selected-v1', policyRevision: 'fixture-policy-v1',
    approvedEffects: ['READ', 'NAVIGATE'],
    parameters: [{ parameterRef: 'file-path', sourceRef: 'fixture-config',
      valueDigest: digest('Documents/Budget.xlsx') }],
  });
  return { registry, issued };
}

function attempt(taskId = 'task-001', executionId = 'execution-1'): PreparedAttempt {
  return { taskId, taskEpoch: 1, goalRevision: 1, executionId,
    permitRef: `permit-${executionId}`, scopeRef: 'native-fixture-only',
    observationId: 'observation-1', candidateId: 'candidate-1',
    candidateSetDigest: 'a'.repeat(64), actionDigest: 'b'.repeat(64),
    policyRevision: 'fixture-policy-v1', leaseGeneration: 1 };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'systemone-durable-contract-'));
  const path = join(root, 'tasks.sqlite');
  return { root, path, journal: new AttemptJournal(path),
    cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

test('admitted goal, bindings and budget survive restart without granting resume', () => {
  const local = fixture();
  const minted = admission();
  try {
    local.journal.startAdmittedTask(minted.registry, minted.issued);
    local.journal.prepare(attempt());
    local.journal.close();
    const reopened = new AttemptJournal(local.path);
    try {
      reopened.recoverAfterRestart();
      const record = reopened.getTaskRecord('task-001')!;
      assert.deepEqual(record.admission, minted.issued);
      assert.equal(record.state, 'paused');
      assert.equal(record.budget?.stepsUsed, 1);
      assert.equal(record.attempts[0]?.outcome?.deliveryStatus, 'not_dispatched');
      assert.equal(record.completion, null);
      assert.ok(Object.isFrozen(record));
      assert.ok(Object.isFrozen(record.admission?.parameters[0]));
      assert.throws(() => reopened.prepare(attempt('task-001', 'execution-2')), /not active/);
      // Serialized state is history; it cannot transfer the one-use admission again.
      assert.throws(() => minted.registry.claimForTask(record.admission!), /not issued/);
    } finally { reopened.close(); }
  } finally { local.cleanup(); }
});

test('copied, foreign and already claimed admissions roll back every durable start row', () => {
  const local = fixture();
  const minted = admission();
  const foreign = admission('foreign-task');
  const consumed = admission('consumed-task');
  try {
    assert.throws(() => local.journal.startAdmittedTask(minted.registry,
      structuredClone(minted.issued)), /not issued/);
    assert.equal(local.journal.getTaskRecord('task-001'), undefined);
    assert.equal(local.journal.getTaskBudget('task-001'), undefined);
    assert.deepEqual(local.journal.taskEventKinds('task-001'), []);
    assert.throws(() => local.journal.startAdmittedTask(foreign.registry,
      minted.issued), /not issued/);
    consumed.registry.claimForTask(consumed.issued);
    assert.throws(() => local.journal.startAdmittedTask(consumed.registry, consumed.issued), /claimed/);
    assert.equal(local.journal.getTaskRecord('consumed-task'), undefined);
    local.journal.startAdmittedTask(minted.registry, minted.issued);
    local.journal.cancelTask('task-001');
    assert.throws(() => local.journal.startAdmittedTask(minted.registry, minted.issued));
    assert.equal(local.journal.getTaskRecord('task-001')?.state, 'cancelled');
  } finally { local.journal.close(); local.cleanup(); }
});

test('a blocked durable start does not consume another genuine admission', () => {
  const local = fixture();
  const first = admission();
  const second = admission('task-002');
  try {
    local.journal.startAdmittedTask(first.registry, first.issued);
    assert.throws(() => local.journal.startAdmittedTask(second.registry, second.issued), /active/);
    assert.equal(local.journal.getTaskRecord('task-002'), undefined);
    local.journal.cancelTask('task-001');
    local.journal.startAdmittedTask(second.registry, second.issued);
    assert.deepEqual(local.journal.getTaskRecord('task-002')?.admission, second.issued);
  } finally { local.journal.close(); local.cleanup(); }
});

test('stored scope and policy bind preparation even when the task revision matches', () => {
  const local = fixture();
  const minted = admission();
  try {
    local.journal.startAdmittedTask(minted.registry, minted.issued);
    assert.throws(() => local.journal.prepare({ ...attempt(), scopeRef: 'another-app' }), /admitted/);
    assert.throws(() => local.journal.prepare({ ...attempt(), policyRevision: 'wider-policy' }), /admitted/);
    assert.equal(local.journal.getTaskBudget('task-001')?.stepsUsed, 0);
    assert.deepEqual(local.journal.attemptsForTask('task-001'), []);
    local.journal.prepare(attempt());
    local.journal.markDispatchBoundary('execution-1');
  } finally { local.journal.close(); local.cleanup(); }
});

test('completion and its verifier-bound evidence survive together after reopening', () => {
  const local = fixture();
  const minted = admission();
  try {
    local.journal.startAdmittedTask(minted.registry, minted.issued);
    local.journal.prepare(attempt());
    local.journal.markDispatchBoundary('execution-1');
    local.journal.recordOutcome('execution-1', { deliveryStatus: 'dispatched',
      effectStatus: 'applied', verification: 'matched', evidenceRef: 'selected-file-evidence' });
    local.journal.completeTask('task-001', 'selected-file-evidence');
    local.journal.close();
    const reopened = new AttemptJournal(local.path);
    try {
      reopened.recoverAfterRestart();
      const record = reopened.getTaskRecord('task-001')!;
      assert.equal(record.state, 'completed');
      assert.equal(record.completion?.evidenceRef, 'selected-file-evidence');
      assert.equal(record.completion?.completionVerifierRef, 'fixture-selected-v1');
      assert.equal(record.attempts[0]?.outcome?.verification, 'matched');
    } finally { reopened.close(); }
  } finally { local.cleanup(); }
});

test('failure writing terminal evidence rolls back completion and preserves settled effect history', () => {
  const local = fixture();
  const minted = admission();
  const other = new DatabaseSync(local.path);
  try {
    local.journal.startAdmittedTask(minted.registry, minted.issued);
    local.journal.prepare(attempt());
    local.journal.markDispatchBoundary('execution-1');
    local.journal.recordOutcome('execution-1', { deliveryStatus: 'dispatched',
      effectStatus: 'applied', verification: 'matched', evidenceRef: 'selected-file-evidence' });
    other.exec(`CREATE TRIGGER reject_completion BEFORE INSERT ON task_completions
      BEGIN SELECT RAISE(ABORT, 'synthetic completion write failure'); END;`);
    assert.throws(() => local.journal.completeTask('task-001', 'selected-file-evidence'), /write failure/);
    const record = local.journal.getTaskRecord('task-001')!;
    assert.equal(record.state, 'active');
    assert.equal(record.completion, null);
    assert.equal(record.attempts[0]?.outcome?.effectStatus, 'applied');
    assert.deepEqual(local.journal.taskEventKinds('task-001'), ['started']);
  } finally { other.close(); local.journal.close(); local.cleanup(); }
});

test('late matched receipts after cancellation remain history and cannot become terminal evidence', () => {
  const local = fixture();
  const minted = admission();
  try {
    local.journal.startAdmittedTask(minted.registry, minted.issued);
    local.journal.prepare(attempt());
    local.journal.markDispatchBoundary('execution-1');
    local.journal.cancelTask('task-001');
    local.journal.recordOutcome('execution-1', { deliveryStatus: 'dispatched',
      effectStatus: 'applied', verification: 'matched', evidenceRef: 'late-evidence' });
    assert.throws(() => local.journal.completeTask('task-001', 'late-evidence'), /not active/);
    assert.equal(local.journal.getTaskRecord('task-001')?.completion, null);
    assert.equal(local.journal.getTaskRecord('task-001')?.state, 'cancelled');
    assert.equal(local.journal.getTaskRecord('task-001')?.attempts[0]?.outcome?.evidenceRef, 'late-evidence');
  } finally { local.journal.close(); local.cleanup(); }
});

test('unknown effects after restart keep their admitted goal and block another task', () => {
  const local = fixture();
  const minted = admission();
  try {
    local.journal.startAdmittedTask(minted.registry, minted.issued);
    local.journal.prepare(attempt());
    local.journal.markDispatchBoundary('execution-1');
    local.journal.close();
    const reopened = new AttemptJournal(local.path);
    try {
      reopened.recoverAfterRestart();
      const record = reopened.getTaskRecord('task-001')!;
      assert.equal(record.state, 'paused');
      assert.equal(record.admission?.goal, minted.issued.goal);
      assert.equal(record.attempts[0]?.phase, 'at_dispatch_boundary');
      assert.equal(record.completion, null);
      const second = admission('task-002');
      assert.throws(() => reopened.startAdmittedTask(second.registry, second.issued), /unresolved/);
    } finally { reopened.close(); }
  } finally { local.cleanup(); }
});

test('changed persisted contract fails closed before preparation or completion', () => {
  const local = fixture();
  const minted = admission();
  const other = new DatabaseSync(local.path);
  try {
    local.journal.startAdmittedTask(minted.registry, minted.issued);
    other.prepare('UPDATE task_admissions SET contract_json = ? WHERE task_id = ?')
      .run(JSON.stringify({ ...minted.issued, scopeRef: 'another-app' }), 'task-001');
    assert.throws(() => local.journal.getTaskRecord('task-001'), /integrity/);
    assert.throws(() => local.journal.prepare(attempt()), /integrity/);
    assert.throws(() => local.journal.completeTask('task-001', 'read-only-evidence'), /integrity/);
    assert.equal(local.journal.getTaskState('task-001'), 'active');
    assert.equal(local.journal.getTaskBudget('task-001')?.stepsUsed, 0);
  } finally { other.close(); local.journal.close(); local.cleanup(); }
});

test('legacy revision-only tasks stay explicitly unbound rather than inventing a goal', () => {
  const local = fixture();
  try {
    local.journal.startTask('legacy-task', 1, 1);
    local.journal.completeTask('legacy-task', 'legacy-evidence');
    const record = local.journal.getTaskRecord('legacy-task')!;
    assert.equal(record.admission, null);
    assert.equal(record.completion?.completionVerifierRef, null);
    assert.equal(record.completion?.evidenceRef, 'legacy-evidence');
  } finally { local.journal.close(); local.cleanup(); }
});

test('a missing admitted contract cannot downgrade preparation to the legacy path', () => {
  const local = fixture();
  const minted = admission();
  const other = new DatabaseSync(local.path);
  try {
    local.journal.startAdmittedTask(minted.registry, minted.issued);
    other.prepare('DELETE FROM task_admissions WHERE task_id = ?').run('task-001');
    assert.throws(() => local.journal.getTaskRecord('task-001'), /integrity/);
    assert.throws(() => local.journal.prepare(attempt()), /integrity/);
    assert.throws(() => local.journal.completeTask('task-001', 'read-only-evidence'), /integrity/);
    assert.equal(local.journal.getTaskBudget('task-001')?.stepsUsed, 0);
  } finally { other.close(); local.journal.close(); local.cleanup(); }
});

test('contract changes after preparation are checked again at the dispatch boundary', () => {
  const local = fixture();
  const minted = admission();
  const other = new DatabaseSync(local.path);
  try {
    local.journal.startAdmittedTask(minted.registry, minted.issued);
    local.journal.prepare(attempt());
    other.prepare('UPDATE task_admissions SET contract_json = ? WHERE task_id = ?')
      .run(JSON.stringify({ ...minted.issued, policyRevision: 'wider-policy' }), 'task-001');
    assert.throws(() => local.journal.markDispatchBoundary('execution-1'), /integrity/);
    assert.equal(local.journal.getAttempt('execution-1')?.phase, 'prepared');
    local.journal.cancelTask('task-001');
    assert.equal(local.journal.getAttempt('execution-1')?.outcome?.deliveryStatus, 'not_dispatched');
  } finally { other.close(); local.journal.close(); local.cleanup(); }
});

test('failed contract persistence leaves no active task and allows a genuine admission to retry', () => {
  const local = fixture();
  const minted = admission();
  const other = new DatabaseSync(local.path);
  try {
    other.exec(`CREATE TRIGGER reject_contract BEFORE INSERT ON task_admissions
      BEGIN SELECT RAISE(ABORT, 'synthetic contract write failure'); END;`);
    assert.throws(() => local.journal.startAdmittedTask(minted.registry, minted.issued), /write failure/);
    assert.equal(local.journal.getTaskRecord('task-001'), undefined);
    assert.equal(local.journal.getTaskBudget('task-001'), undefined);
    assert.deepEqual(local.journal.taskEventKinds('task-001'), []);
    other.exec('DROP TRIGGER reject_contract');
    local.journal.startAdmittedTask(minted.registry, minted.issued);
    assert.equal(local.journal.getTaskRecord('task-001')?.state, 'active');
  } finally { other.close(); local.journal.close(); local.cleanup(); }
});
