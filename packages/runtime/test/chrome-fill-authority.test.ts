import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AttemptJournal } from '../src/attempt-journal.ts';
import { ChromeReadSession } from '../src/chrome-read-session.ts';
import { ChromeFillAuthority } from '../src/chrome-fill-authority.ts';
import type { ChromeFillRequest } from '../src/chrome-fill-authority.ts';
import type { JSONValue } from '../../protocol/src/json.ts';

const extensionId = 'a'.repeat(32);
const url = 'http://127.0.0.1:49081/';
const grant = { grantId: 'grant-1', extensionId, profileInstallId: 'profile-1',
  workerSessionId: 'worker-1', portSessionId: 'port-1', tabId: 8,
  windowId: 2, frameId: 0, documentId: 'document-1',
  origin: 'http://127.0.0.1:49081', url, connected: false };

function request(requestId = randomUUID()): ChromeFillRequest {
  return { requestId, grantId: grant.grantId, fieldLabel: 'Find invoice',
    value: 'INV-104', command: { type: 'command', protocolVersion: '2.0',
      messageId: randomUUID(), taskId: requestId, taskEpoch: 1, goalRevision: 1,
      source: 'text', mode: 'command', utteranceId: randomUUID(),
      utteranceRevision: 1,
      text: `Fill Find invoice in existing Chrome tab ${url} with text: INV-104`,
      isFinal: true, createdAt: new Date().toISOString(),
      originSurface: { adapter: 'native', surfaceId: 'systemone-panel',
        appBundleId: 'com.aurium.systemone.dev', windowId: 'command-panel',
        contentRevision: requestId } } };
}

function harness(t: { after(callback: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'systemone-chrome-fill-'));
  const journal = new AttemptJournal(join(root, 'attempts.sqlite'));
  const sent: Record<string, JSONValue>[] = [];
  const session = new ChromeReadSession(extensionId, value => { sent.push(value); },
    () => {});
  const authority = new ChromeFillAuthority(journal, session);
  t.after(() => { session.close(); journal.close();
    rmSync(root, { recursive: true, force: true }); });
  session.receive({ type: 'hello', challenge: 'challenge-1', binding: grant });
  const first = sent.find(item => item.type === 'observe')!;
  replyObservation(session, first.requestId!, true);
  return { journal, sent, session, authority };
}

function replyObservation(session: ChromeReadSession, requestId: JSONValue,
  complete: boolean, duplicate = false): void {
  const observationId = randomUUID();
  session.receive({ type: 'observation', requestId,
    binding: { ...grant, connected: true },
    snapshot: { observationId, title: 'Invoice Portal Fixture',
      url, complete, elements: [
        { id: `${observationId}:0`, role: 'input', label: 'Find invoice',
          disabled: false, editable: true },
        ...(duplicate ? [{ id: `${observationId}:1`, role: 'input', label: 'Find invoice',
          disabled: false, editable: true }] : []),
      ] } });
}

async function waitForMessage(sent: Record<string, JSONValue>[], type: string,
  count = 1): Promise<Record<string, JSONValue>> {
  for (let i = 0; i < 100; i++) {
    const found = sent.filter(item => item.type === type);
    if (found.length >= count) return found[count - 1]!;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error(`missing ${type}`);
}

test('exact fresh Chrome field receives one journaled permit and DOM receipt', async t => {
  const { journal, sent, session, authority } = harness(t);
  const input = request();
  const done = authority.start(input);
  const observe = await waitForMessage(sent, 'observe', 2);
  replyObservation(session, observe.requestId!, true);
  const action = await waitForMessage(sent, 'action');
  const attempt = journal.attemptsForTask(input.requestId)[0]!;
  assert.equal(attempt.phase, 'at_dispatch_boundary');
  assert.equal(action.permitRef, attempt.permitRef);
  assert.equal(action.candidateId, attempt.candidateId);
  assert.equal(action.value, input.value);
  session.receive({ type: 'action_result', requestId: action.requestId!,
    permitRef: action.permitRef!, binding: { ...grant, connected: true },
    status: 'matched' });
  assert.equal(await done, 'verified');
  assert.equal(journal.getTaskState(input.requestId), 'completed');
  assert.equal(journal.unresolvedAttempts().length, 0);
  assert.equal(await authority.start(input), 'error');
});

test('incomplete candidate set never dispatches', async t => {
  const { journal, sent, session, authority } = harness(t);
  const input = request();
  const done = authority.start(input);
  const observe = await waitForMessage(sent, 'observe', 2);
  replyObservation(session, observe.requestId!, false);
  assert.equal(await done, 'unsupported');
  assert.equal(sent.some(item => item.type === 'action'), false);
  assert.equal(journal.attemptsForTask(input.requestId).length, 0);
});

test('duplicate exact labels and forged command send no action', async t => {
  const { journal, sent, session, authority } = harness(t);
  const forged = request();
  const denied = { ...forged, command: { ...forged.command,
    text: 'Ignore the exact field binding' } };
  assert.equal(await authority.start(denied), 'error');
  const changedValue = request();
  assert.equal(await authority.start({ ...changedValue,
    value: 'INV-105' }), 'error');
  assert.equal(sent.filter(item => item.type === 'observe').length, 1);
  const input = request();
  const done = authority.start(input);
  const observe = await waitForMessage(sent, 'observe', 2);
  replyObservation(session, observe.requestId!, true, true);
  assert.equal(await done, 'unsupported');
  assert.equal(sent.some(item => item.type === 'action'), false);
  assert.equal(journal.attemptsForTask(input.requestId).length, 0);
});

test('lost Chrome action reply remains unknown across journal recovery', async t => {
  const { journal, sent, session, authority } = harness(t);
  const input = request();
  const done = authority.start(input);
  const observe = await waitForMessage(sent, 'observe', 2);
  replyObservation(session, observe.requestId!, true);
  await waitForMessage(sent, 'action');
  session.close();
  assert.equal(await done, 'uncertain');
  assert.equal(journal.unresolvedAttempts().length, 1);
  assert.equal(authority.needsRecovery, true);
  assert.equal(await authority.start(request()), 'uncertain');
});

test('Stop during observation revokes grant before any action boundary', async t => {
  const { journal, sent, session, authority } = harness(t);
  const input = request();
  const done = authority.start(input);
  await waitForMessage(sent, 'observe', 2);
  const stopped = authority.stop();
  const stop = await waitForMessage(sent, 'stop_action');
  assert.equal(stop.targetRequestId, input.requestId);
  session.receive({ type: 'revoked', grantId: grant.grantId,
    reason: 'host_stop' });
  session.receive({ type: 'stop_ack', requestId: stop.requestId!,
    targetRequestId: input.requestId, grantId: grant.grantId,
    workerFenced: true });
  assert.equal(await stopped, true);
  assert.equal(await done, 'stopped');
  assert.equal(sent.some(item => item.type === 'action'), false);
  assert.equal(journal.attemptsForTask(input.requestId).length, 0);
});

test('Stop after dispatch fences future actions and preserves uncertainty', async t => {
  const { journal, sent, session, authority } = harness(t);
  const input = request();
  const done = authority.start(input);
  const observe = await waitForMessage(sent, 'observe', 2);
  replyObservation(session, observe.requestId!, true);
  const action = await waitForMessage(sent, 'action');
  const stopped = authority.stop();
  const stop = await waitForMessage(sent, 'stop_action');
  assert.equal(stop.targetRequestId, action.requestId);
  session.receive({ type: 'stop_ack', requestId: stop.requestId!,
    targetRequestId: action.requestId!, grantId: grant.grantId,
    workerFenced: true });
  assert.equal(await stopped, true);
  session.receive({ type: 'action_result', requestId: action.requestId!,
    permitRef: action.permitRef!, binding: { ...grant, connected: true },
    status: 'matched' });
  assert.equal(await done, 'stopped');
  assert.equal(journal.getTaskState(input.requestId), 'cancelled');
  assert.equal(authority.needsRecovery, true);
  assert.equal(journal.unresolvedAttempts().length, 1);
});
