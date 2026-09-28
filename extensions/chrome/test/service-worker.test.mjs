import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { for (const listener of listeners) listener(...args); },
  };
}

async function until(predicate) {
  for (let count = 0; count < 50; count++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('extension mock event was not observed');
}

test('Chrome manifest is scoped to user-invoked tabs without broad page access', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.ok(manifest.permissions.includes('nativeMessaging'));
  assert.ok(!manifest.permissions.includes('debugger'));
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.content_scripts, undefined);
});

test('user click, host handshake, exact document read and navigation revocation', async () => {
  const sent = [];
  const badges = [];
  const port = { postMessage(message) { sent.push(message); },
    onMessage: event(), onDisconnect: event() };
  const clicked = event();
  const committed = event();
  const changed = event();
  const removed = event();
  const detached = event();
  const history = event();
  const fragment = event();
  let injected = 0;
  let profile = {};
  let documentId = 'document-1';
  const tab = { id: 7, windowId: 4, url: 'https://example.test/account', incognito: false };
  globalThis.crypto ??= webcrypto;
  globalThis.chrome = {
    action: { onClicked: clicked,
      setBadgeText: async value => { badges.push(value); },
      setBadgeBackgroundColor: async () => {} },
    storage: { local: {
      get: async () => profile,
      set: async value => { profile = { ...profile, ...value }; },
    } },
    runtime: { id: 'extension-1', connectNative(name) {
      assert.equal(name, 'com.aurium.systemone.chrome');
      return port;
    } },
    tabs: { get: async () => tab, onUpdated: changed, onRemoved: removed,
      onDetached: detached },
    webNavigation: {
      getFrame: async () => ({ frameId: 0, documentId, url: tab.url }),
      onCommitted: committed, onHistoryStateUpdated: history,
      onReferenceFragmentUpdated: fragment,
    },
    scripting: { async executeScript(options) {
      injected++;
      assert.deepEqual(options.target, { tabId: 7, documentIds: ['document-1'] });
      return [{ frameId: 0, documentId,
        result: { title: 'Synthetic page', url: tab.url, elements: [] } }];
    } },
  };
  try {
    await import(`../service-worker.mjs?test=${Date.now()}`);
    clicked.emit(tab);
    await until(() => sent.some(message => message.type === 'hello'));
    const hello = sent.find(message => message.type === 'hello');
    assert.equal(hello.binding.tabId, 7);
    assert.equal(hello.binding.frameId, 0);
    assert.equal(hello.binding.documentId, 'document-1');
    assert.equal(hello.binding.origin, 'https://example.test');
    assert.equal(hello.binding.extensionId, 'extension-1');
    assert.equal(hello.binding.url, tab.url);
    assert.equal(injected, 0);
    port.onMessage.emit({ type: 'hello_ack', challenge: hello.challenge,
      grantId: hello.binding.grantId, binding: hello.binding });
    await until(() => badges.some(value => value.text === 'ON'));
    port.onMessage.emit({ type: 'action', requestId: 'action-1' });
    assert.ok(sent.some(message => message.type === 'unsupported_operation'));
    port.onMessage.emit({ type: 'observe', requestId: 'read-1',
      grantId: hello.binding.grantId, binding: hello.binding });
    await until(() => sent.some(message => message.type === 'observation'));
    assert.equal(injected, 1);
    documentId = 'document-2';
    committed.emit({ tabId: 7, frameId: 0, documentId });
    assert.ok(sent.some(message => message.type === 'revoked'
      && message.grantId === hello.binding.grantId));
    port.onMessage.emit({ type: 'observe', requestId: 'read-2',
      grantId: hello.binding.grantId, binding: hello.binding });
    await until(() => sent.some(message => message.type === 'unavailable'
      && message.requestId === 'read-2'));
    assert.equal(injected, 1);
  } finally {
    delete globalThis.chrome;
  }
});
