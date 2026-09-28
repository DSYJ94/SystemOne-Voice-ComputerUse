import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = mkdtempSync(join(tmpdir(), 'systemone-worker-ledger-'));
const binary = join(build, 'NativeWorkerPermitLedgerCheck');
const digest = 'a'.repeat(64);
try {
  const compile = spawnSync('swiftc', ['-swift-version', '6',
    '-module-cache-path', join(build, 'module-cache'), '-parse-as-library',
    join(root, 'apps/native-dev/NativeWorkerPermitLedger.swift'),
    join(root, 'apps/native-dev/NativeWorkerPermitLedgerCheck.swift'),
    '-lsqlite3', '-o', binary], { encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stderr);
  const database = join(build, 'support', 'permits.sqlite');
  function consume(path, executionId, permitRef) {
    const result = spawnSync(binary, [path, executionId, permitRef, digest],
      { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  assert.equal(consume(database, 'execution-1', 'permit-1'), 'consumed');
  assert.equal(lstatSync(database).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(build, 'support')).mode & 0o777, 0o700);
  // Every call is a new worker process. A crash/restart cannot reuse either ID.
  assert.equal(consume(database, 'execution-1', 'permit-1'), 'refused');
  assert.equal(consume(database, 'execution-1', 'permit-2'), 'refused');
  assert.equal(consume(database, 'execution-2', 'permit-1'), 'refused');
  assert.equal(consume(database, 'execution-2', 'permit-2'), 'consumed');
  assert.equal(consume(database, 'bad id', 'permit-3'), 'refused');
  const contents = readFileSync(database);
  assert.equal(contents.includes(Buffer.from('fixture-secret')), false);

  const bad = join(build, 'bad', 'permits.sqlite');
  mkdirSync(join(build, 'bad'), { mode: 0o700 });
  writeFileSync(bad, 'not a database');
  chmodSync(bad, 0o600);
  assert.equal(consume(bad, 'execution-3', 'permit-3'), 'unavailable');
  const open = join(build, 'open', 'permits.sqlite');
  mkdirSync(join(build, 'open'), { mode: 0o700 });
  writeFileSync(open, '');
  chmodSync(open, 0o644);
  assert.equal(consume(open, 'execution-4', 'permit-4'), 'unavailable');
  const link = join(build, 'link', 'permits.sqlite');
  mkdirSync(join(build, 'link'), { mode: 0o700 });
  symlinkSync(database, link);
  assert.equal(consume(link, 'execution-5', 'permit-5'), 'unavailable');
  process.stdout.write('Native worker ledger restart, replay and path checks passed.\n');
} finally { rmSync(build, { recursive: true, force: true }); }
