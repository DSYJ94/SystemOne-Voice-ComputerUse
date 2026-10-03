import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createCLMHTTPTransport } from '../src/clm-http-transport.ts';

const body = Buffer.from('{"synthetic":true}');
const signal = () => new AbortController().signal;
const manifest = 'a'.repeat(64);

async function server(t: TestContext, handler: RequestListener) {
  const service = createServer(handler);
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
  t.after(async () => { service.closeAllConnections(); await new Promise<void>(resolve => service.close(() => resolve())); });
  const address = service.address(); assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}/v1/systemone`;
}

test('owned transport makes no startup I/O and rejects remote plaintext or missing authentication', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json({ fixture: true }); };
  for (const endpoint of ['http://remote.invalid/v1/systemone', 'https://remote.invalid/v1/systemone',
    'http://127.0.0.1/health', 'https://user:password@remote.invalid/v1/systemone', 'http://127.0.0.1/v1/systemone?key=value']) {
    assert.throws(() => createCLMHTTPTransport({ endpoint, fetcher }));
  }
  const transport = createCLMHTTPTransport({ endpoint: 'https://owned.invalid/v1/systemone', apiKey: 'fixture-only', fetcher });
  assert.equal(calls, 0);
  await assert.rejects(transport.send(body, AbortSignal.abort()));
  await assert.rejects(transport.send(Buffer.alloc(65_537), signal()));
  assert.equal(calls, 0);
});

test('loopback fixture accepts only the exact POST and checks the expected artifact header', async t => {
  let calls = 0;
  const endpoint = await server(t, async (request, response) => {
    calls++;
    assert.equal(request.url, '/v1/systemone'); assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, 'Bearer fixture-only');
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), body);
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-systemone-artifact-manifest-sha256': manifest });
    response.end('{"fixture":true}');
  });
  const result = await createCLMHTTPTransport({ endpoint, apiKey: 'fixture-only', artifactManifestDigest: manifest }).send(body, signal());
  assert.deepEqual(result, { fixture: true }); assert.equal(calls, 1);
  await assert.rejects(createCLMHTTPTransport({ endpoint, apiKey: 'fixture-only', artifactManifestDigest: 'b'.repeat(64) }).send(body, signal()), /manifest mismatch/);
});

test('redirects cannot forward a CLM request to another endpoint', async t => {
  let redirected = 0;
  const endpoint = await server(t, (request, response) => {
    if (request.url === '/destination') { redirected++; response.end('{}'); }
    else { response.writeHead(307, { location: '/destination' }); response.end(); }
  });
  await assert.rejects(createCLMHTTPTransport({ endpoint }).send(body, signal()));
  assert.equal(redirected, 0);
});

test('response validation rejects status, content type, duplicate keys and both size bounds', async () => {
  const replies = [
    new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'text/html' } }),
    new Response('{"choice":"one","choice":"two"}', { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '262145' } }),
    new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(262_145)); controller.close(); } }),
      { headers: { 'content-type': 'application/json' } }),
  ];
  for (const response of replies) {
    await assert.rejects(createCLMHTTPTransport({ endpoint: 'http://127.0.0.1/v1/systemone',
      fetcher: async () => response }).send(body, signal()));
  }
});

test('timeout and supplied cancellation terminate a pending response', async t => {
  const endpoint = await server(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }); response.write('{');
  });
  await assert.rejects(createCLMHTTPTransport({ endpoint, timeoutMs: 25 }).send(body, signal()));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25);
  try { await assert.rejects(createCLMHTTPTransport({ endpoint, timeoutMs: 5_000 }).send(body, controller.signal)); }
  finally { clearTimeout(timer); }
});
