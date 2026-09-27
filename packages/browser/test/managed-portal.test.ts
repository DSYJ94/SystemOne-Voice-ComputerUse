import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { startPortalFixture } from '../../fixtures/portal.ts';
import { ManagedPortalSession } from '../src/managed-portal.ts';

test('managed Chromium searches, opens an exact duplicate and downloads it', async () => {
  const portal = await startPortalFixture();
  let session: ManagedPortalSession | undefined;
  let savedPath = '';
  try {
    session = await ManagedPortalSession.launch(portal.url);
    const found = await session.search('April Service Statement');
    assert.equal(found.kind, 'results');
    if (found.kind !== 'results') return;
    assert.deepEqual(found.rows.map(row => row.id), ['INV-104', 'INV-105']);

    const opened = await session.openInvoice('INV-105', found.revision);
    assert.equal(opened.kind, 'detail');
    if (opened.kind !== 'detail') return;
    assert.equal(opened.invoiceId, 'INV-105');
    assert.equal(opened.account, 'Harbor Works');

    const receipt = await session.downloadInvoice('INV-105', opened.revision);
    savedPath = receipt.path;
    assert.equal(receipt.filename, 'INV-105.txt');
    assert.ok(receipt.bytes > 30);
    const bytes = await readFile(receipt.path, 'utf8');
    assert.match(bytes, /^SYNTHETIC FIXTURE\nInvoice: INV-105\n/);
    assert.match(bytes, /Harbor Works/);
    assert.doesNotMatch(bytes, /Northstar Studio/);
  } finally {
    await session?.close();
    await portal.close();
  }
  assert.equal(existsSync(savedPath), false);
});

test('stale result identity and unknown invoice cannot be opened', async () => {
  const portal = await startPortalFixture();
  let session: ManagedPortalSession | undefined;
  try {
    session = await ManagedPortalSession.launch(portal.url);
    const first = await session.search('April');
    const second = await session.search('May');
    assert.equal(first.kind, 'results');
    assert.equal(second.kind, 'results');
    await assert.rejects(session.openInvoice('INV-104', first.revision), /current results/);
    await assert.rejects(session.openInvoice('INV-999', second.revision), /current results/);
    const opened = await session.openInvoice('INV-106', second.revision);
    assert.equal(opened.kind, 'detail');
    if (opened.kind === 'detail') {
      await assert.rejects(session.downloadInvoice('INV-104', opened.revision), /current exact invoice/);
    }
  } finally {
    await session?.close();
    await portal.close();
  }
});

test('managed browser refuses non-fixture origins before launch', async () => {
  for (const url of ['https://example.com/', 'http://localhost:1234/',
    'http://127.0.0.1:1234/path', 'http://127.0.0.1:1234/?q=x']) {
    await assert.rejects(ManagedPortalSession.launch(url), /exact loopback fixture origin/);
  }
});
