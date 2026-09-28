import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startPortalFixture } from '../../fixtures/portal.ts';
import { schema } from '../../protocol/src/contract.ts';
import { digest } from '../../protocol/src/json.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { AttemptJournal } from '../../runtime/src/attempt-journal.ts';
import { CommittedInputSession } from '../../runtime/src/committed-input.ts';
import { TaskAdmissionRegistry } from '../../runtime/src/task-authority.ts';
import type { TaskAdmission } from '../../runtime/src/task-authority.ts';
import { ManagedFillTask } from '../src/managed-fill-task.ts';
import { ManagedObservationSession } from '../src/managed-observation.ts';
import type { ManagedObservation } from '../src/managed-observation.ts';

function mint(session: ManagedObservationSession, value: string, taskId: string) {
  const revision = { taskId, taskEpoch: 1, goalRevision: 1 };
  const endpoint = bindEndpoint(['command']);
  const inputSession = new CommittedInputSession(endpoint, revision);
  const command = inputSession.accept(endpoint, Buffer.from(JSON.stringify({
    ...structuredClone(schema.examples[0]), ...revision,
    messageId: `command-${taskId}`, utteranceId: `utterance-${taskId}`,
    source: 'text', text: `Fill the Search field with ${value}`,
  }))).input;
  const registry = new TaskAdmissionRegistry(revision, inputSession);
  const admission = registry.admit(command, {
    admissionId: `admission-${taskId}`, goal: command.text,
    outcomeKind: 'FILL', scopeRef: session.scopeRef,
    completionVerifierRef: 'managed-field-v1', policyRevision: 'managed-policy-v1',
    approvedEffects: ['READ', 'LOCAL_EDIT', 'EXTERNAL_WRITE'],
    parameters: [{ parameterRef: 'fill-value', sourceRef: command.messageId,
      valueDigest: digest(value) }],
  });
  return { registry, admission };
}

function target(observation: ManagedObservation): string {
  const control = observation.controls.find(item => item.label === 'Find invoice');
  assert.ok(control?.editable);
  return control.id;
}

function localJournal() {
  const root = mkdtempSync(join(tmpdir(), 'systemone-managed-fill-'));
  return { root, journal: new AttemptJournal(join(root, 'attempts.sqlite')) };
}

test('an admitted managed-browser fill uses one permit and records observed field state', async () => {
  const portal = await startPortalFixture();
  const local = localJournal();
  let session: ManagedObservationSession | undefined;
  try {
    session = await ManagedObservationSession.launch(portal.url, {
      allowedOrigins: [new URL(portal.url).origin], headless: true,
    });
    const observed = await session.observe();
    const { registry, admission } = mint(session, 'fixture-123', 'managed-fill-one');
    assert.throws(() => new ManagedFillTask(local.journal, registry,
      { ...admission, approvedEffects: ['READ', 'LOCAL_EDIT'] },
      session!, observed, target(observed), 'fixture-123', 'fill-value'),
    /outside admitted task/);
    assert.equal(local.journal.getTaskState(admission.taskId), undefined);
    assert.throws(() => new ManagedFillTask(local.journal, registry,
      { ...admission }, session!, observed, target(observed), 'fixture-123',
      'fill-value'), /not issued/);
    const task = new ManagedFillTask(local.journal, registry, admission, session,
      observed, target(observed), 'fixture-123', 'fill-value');
    const permit = task.issuePermit();
    await assert.rejects(task.execute({ ...permit }), /cloned/);
    const attempt = await task.execute(permit);
    assert.equal(attempt.phase, 'settled');
    assert.equal(attempt.outcome?.deliveryStatus, 'dispatched');
    assert.equal(attempt.outcome?.effectStatus, 'applied');
    assert.equal(attempt.outcome?.verification, 'matched');
    assert.equal(local.journal.getTaskState(admission.taskId), 'completed');
    assert.deepEqual(local.journal.eventKinds(permit.executionId),
      ['prepared', 'dispatch_boundary', 'outcome']);
    await assert.rejects(task.execute(permit), /replayed/);
    const after = await session.observe();
    assert.equal(JSON.stringify(after).includes('fixture-123'), false);
    const stopped = await task.stop();
    assert.equal(stopped.browserFenced, true);
    assert.equal(local.journal.getTaskState(admission.taskId), 'completed');
  } finally {
    await session?.close();
    local.journal.close();
    rmSync(local.root, { recursive: true, force: true });
    await portal.close();
  }
});

test('stale observation and changed byte provenance cannot fill a managed page', async () => {
  const portal = await startPortalFixture();
  const local = localJournal();
  let session: ManagedObservationSession | undefined;
  try {
    session = await ManagedObservationSession.launch(portal.url, {
      allowedOrigins: [new URL(portal.url).origin], headless: true,
    });
    const old = await session.observe();
    const { registry, admission } = mint(session, 'fixture-123', 'managed-fill-stale');
    assert.throws(() => new ManagedFillTask(local.journal, registry, admission,
      session!, old, target(old), 'other-value', 'fill-value'), /provenance/);
    const task = new ManagedFillTask(local.journal, registry, admission,
      session, old, target(old), 'fixture-123', 'fill-value');
    await session.observe();
    const permit = task.issuePermit();
    const attempt = await task.execute(permit);
    assert.equal(attempt.outcome?.deliveryStatus, 'not_dispatched');
    assert.equal(local.journal.getTaskState(admission.taskId), 'active');
  } finally {
    await session?.close();
    local.journal.close();
    rmSync(local.root, { recursive: true, force: true });
    await portal.close();
  }
});

test('Stop during preflight fences the journal and prevents a late fill send', async () => {
  const portal = await startPortalFixture();
  const local = localJournal();
  let session: ManagedObservationSession | undefined;
  try {
    session = await ManagedObservationSession.launch(portal.url, {
      allowedOrigins: [new URL(portal.url).origin], headless: true,
    });
    const observed = await session.observe();
    const { registry, admission } = mint(session, 'fixture-123', 'managed-fill-stop');
    const task = new ManagedFillTask(local.journal, registry, admission,
      session, observed, target(observed), 'fixture-123', 'fill-value');
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let sent = 0;
    session.prepareFill = async () => {
      await held;
      return { controlId: target(observed), release() {},
        async send() { sent++; return true; } };
    };
    const permit = task.issuePermit();
    const work = task.execute(permit);
    for (let count = 0; count < 50
      && local.journal.getAttempt(permit.executionId)?.phase !== 'prepared'; count++) {
      await delay(2);
    }
    const stopped = await task.stop();
    release();
    const attempt = await work;
    assert.equal(stopped.browserFenced, true);
    assert.equal(local.journal.getTaskState(admission.taskId), 'cancelled');
    assert.equal(attempt.outcome?.deliveryStatus, 'not_dispatched');
    assert.equal(sent, 0);
  } finally {
    await session?.close();
    local.journal.close();
    rmSync(local.root, { recursive: true, force: true });
    await portal.close();
  }
});

test('Stop after the dispatch boundary never turns a late receipt into task completion', async () => {
  const portal = await startPortalFixture();
  const local = localJournal();
  let session: ManagedObservationSession | undefined;
  try {
    session = await ManagedObservationSession.launch(portal.url, {
      allowedOrigins: [new URL(portal.url).origin], headless: true,
    });
    const observed = await session.observe();
    const { registry, admission } = mint(session, 'fixture-123', 'managed-fill-late');
    const task = new ManagedFillTask(local.journal, registry, admission,
      session, observed, target(observed), 'fixture-123', 'fill-value');
    let release!: (matched: boolean) => void;
    const held = new Promise<boolean>(resolve => { release = resolve; });
    session.prepareFill = async () => ({ controlId: target(observed), release() {},
      send() { return held; } });
    const permit = task.issuePermit();
    const work = task.execute(permit);
    for (let count = 0; count < 50
      && local.journal.getAttempt(permit.executionId)?.phase !== 'at_dispatch_boundary'; count++) {
      await delay(2);
    }
    assert.equal(local.journal.getAttempt(permit.executionId)?.phase, 'at_dispatch_boundary');
    const stopped = await task.stop();
    assert.equal(stopped.browserFenced, true);
    assert.deepEqual(stopped.unresolvedExecutionIds, [permit.executionId]);
    release(true);
    const attempt = await work;
    assert.equal(attempt.outcome?.verification, 'matched');
    assert.equal(local.journal.getTaskState(admission.taskId), 'cancelled');
    assert.throws(() => local.journal.completeTask(admission.taskId, 'late-fill'), /active/);
  } finally {
    await session?.close();
    local.journal.close();
    rmSync(local.root, { recursive: true, force: true });
    await portal.close();
  }
});

test('uncertain managed fill remains unknown and blocks a new task', async () => {
  const portal = await startPortalFixture();
  const local = localJournal();
  let session: ManagedObservationSession | undefined;
  try {
    session = await ManagedObservationSession.launch(portal.url, {
      allowedOrigins: [new URL(portal.url).origin], headless: true,
    });
    const observed = await session.observe();
    const { registry, admission } = mint(session, 'fixture-123', 'managed-fill-unknown');
    const task = new ManagedFillTask(local.journal, registry, admission,
      session, observed, target(observed), 'fixture-123', 'fill-value');
    session.prepareFill = async () => ({ controlId: target(observed), release() {},
      async send() { return false; } });
    const attempt = await task.execute(task.issuePermit());
    assert.equal(attempt.outcome?.deliveryStatus, 'unknown');
    assert.equal(attempt.outcome?.effectStatus, 'unknown');
    assert.equal(local.journal.getTaskState(admission.taskId), 'active');
    assert.throws(() => local.journal.completeTask(admission.taskId, 'unverified'), /unknown/);
    await task.stop();
    assert.throws(() => local.journal.startTask('another-task', 1, 1), /unresolved or unknown/);
  } finally {
    await session?.close();
    local.journal.close();
    rmSync(local.root, { recursive: true, force: true });
    await portal.close();
  }
});
