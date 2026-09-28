import { ChromeTabGrants, checkedOrigin } from './grants.mjs';
import { collectSemantic, fillSemantic, verifySemantic } from './semantic-controls.mjs';

const HOST = 'com.aurium.systemone.chrome';
const workerSessionId = crypto.randomUUID();
let profilePromise;
let nativePort;
let grants;
const pending = new Map();
const activeActions = new Map();
const seenPermits = new Set();
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;

function cancelActionsForGrant(grantId) {
  for (const action of activeActions.values()) {
    if (action.grantId === grantId) action.stopped = true;
  }
}

async function profileInstallId() {
  if (!profilePromise) profilePromise = (async () => {
    const stored = await chrome.storage.local.get('profileInstallId');
    if (typeof stored.profileInstallId === 'string'
      && /^[A-Za-z0-9_.:-]{1,160}$/.test(stored.profileInstallId)) {
      return stored.profileInstallId;
    }
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ profileInstallId: id });
    return id;
  })();
  return profilePromise;
}

function badge(tabId, text, color = '#535a65') {
  void chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  void chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

function revokeTab(tabId, reason) {
  if (!grants) return;
  for (const grant of grants.revokeTab(tabId)) {
    cancelActionsForGrant(grant.grantId);
    pending.delete(grant.grantId);
    try { nativePort?.postMessage({ type: 'revoked', grantId: grant.grantId, reason }); }
    catch { /* A broken port already fences this session. */ }
  }
  badge(tabId, 'OFF');
}

function revokeGrant(grantId, reason) {
  const grant = grants?.revokeGrant(grantId);
  if (!grant) return;
  cancelActionsForGrant(grantId);
  pending.delete(grantId);
  badge(grant.tabId, 'OFF');
  try { nativePort?.postMessage({ type: 'revoked', grantId, reason }); }
  catch { /* A broken port already fences this session. */ }
}

function disconnect(port) {
  if (nativePort !== port) return;
  const revoked = grants?.revokeAll() ?? [];
  for (const grant of revoked) badge(grant.tabId, 'OFF');
  for (const action of activeActions.values()) action.stopped = true;
  pending.clear();
  seenPermits.clear();
  nativePort = undefined;
  grants = undefined;
}

async function exactFrame(grant) {
  const [tab, frame] = await Promise.all([
    chrome.tabs.get(grant.tabId),
    chrome.webNavigation.getFrame({ tabId: grant.tabId, frameId: 0 }),
  ]);
  if (!frame || tab.incognito || tab.windowId !== grant.windowId
    || frame.documentId !== grant.documentId
    || frame.url !== grant.url || tab.url !== grant.url
    || checkedOrigin(frame.url) !== grant.origin
    || checkedOrigin(tab.url) !== grant.origin) {
    throw new Error('Chrome tab grant is stale');
  }
  return frame;
}

async function observe(message, port) {
  const grant = grants.requireConnected(message.grantId, message.binding);
  await exactFrame(grant);
  const observationId = crypto.randomUUID();
  const results = await chrome.scripting.executeScript({
    target: { tabId: grant.tabId, documentIds: [grant.documentId] },
    func: collectSemantic, args: [observationId],
  });
  if (results.length !== 1 || results[0].frameId !== 0
    || results[0].documentId !== grant.documentId) {
    throw new Error('Chrome observation document changed');
  }
  await exactFrame(grant);
  if (nativePort !== port) throw new Error('Chrome native host disconnected');
  port.postMessage({ type: 'observation', requestId: message.requestId,
    binding: grant, snapshot: results[0].result });
}

async function fillField(message, port) {
  if (Object.keys(message).sort().join(',') !==
      'binding,candidateId,grantId,label,observationId,operation,permitRef,requestId,role,taskId,type,url,value'
    || message.operation !== 'fill' || !ID.test(message.requestId)
    || !ID.test(message.taskId) || !ID.test(message.permitRef)
    || !ID.test(message.observationId) || !ID.test(message.candidateId)
    || typeof message.label !== 'string' || !message.label
    || message.label.length > 160 || typeof message.role !== 'string'
    || !message.role || message.role.length > 40
    || typeof message.value !== 'string'
    || new TextEncoder().encode(message.value).length > 1_024
    || typeof message.url !== 'string' || message.url.length > 4_096
    || activeActions.has(message.requestId) || seenPermits.has(message.permitRef)
    || seenPermits.size >= 1_000) {
    port.postMessage({ type: 'unsupported_operation', requestId: message.requestId ?? null });
    return;
  }
  let grant;
  try {
    grant = grants.requireConnected(message.grantId, message.binding);
    if (grant.url !== message.url || [...activeActions.values()]
      .some(action => action.grantId === grant.grantId)) {
      throw new Error('Chrome action target changed or busy');
    }
  } catch {
    port.postMessage({ type: 'unsupported_operation', requestId: message.requestId });
    return;
  }
  seenPermits.add(message.permitRef);
  const active = { grantId: grant.grantId, stopped: false,
    injectionStarted: false, done: Promise.resolve('not_dispatched') };
  activeActions.set(message.requestId, active);
  active.done = (async () => {
    try {
      await exactFrame(grant);
      if (active.stopped || nativePort !== port) return 'not_dispatched';
      const input = { observationId: message.observationId,
        candidateId: message.candidateId, label: message.label,
        role: message.role, url: message.url, value: message.value };
      // The host journaled its dispatch boundary before this message. There
      // is no await between the final Stop check and the injection call.
      active.injectionStarted = true;
      const result = await chrome.scripting.executeScript({
        target: { tabId: grant.tabId, documentIds: [grant.documentId] },
        func: fillSemantic, args: [input],
      });
      if (result.length !== 1 || result[0].frameId !== 0
        || result[0].documentId !== grant.documentId
        || !['matched', 'already_matched', 'not_dispatched', 'unknown']
          .includes(result[0].result)) return 'unknown';
      const status = result[0].result;
      if (status === 'not_dispatched' || status === 'unknown') return status;
      await exactFrame(grant);
      const verified = await chrome.scripting.executeScript({
        target: { tabId: grant.tabId, documentIds: [grant.documentId] },
        func: verifySemantic, args: [input],
      });
      if (verified.length !== 1 || verified[0].frameId !== 0
        || verified[0].documentId !== grant.documentId
        || verified[0].result !== true) return 'unknown';
      await exactFrame(grant);
      return status;
    } catch { return active.injectionStarted ? 'unknown' : 'not_dispatched'; }
  })();
  try {
    const status = await active.done;
    if (nativePort === port) port.postMessage({ type: 'action_result',
      requestId: message.requestId, permitRef: message.permitRef,
      binding: grant, status });
  } finally { activeActions.delete(message.requestId); }
}

async function stopAction(message, port) {
  if (Object.keys(message).sort().join(',') !== 'grantId,requestId,targetRequestId,type'
    || !ID.test(message.requestId) || !ID.test(message.targetRequestId)
    || !ID.test(message.grantId)) return;
  const active = activeActions.get(message.targetRequestId);
  if (active && active.grantId !== message.grantId) return;
  if (active) active.stopped = true;
  revokeGrant(message.grantId, 'host_stop');
  let workerFenced = true;
  if (active) {
    workerFenced = await Promise.race([
      active.done.then(() => true, () => false),
      new Promise(resolve => setTimeout(() => resolve(false), 2_500)),
    ]);
  }
  if (nativePort === port) port.postMessage({ type: 'stop_ack',
    requestId: message.requestId, targetRequestId: message.targetRequestId,
    grantId: message.grantId, workerFenced });
}

function ensurePort(profileId) {
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative(HOST);
  nativePort = port;
  grants = new ChromeTabGrants(chrome.runtime.id, profileId,
    workerSessionId, crypto.randomUUID());
  port.onDisconnect.addListener(() => disconnect(port));
  port.onMessage.addListener(message => {
    if (nativePort !== port || !message || typeof message !== 'object') return;
    if (message.type === 'hello_ack') {
      const expected = pending.get(message.grantId);
      if (!expected || message.challenge !== expected.challenge) return;
      try {
        const grant = grants.acknowledge(message.grantId, message.binding);
        pending.delete(message.grantId);
        badge(grant.tabId, 'ON', '#167c46');
      } catch { revokeGrant(message.grantId, 'handshake_mismatch'); }
      return;
    }
    if (message.type === 'observe' && typeof message.requestId === 'string') {
      void observe(message, port).catch(() => {
        revokeGrant(message.grantId, 'stale_or_unavailable');
        try { port.postMessage({ type: 'unavailable', requestId: message.requestId }); }
        catch { disconnect(port); }
      });
      return;
    }
    if (message.type === 'action') {
      void fillField(message, port).catch(() => {
        try { port.postMessage({ type: 'action_result',
          requestId: message.requestId ?? null, permitRef: message.permitRef ?? null,
          binding: message.binding ?? null, status: 'unknown' }); }
        catch { disconnect(port); }
      });
      return;
    }
    if (message.type === 'stop_action') {
      void stopAction(message, port).catch(() => disconnect(port));
    }
  });
  return port;
}

chrome.action.onClicked.addListener(tab => {
  void (async () => {
    if (!Number.isSafeInteger(tab.id) || !Number.isSafeInteger(tab.windowId)
      || tab.incognito || !tab.url) {
      if (Number.isSafeInteger(tab.id)) badge(tab.id, 'NO');
      return;
    }
    try {
      const origin = checkedOrigin(tab.url);
      const profileId = await profileInstallId();
      const port = ensurePort(profileId);
      const frame = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 });
      const current = await chrome.tabs.get(tab.id);
      if (!frame?.documentId || current.incognito || current.windowId !== tab.windowId
        || frame.url !== current.url || checkedOrigin(frame.url) !== origin
        || checkedOrigin(current.url) !== origin) {
        throw new Error('Chrome tab changed during grant');
      }
      const grant = grants.attach({ grantId: crypto.randomUUID(), tabId: tab.id,
        windowId: tab.windowId, frameId: 0, documentId: frame.documentId,
        url: current.url, incognito: false });
      const challenge = crypto.randomUUID();
      pending.set(grant.grantId, { challenge, tabId: grant.tabId });
      port.postMessage({ type: 'hello', challenge, binding: grant });
      badge(tab.id, '...', '#7c5c19');
    } catch { revokeTab(tab.id, 'attach_failed'); }
  })();
});

chrome.webNavigation.onCommitted.addListener(details => revokeTab(details.tabId, 'navigation'));
chrome.webNavigation.onHistoryStateUpdated.addListener(details => revokeTab(details.tabId, 'history_change'));
chrome.webNavigation.onReferenceFragmentUpdated.addListener(details => revokeTab(details.tabId, 'fragment_change'));
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (changes.url || changes.status === 'loading') revokeTab(tabId, 'tab_changed');
});
chrome.tabs.onRemoved.addListener(tabId => revokeTab(tabId, 'tab_closed'));
chrome.tabs.onDetached.addListener(tabId => revokeTab(tabId, 'window_changed'));
