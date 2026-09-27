import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChromeTabGrants, checkedOrigin } from '../grants.mjs';

const input = { grantId: 'grant-1', tabId: 8, windowId: 2, frameId: 0,
  documentId: 'document-1', url: 'https://example.test/account', incognito: false };
const newGrants = () => new ChromeTabGrants('extension-1', 'profile-1', 'worker-1', 'port-1');

test('explicit tab grant binds profile, port, window, frame and document', () => {
  const grants = newGrants();
  const attached = grants.attach(input);
  assert.equal(attached.origin, 'https://example.test');
  assert.ok(Object.isFrozen(attached));
  assert.throws(() => grants.requireConnected(attached.grantId, attached), /incomplete/);
  const connected = grants.acknowledge(attached.grantId, attached);
  assert.equal(grants.requireConnected(connected.grantId, connected), connected);
  for (const changed of [
    { ...connected, extensionId: 'extension-2' },
    { ...connected, profileInstallId: 'profile-2' },
    { ...connected, workerSessionId: 'worker-2' },
    { ...connected, portSessionId: 'port-2' },
    { ...connected, tabId: 9 },
    { ...connected, windowId: 3 },
    { ...connected, frameId: 1 },
    { ...connected, documentId: 'document-2' },
    { ...connected, origin: 'https://other.test' },
    { ...connected, url: 'https://example.test/other-route' },
  ]) assert.throws(() => grants.requireConnected(connected.grantId, changed), /identity changed/);
  assert.throws(() => grants.acknowledge(connected.grantId, connected), /replay/);
});

test('navigation, tab closure or native disconnect removes authority', () => {
  const grants = newGrants();
  const first = grants.acknowledge('grant-1', grants.attach(input));
  assert.deepEqual(grants.revokeTab(8), [first]);
  assert.throws(() => grants.requireConnected(first.grantId, first), /revoked/);
  assert.throws(() => grants.attach(input), /replay/);
  const second = grants.attach({ ...input, grantId: 'grant-2', documentId: 'document-2' });
  assert.deepEqual(grants.revokeAll(), [second]);
  assert.throws(() => grants.acknowledge(second.grantId, second), /revoked/);
});

test('restricted, incognito, subframe and malformed grants fail closed', () => {
  const grants = newGrants();
  for (const url of ['chrome://settings', 'file:///tmp/x', 'javascript:alert(1)',
    'https://user:pass@example.test/', 'not a url']) {
    assert.throws(() => grants.attach({ ...input, url }), /origin|URL/);
  }
  assert.throws(() => grants.attach({ ...input, incognito: true }), /invalid/);
  assert.throws(() => grants.attach({ ...input, frameId: 1 }), /invalid/);
  assert.throws(() => grants.attach({ ...input, documentId: '' }), /invalid/);
  assert.equal(checkedOrigin('https://example.test/path?q=1'), 'https://example.test');
});
