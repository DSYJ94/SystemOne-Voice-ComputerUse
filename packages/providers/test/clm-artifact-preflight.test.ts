import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { CLM_HEAD_SHA256, validateCLMArtifactManifest, verifyCLMArtifactFiles, preflightCLMArtifacts } from '../src/clm-artifact-preflight.ts';
import type { CLMArtifactFile } from '../src/clm-artifact-preflight.ts';

const pendingPath = new URL('../fixtures/clm-artifact-manifest.pending.json', import.meta.url);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const declaration = (path: string, role: CLMArtifactFile['role'], bytes = Buffer.from('synthetic metadata only')) => ({ path, role, bytes: bytes.length, sha256: sha(bytes) });
function manifest() {
  const value = JSON.parse(readFileSync(pendingPath, 'utf8'));
  value.encoder.revision = '1'.repeat(40);
  value.encoder.files = [declaration('encoder/model.safetensors', 'weights'), declaration('encoder/tokenizer.json', 'tokenizer'),
    declaration('encoder/config.json', 'config'), declaration('encoder/LICENSE', 'license')];
  value.heads.files = [{ ...declaration('heads/CLM_v0.1-8B.pt', 'weights'), sha256: CLM_HEAD_SHA256 }, declaration('heads/LICENSE', 'license')];
  value.runtime = { image: `registry.invalid/systemone-clm@sha256:${'2'.repeat(64)}`, serverRevision: '3'.repeat(40) };
  value.licenseReviewRef = 'synthetic-declaration-only';
  return value;
}
function directory(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'systemone-clm-artifacts-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}

test('artifact manifest accepts immutable declarations without claiming verified bytes or inference', () => {
  const value = manifest(); const checked = validateCLMArtifactManifest(value);
  assert.ok(Object.isFrozen(checked)); assert.ok(Object.isFrozen(checked.encoder.files[0]));
  value.encoder.revision = 'main';
  assert.equal(checked.encoder.revision, '1'.repeat(40));
  assert.equal(Object.hasOwn(checked, 'inferenceQualified'), false);
});

test('unresolved committed pins fail before artifact filesystem access', async () => {
  const pending = JSON.parse(readFileSync(pendingPath, 'utf8'));
  assert.throws(() => validateCLMArtifactManifest(pending), /unresolved/);
  await assert.rejects(preflightCLMArtifacts(pending, '/absent-artifact-root'), /unresolved/);
});

test('moving pins, unsafe loader/settings and changed reference identity are rejected', () => {
  const changes = [
    (v: any) => { v.encoder.revision = 'main'; },
    (v: any) => { v.runtime.image = 'image:latest'; },
    (v: any) => { v.runtime.serverRevision = '0'.repeat(40); },
    (v: any) => { v.referenceRevision = '4'.repeat(40); },
    (v: any) => { v.heads.files[0].sha256 = '0'.repeat(64); },
    (v: any) => { v.security.checkpointLoading = 'pickle'; },
    (v: any) => { v.security.hotReload = 'enabled'; },
    (v: any) => { v.security.downloads = 'enabled'; },
    (v: any) => { v.security.trustRemoteCode = true; },
    (v: any) => { v.security.authentication = 'optional'; },
    (v: any) => { v.recipe.overflow = 'truncate'; },
    (v: any) => { v.recipe.pooling = 'mean'; },
    (v: any) => { v.recipe.normalizeEncoder = false; },
    (v: any) => { v.unexpected = 'private'; },
  ];
  for (const change of changes) { const v = manifest(); change(v); assert.throws(() => validateCLMArtifactManifest(v)); }
});

test('manifest refuses missing roles, duplicate paths, pickle encoder and escaping paths', () => {
  for (const change of [
    (v: any) => { v.encoder.files.pop(); },
    (v: any) => { v.encoder.files.push(v.encoder.files[0]); },
    (v: any) => { v.encoder.files[0].path = 'encoder/model.bin'; },
    (v: any) => { v.encoder.files[0].path = 'encoder/../model.safetensors'; },
    (v: any) => { v.encoder.files[0].bytes = Number.MAX_SAFE_INTEGER; },
  ]) { const v = manifest(); change(v); assert.throws(() => validateCLMArtifactManifest(v)); }
});

test('local verifier streams exact fixture bytes and detects wrong checksums or sizes', async t => {
  const root = directory(t); mkdirSync(join(root, 'encoder'));
  const bytes = Buffer.alloc(512_000, 7); const file = declaration('encoder/model.safetensors', 'weights', bytes);
  writeFileSync(join(root, file.path), bytes);
  assert.deepEqual(await verifyCLMArtifactFiles(root, [file]), [{ path: file.path, sha256: file.sha256, bytes: file.bytes }]);
  await assert.rejects(verifyCLMArtifactFiles(root, [{ ...file, sha256: '0'.repeat(64) }]), /checksum/);
  await assert.rejects(verifyCLMArtifactFiles(root, [{ ...file, bytes: file.bytes + 1 }]), /size/);
  await assert.rejects(verifyCLMArtifactFiles(root, [file], AbortSignal.abort()));
});

test('local verifier rejects symlink files/directories and invalid standalone declarations', async t => {
  const root = directory(t); mkdirSync(join(root, 'encoder'));
  const bytes = Buffer.from('fixture'); writeFileSync(join(root, 'original'), bytes);
  symlinkSync(join(root, 'original'), join(root, 'encoder/link'));
  symlinkSync(join(root, 'encoder'), join(root, 'linked'));
  await assert.rejects(verifyCLMArtifactFiles(root, [declaration('encoder/link', 'weights', bytes)]), /symlink/);
  await assert.rejects(verifyCLMArtifactFiles(root, [declaration('linked/link', 'weights', bytes)]), /symlink/);
  await assert.rejects(verifyCLMArtifactFiles(root, [declaration('../original', 'weights', bytes)]), /identity/);
  await assert.rejects(verifyCLMArtifactFiles(root, [declaration('encoder', 'weights', bytes)]), /regular file/);
  await assert.rejects(verifyCLMArtifactFiles(root, []), /count/);
  const file = declaration('original', 'weights', bytes);
  await assert.rejects(verifyCLMArtifactFiles(root, [file, file]), /duplicate/);
});

test('a declared manifest never succeeds when actual model files are absent', async t => {
  await assert.rejects(preflightCLMArtifacts(manifest(), directory(t)), /ENOENT/);
});

test('preflight CLI fails on the pending manifest without writing a report or loading weights', t => {
  const root = directory(t); const report = join(root, 'report.json');
  assert.throws(() => execFileSync(process.execPath, ['scripts/preflight-clm-artifacts.ts', '--manifest', pendingPath.pathname,
    '--artifacts', root, '--output', report], { cwd: new URL('../../../', import.meta.url), stdio: 'pipe' }));
  assert.equal(existsSync(report), false);
});
