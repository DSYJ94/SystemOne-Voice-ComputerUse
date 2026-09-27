import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { test } from 'node:test';
import { startPortalFixture } from '../../fixtures/portal.ts';
import { ManagedObservationSession } from '../src/managed-observation.ts';

async function localServer(html: string): Promise<{ url: string; server: Server;
  methods: string[] }> {
  const methods: string[] = [];
  const server = createServer((request, response) => {
    methods.push(request.method ?? '');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing local server port');
  return { url: `http://127.0.0.1:${address.port}`, server, methods };
}

async function closeServer(server: Server): Promise<void> {
  server.close();
  await once(server, 'close');
}

test('managed Chromium observes general semantic controls without granting actions', async () => {
  const portal = await startPortalFixture();
  let session: ManagedObservationSession | undefined;
  try {
    session = await ManagedObservationSession.launch(portal.url, {
      allowedOrigins: [new URL(portal.url).origin], headless: true,
    });
    const first = await session.observe();
    assert.equal(first.url, `${portal.url}/`);
    assert.equal(first.coverage.mainDocument, true);
    assert.equal(first.coverage.truncated, false);
    assert.equal(first.coverage.complete, true);
    assert.ok(first.controls.some(control =>
      control.role === 'input' && control.label === 'Find invoice'));
    assert.ok(first.controls.some(control =>
      control.role === 'button' && control.label === 'Search'));
    assert.ok(first.controls.some(control =>
      control.role === 'a' && control.label === 'Browse all invoices'));
    assert.equal(new Set(first.controls.map(control => control.id)).size,
      first.controls.length);
    const second = await session.observe();
    assert.notEqual(first.observationId, second.observationId);
    assert.notEqual(first.controls[0]?.id, second.controls[0]?.id);
    await session.close();
    await assert.rejects(session.observe(), /stopped/);
  } finally {
    await session?.close();
    await portal.close();
  }
});

test('managed observation keeps values private and blocks out-of-scope requests', async () => {
  const foreign = await localServer('<p>foreign</p>');
  const main = await localServer(`<html><head><title>Private controls</title></head><body>
    <label for="query">Search records</label><input id="query" value="sensitive-value">
    <input type="password" aria-label="Password" value="secret-password">
    <button disabled>Unavailable</button>
    <ul><li>Record A <button>Continue</button></li>
      <li>Record B <button>Continue</button></li></ul>
    <div id="shadow"></div><iframe src="${foreign.url}/foreign"></iframe>
    <script>
      document.getElementById('shadow').attachShadow({mode:'open'}).innerHTML='<button>Hidden shadow action</button>';
      fetch('/submit', {method:'POST', body:'should-not-send'}).catch(() => {});
      fetch('${foreign.url}/foreign').catch(() => {});
    </script></body></html>`);
  let session: ManagedObservationSession | undefined;
  try {
    session = await ManagedObservationSession.launch(`${main.url}/`, {
      allowedOrigins: [main.url], headless: true,
    });
    const snapshot = await session.observe();
    assert.ok(snapshot.controls.some(control => control.label === 'Search records'));
    assert.ok(snapshot.controls.some(control =>
      control.label === 'Unavailable' && !control.enabled));
    const duplicates = snapshot.controls.filter(control => control.label === 'Continue');
    assert.equal(duplicates.length, 2);
    assert.notEqual(duplicates[0]?.context, duplicates[1]?.context);
    assert.ok(duplicates[0]?.context.includes('Record A'));
    assert.ok(duplicates[1]?.context.includes('Record B'));
    assert.equal(snapshot.controls.some(control => control.label === 'Password'), false);
    assert.equal(snapshot.controls.some(control => control.label === 'Hidden shadow action'), false);
    assert.equal(JSON.stringify(snapshot).includes('sensitive-value'), false);
    assert.equal(JSON.stringify(snapshot).includes('secret-password'), false);
    assert.equal(snapshot.coverage.hasUnobservedSubframes, true);
    assert.equal(snapshot.coverage.hasUnobservedShadowRoots, true);
    assert.equal(snapshot.coverage.complete, false);
    assert.equal(main.methods.includes('POST'), false);
    assert.equal(foreign.methods.length, 0);
  } finally {
    await session?.close();
    await closeServer(main.server);
    await closeServer(foreign.server);
  }
});

test('managed browser rejects unapproved start URLs and unsafe scope', async () => {
  for (const start of ['https://example.test/', 'http://127.0.0.1:1234/']) {
    await assert.rejects(ManagedObservationSession.launch(start, {
      allowedOrigins: ['https://allowed.test'], headless: true,
    }), /outside approved/);
  }
  for (const origin of ['http://example.test', 'https://user:pass@example.test',
    'https://example.test/path', 'http://localhost:4321']) {
    await assert.rejects(ManagedObservationSession.launch('https://example.test/', {
      allowedOrigins: [origin], headless: true,
    }), /managed-browser origin/);
  }
});
