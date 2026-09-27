import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stageChromeNativeHost } from '../../../scripts/stage-chrome-native-host.mjs';

test('Chrome host staging pins one extension and release controller identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'systemone-chrome-stage-'));
  const hostPath = join(root, 'SystemOneChromeNativeHost');
  const manifestPath = join(root, 'com.aurium.systemone.chrome.json');
  writeFileSync(hostPath, 'synthetic executable');
  try {
    const extensionId = 'a'.repeat(32);
    await stageChromeNativeHost({ extensionId, hostPath, manifestPath,
      controllerSigningIdentifier: 'com.aurium.systemone',
      controllerTeamIdentifier: 'ABCDEFGHIJ' });
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const config = JSON.parse(await readFile(join(root, 'ChromeNativeHost.json'), 'utf8'));
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
    assert.equal(manifest.path, hostPath);
    assert.equal(manifest.type, 'stdio');
    assert.equal(config.controllerTeamIdentifier, 'ABCDEFGHIJ');
    assert.equal(config.testControllerSocketPath, undefined);
    await assert.rejects(stageChromeNativeHost({ extensionId, hostPath, manifestPath,
      controllerSigningIdentifier: 'com.aurium.systemone',
      controllerTeamIdentifier: 'ABCDEFGHIJ' }), /EEXIST/);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'ChromeNativeHost.json'), 'utf8')),
      config);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Chrome host staging removes a new config when the manifest already exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'systemone-chrome-stage-'));
  const hostPath = join(root, 'SystemOneChromeNativeHost');
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(hostPath, 'synthetic executable');
  writeFileSync(manifestPath, 'existing manifest');
  try {
    await assert.rejects(stageChromeNativeHost({ extensionId: 'a'.repeat(32),
      hostPath, manifestPath, controllerSigningIdentifier: 'com.aurium.systemone',
      controllerTeamIdentifier: 'ABCDEFGHIJ' }), /EEXIST/);
    assert.equal(existsSync(join(root, 'ChromeNativeHost.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Chrome host staging refuses wildcard extension and unanchored controller', async () => {
  const root = mkdtempSync(join(tmpdir(), 'systemone-chrome-stage-'));
  const hostPath = join(root, 'SystemOneChromeNativeHost');
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(hostPath, 'synthetic executable');
  try {
    await assert.rejects(stageChromeNativeHost({ extensionId: '*', hostPath, manifestPath,
      controllerSigningIdentifier: 'com.aurium.systemone', controllerTeamIdentifier: 'ABCDEFGHIJ' }),
    /invalid/);
    await assert.rejects(stageChromeNativeHost({ extensionId: 'a'.repeat(32), hostPath,
      manifestPath, controllerSigningIdentifier: 'com.aurium.systemone' }), /invalid/);
    const linkPath = join(root, 'host-link');
    symlinkSync(hostPath, linkPath);
    await assert.rejects(stageChromeNativeHost({ extensionId: 'a'.repeat(32),
      hostPath: linkPath, manifestPath,
      controllerSigningIdentifier: 'com.aurium.systemone',
      controllerTeamIdentifier: 'ABCDEFGHIJ' }), /regular file/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
