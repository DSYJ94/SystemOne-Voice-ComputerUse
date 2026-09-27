import { ChromeTabGrants, checkedOrigin } from './grants.mjs';

const HOST = 'com.aurium.systemone.chrome';
const workerSessionId = crypto.randomUUID();
let profilePromise;
let nativePort;
let grants;
const pending = new Map();

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
    pending.delete(grant.grantId);
    try { nativePort?.postMessage({ type: 'revoked', grantId: grant.grantId, reason }); }
    catch { /* A broken port already fences this session. */ }
  }
  badge(tabId, 'OFF');
}

function revokeGrant(grantId, reason) {
  const grant = grants?.revokeGrant(grantId);
  if (!grant) return;
  pending.delete(grantId);
  badge(grant.tabId, 'OFF');
  try { nativePort?.postMessage({ type: 'revoked', grantId, reason }); }
  catch { /* A broken port already fences this session. */ }
}

function disconnect(port) {
  if (nativePort !== port) return;
  const revoked = grants?.revokeAll() ?? [];
  for (const grant of revoked) badge(grant.tabId, 'OFF');
  pending.clear();
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

function collectSemantic() {
  const elements = [];
  const nodes = document.querySelectorAll('button,a,input,select,textarea,[role]');
  for (let index = 0; index < Math.min(nodes.length, 2_000) && elements.length < 80; index++) {
    const node = nodes[index];
    if (node.isContentEditable || node.closest('[contenteditable="true"]')) continue;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden'
      || node.getClientRects().length === 0) continue;
    const tag = node.tagName.toLowerCase();
    const inputType = tag === 'input' ? String(node.type ?? '').toLowerCase() : '';
    if (inputType === 'password' || inputType === 'hidden') continue;
    const label = (node.getAttribute('aria-label') || node.getAttribute('title')
      || node.getAttribute('placeholder')
      || (['input', 'textarea', 'select'].includes(tag) ? '' : node.innerText) || '')
      .replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!label) continue;
    elements.push({ role: (node.getAttribute('role') || tag).slice(0, 40),
      label, disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true') });
  }
  return { title: document.title.slice(0, 160), url: location.href.slice(0, 2_048), elements };
}

async function observe(message, port) {
  const grant = grants.requireConnected(message.grantId, message.binding);
  await exactFrame(grant);
  const results = await chrome.scripting.executeScript({
    target: { tabId: grant.tabId, documentIds: [grant.documentId] },
    func: collectSemantic,
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
      port.postMessage({ type: 'unsupported_operation', requestId: message.requestId ?? null });
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
