const ID = /^[A-Za-z0-9_.:-]{1,160}$/;

function checkedOrigin(url) {
  if (typeof url !== 'string' || url.length > 4_096) throw new Error('invalid Chrome tab URL');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('invalid Chrome tab URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('unsupported Chrome tab origin');
  }
  return parsed.origin;
}

/** Ephemeral per-service-worker grants. No page-supplied message is authority. */
export class ChromeTabGrants {
  #grants = new Map();
  #seen = new Set();
  #extensionId;
  #profileInstallId;
  #workerSessionId;
  #portSessionId;

  constructor(extensionId, profileInstallId, workerSessionId, portSessionId) {
    for (const id of [extensionId, profileInstallId, workerSessionId, portSessionId]) {
      if (typeof id !== 'string' || !ID.test(id)) throw new Error('invalid Chrome session identity');
    }
    this.#extensionId = extensionId;
    this.#profileInstallId = profileInstallId;
    this.#workerSessionId = workerSessionId;
    this.#portSessionId = portSessionId;
  }

  attach(input) {
    if (!input || !ID.test(input.grantId) || !ID.test(input.documentId)
      || !Number.isSafeInteger(input.tabId) || input.tabId < 0
      || !Number.isSafeInteger(input.windowId) || input.windowId < 0
      || input.frameId !== 0 || input.incognito !== false) {
      throw new Error('invalid Chrome tab grant');
    }
    const origin = checkedOrigin(input.url);
    if (this.#seen.size >= 1_000) throw new Error('Chrome grant budget exceeded');
    if (this.#seen.has(input.grantId)) throw new Error('Chrome grant replay');
    this.#seen.add(input.grantId);
    this.revokeTab(input.tabId);
    const grant = Object.freeze({
      grantId: input.grantId,
      extensionId: this.#extensionId,
      profileInstallId: this.#profileInstallId,
      workerSessionId: this.#workerSessionId,
      portSessionId: this.#portSessionId,
      tabId: input.tabId, windowId: input.windowId, frameId: 0,
      documentId: input.documentId, origin, url: input.url, connected: false,
    });
    this.#grants.set(grant.grantId, grant);
    return grant;
  }

  acknowledge(grantId, binding) {
    const grant = this.#required(grantId);
    this.#match(grant, binding);
    if (grant.connected) throw new Error('Chrome grant acknowledgement replay');
    const connected = Object.freeze({ ...grant, connected: true });
    this.#grants.set(grantId, connected);
    return connected;
  }

  requireConnected(grantId, binding) {
    const grant = this.#required(grantId);
    this.#match(grant, binding);
    if (!grant.connected) throw new Error('Chrome host handshake incomplete');
    return grant;
  }

  revokeTab(tabId) {
    const revoked = [];
    for (const grant of this.#grants.values()) {
      if (grant.tabId === tabId) {
        revoked.push(grant);
        this.#grants.delete(grant.grantId);
      }
    }
    return revoked;
  }

  revokeGrant(grantId) {
    const grant = this.#grants.get(grantId);
    if (grant) this.#grants.delete(grantId);
    return grant;
  }

  revokeAll() {
    const revoked = [...this.#grants.values()];
    this.#grants.clear();
    return revoked;
  }

  #required(grantId) {
    const grant = this.#grants.get(grantId);
    if (!grant) throw new Error('Chrome tab grant missing or revoked');
    return grant;
  }

  #match(grant, binding) {
    if (!binding || grant.extensionId !== binding.extensionId
      || grant.profileInstallId !== binding.profileInstallId
      || grant.workerSessionId !== binding.workerSessionId
      || grant.portSessionId !== binding.portSessionId
      || grant.tabId !== binding.tabId || grant.windowId !== binding.windowId
      || grant.frameId !== binding.frameId || grant.documentId !== binding.documentId
      || grant.origin !== binding.origin || grant.url !== binding.url) {
      throw new Error('Chrome tab or document identity changed');
    }
  }
}

export { checkedOrigin };
