import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { ChromeReadSession } from '../../../packages/runtime/src/chrome-read-session.ts';

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
        result: { observationId: options.args[0], title: 'Synthetic page',
          url: tab.url, complete: true, elements: [] } }];
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

test('extension and controller read contracts exchange one exact tab snapshot', async () => {
  const clicked = event();
  const committed = event();
  const changed = event();
  const removed = event();
  const detached = event();
  const history = event();
  const fragment = event();
  const reports = [];
  const extensionId = 'a'.repeat(32);
  let documentId = 'document-1';
  let injected = 0;
  const tab = { id: 18, windowId: 3, url: 'https://example.test/account',
    incognito: false };
  const port = { onMessage: event(), onDisconnect: event(),
    postMessage(message) { session.receive(message); } };
  const session = new ChromeReadSession(extensionId,
    message => port.onMessage.emit(message),
    (binding, snapshot) => reports.push({ binding, snapshot }));
  globalThis.crypto ??= webcrypto;
  globalThis.chrome = {
    action: { onClicked: clicked, setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {} },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: { id: extensionId, connectNative: () => port },
    tabs: { get: async () => tab, onUpdated: changed,
      onRemoved: removed, onDetached: detached },
    webNavigation: { getFrame: async () => ({ frameId: 0, documentId,
      url: tab.url }), onCommitted: committed,
      onHistoryStateUpdated: history,
      onReferenceFragmentUpdated: fragment },
    scripting: { async executeScript(options) {
      injected++;
      assert.deepEqual(options.target, { tabId: 18, documentIds: ['document-1'] });
      return [{ frameId: 0, documentId,
        result: { observationId: options.args[0], title: 'Synthetic account',
          url: tab.url, complete: true,
          elements: [{ id: `${options.args[0]}:0`, role: 'button',
            label: 'Open', disabled: false, editable: false }] } }];
    } },
  };
  try {
    await import(`../service-worker.mjs?contract=${Date.now()}`);
    clicked.emit(tab);
    await until(() => reports.length === 1);
    assert.equal(injected, 1);
    assert.equal(reports[0].binding.documentId, documentId);
    assert.deepEqual(reports[0].snapshot.elements,
      [{ id: `${reports[0].snapshot.observationId}:0`, role: 'button',
        label: 'Open', disabled: false, editable: false }]);
    documentId = 'document-2';
    committed.emit({ tabId: 18, frameId: 0, documentId });
    assert.equal(session.activeGrantCount, 0);
  } finally {
    session.close();
    delete globalThis.chrome;
  }
});

test('extension accepts one exact fill permit and verifies the same document', async () => {
  const clicked = event();
  const committed = event();
  const changed = event();
  const removed = event();
  const detached = event();
  const history = event();
  const fragment = event();
  const sent = [];
  const calls = [];
  const extensionId = 'a'.repeat(32);
  const tab = { id: 19, windowId: 3, url: 'http://127.0.0.1:49081/',
    incognito: false };
  const port = { onMessage: event(), onDisconnect: event(),
    postMessage(message) { sent.push(message); } };
  globalThis.crypto ??= webcrypto;
  globalThis.chrome = {
    action: { onClicked: clicked, setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {} },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: { id: extensionId, connectNative: () => port },
    tabs: { get: async () => tab, onUpdated: changed,
      onRemoved: removed, onDetached: detached },
    webNavigation: { getFrame: async () => ({ frameId: 0,
      documentId: 'document-1', url: tab.url }), onCommitted: committed,
      onHistoryStateUpdated: history, onReferenceFragmentUpdated: fragment },
    scripting: { async executeScript(options) {
      calls.push(options.func.name);
      assert.deepEqual(options.target, { tabId: 19, documentIds: ['document-1'] });
      if (options.func.name === 'collectSemantic') {
        return [{ frameId: 0, documentId: 'document-1',
          result: { observationId: options.args[0],
            title: 'Invoice Portal Fixture', url: tab.url, complete: true,
            elements: [{ id: `${options.args[0]}:0`, role: 'input',
              label: 'Find invoice', disabled: false, editable: true }] } }];
      }
      return [{ frameId: 0, documentId: 'document-1',
        result: options.func.name === 'fillSemantic' ? 'matched' : true }];
    } },
  };
  try {
    await import(`../service-worker.mjs?fill=${Date.now()}`);
    clicked.emit(tab);
    await until(() => sent.some(message => message.type === 'hello'));
    const hello = sent.find(message => message.type === 'hello');
    port.onMessage.emit({ type: 'hello_ack', grantId: hello.binding.grantId,
      challenge: hello.challenge, binding: hello.binding });
    const binding = { ...hello.binding, connected: true };
    port.onMessage.emit({ type: 'observe', requestId: 'read-1',
      grantId: binding.grantId, binding });
    await until(() => sent.some(message => message.type === 'observation'));
    const observation = sent.find(message => message.type === 'observation');
    const candidate = observation.snapshot.elements[0];
    const action = { type: 'action', operation: 'fill', requestId: 'action-1',
      taskId: 'task-1', permitRef: 'permit-1', grantId: binding.grantId,
      binding, observationId: observation.snapshot.observationId,
      candidateId: candidate.id, role: candidate.role, label: candidate.label,
      url: binding.url, value: 'INV-104' };
    port.onMessage.emit(action);
    await until(() => sent.some(message => message.type === 'action_result'));
    assert.equal(sent.find(message => message.type === 'action_result').status,
      'matched');
    assert.deepEqual(calls, ['collectSemantic', 'fillSemantic', 'verifySemantic']);
    port.onMessage.emit(action);
    await until(() => sent.some(message => message.type === 'unsupported_operation'));
    assert.equal(calls.filter(name => name === 'fillSemantic').length, 1);
  } finally { delete globalThis.chrome; }
});
