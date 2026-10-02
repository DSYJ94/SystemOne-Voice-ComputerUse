import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CLMReferenceProcess, createVerifiedCLMReferenceBackend } from '../src/clm-reference-process.ts';

const identity = 'a'.repeat(64), revision = 'b'.repeat(40);
const script = (operation: string, ready = `JSON.stringify({ready:true,manifestDigest:'${identity}',tokenizerRevision:'${revision}'})`) => `
  const readline = require('node:readline');
  let first = true;
  readline.createInterface({input:process.stdin}).on('line', line => {
    const m = JSON.parse(line);
    if (first) { first=false; console.log(${ready}); return; }
    ${operation}
  });`;

function worker(code: string, timeout = 1000) {
  const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
  const backend = new CLMReferenceProcess(child, identity, revision, {}, timeout);
  return { backend, child };
}

test('synthetic private worker counts exact batch and serializes operations', async t => {
  const { backend } = worker(script(`setTimeout(()=>console.log(JSON.stringify({id:m.id,ok:true,value:m.value.map(()=>3)})),30);`));
  t.after(() => backend.close()); await backend.ready;
  const pending = backend.countTokens(['state', 'candidate'], new AbortController().signal);
  await assert.rejects(backend.countTokens(['other'], new AbortController().signal), /unavailable/);
  assert.deepEqual(await pending, [3, 3]);
});

test('wrong startup artifact identity fails closed after worker settlement', async () => {
  const { backend, child } = worker(script('', `JSON.stringify({ready:true,manifestDigest:'wrong',tokenizerRevision:'${revision}'})`));
  await assert.rejects(backend.ready, /unavailable/);
  assert.notEqual(child.exitCode ?? child.signalCode, null); await backend.close();
});

test('a missing Python executable settles startup and shutdown without hanging', async () => {
  const child = spawn('/absent/systemone-python', [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const backend = new CLMReferenceProcess(child, identity, revision, {}, 1000);
  await assert.rejects(backend.ready, /unavailable/);
  await backend.close();
});

test('malformed, oversized and unsolicited replies terminate the owned process', async () => {
  for (const code of [
    `console.log('{invalid');`,
    `console.log('x'.repeat(262145));`,
    `console.log(JSON.stringify({id:m.id+1,ok:true,value:[1]}));`,
    `console.log(JSON.stringify({id:m.id,ok:true,value:[0]}));`,
    `console.log(JSON.stringify({id:m.id,ok:true,value:[1]})+'\\n'+JSON.stringify({id:m.id,ok:true,value:[1]}));`,
  ]) {
    const { backend } = worker(script(code)); await backend.ready;
    await assert.rejects(backend.countTokens(['state'], new AbortController().signal), /unavailable/);
    await backend.close();
  }
});

test('abort revokes late replies and waits for actual worker close', async () => {
  const { backend, child } = worker(script(`
    if (m.id===1) {
      process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),120));
      console.log(JSON.stringify({id:m.id,ok:true,value:[1]}));
    } else setTimeout(()=>console.log(JSON.stringify({id:m.id,ok:true,value:[1]})),80);
  `));
  await backend.ready;
  // Let the worker install its SIGTERM handler in a first operation.
  await backend.countTokens(['first'], new AbortController().signal);
  const controller = new AbortController(); let closed = false;
  child.once('close', () => { closed = true; });
  const pending = backend.countTokens(['second'], controller.signal);
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending);
  assert.equal(closed, true); await backend.close();
});

test('worker failures redact backend text and startup deadline fences an unready process', async () => {
  const { backend } = worker(script(`console.error('private model text'); console.log(JSON.stringify({id:m.id,ok:false}));`));
  await backend.ready;
  await assert.rejects(backend.countTokens(['state'], new AbortController().signal), error => {
    assert.equal(String(error).includes('private'), false); return true;
  });
  await backend.close();
  const stalled = worker('setInterval(()=>{},1000)', 30);
  await assert.rejects(stalled.backend.ready, /unavailable/); await stalled.backend.close();
});

test('production factory rejects unresolved artifacts before Python or GPU startup', async () => {
  const pending = JSON.parse(readFileSync(new URL('../fixtures/clm-artifact-manifest.pending.json', import.meta.url), 'utf8'));
  await assert.rejects(createVerifiedCLMReferenceBackend({ artifactManifest: pending, artifactRoot: '/absent',
    pythonExecutable: '/absent/python', device: 'mps' }), /unresolved/);
});

test('local GPU benchmark refuses unresolved pins without creating a report', t => {
  const directory = mkdtempSync(join(tmpdir(), 'clm-benchmark-refusal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'report.json');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../../scripts/benchmark-clm-local.ts', import.meta.url)),
    fileURLToPath(new URL('../fixtures/clm-artifact-manifest.macos.pending.json', import.meta.url)),
    '/absent/artifacts', '/absent/python', 'mps', output], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.equal(existsSync(output), false);
  assert.match(result.stderr, /^Local GPU experiment refused or failed;/);
});

test('serving CLI requires a private key before any Python/model initialization', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../../scripts/serve-clm-reference.ts', import.meta.url)),
    fileURLToPath(new URL('../fixtures/clm-artifact-manifest.macos.pending.json', import.meta.url)),
    '/absent/artifacts', '/absent/python', 'mps', '0'],
  { encoding: 'utf8', timeout: 5000, env: { ...process.env, CLM_SERVING_API_KEY: '' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^CLM startup refused;/); assert.equal(result.stdout, '');
});
