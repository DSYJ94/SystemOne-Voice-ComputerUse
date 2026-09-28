import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startPortalFixture } from '../../../packages/fixtures/portal.ts';

/** A temporary MV3 test extension uses the production semantic functions, but
 * never loads the native host or the owner's browser profile. This verifies
 * Chrome's isolated-world persistence across separate scripting API calls. */
test('MV3 scripting retains and revalidates an observed field in isolated world', async t => {
  const root = mkdtempSync(join(tmpdir(), 'systemone-isolated-chrome-'));
  const extension = join(root, 'extension');
  mkdirSync(extension);
  copyFileSync(fileURLToPath(new URL('../semantic-controls.mjs', import.meta.url)),
    join(extension, 'semantic-controls.mjs'));
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'SystemOne isolated-world contract fixture',
    version: '0.0.1', minimum_chrome_version: '106',
    permissions: ['scripting', 'tabs', 'webNavigation'],
    host_permissions: ['http://127.0.0.1/*'],
    background: { service_worker: 'worker.mjs', type: 'module' },
  }));
  writeFileSync(join(extension, 'worker.mjs'), `
    import { collectSemantic, fillSemantic, verifySemantic }
      from './semantic-controls.mjs';
    globalThis.runSystemOneFixture = async (tabId, operation, input) => {
      const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
      const func = operation === 'collect' ? collectSemantic
        : operation === 'fill' ? fillSemantic : verifySemantic;
      const result = await chrome.scripting.executeScript({
        target: { tabId, documentIds: [frame.documentId] },
        func, args: [input],
      });
      return { documentId: frame.documentId, result };
    };
  `);
  const fixture = await startPortalFixture();
  let context;
  t.after(async () => {
    await context?.close();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  });
  context = await chromium.launchPersistentContext(join(root, 'profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0]
    ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`${fixture.url}/`);
  const tabId = await worker.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(item => item.url === url);
    return tab?.id;
  }, page.url());
  assert.ok(Number.isSafeInteger(tabId));
  const run = (operation, input) => worker.evaluate(
    ({ tabId, operation, input }) =>
      globalThis.runSystemOneFixture(tabId, operation, input),
    { tabId, operation, input });

  const observed = await run('collect', 'observation-1');
  assert.equal(observed.result.length, 1);
  assert.equal(observed.result[0].documentId, observed.documentId);
  const view = observed.result[0].result;
  assert.equal(view.complete, true);
  const field = view.elements.find(item => item.label === 'Find invoice');
  assert.ok(field?.editable);
  const input = { observationId: view.observationId, candidateId: field.id,
    label: field.label, role: field.role, url: view.url, value: 'INV-104' };
  assert.equal((await run('fill', input)).result[0].result, 'matched');
  assert.equal((await run('verify', input)).result[0].result, true);
  assert.equal(await page.locator('#query').inputValue(), 'INV-104');
  await page.evaluate(() => {
    const duplicate = document.createElement('input');
    duplicate.setAttribute('aria-label', 'Find invoice');
    document.body.append(duplicate);
  });
  assert.equal((await run('fill', { ...input, value: 'INV-105' })).result[0].result,
    'not_dispatched');
  assert.equal(await page.locator('#query').inputValue(), 'INV-104');
  await page.reload();
  assert.equal((await run('fill', input)).result[0].result, 'not_dispatched');
});
