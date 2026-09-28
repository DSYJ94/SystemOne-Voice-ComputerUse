import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installChromeNativeHost, removeChromeNativeHost,
  verifyChromeNativeHost } from '../../../scripts/register-chrome-native-host.mjs';
import { stageChromeNativeHost } from '../../../scripts/stage-chrome-native-host.mjs';

const hostName = 'com.aurium.systemone.chrome.json';

async function fixture(root: string) {
  const staged = join(root, 'staged');
  const registration = join(root, 'Chrome', 'NativeMessagingHosts');
  const host = join(staged, 'SystemOneChromeNativeHost');
  const manifest = join(staged, hostName);
  const extensionId = 'a'.repeat(32);
  mkdirSync(staged);
  copyFileSync('/usr/bin/true', host);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-',
    '--identifier', 'com.aurium.systemone.chromenativehost', host]);
  await stageChromeNativeHost({ extensionId, hostPath: host, manifestPath: manifest,
    controllerSigningIdentifier: 'com.aurium.systemone.dev',
    controllerCDHashes: ['a'.repeat(40)] });
  return { registration, host, manifest, extensionId };
}

test('Chrome host registration is exact, idempotent, and removable without touching other files',
  { skip: process.platform !== 'darwin' }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'systemone-chrome-registration-'));
    try {
      const { registration, manifest } = await fixture(root);
      const installed = await installChromeNativeHost(manifest, registration);
      assert.equal(installed.changed, true);
      assert.deepEqual(await readFile(installed.destination), await readFile(manifest));
      assert.equal(await verifyChromeNativeHost(manifest, registration), installed.destination);
      assert.equal((await installChromeNativeHost(manifest, registration)).changed, false);
      const unrelated = join(registration, 'com.example.other.json');
      writeFileSync(unrelated, 'other host');
      assert.equal((await removeChromeNativeHost(manifest, registration)).changed, true);
      assert.equal((await removeChromeNativeHost(manifest, registration)).changed, false);
      assert.equal(readFileSync(unrelated, 'utf8'), 'other host');
      await assert.rejects(verifyChromeNativeHost(manifest, registration), /does not match/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

test('Chrome host registration refuses changed destination, wrong origin, and host symlink',
  { skip: process.platform !== 'darwin' }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'systemone-chrome-registration-'));
    try {
      const { registration, host, manifest, extensionId } = await fixture(root);
      await installChromeNativeHost(manifest, registration);
      const destination = join(registration, hostName);
      writeFileSync(destination, '{"name":"another owner"}\n');
      await assert.rejects(installChromeNativeHost(manifest, registration), /different/);
      await assert.rejects(removeChromeNativeHost(manifest, registration), /differs/);
      assert.equal(readFileSync(destination, 'utf8'), '{"name":"another owner"}\n');
      rmSync(destination);

      const staged = JSON.parse(readFileSync(manifest, 'utf8'));
      staged.allowed_origins = [`chrome-extension://${'b'.repeat(32)}/`];
      writeFileSync(manifest, `${JSON.stringify(staged)}\n`);
      await assert.rejects(installChromeNativeHost(manifest, registration), /does not match/);
      staged.allowed_origins = [`chrome-extension://${extensionId}/`];
      writeFileSync(manifest, `${JSON.stringify(staged)}\n`);

      const realHost = `${host}.real`;
      copyFileSync(host, realHost);
      rmSync(host);
      symlinkSync(realHost, host);
      await assert.rejects(installChromeNativeHost(manifest, registration), /regular file/);
      rmSync(host);
      copyFileSync(realHost, host);
      appendFileSync(host, 'tampered');
      await assert.rejects(installChromeNativeHost(manifest, registration), /Command failed/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
