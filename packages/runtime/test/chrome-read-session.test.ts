import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChromeReadSession } from '../src/chrome-read-session.ts';
import type { JSONValue } from '../../protocol/src/json.ts';

const extensionId = 'a'.repeat(32);
const grant = {
  grantId: 'grant-1', extensionId, profileInstallId: 'profile-1',
  workerSessionId: 'worker-1', portSessionId: 'port-1',
  tabId: 8, windowId: 2, frameId: 0, documentId: 'document-1',
  origin: 'https://example.test', url: 'https://example.test/account',
  connected: false,
};

function fixture() {
  let now = 1_000;
  const sent: Record<string, JSONValue>[] = [];
  const reported: unknown[] = [];
  const session = new ChromeReadSession(extensionId,
    message => { sent.push(message); },
    (binding, view) => { reported.push({ binding, view }); }, () => now);
  return { session, sent, reported, tick: (elapsed: number) => { now += elapsed; } };
}

function hello(state: ReturnType<typeof fixture>, binding = grant) {
  state.session.receive({ type: 'hello', challenge: 'challenge-1', binding });
  assert.equal(state.sent[0]?.type, 'hello_ack');
  assert.equal(state.sent[1]?.type, 'observe');
  return state.sent[1]!;
}

function observation(requestId: JSONValue, binding = { ...grant, connected: true }) {
  return { type: 'observation', requestId, binding,
    snapshot: { title: 'Synthetic account', url: grant.url,
      elements: [{ role: 'button', label: 'Open', disabled: false }] } };
}

test('bound existing-Chrome hello produces one read-only observation', () => {
  const state = fixture();
  const request = hello(state);
  assert.equal(state.sent[0]?.challenge, 'challenge-1');
  assert.deepEqual(state.sent[0]?.binding, grant);
  state.session.receive(observation(request.requestId!));
  assert.equal(state.reported.length, 1);
  assert.equal(state.session.activeGrantCount, 1);
  assert.throws(() => state.session.receive({ type: 'action', grantId: grant.grantId }),
    /unsupported/);
  assert.equal(state.session.activeGrantCount, 0);
  assert.throws(() => state.session.receive(observation(request.requestId!)), /closed/);
});

test('wrong extension, profile, document and values fail without reporting', () => {
  const wrongExtension = fixture();
  assert.throws(() => wrongExtension.session.receive({ type: 'hello', challenge: 'c',
    binding: { ...grant, extensionId: 'b'.repeat(32) } }), /binding/);
  assert.equal(wrongExtension.session.activeGrantCount, 0);

  const wrongDocument = fixture();
  const request = hello(wrongDocument);
  assert.throws(() => wrongDocument.session.receive(observation(request.requestId!,
    { ...grant, documentId: 'document-2', connected: true })), /binding changed/);
  assert.equal(wrongDocument.session.activeGrantCount, 0);
  assert.equal(wrongDocument.reported.length, 0);

  const wrongProfile = fixture();
  hello(wrongProfile);
  assert.throws(() => wrongProfile.session.receive({ type: 'hello', challenge: 'c',
    binding: { ...grant, grantId: 'grant-2', profileInstallId: 'profile-2' } }),
  /identity changed/);
  assert.equal(wrongProfile.session.activeGrantCount, 0);

  const state = fixture();
  hello(state);
  const next = { ...grant, grantId: 'grant-3', documentId: 'document-3' };
  state.session.receive({ type: 'hello', challenge: 'next', binding: next });
  const nextRequest = state.sent.at(-1)!;
  assert.throws(() => state.session.receive({ ...observation(nextRequest.requestId!,
    { ...next, connected: true }),
    snapshot: { title: 'Synthetic', url: next.url,
      elements: [{ role: 'input', label: 'Password', disabled: false, value: 'secret' }] } }),
  /control/);
  assert.equal(state.reported.length, 0);
  assert.equal(state.session.activeGrantCount, 0);
});

test('revocation, unavailable, expiry and close discard read authority', () => {
  const state = fixture();
  const request = hello(state);
  state.session.receive({ type: 'revoked', grantId: grant.grantId, reason: 'navigation' });
  assert.equal(state.session.activeGrantCount, 0);

  const second = { ...grant, grantId: 'grant-2', documentId: 'document-2' };
  state.session.receive({ type: 'hello', challenge: 'next', binding: second });
  const request2 = state.sent.at(-1)!;
  state.session.receive({ type: 'unavailable', requestId: request2.requestId! });
  assert.equal(state.session.activeGrantCount, 0);

  const third = { ...grant, grantId: 'grant-3', documentId: 'document-3' };
  state.session.receive({ type: 'hello', challenge: 'last', binding: third });
  const request3 = state.sent.at(-1)!;
  state.tick(5_001);
  assert.throws(() => state.session.receive(observation(request3.requestId!,
    { ...third, connected: true })), /expired/);
  assert.equal(state.session.activeGrantCount, 0);
  assert.throws(() => state.session.receive({ type: 'hello', challenge: 'closed',
    binding: { ...third, grantId: 'grant-4' } }), /closed/);

  const replay = fixture();
  hello(replay);
  assert.throws(() => replay.session.receive({ type: 'hello', challenge: 'again',
    binding: grant }), /replay/);
  assert.equal(replay.session.activeGrantCount, 0);
});
