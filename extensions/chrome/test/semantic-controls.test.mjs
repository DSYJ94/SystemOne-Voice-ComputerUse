import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { collectSemantic, fillSemantic, verifySemantic } from '../semantic-controls.mjs';

test('synthetic DOM retains one exact text field, rejects stale and ambiguous controls', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<label for="query">Find invoice</label>
    <input id="query" type="text"><label for="secret">Password</label>
    <input id="secret" type="password">`);
  const first = await page.evaluate(collectSemantic, 'observation-1');
  assert.equal(first.complete, true);
  assert.equal(first.elements.length, 1);
  assert.equal(first.elements[0].label, 'Find invoice');
  const input = { observationId: first.observationId,
    candidateId: first.elements[0].id, role: first.elements[0].role,
    label: first.elements[0].label, url: first.url, value: 'INV-104' };
  assert.equal(await page.evaluate(fillSemantic, input), 'matched');
  assert.equal(await page.evaluate(verifySemantic, input), true);
  assert.equal(await page.locator('#query').inputValue(), 'INV-104');
  assert.equal(await page.evaluate(fillSemantic, input), 'already_matched');
  await page.evaluate(() => {
    const duplicate = document.createElement('input');
    duplicate.setAttribute('aria-label', 'Find invoice');
    document.body.append(duplicate);
  });
  assert.equal(await page.evaluate(fillSemantic, { ...input, value: 'INV-105' }),
    'not_dispatched');
  assert.equal(await page.locator('#query').inputValue(), 'INV-104');
  const next = await page.evaluate(collectSemantic, 'observation-2');
  assert.equal(await page.evaluate(fillSemantic, input), 'not_dispatched');
  assert.equal(next.elements.length, 2);
});
