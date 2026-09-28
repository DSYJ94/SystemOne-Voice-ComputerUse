import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startPortalFixture } from '../packages/fixtures/portal.ts';

if (!process.argv[2] || !isAbsolute(process.argv[2])) {
  throw new Error('pass an absolute built SystemOne Dev.app path');
}
const app = resolve(process.argv[2]);
if (!existsSync(app)) throw new Error('built SystemOne Dev.app is missing');
const contents = join(app, 'Contents');
const node = join(contents, 'Frameworks', 'node');
const script = join(contents, 'Resources', 'runtime', 'packages', 'runtime',
  'src', 'native-managed-controller.ts');
const browserModule = join(contents, 'Resources', 'runtime', 'packages',
  'browser', 'src', 'managed-observation.ts');
const browsers = join(contents, 'Resources', 'browsers');
for (const path of [node, script, browserModule, browsers]) {
  assert.ok(existsSync(path), `bundle is missing ${path}`);
}
const plist = join(contents, 'Info.plist');
const bundled = spawnSync('/usr/libexec/PlistBuddy',
  ['-c', 'Print :SystemOneBundledRuntime', plist], { encoding: 'utf8' });
assert.equal(bundled.status, 0);
assert.equal(bundled.stdout.trim(), 'true');
const expectedHash = spawnSync('/usr/libexec/PlistBuddy',
  ['-c', 'Print :SystemOneControllerNodeCDHash', plist], { encoding: 'utf8' });
assert.equal(expectedHash.status, 0);
assert.match(expectedHash.stdout.trim(), /^[a-f0-9]{40,128}$/);
const actualIdentity = spawnSync('codesign', ['-dv', '--verbose=4', node],
  { encoding: 'utf8' });
assert.equal(actualIdentity.status, 0);
assert.match(actualIdentity.stderr, /Identifier=com\.aurium\.systemone\.bundlednode/);
assert.equal(actualIdentity.stderr.match(/^CDHash=([a-f0-9]+)$/m)?.[1],
  expectedHash.stdout.trim());
for (const key of ['SystemOneNodeExecutable', 'SystemOneControllerScript']) {
  const external = spawnSync('/usr/libexec/PlistBuddy',
    ['-c', `Print :${key}`, plist], { encoding: 'utf8' });
  assert.notEqual(external.status, 0, `${key} must not point outside the bundle`);
}
const signature = spawnSync('codesign', ['--verify', '--deep', '--strict', app],
  { encoding: 'utf8' });
assert.equal(signature.status, 0, signature.stderr);

function run(executable, args, env, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', rejectRun);
    child.on('close', code => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

const root = mkdtempSync(join(tmpdir(), 'systemone-bundled-smoke-'));
const fixture = await startPortalFixture();
try {
  // A restricted PATH prevents accidental use of Homebrew at runtime.
  const env = { ...process.env, PATH: '/usr/bin:/bin',
    PLAYWRIGHT_BROWSERS_PATH: browsers };
  const identity = await run(join(contents, 'MacOS', 'SystemOneDev'),
    ['--check-controller-identity'], env, root);
  assert.equal(identity.code, 0, identity.stderr);
  assert.match(identity.stdout, /PASS: bundled controller running code identity accepted/);
  const controller = await run(node, [script, join(root, 'attempts.sqlite')],
    env, root);
  assert.equal(controller.code, 0, controller.stderr);
  assert.match(controller.stdout, /"requestId":"startup","phase":"ready"/);

  const probe = `
    const { ManagedObservationSession } = await import(
      process.env.SYSTEMONE_BUNDLE_BROWSER_MODULE);
    const url = process.env.SYSTEMONE_BUNDLE_FIXTURE_URL;
    const session = await ManagedObservationSession.launch(url,
      { allowedOrigins: [url], headless: true });
    try {
      const view = await session.observe();
      if (view.title !== 'Invoice Portal Fixture'
        || !view.controls.some(item => item.label === 'Find invoice')) {
        throw new Error('bundled browser observation did not match fixture');
      }
      process.stdout.write('bundled-browser-observed\\n');
    } finally { await session.close(); }
  `;
  const browser = await run(node, ['--input-type=module', '-e', probe], {
    ...env, SYSTEMONE_BUNDLE_BROWSER_MODULE: pathToFileURL(browserModule).href,
    SYSTEMONE_BUNDLE_FIXTURE_URL: fixture.url,
  }, root);
  assert.equal(browser.code, 0, browser.stderr);
  assert.match(browser.stdout, /bundled-browser-observed/);
  process.stdout.write('Bundled controller and managed Chromium fixture passed.\n');
} finally {
  await fixture.close();
  rmSync(root, { recursive: true, force: true });
}
