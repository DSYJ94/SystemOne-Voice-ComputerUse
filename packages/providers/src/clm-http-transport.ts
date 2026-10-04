import { Agent, request } from 'node:https';
import { Readable } from 'node:stream';
import { ContractError, parseJSON } from '../../protocol/src/json.ts';
import type { CLMTransport } from './clm-decision-client.ts';

const MAX_REPLY = 262_144;

/** Kept-alive HTTPS connections, up to 16 in parallel. Node's built-in fetch sent every
 * request down one connection in turn (measured: the 12th of 12 parallel calls waited
 * 2.6 s), so an agent step's parallel questions queued behind each other. */
const POOL = new Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30_000 });

function pooledFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) { reject(signal.reason); return; }
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = init.body instanceof Uint8Array ? init.body : Buffer.from(String(init.body ?? ''));
    const outgoing = request(String(input), { method: init.method ?? 'GET', agent: POOL,
      headers: { ...headers, 'content-length': String(body.byteLength) } }, incoming => {
      const status = incoming.statusCode ?? 0;
      if (status >= 300 && status < 400 && init.redirect === 'error') {
        incoming.resume(); reject(new ContractError('CLM redirect refused')); return;
      }
      const replyHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) replyHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers: replyHeaders }));
    });
    const abort = () => outgoing.destroy(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    outgoing.on('error', reject);
    outgoing.on('close', () => signal?.removeEventListener('abort', abort));
    outgoing.end(body);
  });
}

/** Owned reference endpoint only. Construction performs zero I/O. Caller must
 * still use requestDecision's registration/disclosure policy before send. */
export function createCLMHTTPTransport(options: {
  readonly endpoint: string; readonly apiKey?: string; readonly timeoutMs?: number;
  readonly artifactManifestDigest?: string; readonly fetcher?: typeof fetch;
}): CLMTransport {
  const url = new URL(options.endpoint);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (url.pathname !== '/v1/systemone' || url.search || url.hash || url.username || url.password
    || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
    || (!loopback && (!options.apiKey || /[\r\n]/.test(options.apiKey)))
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || (options.artifactManifestDigest !== undefined && !/^[a-f0-9]{64}$/.test(options.artifactManifestDigest))) {
    throw new ContractError('invalid owned CLM endpoint, authentication or bounds');
  }
  const endpoint = url.href;
  const key = options.apiKey;
  const artifact = options.artifactManifestDigest;
  const fetcher = options.fetcher ?? (url.protocol === 'https:' ? pooledFetch : fetch);
  return Object.freeze({ async send(body: Uint8Array, suppliedSignal: AbortSignal): Promise<unknown> {
    if (suppliedSignal.aborted) throw new ContractError('CLM transport cancelled before I/O');
    if (body.byteLength > 65_536) throw new ContractError('CLM request too large');
    const signal = AbortSignal.any([suppliedSignal, AbortSignal.timeout(timeoutMs)]);
    const response = await fetcher(endpoint, { method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: Buffer.from(body) });
    if (!response.ok) {
      await response.body?.cancel();
      // Status only (never the body) so callers can back off on 429/529.
      throw Object.assign(new ContractError(`CLM HTTP ${response.status}`), { status: response.status });
    }
    if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
      await response.body?.cancel(); throw new ContractError('CLM response type mismatch');
    }
    if (artifact && response.headers.get('x-systemone-artifact-manifest-sha256') !== artifact) {
      await response.body?.cancel(); throw new ContractError('CLM artifact manifest mismatch');
    }
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_REPLY) { await response.body?.cancel(); throw new ContractError('CLM response too large'); }
    if (!response.body) throw new ContractError('CLM response body missing');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_REPLY) { await reader.cancel(); throw new ContractError('CLM response too large'); }
        chunks.push(value);
      }
      if (signal.aborted) throw new ContractError('CLM transport cancelled while reading');
      return parseJSON(Buffer.concat(chunks));
    } finally { reader.releaseLock(); }
  } });
}
