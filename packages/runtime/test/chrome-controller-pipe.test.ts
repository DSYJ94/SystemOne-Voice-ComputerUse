import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

for (const sessionLoss of [false, true]) test(sessionLoss
  ? 'controller private pipe revokes Chrome reads on session loss and refuses stale observations'
  : 'controller private pipe accepts one scoped Chrome read, then revokes on replay', async () => {
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
        snapshot: { observationId: 'observation-1', title: 'Synthetic account',
          url: binding.url, complete: true,
          elements: [{ id: 'observation-1:0', role: 'button',
            label: 'Open', disabled: false, editable: false }] } });
    await waitFor(() => messages.some(message => message.type === 'chrome_observation'));
    const observed = messages.find(message => message.type === 'chrome_observation')!;
    assert.equal(observed.grantId, 'grant-1');
    assert.equal(observed.url, binding.url);
    assert.equal((observed.elements as unknown[]).length, 1);
    if (sessionLoss) {
      send({ type: 'host_lifecycle', requestId: randomUUID(), sequence: 1,
        sleeping: false, sessionActive: false });
      await waitFor(() => messages.some(message => message.type === 'chrome_port_close'));
    }
    sendChrome({ type: 'observation', requestId,
        binding: { ...binding, connected: true },
        snapshot: { observationId: 'observation-1', title: 'Synthetic account',
          url: binding.url, complete: true, elements: [] } });
    await waitFor(() => messages.some(message => message.type === 'chrome_port_close'));
    assert.equal(messages.filter(message => message.type === 'chrome_observation').length, 1);
    assert.equal(messages.some(message => message.type === 'native_worker_request'), false);
    if (sessionLoss) {
      send({ type: 'chrome_port_open', connectionId: 'held-port', extensionId });
      await waitFor(() => messages.some(message => message.type === 'chrome_port_close'
        && message.connectionId === 'held-port'));
      send({ type: 'host_lifecycle', requestId: randomUUID(), sequence: 2,
        sleeping: false, sessionActive: true });
    }
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

test('controller pipe admits one loopback Chrome fill after fresh observation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'systemone-chrome-fill-pipe-'));
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
  const send = (value: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  const sendChrome = (payload: Record<string, unknown>) => {
    send({ type: 'chrome_port_message', connectionId: 'connection-1',
      base64: Buffer.from(JSON.stringify(payload)).toString('base64') });
  };
  async function waitFor(predicate: () => boolean) {
    for (let count = 0; count < 1_000; count++) {
      if (predicate()) return;
      if (child.exitCode !== null) throw new Error('controller exited early');
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error('Chrome fill controller stage was not reached');
  }
  const scoped = { ...binding, origin: 'http://127.0.0.1:49081',
    url: 'http://127.0.0.1:49081/' };
  try {
    await waitFor(() => messages.some(message => message.requestId === 'startup'));
    send({ type: 'chrome_port_open', connectionId: 'connection-1', extensionId });
    sendChrome({ type: 'hello', challenge: 'challenge-1', binding: scoped });
    await waitFor(() => messages.filter(message => message.type === 'chrome_port_send').length >= 2);
    const first = messages.filter(message => message.type === 'chrome_port_send')[1]!
      .payload as Record<string, unknown>;
    const observed = (requestId: unknown, observationId: string) => ({
      type: 'observation', requestId, binding: { ...scoped, connected: true },
      snapshot: { observationId, title: 'Invoice Portal Fixture',
        url: scoped.url, complete: true,
        elements: [{ id: `${observationId}:0`, role: 'input',
          label: 'Find invoice', disabled: false, editable: true }] },
    });
    sendChrome(observed(first.requestId, 'observation-1'));
    await waitFor(() => messages.some(message => message.type === 'chrome_observation'));
    const taskId = randomUUID();
    send({ type: 'start_chrome_fill', requestId: taskId,
      connectionId: 'connection-1', grantId: scoped.grantId,
      fieldLabel: 'Find invoice', value: 'INV-104',
      command: { type: 'command', protocolVersion: '2.0',
        messageId: randomUUID(), taskId, taskEpoch: 1, goalRevision: 1,
        source: 'text', mode: 'command', utteranceId: randomUUID(),
        utteranceRevision: 1,
        text: `Fill Find invoice in existing Chrome tab ${scoped.url} with text: INV-104`,
        isFinal: true, createdAt: new Date().toISOString(),
        originSurface: { adapter: 'native', surfaceId: 'systemone-panel',
          appBundleId: 'com.aurium.systemone.dev', windowId: 'command-panel',
          contentRevision: taskId } } });
    await waitFor(() => messages.filter(message => message.type === 'chrome_port_send').length >= 3);
    const second = messages.filter(message => message.type === 'chrome_port_send')[2]!
      .payload as Record<string, unknown>;
    assert.equal(second.type, 'observe');
    sendChrome(observed(second.requestId, 'observation-2'));
    await waitFor(() => messages.filter(message => message.type === 'chrome_port_send').length >= 4);
    const action = messages.filter(message => message.type === 'chrome_port_send')[3]!
      .payload as Record<string, unknown>;
    assert.equal(action.type, 'action');
    assert.equal(action.candidateId, 'observation-2:0');
    sendChrome({ type: 'action_result', requestId: action.requestId,
      permitRef: action.permitRef, binding: { ...scoped, connected: true },
      status: 'matched' });
    await waitFor(() => messages.some(message => message.type === 'status'
      && message.requestId === taskId && message.phase === 'verified_chrome_dom_fill'));
    await waitFor(() => messages.some(message => message.type === 'status'
      && message.requestId === taskId && message.phase === 'ready'));
    const secondTaskId = randomUUID();
    const before = messages.filter(message => message.type === 'chrome_port_send').length;
    send({ type: 'start_chrome_fill', requestId: secondTaskId,
      connectionId: 'connection-1', grantId: scoped.grantId,
      fieldLabel: 'Find invoice', value: 'INV-105',
      command: { type: 'command', protocolVersion: '2.0',
        messageId: randomUUID(), taskId: secondTaskId, taskEpoch: 1, goalRevision: 1,
        source: 'text', mode: 'command', utteranceId: randomUUID(),
        utteranceRevision: 1,
        text: `Fill Find invoice in existing Chrome tab ${scoped.url} with text: INV-105`,
        isFinal: true, createdAt: new Date().toISOString(),
        originSurface: { adapter: 'native', surfaceId: 'systemone-panel',
          appBundleId: 'com.aurium.systemone.dev', windowId: 'command-panel',
          contentRevision: secondTaskId } } });
    await waitFor(() => messages.filter(message => message.type === 'chrome_port_send').length > before);
    const secondObserve = messages.filter(message => message.type === 'chrome_port_send')[before]!
      .payload as Record<string, unknown>;
    sendChrome(observed(secondObserve.requestId, 'observation-3'));
    await waitFor(() => messages.filter(message => message.type === 'chrome_port_send').length > before + 1);
    const secondAction = messages.filter(message => message.type === 'chrome_port_send')[before + 1]!
      .payload as Record<string, unknown>;
    assert.equal(secondAction.type, 'action');
    const stopId = randomUUID();
    send({ type: 'stop', requestId: stopId, targetRequestId: secondTaskId });
    await waitFor(() => messages.filter(message => message.type === 'chrome_port_send').length > before + 2);
    const stop = messages.filter(message => message.type === 'chrome_port_send')[before + 2]!
      .payload as Record<string, unknown>;
    assert.equal(stop.type, 'stop_action');
    sendChrome({ type: 'stop_ack', requestId: stop.requestId,
      targetRequestId: secondAction.requestId, grantId: scoped.grantId,
      workerFenced: true });
    await waitFor(() => messages.some(message => message.type === 'status'
      && message.requestId === stopId && message.phase === 'uncertain'));
    assert.equal(messages.some(message => message.type === 'status'
      && message.requestId === secondTaskId && message.phase === 'verified_chrome_dom_fill'), false);
    const tooEarly = randomUUID();
    send({ type: 'start_chrome_fill', requestId: tooEarly,
      connectionId: 'connection-1', grantId: scoped.grantId,
      fieldLabel: 'Find invoice', value: 'INV-106', command: {} });
    await waitFor(() => messages.some(message => message.type === 'status'
      && message.requestId === tooEarly && message.phase === 'busy'));
    sendChrome({ type: 'action_result', requestId: secondAction.requestId,
      permitRef: secondAction.permitRef, binding: { ...scoped, connected: true },
      status: 'matched' });
    await waitFor(() => messages.some(message => message.type === 'status'
      && message.requestId === secondTaskId && message.phase === 'blocked_recovery'));
    child.stdin.end();
    const exit = await new Promise<number | null>(resolve => child.once('exit', resolve));
    assert.equal(exit, 0);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});
