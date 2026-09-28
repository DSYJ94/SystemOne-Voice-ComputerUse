import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeHostPermitSigner } from '../packages/runtime/src/native-host-permit.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = mkdtempSync(join(tmpdir(), 'systemone-native-host-permit-'));
const now = 1_800_000_000_000;
const permit = {
  executionId: 'execution-1', permitRef: 'permit-1', taskId: 'task-1',
  taskEpoch: 1, goalRevision: 1, scopeRef: 'native:scope-1',
  observationId: 'obs-1', candidateId: 'node-1',
  candidateSetDigest: 'a'.repeat(64), actionDigest: 'b'.repeat(64),
  policyRevision: 'native-ax-policy-v1', leaseGeneration: 1,
};
try {
  const binary = join(build, 'NativeHostPermitCheck');
  const compile = spawnSync('swiftc', ['-swift-version', '6', '-parse-as-library',
    '-module-cache-path', join(build, 'module-cache'),
    join(root, 'packages/protocol/swift/Sources/ProtocolDigest/CanonicalJSON.swift'),
    join(root, 'apps/native-dev/NativeWorkerPermitDigest.swift'),
    join(root, 'apps/native-dev/NativeHostPermit.swift'),
    join(root, 'apps/native-dev/NativeHostPermitCheck.swift'),
    '-o', binary], { encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stderr);
  const signer = new NativeHostPermitSigner();
  const other = new NativeHostPermitSigner();
  const claim = signer.sign(permit, 'prep-1', now);
  const check = (key, message, at = now, policy) => {
    const run = spawnSync(binary, [key, JSON.stringify(message), String(at),
      ...(policy ? [policy] : [])],
      { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  assert.equal(check(signer.publicKey, claim), 'accepted');
  const pressPolicy = 'native-ax-press-fixture-v1';
  const pressClaim = signer.sign({ ...permit, policyRevision: pressPolicy },
    'prep-1', now);
  assert.equal(check(signer.publicKey, pressClaim, now, pressPolicy), 'accepted');
  assert.equal(check(signer.publicKey, pressClaim), 'rejected');
  assert.equal(check(other.publicKey, claim), 'rejected');
  assert.equal(check(signer.publicKey,
    { ...claim, signature: other.sign(permit, 'prep-1', now).signature }), 'rejected');
  assert.equal(check(signer.publicKey,
    { ...claim, permit: { ...claim.permit, candidateId: 'node-2' } }), 'rejected');
  assert.equal(check(signer.publicKey,
    { ...claim, preparationRef: 'prep-2' }), 'rejected');
  assert.equal(check(signer.publicKey,
    { ...claim, permit: { ...claim.permit, actionDigest: 'c'.repeat(64) } }),
  'rejected');
  assert.equal(check(signer.publicKey,
    { ...claim, signature: undefined }), 'rejected');
  assert.equal(check(signer.publicKey,
    signer.sign({ ...permit, candidateId: 'node-2' }, 'prep-1', now)), 'rejected');
  assert.equal(check(signer.publicKey,
    { ...claim, permit: { ...claim.permit, taskEpoch: 2 } }), 'rejected');
  assert.equal(check(signer.publicKey, claim, now + 10_000), 'rejected');
  assert.equal(check(signer.publicKey, claim, now - 25_000), 'rejected');
  assert.equal(check(signer.publicKey,
    { ...claim, permit: { ...claim.permit, unreviewedEffect: 'UPLOAD' } }), 'rejected');
  process.stdout.write('Native host permit cross-language checks passed.\n');
} finally { rmSync(build, { recursive: true, force: true }); }
