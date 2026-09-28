import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const extensionId = 'a'.repeat(32);
const binding = {
  grantId: 'grant-1', extensionId, profileInstallId: 'profile-1',
  workerSessionId: 'worker-1', portSessionId: 'port-1',
  tabId: 8, windowId: 2, frameId: 0, documentId: 'document-1',
  origin: 'https://example.test', url: 'https://example.test/account',
  connected: false,
};

test('controller private pipe accepts one scoped Chrome read, then revokes on replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'systemone-chrome-pipe-'));
  const source = fileURLToPath(new URL('../src/native-managed-controller.ts', import.meta.url));
  const child = spawn(process.execPath, [source, join(root, 'attempts.sqlite')],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const messages: Record<string, unknown>[] = [];
  let output = '';
  child.stdout.on('data', chunk => {
    output += String(chunk);
    while (output.includes('\n')) {
      const index = output.indexOf('\n');
      messages.push(JSON.parse(output.slice(0, index)) as Record<string, unknown>);
      output = output.slice(index + 1);
    }
  });
  function send(value: Record<string, unknown>) {
    child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  function sendChrome(payload: Record<string, unknown>) {
    send({ type: 'chrome_port_message', connectionId: 'connection-1',
      base64: Buffer.from(JSON.stringify(payload)).toString('base64') });
  }
  async function waitFor(predicate: () => boolean) {
    for (let count = 0; count < 1_000; count++) {
      if (predicate()) return;
      if (child.exitCode !== null) throw new Error('controller exited early');
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error('Chrome controller stage was not reached');
  }
  try {
    await waitFor(() => messages.some(message => message.type === 'status'
      && message.requestId === 'startup'));
    send({ type: 'chrome_port_open', connectionId: 'connection-1', extensionId });
    sendChrome({ type: 'hello', challenge: 'challenge-1', binding });
    await waitFor(() => messages.filter(message => message.type === 'chrome_port_send').length === 2);
    const outgoing = messages.filter(message => message.type === 'chrome_port_send');
    assert.equal((outgoing[0]?.payload as Record<string, unknown>).type, 'hello_ack');
    assert.equal((outgoing[1]?.payload as Record<string, unknown>).type, 'observe');
    const requestId = (outgoing[1]?.payload as Record<string, unknown>).requestId;
    sendChrome({ type: 'observation', requestId,
        binding: { ...binding, connected: true },
        snapshot: { title: 'Synthetic account', url: binding.url,
          elements: [{ role: 'button', label: 'Open', disabled: false }] } });
    await waitFor(() => messages.some(message => message.type === 'chrome_observation'));
    const observed = messages.find(message => message.type === 'chrome_observation')!;
    assert.equal(observed.grantId, 'grant-1');
    assert.equal(observed.url, binding.url);
    assert.equal((observed.elements as unknown[]).length, 1);
    sendChrome({ type: 'observation', requestId,
        binding: { ...binding, connected: true },
        snapshot: { title: 'Synthetic account', url: binding.url,
          elements: [] } });
    await waitFor(() => messages.some(message => message.type === 'chrome_port_close'));
    assert.equal(messages.some(message => message.type === 'native_worker_request'), false);
    send({ type: 'chrome_port_open', connectionId: 'connection-2', extensionId });
    const duplicate = '{"type":"hello","type":"hello","challenge":"c"}';
    send({ type: 'chrome_port_message', connectionId: 'connection-2',
      base64: Buffer.from(duplicate).toString('base64') });
    await waitFor(() => messages.filter(message => message.type === 'chrome_port_close')
      .some(message => message.connectionId === 'connection-2'));
    child.stdin.end();
    const exit = await new Promise<number | null>(resolve => child.once('exit', resolve));
    assert.equal(exit, 0);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});
