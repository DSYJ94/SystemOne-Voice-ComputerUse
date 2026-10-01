import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['scripts/release-dependency-inventory.mjs', 'package.json', 'package-lock.json',
  'requirements-test.txt', '.node-version', 'scripts/build-bundled-dev.sh', 'docs/DEPENDENCIES.md',
  'packages/providers/fixtures/clm-artifact-manifest.pending.json',
  'docs/release/dependencies.pending.json', 'docs/release/dependency-inventory.json',
  'node_modules/playwright-core/browsers.json', 'node_modules/playwright-core/package.json'];
function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'systemone-inventory-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const file of files) {
    mkdirSync(dirname(resolve(directory, file)), { recursive: true });
    copyFileSync(resolve(root, file), resolve(directory, file));
  }
  return directory;
}
function run(directory, mode = '--check') {
  return spawnSync(process.execPath, [resolve(directory, files[0]), mode], { encoding: 'utf8' });
}
function changeJSON(directory, file, update) {
  const path = resolve(directory, file);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  update(data);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

test('repeated generation is byte-stable and retains unresolved release gates', t => {
  const directory = fixture(t);
  assert.equal(run(directory, '--write').status, 0);
  const path = resolve(directory, 'docs/release/dependency-inventory.json');
  const first = readFileSync(path, 'utf8');
  assert.equal(run(directory, '--write').status, 0);
  assert.equal(readFileSync(path, 'utf8'), first);
  assert.equal(run(directory).status, 0);
  const data = JSON.parse(first);
  assert.equal(data.status, 'pending-release-review');
  assert.equal(data.clm.artifactBytesVerified, false);
  assert.equal(data.clm.declarations.encoder.revision, null);
  assert.ok(data.npm.some(pkg => pkg.name === 'fast-uri' && pkg.declaredLicense === 'BSD-3-Clause'));
  assert.ok(data.npm.some(pkg => pkg.name === '@typescript/typescript-darwin-arm64' && pkg.scope === 'development'));
  assert.ok(data.pythonTests.every(pkg => pkg.artifactHashes === null));
});
test('changed generated inventory fails without rewriting it', t => {
  const directory = fixture(t);
  const path = resolve(directory, 'docs/release/dependency-inventory.json');
  writeFileSync(path, '{}\n');
  assert.match(run(directory).stderr, /Inventory stale/);
  assert.equal(readFileSync(path, 'utf8'), '{}\n');
});
test('direct manifest and lock disagreement rejects generation', t => {
  const directory = fixture(t);
  changeJSON(directory, 'package.json', data => { data.dependencies.ajv = '8.19.0'; });
  assert.notEqual(run(directory, '--write').status, 0);
});
test('missing integrity and licenses reject generation', t => {
  const directory = fixture(t);
  changeJSON(directory, 'package-lock.json', data => { delete data.packages['node_modules/ajv'].integrity; });
  assert.match(run(directory, '--write').stderr, /Missing SHA-512 integrity/);
  copyFileSync(resolve(root, 'package-lock.json'), resolve(directory, 'package-lock.json'));
  changeJSON(directory, 'package-lock.json', data => { delete data.packages['node_modules/fast-uri'].license; });
  assert.match(run(directory, '--write').stderr, /Missing license/);
});
test('unpinned Python and changed Node bundle pins reject generation', t => {
  const directory = fixture(t);
  writeFileSync(resolve(directory, 'requirements-test.txt'), 'jsonschema>=4\n');
  assert.match(run(directory, '--write').stderr, /Unpinned Python/);
  copyFileSync(resolve(root, 'requirements-test.txt'), resolve(directory, 'requirements-test.txt'));
  changeJSON(directory, 'docs/release/dependencies.pending.json', data => { data.node.sha256 = '0'.repeat(64); });
  assert.match(run(directory, '--write').stderr, /Node bundle hash drift/);
});
test('mismatched installed browser metadata cannot validate the browser pin', t => {
  const directory = fixture(t);
  changeJSON(directory, 'node_modules/playwright-core/browsers.json', data => { data.browsers[0].revision = '0000'; });
  assert.match(run(directory, '--write').stderr, /Browser metadata drift/);
});
