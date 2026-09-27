import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { startPortalFixture } from '../portal.ts';

test('portal distinguishes search results from an opened exact invoice', async t => {
  const portal = await startPortalFixture();
  t.after(() => portal.close());

  const home = await fetch(portal.url);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /data-page="home"/);
  assert.match(home.headers.get('content-security-policy') ?? '', /default-src 'none'/);

  const results = await fetch(`${portal.url}/invoices?q=April%20Service%20Statement`);
  const html = await results.text();
  assert.equal(results.status, 200);
  assert.match(html, /data-page="search-results"/);
  assert.match(html, /2 results/);
  assert.match(html, /data-invoice-id="INV-104"/);
  assert.match(html, /data-invoice-id="INV-105"/);
  assert.doesNotMatch(html, /data-invoice-id="INV-106"/);
  assert.doesNotMatch(html, /data-page="invoice-detail"/);

  const detail = await fetch(`${portal.url}/invoices/INV-105`);
  const opened = await detail.text();
  assert.match(opened, /data-page="invoice-detail" data-invoice-id="INV-105"/);
  assert.match(opened, /Harbor Works/);
  assert.doesNotMatch(opened, /Northstar Studio/);
  assert.match(opened, /id="delayed-download" hidden/);
  const script = await fetch(`${portal.url}/portal.js`);
  assert.match(await script.text(), /setTimeout\(\(\) => \{ link.hidden = false; \}, 250\)/);
});

test('download is a fixed synthetic document with a bounded filename', async t => {
  const portal = await startPortalFixture();
  t.after(() => portal.close());
  const response = await fetch(`${portal.url}/downloads/INV-104`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="INV-104.txt"');
  const body = await response.text();
  assert.match(body, /^SYNTHETIC FIXTURE\nInvoice: INV-104\n/);
  assert.match(body, /Northstar Studio/);
  assert.doesNotMatch(body, /Harbor Works/);
  assert.equal((await fetch(`${portal.url}/downloads/INV-999`)).status, 404);
});

test('portal rejects foreign hosts, writes, long queries and unknown routes', async t => {
  const portal = await startPortalFixture();
  t.after(() => portal.close());
  assert.equal((await fetch(`${portal.url}/invoices?q=${'x'.repeat(101)}`)).status, 400);
  const injected = await fetch(`${portal.url}/invoices?q=${encodeURIComponent('<script>')}`);
  const escaped = await injected.text();
  assert.match(escaped, /value="&lt;script&gt;"/);
  assert.doesNotMatch(escaped, /<script>/);
  assert.equal((await fetch(`${portal.url}/uploads`, { method: 'POST', body: 'test' })).status, 405);
  assert.equal((await fetch(`${portal.url}/invoices/INV-999`)).status, 404);
  const url = new URL(portal.url);
  const foreignHost = await new Promise<number>((resolve, reject) => {
    const call = request({ hostname: '127.0.0.1', port: Number(url.port), path: '/',
      headers: { Host: 'evil.example' } }, response => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    call.on('error', reject);
    call.end();
  });
  assert.equal(foreignHost, 421);
});

test('HEAD has the same declared length without returning a body', async t => {
  const portal = await startPortalFixture();
  t.after(() => portal.close());
  const get = await fetch(`${portal.url}/invoices`);
  const head = await fetch(`${portal.url}/invoices`, { method: 'HEAD' });
  assert.equal(head.status, get.status);
  assert.equal(head.headers.get('content-length'), get.headers.get('content-length'));
  assert.equal(await head.text(), '');
});
