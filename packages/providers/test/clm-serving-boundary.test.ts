import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { digest } from '../../protocol/src/json.ts';
import { CLM_HEAD_SHA256, validateCLMArtifactManifest } from '../src/clm-artifact-preflight.ts';
import { createCLMServingBoundary, listenVerifiedCLMServingGateway } from '../src/clm-serving-boundary.ts';
import type { CLMServingBackend } from '../src/clm-serving-boundary.ts';
import { createCLMHTTPTransport } from '../src/clm-http-transport.ts';
import { decodeCLMChoice, encodeCLMProviderView } from '../src/clm-wire.ts';

const key = 'synthetic-test-key-never-use-in-production';
const pending = JSON.parse(readFileSync(new URL('../fixtures/clm-artifact-manifest.pending.json', import.meta.url), 'utf8'));
function manifest() {
  const value = structuredClone(pending);
  value.encoder.revision = '1'.repeat(40);
  const file = (path: string, role: string) => ({ path, role, sha256: 'a'.repeat(64), bytes: 1 });
  value.encoder.files = [file('encoder/weights.safetensors', 'weights'), file('encoder/tokenizer.json', 'tokenizer'),
    file('encoder/config.json', 'config'), file('encoder/LICENSE', 'license')];
  value.heads.files = [{ ...file('heads/CLM_v0.1-8B.pt', 'weights'), sha256: CLM_HEAD_SHA256 }, file('heads/LICENSE', 'license')];
  value.runtime = { image: `registry.invalid/test@sha256:${'2'.repeat(64)}`, serverRevision: '3'.repeat(40) };
  value.licenseReviewRef = 'synthetic-declaration-only';
  return validateCLMArtifactManifest(value);
}
const view = { projectionRevision: 'test.v1', stateText: 'Synthetic window', questionText: 'Choose the next legal step',
  candidates: [{ candidateId: 'first', description: 'Open the synthetic folder' }, { candidateId: 'second', description: 'Read the synthetic window' }] };
const payload = () => JSON.parse(Buffer.from(encodeCLMProviderView(view)).toString());
const reply = () => ({ model: 'clm-latest', answers: { next_action: { type: 'choice', choice: 'first',
  probabilities: { first: 0.8, second: 0.2 }, privateDebug: 'must not cross ingress' } }, usage: { input_tokens: 3 }, privateDebug: 'private backend text' });

function backend(value = manifest()) {
  const calls = { count: 0, answer: 0 };
  const adapter: CLMServingBackend = {
    artifactManifestDigest: digest(value as any), tokenizerRevision: value.encoder.revision,
    async countTokens(texts) { calls.count++; return texts.map(() => 1); },
    async answer() { calls.answer++; return reply(); },
  };
  return { adapter, calls, value };
}
async function service(t: TestContext, adapter: CLMServingBackend, timeoutMs = 1000, maxConcurrent = 1) {
  const value = manifest();
  const server = createServer(createCLMServingBoundary({ artifactManifest: value, backend: adapter, apiKey: key, timeoutMs, maxConcurrent }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}/v1/systemone`;
  const send = (body: unknown = payload(), headers: Record<string, string> = {}, path = '/v1/systemone', method = 'POST') =>
    fetch(new URL(path, endpoint), { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
      ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  return { endpoint, send };
}

test('boundary rejects pending declarations, weak credentials and mismatched artifact/tokenizer identity before I/O', () => {
  const { adapter, calls, value } = backend();
  for (const options of [
    { artifactManifest: pending, backend: adapter, apiKey: key },
    { artifactManifest: value, backend: adapter, apiKey: 'short' },
    { artifactManifest: value, backend: { ...adapter, tokenizerRevision: '4'.repeat(40) }, apiKey: key },
    { artifactManifest: value, backend: { ...adapter, artifactManifestDigest: '0'.repeat(64) }, apiKey: key },
    { artifactManifest: value, backend: adapter, apiKey: key, timeoutMs: 30_001 },
    { artifactManifest: value, backend: adapter, apiKey: key, maxConcurrent: 9 },
  ]) assert.throws(() => createCLMServingBoundary(options));
  assert.deepEqual(calls, { count: 0, answer: 0 });
});

test('production listener refuses missing or unresolved local artifacts without inference', async () => {
  const { adapter, calls, value } = backend();
  await assert.rejects(listenVerifiedCLMServingGateway({ artifactManifest: pending, backend: adapter, apiKey: key, artifactRoot: '/absent', port: 0 }));
  await assert.rejects(listenVerifiedCLMServingGateway({ artifactManifest: value, backend: adapter, apiKey: key, artifactRoot: '/absent', port: 0 }), /ENOENT/);
  assert.deepEqual(calls, { count: 0, answer: 0 });
});

test('owned transport interoperates with pinned boundary and omits backend debug/error metadata', async t => {
  const { adapter, value } = backend(); const { endpoint } = await service(t, adapter);
  const transport = createCLMHTTPTransport({ endpoint, apiKey: key, artifactManifestDigest: digest(value as any) });
  const raw = await transport.send(encodeCLMProviderView(view), new AbortController().signal);
  assert.equal(decodeCLMChoice(raw, view).choice, 'first');
  assert.equal(JSON.stringify(raw).includes('private'), false);
});

test('authentication is mandatory and only exact SystemOne POST is exposed without CORS', async t => {
  const { adapter, calls } = backend(); const { send } = await service(t, adapter);
  for (const authorization of ['', 'Bearer incorrect', `bearer ${key}`]) assert.equal((await send(payload(), { authorization })).status, 401);
  for (const path of ['/health', '/models', '/v1/systemone?debug=true', '/v1/systemone/']) assert.equal((await send(payload(), {}, path)).status, 404);
  const response = await send(undefined, { origin: 'https://untrusted.invalid' }, '/v1/systemone', 'GET');
  assert.equal(response.status, 404); assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(calls, { count: 0, answer: 0 });
});

test('duplicate Authorization headers cannot exploit Node first-header parsing', async t => {
  const { adapter, calls } = backend(); const { endpoint } = await service(t, adapter);
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(endpoint, { method: 'POST', headers: [
      'Host', new URL(endpoint).host,
      'Authorization', `Bearer ${key}`, 'Authorization', 'Bearer other', 'Content-Type', 'application/json',
    ] }, response => { response.resume(); resolve(response.statusCode!); });
    request.once('error', reject); request.end(JSON.stringify(payload()));
  });
  assert.equal(status, 401); assert.deepEqual(calls, { count: 0, answer: 0 });
});

test('request bounds reject oversized, compressed, malformed and authority-bearing envelopes before tokenizer work', async t => {
  const { adapter, calls } = backend(); const { send } = await service(t, adapter);
  assert.equal((await send('x'.repeat(65_537))).status, 413);
  assert.equal((await send(payload(), { 'content-encoding': 'gzip' })).status, 415);
  assert.equal((await send(payload(), { 'content-type': 'text/plain' })).status, 415);
  for (const body of ['{"state":"one","state":"two"}', '{',
    { ...payload(), taskId: 'foreign-authority' }, { ...payload(), state: { rawHandles: true } },
    { ...payload(), model: 'encoder-raw' }, { ...payload(), temperature: 0 },
    { ...payload(), questions: { other: payload().questions.next_action } },
    { ...payload(), questions: { next_action: { ...payload().questions.next_action, criteria: { first: 'Only one candidate' } } } },
  ]) assert.equal((await send(body)).status, 400);
  assert.deepEqual(calls, { count: 0, answer: 0 });
});

test('tokenization matches pinned combined state/question text and unmodified candidate descriptions', async t => {
  const { adapter } = backend(); let texts: readonly string[] = [];
  adapter.countTokens = async input => { texts = input; assert.ok(Object.isFrozen(input)); return input.map(() => 1); };
  adapter.answer = async request => { assert.ok(Object.isFrozen(request.questions.next_action.criteria)); return reply(); };
  const { send } = await service(t, adapter);
  const body = payload(); body.state = '\u0085 Synthetic state \u0085'; body.questions.next_action.instructions = '\nQuestion?\n';
  body.questions.next_action.criteria.first = '  Description with whitespace  ';
  assert.equal((await send(body)).status, 200);
  assert.deepEqual(texts, ['Synthetic state\n\nQuestion?', '  Description with whitespace  ', 'Read the synthetic window']);
  body.state = '\ufeffState'; assert.equal((await send(body)).status, 200);
  assert.equal(texts[0], '\ufeffState\n\nQuestion?');
});

test('per-text token overflow rejects before ranking and exact 2048-token boundary is accepted', async t => {
  const { adapter, calls } = backend(); let counts = [2048, 2048, 2048];
  adapter.countTokens = async () => counts;
  const { send } = await service(t, adapter);
  assert.equal((await send()).status, 200); assert.equal(calls.answer, 1);
  for (const index of [0, 1, 2]) {
    counts = [1, 1, 1]; counts[index] = 2049;
    assert.equal((await send()).status, 422); assert.equal(calls.answer, 1);
  }
});

test('invalid tokenizer accounting never reaches ranking', async t => {
  const { adapter, calls } = backend(); let counts: readonly number[] = [];
  adapter.countTokens = async () => counts;
  const { send } = await service(t, adapter);
  for (const bad of [[], [1, 1], [1, NaN, 1], [1, 0, 1], [1, 1.5, 1], [1, -1, 1]]) {
    counts = bad; assert.equal((await send()).status, 502);
  }
  assert.equal(calls.answer, 0);
});

test('malformed ranking, inconsistent choice and excessive usage are redacted', async t => {
  const { adapter } = backend(); let raw: unknown = reply(); adapter.answer = async () => raw;
  const { send } = await service(t, adapter);
  for (const bad of [{ privateError: 'secret backend details' },
    { ...reply(), model: 'wrong' }, { ...reply(), usage: { input_tokens: 4 } },
    { ...reply(), answers: { next_action: { type: 'choice', choice: 'second', probabilities: { first: 0.8, second: 0.2 } } } },
  ]) { raw = bad; const response = await send(); assert.equal(response.status, 502); assert.deepEqual(await response.json(), { error: 'request_rejected' }); }
  adapter.answer = async () => { throw new Error('private exception body'); };
  // The existing handler binds its backend methods once, not on each request.
  const throwing = await service(t, adapter); const response = await throwing.send();
  assert.equal(response.status, 502); assert.equal((await response.text()).includes('private'), false);
});

test('timeout revokes delivery but holds capacity until noncancellable backend actually settles', async t => {
  const { adapter, calls } = backend(); let resolve!: (value: unknown) => void; let entered!: () => void;
  const started = new Promise<void>(done => { entered = done; }); let signal!: AbortSignal;
  adapter.answer = async (_request, supplied) => { calls.answer++; signal = supplied; entered(); return new Promise(done => { resolve = done; }); };
  const { send } = await service(t, adapter, 100);
  const first = send(); await started;
  assert.equal((await send()).status, 503);
  assert.equal((await first).status, 504); assert.equal(signal.aborted, true);
  assert.equal((await send()).status, 503); assert.equal(calls.answer, 1);
  resolve(reply()); await new Promise<void>(done => setImmediate(done));
  // A later request is accepted only after actual settlement, then times out
  // because this deliberately uncooperative adapter again waits forever.
  assert.equal((await send()).status, 504); assert.equal(calls.answer, 2); resolve(reply());
});

test('timeout during tokenization cannot start ranking after a late tokenizer result', async t => {
  const { adapter, calls } = backend(); let resolve!: (counts: readonly number[]) => void;
  adapter.countTokens = async () => new Promise(done => { resolve = done; });
  const { send } = await service(t, adapter, 50);
  assert.equal((await send()).status, 504); assert.equal((await send()).status, 503);
  resolve([1, 1, 1]); await new Promise<void>(done => setImmediate(done));
  assert.equal(calls.answer, 0);
});

test('client cancellation aborts ranking without releasing outstanding backend ownership', async t => {
  const { adapter } = backend(); let resolve!: (value: unknown) => void; let entered!: () => void; let signal!: AbortSignal;
  const started = new Promise<void>(done => { entered = done; });
  adapter.answer = async (_request, supplied) => { signal = supplied; entered(); return new Promise(done => { resolve = done; }); };
  const { endpoint, send } = await service(t, adapter);
  const controller = new AbortController();
  const first = fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(payload()), signal: controller.signal });
  await started; controller.abort(); await assert.rejects(first);
  await new Promise<void>(done => setTimeout(done, 20));
  assert.equal(signal.aborted, true); assert.equal((await send()).status, 503); resolve(reply());
});

test('chunked body overflow is bounded even without Content-Length', async t => {
  const { adapter, calls } = backend(); const { endpoint } = await service(t, adapter);
  const status = await new Promise<number | 'closed'>((resolve) => {
    const request = httpRequest(endpoint, { method: 'POST', headers: {
      authorization: `Bearer ${key}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked',
    } }, response => { response.resume(); resolve(response.statusCode!); });
    request.once('error', () => resolve('closed')); request.write(Buffer.alloc(32_768, 32)); request.end(Buffer.alloc(32_769, 32));
  });
  assert.ok(status === 413 || status === 'closed'); assert.deepEqual(calls, { count: 0, answer: 0 });
});

test('stalled body deadline closes its socket and releases capacity after read settlement', async t => {
  const { adapter, calls } = backend(); const { endpoint, send } = await service(t, adapter, 100);
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(endpoint, { method: 'POST', headers: {
      authorization: `Bearer ${key}`, 'content-type': 'application/json', 'content-length': '100',
    } });
    request.once('response', response => { response.resume(); resolve(); });
    request.once('error', () => resolve()); request.write('{');
    const timer = setTimeout(() => { request.destroy(); reject(new Error('body timeout did not close socket')); }, 1000);
    request.once('close', () => { clearTimeout(timer); resolve(); });
  });
  assert.deepEqual(calls, { count: 0, answer: 0 });
  assert.equal((await send()).status, 200);
});
