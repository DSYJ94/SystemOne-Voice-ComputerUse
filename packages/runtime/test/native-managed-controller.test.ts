import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startPortalFixture } from '../../fixtures/portal.ts';
import { AttemptJournal } from '../src/attempt-journal.ts';

interface Status {
  readonly type: 'status';
  readonly requestId: string;
  readonly phase: string;
}

test('native private pipe drives an admitted managed-browser fill and stays alive for another task', async () => {
  const portal = await startPortalFixture();
  const root = mkdtempSync(join(tmpdir(), 'systemone-native-managed-'));
  const journalPath = join(root, 'attempts.sqlite');
  const source = fileURLToPath(new URL('../src/native-managed-controller.ts', import.meta.url));
  const child = spawn(process.execPath, [source, journalPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SYSTEMONE_MANAGED_HEADLESS: '1' },
  });
  const statuses: Status[] = [];
  let output = '';
  child.stdout.on('data', chunk => {
    output += String(chunk);
    while (output.includes('\n')) {
      const index = output.indexOf('\n');
      const line = output.slice(0, index);
      output = output.slice(index + 1);
      statuses.push(JSON.parse(line) as Status);
    }
  });
  async function waitStatus(requestId: string, phase: string): Promise<void> {
    for (let count = 0; count < 500; count++) {
      if (statuses.some(status => status.requestId === requestId && status.phase === phase)) return;
      if (child.exitCode !== null) throw new Error(`controller exited before ${phase}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`controller did not report ${phase}`);
  }
  function start(requestId: string, value: string, invalidCommand = false): void {
    const url = `${portal.url}/`;
    const fieldLabel = 'Find invoice';
    const command = {
      type: 'command', protocolVersion: '2.0', messageId: randomUUID(),
      taskId: requestId, taskEpoch: 1, goalRevision: 1,
      source: 'text', mode: 'command', utteranceId: randomUUID(),
      utteranceRevision: 1,
      text: invalidCommand ? 'Unbound command' : `Fill ${fieldLabel} on ${url} with supplied text`, isFinal: true,
      createdAt: new Date().toISOString(),
      originSurface: { adapter: 'native', surfaceId: 'systemone-panel',
        appBundleId: 'com.aurium.systemone.dev', windowId: 'command-panel',
        contentRevision: requestId },
    };
    child.stdin.write(`${JSON.stringify({ type: 'start_fill', requestId, url,
      fieldLabel, value, command })}\n`);
  }
  try {
    await waitStatus('startup', 'ready');
    const rejected = randomUUID();
    start(rejected, 'must-not-dispatch', true);
    await waitStatus(rejected, 'error');
    await waitStatus(rejected, 'ready');
    assert.equal(portal.requestCount('/'), 0, 'invalid command must not navigate');
    const first = randomUUID();
    start(first, 'fixture-123');
    await waitStatus(first, 'verified_dom_fill');
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(statuses.some(status => status.requestId === first
      && status.phase === 'ready'), false);
    const firstStop = randomUUID();
    child.stdin.write(`${JSON.stringify({ type: 'stop', requestId: firstStop,
      targetRequestId: first })}\n`);
    await waitStatus(firstStop, 'stopped');
    await waitStatus(first, 'ready');
    const second = randomUUID();
    start(second, 'another-value');
    await waitStatus(second, 'verified_dom_fill');
    const stop = randomUUID();
    child.stdin.write(`${JSON.stringify({ type: 'stop', requestId: stop,
      targetRequestId: second })}\n`);
    await waitStatus(stop, 'stopped');
    await waitStatus(second, 'ready');
    child.stdin.end();
    const exitCode = await new Promise<number | null>(resolve => child.once('exit', resolve));
    assert.equal(exitCode, 0);
    const journal = new AttemptJournal(journalPath);
    try {
      assert.equal(journal.getTaskState(first), 'completed');
      assert.equal(journal.getTaskState(second), 'completed');
      assert.deepEqual(journal.unresolvedAttempts(), []);
    } finally { journal.close(); }
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await portal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Stop acknowledges an in-flight managed launch without waiting for navigation',
  { timeout: 15_000 }, async () => {
  let releasePage: (() => void) | undefined;
  let pageRequested: (() => void) | undefined;
  const requested = new Promise<void>(resolve => { pageRequested = resolve; });
  const server = createServer((request, response) => {
    if (request.url !== '/' || releasePage) { response.end(); return; }
    releasePage = () => {
      if (response.writableEnded) return;
      response.setHeader('content-type', 'text/html');
      response.end('<html><body><input aria-label="Find invoice"></body></html>');
    };
    pageRequested?.();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/`;
  const root = mkdtempSync(join(tmpdir(), 'systemone-managed-stop-launch-'));
  const source = fileURLToPath(new URL('../src/native-managed-controller.ts', import.meta.url));
  const child = spawn(process.execPath, [source, join(root, 'attempts.sqlite')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SYSTEMONE_MANAGED_HEADLESS: '1' },
  });
  const statuses: Status[] = [];
  let output = '';
  child.stdout.on('data', chunk => {
    output += String(chunk);
    while (output.includes('\n')) {
      const index = output.indexOf('\n');
      statuses.push(JSON.parse(output.slice(0, index)) as Status);
      output = output.slice(index + 1);
    }
  });
  const waitStatus = async (requestId: string, phase: string): Promise<void> => {
    for (let count = 0; count < 1_000; count++) {
      if (statuses.some(item => item.requestId === requestId && item.phase === phase)) return;
      if (child.exitCode !== null) throw Error('controller exited early');
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw Error(`missing ${phase}`);
  };
  const send = (value: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  try {
    await waitStatus('startup', 'ready');
    const taskId = randomUUID();
    send({ type: 'start_fill', requestId: taskId, url,
      fieldLabel: 'Find invoice', value: 'fixture-123',
      command: { type: 'command', protocolVersion: '2.0',
        messageId: randomUUID(), taskId, taskEpoch: 1, goalRevision: 1,
        source: 'text', mode: 'command', utteranceId: randomUUID(),
        utteranceRevision: 1, text: `Fill Find invoice on ${url} with supplied text`,
        isFinal: true, createdAt: new Date().toISOString(),
        originSurface: { adapter: 'native', surfaceId: 'systemone-panel',
          appBundleId: 'com.aurium.systemone.dev', windowId: 'command-panel',
          contentRevision: taskId } } });
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([requested, new Promise((_, reject) => {
        requestTimer = setTimeout(() => reject(Error('navigation request missing')), 5_000);
      })]);
    } finally { if (requestTimer) clearTimeout(requestTimer); }
    const stopId = randomUUID();
    send({ type: 'stop', requestId: stopId, targetRequestId: taskId });
    await waitStatus(stopId, 'uncertain');
    assert.equal(statuses.some(item => item.requestId === taskId
      && item.phase === 'verified_dom_fill'), false);
    const tooEarly = randomUUID();
    send({ type: 'start_fill', requestId: tooEarly, url,
      fieldLabel: 'Find invoice', value: 'another-value', command: {} });
    await waitStatus(tooEarly, 'busy');
    releasePage?.();
    await waitStatus(taskId, 'blocked_recovery');
    child.stdin.end();
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
  } finally {
    releasePage?.();
    if (child.exitCode === null) child.kill('SIGTERM');
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
