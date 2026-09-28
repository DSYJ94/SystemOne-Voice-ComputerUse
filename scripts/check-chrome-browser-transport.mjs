import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { startPortalFixture } from '../packages/fixtures/portal.ts';
import { ChromeReadSession } from '../packages/runtime/src/chrome-read-session.ts';
import { installChromeNativeHost, verifyChromeNativeHost } from
  './register-chrome-native-host.mjs';
import { stageChromeNativeHost } from './stage-chrome-native-host.mjs';

if (process.platform !== 'darwin') {
  process.stderr.write('This signed-host Chromium check requires macOS.\n');
  process.exit(2);
}

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync('/private/tmp/systemone-chrome-transport-');
const extension = join(root, 'extension');
const profile = join(root, 'profile');
const staged = join(root, 'staged');
const socketPath = join(root, 'controller.sock');
const registration = join(profile, 'NativeMessagingHosts');
let context;
let listenerProcess;
let fixture;
let extensionId;
let liveSession;
let sessionError;
const sessions = new Map();
const received = [];
const observations = [];
let closedConnections = 0;

function command(binary, args, options = {}) {
  return execFileSync(binary, args, { encoding: 'utf8', ...options });
}

function codeDetails(binary) {
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', binary],
    { encoding: 'utf8' });
  assert.equal(result.status, 0, `codesign inspection failed for ${binary}`);
  const detail = result.stderr;
  const identifier = /^Identifier=(.+)$/m.exec(detail)?.[1];
  const cdHash = /^CDHash=([a-f0-9]{40,128})$/m.exec(detail)?.[1];
  assert.ok(identifier && cdHash, `missing signed code identity for ${binary}`);
  return { identifier, cdHash };
}

function sendListener(connectionId, payload) {
  listenerProcess.stdin.write(`${JSON.stringify({ type: 'send', connectionId,
    base64: Buffer.from(JSON.stringify(payload)).toString('base64') })}\n`);
}

function onListenerEvent(event) {
  if (event.type === 'closed') {
    closedConnections++;
    const session = sessions.get(event.connectionId);
    session?.close();
    sessions.delete(event.connectionId);
    if (liveSession === session) liveSession = undefined;
    return;
  }
  if (event.type !== 'message') return;
  try {
    const message = JSON.parse(Buffer.from(event.base64, 'base64').toString('utf8'));
    received.push(message);
    if (message.type === 'probe') {
      sendListener(event.connectionId, { type: 'probe_ack', nonce: message.nonce });
      return;
    }
    let session = sessions.get(event.connectionId);
    if (!session) {
      session = new ChromeReadSession(extensionId,
        reply => sendListener(event.connectionId, reply),
        (binding, snapshot) => observations.push({ binding, snapshot }));
      sessions.set(event.connectionId, session);
    }
    liveSession = session;
    session.receive(message);
  } catch (error) {
    sessionError = error;
    listenerProcess.stdin.write(`${JSON.stringify({ type: 'close',
      connectionId: event.connectionId })}\n`);
  }
}

async function startListener(hostHash) {
  const binary = join(root, 'DevChromeBrowserListenerCheck');
  command('swiftc', ['-swift-version', '6', '-parse-as-library',
    '-framework', 'Security', '-lbsm',
    join(repository, 'packages/protocol/swift/Sources/PeerIdentity/PeerIdentity.swift'),
    join(repository, 'apps/native-dev/DevChromeListener.swift'),
    join(repository, 'apps/native-dev/DevChromeBrowserListenerCheck.swift'),
    '-o', binary]);
  command('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier',
    'com.aurium.systemone.listenercheck', binary]);
  command('/usr/bin/codesign', ['--verify', '--strict', binary]);
  const identity = codeDetails(binary);
  listenerProcess = spawn(binary, [socketPath, hostHash],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: listenerProcess.stdout });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Swift listener did not start')), 5_000);
    listenerProcess.once('error', reject);
    listenerProcess.once('exit', code => reject(new Error(
      `Swift listener exited before ready: ${code}`)));
    lines.on('line', line => {
      const event = JSON.parse(line);
      if (event.type === 'ready') { clearTimeout(timer); resolve(); }
      else onListenerEvent(event);
    });
  });
  return identity;
}

async function stopListener() {
  if (!listenerProcess || listenerProcess.exitCode !== null) return;
  const done = once(listenerProcess, 'exit');
  listenerProcess.stdin.end();
  const timer = setTimeout(() => listenerProcess.kill('SIGKILL'), 5_000);
  try { await done; } finally { clearTimeout(timer); }
}

function extensionFiles() {
  mkdirSync(extension);
  const source = join(repository, 'extensions', 'chrome');
  for (const name of ['grants.mjs', 'semantic-controls.mjs']) {
    copyFileSync(join(source, name), join(extension, name));
  }
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
  // The temporary copy receives loopback host access because this test invokes
  // its handler without a real toolbar click or activeTab user gesture.
  manifest.host_permissions = ['http://127.0.0.1/*'];
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify(manifest));
  const workerSource = readFileSync(join(source, 'service-worker.mjs'), 'utf8');
  const hooked = workerSource.replace('chrome.action.onClicked.addListener(tab => {',
    'chrome.action.onClicked.addListener(globalThis.testInvoke = tab => {');
  assert.notEqual(hooked, workerSource, 'production click handler not found');
  writeFileSync(join(extension, 'service-worker.mjs'), `${hooked}\n
    globalThis.probeHost = nonce => new Promise(resolve => {
      const port = chrome.runtime.connectNative('com.aurium.systemone.chrome');
      const timeout = setTimeout(() => { port.disconnect(); resolve({ timeout: true }); }, 3000);
      port.onMessage.addListener(message => {
        clearTimeout(timeout); port.disconnect(); resolve(message);
      });
      port.onDisconnect.addListener(() => {
        clearTimeout(timeout);
        resolve({ error: chrome.runtime.lastError?.message ?? 'disconnected' });
      });
      port.postMessage({ type: 'probe', nonce });
    });
  `);
}

async function until(predicate, label) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}: ${sessionError?.message ?? 'no error'}`);
}

async function browserWorker() {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`],
  });
  return context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
}

try {
  fixture = await startPortalFixture();
  extensionFiles();
  const buildEnvironment = { ...process.env,
    CLANG_MODULE_CACHE_PATH: '/private/tmp/systemone-clang-cache',
    SWIFTPM_MODULECACHE_OVERRIDE: '/private/tmp/systemone-clang-cache' };
  const packagePath = join(repository, 'packages', 'chrome-native-host');
  const cache = '/private/tmp/systemone-swift-cache';
  command('swift', ['build', '--package-path', packagePath,
    '--cache-path', cache, '--product', 'SystemOneChromeNativeHost'],
  { env: buildEnvironment });
  const binaryDir = command('swift', ['build', '--package-path', packagePath,
    '--cache-path', cache, '--show-bin-path'], { env: buildEnvironment }).trim();
  mkdirSync(staged);
  const host = join(staged, 'SystemOneChromeNativeHost');
  copyFileSync(join(binaryDir, 'SystemOneChromeNativeHost'), host);
  command('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier',
    'com.aurium.systemone.chromenativehost', host]);
  command('/usr/bin/codesign', ['--verify', '--strict', host]);
  let worker = await browserWorker();
  extensionId = await worker.evaluate(() => chrome.runtime.id);
  await context.close();
  context = null;
  const hostHash = codeDetails(host).cdHash;
  const controller = await startListener(hostHash);
  const stagedManifest = join(staged, 'com.aurium.systemone.chrome.json');
  await stageChromeNativeHost({ extensionId, hostPath: host,
    manifestPath: stagedManifest,
    controllerSigningIdentifier: controller.identifier,
    controllerCDHashes: [controller.cdHash] });
  const configPath = join(staged, 'ChromeNativeHost.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  // The release build excludes this debug-only socket override.
  writeFileSync(configPath, `${JSON.stringify({ ...config,
    testControllerSocketPath: socketPath })}\n`);
  const installed = await installChromeNativeHost(stagedManifest, registration);
  assert.equal(installed.changed, true);
  assert.equal(await verifyChromeNativeHost(stagedManifest, registration),
    installed.destination);

  worker = await browserWorker();
  const reply = await worker.evaluate(() => probeHost('signed-roundtrip'));
  assert.deepEqual(reply, { type: 'probe_ack', nonce: 'signed-roundtrip' });
  assert.deepEqual(received, [{ type: 'probe', nonce: 'signed-roundtrip' }]);
  await until(() => closedConnections >= 1, 'probe port close');

  const page = await context.newPage();
  await page.goto(`${fixture.url}/`);
  await page.locator('#query').fill('synthetic-private-value');
  await worker.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(item => item.url === url);
    if (!tab) throw new Error('fixture tab missing');
    globalThis.testInvoke(tab);
  }, page.url());
  await until(() => observations.length === 1, 'production extension observation');
  assert.equal(sessionError, undefined);
  assert.equal(observations[0].snapshot.title, 'Invoice Portal Fixture');
  assert.ok(observations[0].snapshot.elements.some(item =>
    item.label === 'Find invoice' && item.editable));
  assert.equal(JSON.stringify(observations[0].snapshot)
    .includes('synthetic-private-value'), false);
  assert.equal(observations[0].binding.extensionId, extensionId);
  await page.reload();
  await until(() => liveSession?.activeGrantCount === 0,
    'navigation grant revocation');
  await context.close();
  context = null;

  writeFileSync(configPath, `${JSON.stringify({ ...config,
    controllerCDHashes: ['f'.repeat(40)],
    testControllerSocketPath: socketPath })}\n`);
  worker = await browserWorker();
  const rejected = await worker.evaluate(() => probeHost('wrong-controller'));
  assert.ok(rejected.error && !rejected.timeout,
    `wrong controller identity unexpectedly accepted: ${JSON.stringify(rejected)}`);
  assert.equal(received.filter(message => message.type === 'probe').length, 1);
  await context.close();
  context = null;

  await stopListener();
  const wrongHostListener = await startListener('f'.repeat(40));
  writeFileSync(configPath, `${JSON.stringify({ ...config,
    controllerSigningIdentifier: wrongHostListener.identifier,
    controllerCDHashes: [wrongHostListener.cdHash],
    testControllerSocketPath: socketPath })}\n`);
  worker = await browserWorker();
  const wrongHost = await worker.evaluate(() => probeHost('wrong-host'));
  assert.ok(wrongHost.error && !wrongHost.timeout,
    `wrong host identity unexpectedly accepted: ${JSON.stringify(wrongHost)}`);
  assert.equal(received.filter(message => message.type === 'probe').length, 1);
  process.stdout.write('PASS: temporary Chromium -> signed Swift host -> authenticated Swift listener -> synthetic controller; semantic read and navigation revocation; changed listener and host CDHashes rejected.\n');
} finally {
  await context?.close();
  await fixture?.close();
  for (const session of sessions.values()) session.close();
  await stopListener();
  rmSync(root, { recursive: true, force: true });
}
