import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright';

const SOURCE = readFileSync(new URL('../../../apps/native-dev/dom-agent.js', import.meta.url), 'utf8');
const PAGE = `<!doctype html><meta charset="utf-8"><title>Inbox - Mail</title>
<nav aria-label="Folders"><a href="/inbox"><span>Inbox</span></a><a href="/sent">Sent</a></nav>
<input type="search" placeholder="Search mail" id="q">
<button aria-label="Compose" onclick="document.getElementById('draft').hidden=false">✎</button>
<label>Password <input type="password" value="secret"></label>
<div hidden><a href="/hidden">Hidden link</a></div>
<ul><li><a href="/m/1">Acme Billing, Your invoice #4412</a></li></ul>
<p>Amount due: £120.00</p>
<textarea aria-label="Notes">eggs</textarea>
<div contenteditable="true" aria-label="Message body"></div>
<select aria-label="Priority"><option>Low</option><option>High</option></select>
<div role="tab" aria-selected="true">Primary</div>
<button id="toggle" onclick="this.textContent = this.textContent === 'Play' ? 'Pause' : 'Play'">Play</button>
<div id="draft" hidden><button>Send</button></div>
<div style="height:4000px"></div><a href="/far">Far below</a>`;

const run = (page: import('playwright').Page, request: object) =>
  page.evaluate(`(${SOURCE})(${JSON.stringify(request)})`).then(text => JSON.parse(String(text)));

test('the in-page agent reads visible DOM controls and texts in Accessibility terms', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.setContent(PAGE);
  const snap = (await run(page, { op: 'snapshot' })).value;
  const by = (label: string) => snap.elements.find((e: { label: string }) => e.label === label);
  assert.equal(snap.title, 'Inbox - Mail');
  assert.equal(by('Inbox')?.role, 'AXLink');
  assert.equal(snap.elements.filter((e: { label: string }) => e.label === 'Inbox').length, 1); // no duplicate span
  assert.equal(by('Search mail')?.role, 'AXSearchField');
  assert.equal(by('Search mail')?.editable, true);
  assert.equal(by('Compose')?.role, 'AXButton');
  assert.equal(by('Acme Billing, Your invoice #4412')?.role, 'AXLink');
  assert.equal(by('Amount due: £120.00')?.role, 'AXStaticText');
  assert.equal(by('Notes')?.role, 'AXTextArea');
  assert.equal(by('Message body')?.role, 'AXTextArea');
  assert.equal(by('Priority')?.role, 'AXPopUpButton');
  assert.equal(by('Primary')?.selected, true);
  assert.equal(by('Folders') ?? null, null);
  assert.ok(!snap.elements.some((e: { label: string }) => ['Hidden link', 'Send', 'Far below'].includes(e.label)));
  const password = snap.elements.find((e: { secure?: boolean }) => e.secure);
  assert.ok(password && !password.editable && password.value === undefined);
});

test('the in-page agent clicks, types (replacing fields, appending text areas), copies and selects', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.setContent(PAGE);
  let snap = (await run(page, { op: 'snapshot' })).value;
  const id = (label: string) => snap.elements.find((e: { label: string }) => e.label === label).id;
  assert.equal((await run(page, { op: 'press', id: id('Play') })).ok, true);
  assert.equal(await page.textContent('#toggle'), 'Pause');
  await run(page, { op: 'type', id: id('Search mail'), text: 'invoice' });
  assert.equal(await page.inputValue('#q'), 'invoice');
  await run(page, { op: 'type', id: id('Search mail'), text: 'acme' });
  assert.equal(await page.inputValue('#q'), 'acme');
  await run(page, { op: 'type', id: id('Notes'), text: 'buy milk' });
  assert.equal(await page.inputValue('textarea'), 'eggs\nbuy milk');
  await run(page, { op: 'paste', id: id('Message body'), text: 'on my way' });
  assert.equal((await page.textContent('[contenteditable]'))?.trim(), 'on my way');
  assert.equal((await run(page, { op: 'copy', id: id('Amount due: £120.00') })).value, 'Amount due: £120.00');
  await run(page, { op: 'type', id: id('Priority'), text: 'High' });
  assert.equal(await page.$eval('select', el => (el as HTMLSelectElement).value), 'High');
  await run(page, { op: 'press', id: id('Compose') });
  snap = (await run(page, { op: 'snapshot' })).value;
  assert.ok(snap.elements.some((e: { label: string }) => e.label === 'Send'));
  assert.equal((await run(page, { op: 'press', id: 'd999' })).ok, false);
  await run(page, { op: 'scroll', down: true });
  assert.ok((await run(page, { op: 'snapshot' })).value.scrollY > 0);
});
