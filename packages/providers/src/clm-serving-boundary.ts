import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { ContractError, digest, parseJSON } from '../../protocol/src/json.ts';
import type { JSONValue } from '../../protocol/src/json.ts';
import { validateProviderView } from '../../protocol/src/contract.ts';
import { decodeCLMChoice } from './clm-wire.ts';
import type { CLMProviderView } from './clm-wire.ts';
import { preflightCLMArtifacts, validateCLMArtifactManifest } from './clm-artifact-preflight.ts';

export interface CLMServingRequest {
  readonly state: string;
  readonly model: 'clm-latest';
  readonly questions: { readonly next_action: {
    readonly type: 'choice'; readonly instructions: string;
    readonly criteria: Readonly<Record<string, string>>;
  } };
  readonly temperature: number;
}

/** Trusted local adapter, not a remotely supplied attestation. It must count
 * with the exact pinned tokenizer, including encoder special tokens, without
 * truncation, and use the same immutable artifacts for ranking. */
export interface CLMServingBackend {
  readonly artifactManifestDigest: string;
  readonly tokenizerRevision: string;
  countTokens(texts: readonly string[], signal: AbortSignal): Promise<readonly number[]>;
  answer(request: CLMServingRequest, signal: AbortSignal): Promise<unknown>;
}
export interface CLMServingOptions {
  readonly artifactManifest: unknown;
  readonly backend: CLMServingBackend;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
}

class Rejected extends Error {
  readonly status: number;
  constructor(status: number) { super('CLM request rejected'); this.status = status; }
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Rejected(400);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) throw new Rejected(400);
  return record;
}

function decode(bytes: Uint8Array): { request: CLMServingRequest; view: CLMProviderView; texts: readonly string[] } {
  const raw = exact(parseJSON(bytes), ['state', 'model', 'questions', 'temperature']);
  const questions = exact(raw.questions, ['next_action']);
  const question = exact(questions.next_action, ['type', 'instructions', 'criteria']);
  if (!question.criteria || typeof question.criteria !== 'object' || Array.isArray(question.criteria)
    || raw.model !== 'clm-latest' || question.type !== 'choice'
    || typeof raw.temperature !== 'number' || !Number.isFinite(raw.temperature)
    || raw.temperature <= 0 || raw.temperature > 100) throw new Rejected(400);
  const criteria = question.criteria as Record<string, string>;
  const view = { projectionRevision: 'serving.v1', stateText: raw.state, questionText: question.instructions,
    candidates: Object.entries(criteria).map(([candidateId, description]) => ({ candidateId, description })) };
  validateProviderView(view as JSONValue);
  if (view.candidates.length < 2) throw new Rejected(400);
  const request = Object.freeze({ state: raw.state as string, model: 'clm-latest' as const,
    questions: Object.freeze({ next_action: Object.freeze({ type: 'choice' as const,
      instructions: question.instructions as string, criteria: Object.freeze({ ...criteria }) }) }),
    temperature: raw.temperature });
  // Python str.strip() at pinned reference schema.py:62. Candidate strings are
  // NOT stripped or prefixed by that reference. JS trim differs for U+0085/BOM.
  const strip = (text: string) => text.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, '');
  const state = strip(request.state), instruction = strip(request.questions.next_action.instructions);
  const texts = Object.freeze([state && instruction ? `${state}\n\n${instruction}` : state || instruction,
    ...Object.values(request.questions.next_action.criteria)]);
  return { request, view: view as CLMProviderView, texts };
}

function reject(response: ServerResponse, status: number): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
  response.end(JSON.stringify({ error: status === 401 ? 'unauthorized' : 'request_rejected' }));
}

async function readBody(request: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0;
  // Node's default async iterator destroys a stream when exiting early. Keep
  // it intact long enough to deliver 413, then the response closes the socket.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    signal.throwIfAborted(); bytes += chunk.length;
    if (bytes > 65_536) throw new Rejected(413);
    chunks.push(chunk);
  }
  signal.throwIfAborted(); return Buffer.concat(chunks);
}

/** Pure ingress component: validates declarations, not local bytes or live
 * inference. Production startup must use listenVerifiedCLMServingGateway. No
 * UI, health metadata, generic model routes, downloads or request logging. */
export function createCLMServingBoundary(options: CLMServingOptions): RequestListener {
  const manifest = validateCLMArtifactManifest(options.artifactManifest);
  const manifestDigest = digest(manifest as unknown as JSONValue);
  const timeoutMs = options.timeoutMs ?? 30_000, maxConcurrent = options.maxConcurrent ?? 1;
  if (typeof options.apiKey !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(options.apiKey)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
    || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8
    || options.backend.artifactManifestDigest !== manifestDigest
    || options.backend.tokenizerRevision !== manifest.encoder.revision) throw new ContractError('invalid owned serving configuration');
  const expectedKey = createHash('sha256').update(`Bearer ${options.apiKey}`).digest();
  const countTokens = options.backend.countTokens.bind(options.backend), answer = options.backend.answer.bind(options.backend);
  let active = 0;
  return (request, response) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) { reject(response, 403); return; }
    const auth = request.headers.authorization;
    const authCount = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index]?.toLowerCase() === 'authorization').length;
    if (authCount !== 1 || typeof auth !== 'string' || auth.length > 519
      || !timingSafeEqual(createHash('sha256').update(auth).digest(), expectedKey)) { reject(response, 401); return; }
    if (request.method !== 'POST' || request.url !== '/v1/systemone') { reject(response, 404); return; }
    const typeCount = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index]?.toLowerCase() === 'content-type').length;
    if (typeCount !== 1 || request.headers['content-type'] !== 'application/json'
      || request.headers['content-encoding'] !== undefined) { reject(response, 415); return; }
    const length = request.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > 65_536)) { reject(response, 413); return; }
    if (active >= maxConcurrent) { reject(response, 503); return; }
    active++;
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    const disconnected = () => { if (!response.writableEnded) cancel(); };
    request.once('aborted', cancel); response.once('close', disconnected);
    const timer = setTimeout(() => { timedOut = true; cancel(); if (!request.complete) request.destroy(); }, timeoutMs);
    const work = (async () => {
      let decoded: ReturnType<typeof decode>;
      try { decoded = decode(await readBody(request, controller.signal)); }
      catch (error) { if (error instanceof Rejected) throw error; if (controller.signal.aborted) throw error; throw new Rejected(400); }
      controller.signal.throwIfAborted();
      const reportedCounts = await countTokens(decoded.texts, controller.signal);
      controller.signal.throwIfAborted();
      if (!Array.isArray(reportedCounts) || reportedCounts.length !== decoded.texts.length
        || reportedCounts.some(count => !Number.isSafeInteger(count) || count < 1)) throw new Rejected(502);
      const counts = Object.freeze([...reportedCounts]);
      if (counts.some(count => count > manifest.recipe.maxTokensPerText)) throw new Rejected(422);
      const raw = await answer(decoded.request, controller.signal);
      controller.signal.throwIfAborted();
      let choice: ReturnType<typeof decodeCLMChoice>;
      try { choice = decodeCLMChoice(raw, decoded.view); } catch { throw new Rejected(502); }
      // Cache hits may spend zero tokens. Never accept usage exceeding the
      // exact full uncached batch that was checked before inference.
      if (choice.inputTokens > counts.reduce((sum, count) => sum + count, 0)) throw new Rejected(502);
      return { model: choice.model, answers: { next_action: { type: 'choice', choice: choice.choice,
        probabilities: choice.probabilities } }, usage: { input_tokens: choice.inputTokens } };
    })();
    // A deadline/disconnect revokes delivery immediately. Capacity is released
    // only when the actual tokenizer/ranker promise settles, including failures.
    void work.then(() => { active--; }, () => { active--; });
    const aborted = new Promise<never>((_, fail) => {
      if (controller.signal.aborted) fail(new Rejected(504));
      else controller.signal.addEventListener('abort', () => fail(new Rejected(504)), { once: true });
    });
    void Promise.race([work, aborted]).then(value => {
      if (controller.signal.aborted || response.destroyed) return;
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store',
        'x-systemone-artifact-manifest-sha256': manifestDigest });
      response.end(JSON.stringify(value));
    }, error => {
      reject(response, timedOut ? 504 : error instanceof Rejected ? error.status : 502);
    }).finally(() => {
      clearTimeout(timer); request.removeListener('aborted', cancel); response.removeListener('close', disconnected);
    });
  };
}

/** Read-only startup preflight, then loopback-only HTTP behind an owned TLS
 * proxy. No model download/loading, deployment or paid provisioning is done. */
export async function listenVerifiedCLMServingGateway(options: CLMServingOptions & {
  readonly artifactRoot: string; readonly port: number;
}) {
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) throw new ContractError('invalid serving port');
  const manifest = validateCLMArtifactManifest(options.artifactManifest);
  const artifactRoot = options.artifactRoot, port = options.port;
  const boundary = createCLMServingBoundary({ ...options, artifactManifest: manifest });
  await preflightCLMArtifacts(manifest, artifactRoot);
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 30_000, headersTimeout: 10_000,
    keepAliveTimeout: 1000 }, boundary);
  server.maxHeadersCount = 32;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return server;
}
