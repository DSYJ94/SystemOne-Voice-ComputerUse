import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startPortalFixture } from '../../fixtures/portal.ts';
import { schema } from '../../protocol/src/contract.ts';
import { digest } from '../../protocol/src/json.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { AttemptJournal } from '../../runtime/src/attempt-journal.ts';
import { CommittedInputSession } from '../../runtime/src/committed-input.ts';
import { TaskAdmissionRegistry } from '../../runtime/src/task-authority.ts';
import { ManagedNavigateTask } from '../src/managed-navigate-task.ts';
import { ManagedObservationSession } from '../src/managed-observation.ts';

function admitted(session: ManagedObservationSession, taskId: string,
  destinationUrl: string) {
  const revision = { taskId, taskEpoch: 1, goalRevision: 1 };
  const endpoint = bindEndpoint(['command']);
  const input = new CommittedInputSession(endpoint, revision);
  const command = input.accept(endpoint, Buffer.from(JSON.stringify({
    ...structuredClone(schema.examples[0]), ...revision,
    messageId: `command-${taskId}`, utteranceId: `utterance-${taskId}`,
    source: 'text', text: 'Navigate through Browse all invoices',
  }))).input;
  const registry = new TaskAdmissionRegistry(revision, input);
  const admission = registry.admit(command, {
    admissionId: `admission-${taskId}`, goal: command.text,
    outcomeKind: 'NAVIGATE', scopeRef: session.scopeRef,
    completionVerifierRef: 'managed-url-v1', policyRevision: 'managed-policy-v1',
    approvedEffects: ['READ', 'NAVIGATE'],
    parameters: [{ parameterRef: 'destination', sourceRef: command.messageId,
      valueDigest: digest(destinationUrl) }],
  });
  return { registry, admission };
}

test('an admitted observed link navigates once and verifies exact destination', async () => {
  const portal = await startPortalFixture();
  const root = mkdtempSync(join(tmpdir(), 'systemone-managed-navigate-'));
  const journal = new AttemptJournal(join(root, 'attempts.sqlite'));
  let session: ManagedObservationSession | undefined;
  try {
    session = await ManagedObservationSession.launch(portal.url, {
      allowedOrigins: [new URL(portal.url).origin], headless: true,
    });
    const observed = await session.observe();
    assert.equal(observed.controls.find(control =>
      control.label === 'External sample')?.destinationUrl, null);
    const links = observed.controls.filter(control =>
      control.label === 'Browse all invoices' && control.destinationUrl);
    assert.equal(links.length, 1);
    const link = links[0]!;
    assert.equal(link.destinationUrl, `${portal.url}/invoices`);
    const { registry, admission } = admitted(session, 'navigate-one',
      link.destinationUrl!);
    const task = new ManagedNavigateTask(journal, registry, admission, session,
      observed, link.id, link.destinationUrl!, 'destination');
    const permit = task.issuePermit();
    await assert.rejects(task.execute({ ...permit }), /cloned/);
    const attempt = await task.execute(permit);
    assert.equal(attempt.outcome?.verification, 'matched');
    assert.equal(journal.getTaskState(admission.taskId), 'completed');
    assert.deepEqual(journal.eventKinds(permit.executionId),
      ['prepared', 'dispatch_boundary', 'outcome']);
    assert.equal(portal.requestCount('/invoices'), 1);
    const after = await session.observe();
    assert.equal(after.url, `${portal.url}/invoices`);
    assert.equal(after.title, 'Invoice search');
    await assert.rejects(task.execute(permit), /replayed/);
  } finally {
    await session?.close();
    journal.close();
    rmSync(root, { recursive: true, force: true });
    await portal.close();
  }
});

test('stale observation and changed destination never dispatch navigation', async () => {
  const portal = await startPortalFixture();
  const root = mkdtempSync(join(tmpdir(), 'systemone-managed-nav-stale-'));
  const journal = new AttemptJournal(join(root, 'attempts.sqlite'));
  let session: ManagedObservationSession | undefined;
  try {
    session = await ManagedObservationSession.launch(portal.url, {
      allowedOrigins: [new URL(portal.url).origin], headless: true,
    });
    const observed = await session.observe();
    const link = observed.controls.find(control =>
      control.label === 'Browse all invoices');
    assert.ok(link?.destinationUrl);
    const { registry, admission } = admitted(session, 'navigate-stale',
      link.destinationUrl);
    assert.throws(() => new ManagedNavigateTask(journal, registry, admission,
      session!, { ...observed, coverage: { ...observed.coverage, complete: false } },
      link.id, link.destinationUrl!, 'destination'), /outside admitted/);
    assert.throws(() => new ManagedNavigateTask(journal, registry, admission,
      session!, observed, link.id, `${portal.url}/invoices/INV-104`,
      'destination'), /outside admitted/);
    const task = new ManagedNavigateTask(journal, registry, admission,
      session, observed, link.id, link.destinationUrl, 'destination');
    await session.observe();
    const attempt = await task.execute(task.issuePermit());
    assert.equal(attempt.outcome?.deliveryStatus, 'not_dispatched');
    assert.equal(portal.requestCount('/invoices'), 0);
  } finally {
    await session?.close();
    journal.close();
    rmSync(root, { recursive: true, force: true });
    await portal.close();
  }
});

test('Stop during navigation preflight prevents a late send', async () => {
  const portal = await startPortalFixture();
  const root = mkdtempSync(join(tmpdir(), 'systemone-managed-nav-stop-'));
  const journal = new AttemptJournal(join(root, 'attempts.sqlite'));
  let session: ManagedObservationSession | undefined;
  try {
    session = await ManagedObservationSession.launch(portal.url, {
      allowedOrigins: [new URL(portal.url).origin], headless: true,
    });
    const observed = await session.observe();
    const link = observed.controls.find(control =>
      control.label === 'Browse all invoices');
    assert.ok(link?.destinationUrl);
    const { registry, admission } = admitted(session, 'navigate-stop',
      link.destinationUrl);
    const task = new ManagedNavigateTask(journal, registry, admission,
      session, observed, link.id, link.destinationUrl, 'destination');
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let sends = 0;
    session.prepareNavigate = async () => {
      await held;
      return { controlId: link.id, release() {},
        async send() { sends++; return true; } };
    };
    const permit = task.issuePermit();
    const pending = task.execute(permit);
    for (let count = 0; count < 100
      && journal.getAttempt(permit.executionId)?.phase !== 'prepared'; count++) {
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal(journal.getAttempt(permit.executionId)?.phase, 'prepared');
    const stopped = await task.stop();
    release();
    const attempt = await pending;
    assert.equal(stopped.browserFenced, true);
    assert.equal(attempt.outcome?.deliveryStatus, 'not_dispatched');
    assert.equal(sends, 0);
    assert.equal(portal.requestCount('/invoices'), 0);
  } finally {
    await session?.close();
    journal.close();
    rmSync(root, { recursive: true, force: true });
    await portal.close();
  }
});

test('Stop after navigation dispatch keeps a late receipt from completing', async () => {
  const portal = await startPortalFixture();
  const root = mkdtempSync(join(tmpdir(), 'systemone-managed-nav-late-'));
  const journal = new AttemptJournal(join(root, 'attempts.sqlite'));
  let session: ManagedObservationSession | undefined;
  try {
    session = await ManagedObservationSession.launch(portal.url, {
      allowedOrigins: [new URL(portal.url).origin], headless: true,
    });
    const observed = await session.observe();
    const link = observed.controls.find(control =>
      control.label === 'Browse all invoices');
    assert.ok(link?.destinationUrl);
    const { registry, admission } = admitted(session, 'navigate-late',
      link.destinationUrl);
    const task = new ManagedNavigateTask(journal, registry, admission,
      session, observed, link.id, link.destinationUrl, 'destination');
    let release!: (matched: boolean) => void;
    const held = new Promise<boolean>(resolve => { release = resolve; });
    session.prepareNavigate = async () => ({ controlId: link.id,
      release() {}, send() { return held; } });
    const permit = task.issuePermit();
    const pending = task.execute(permit);
    for (let count = 0; count < 100
      && journal.getAttempt(permit.executionId)?.phase !== 'at_dispatch_boundary'; count++) {
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal(journal.getAttempt(permit.executionId)?.phase, 'at_dispatch_boundary');
    const stopped = await task.stop();
    assert.deepEqual(stopped.unresolvedExecutionIds, [permit.executionId]);
    release(true);
    const attempt = await pending;
    assert.equal(attempt.outcome?.deliveryStatus, 'unknown');
    assert.equal(journal.getTaskState(admission.taskId), 'cancelled');
    assert.equal(portal.requestCount('/invoices'), 0);
  } finally {
    await session?.close();
    journal.close();
    rmSync(root, { recursive: true, force: true });
    await portal.close();
  }
});
