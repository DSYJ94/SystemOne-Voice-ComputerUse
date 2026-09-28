import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AttemptJournal } from '../src/attempt-journal.ts';

interface WorkerRequest {
  readonly type: 'native_worker_request';
  readonly requestId: string;
  readonly operation: 'observe' | 'prepare' | 'commit' | 'verify' | 'stop';
  readonly taskId: string;
  readonly [key: string]: unknown;
}

function finalCommand(taskId: string): Record<string, unknown> {
  return { type: 'command', protocolVersion: '2.0', messageId: randomUUID(),
    taskId, taskEpoch: 1, goalRevision: 1, source: 'text', mode: 'command',
    utteranceId: randomUUID(), utteranceRevision: 1,
    text: 'Fill Fixture Name in com.aurium.systemone.fixture with supplied text',
    isFinal: true, createdAt: new Date().toISOString(),
    originSurface: { adapter: 'native', surfaceId: 'systemone-panel',
      appBundleId: 'com.aurium.systemone.dev', windowId: 'command-panel',
      contentRevision: taskId } };
}

test('private pipe carries a journaled native task and fences a late result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'systemone-native-pipe-'));
  const journalPath = join(root, 'attempts.sqlite');
  const source = fileURLToPath(new URL('../src/native-managed-controller.ts', import.meta.url));
  const child = spawn(process.execPath, [source, journalPath],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const statuses: Array<{ requestId: string; phase: string }> = [];
  const operations: string[] = [];
  let pendingCommit: WorkerRequest | undefined;
  let holdCommit = false;
  let output = '';
  function send(value: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  function reply(request: WorkerRequest, result: unknown): void {
    send({ type: 'native_worker_reply', requestId: request.requestId,
      operation: request.operation, result });
  }
  child.stdout.on('data', chunk => {
    output += String(chunk);
    while (output.includes('\n')) {
      const index = output.indexOf('\n');
      const line = output.slice(0, index);
      output = output.slice(index + 1);
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.type === 'status') {
        statuses.push(message as { requestId: string; phase: string });
        continue;
      }
      assert.equal(message.type, 'native_worker_request');
      const request = message as unknown as WorkerRequest;
      operations.push(request.operation);
      switch (request.operation) {
      case 'observe':
        reply(request, { observationId: randomUUID(),
          scopeRef: `native:${randomUUID()}`,
          bundleId: 'com.aurium.systemone.fixture', complete: true,
          controls: [{ id: 'node-1', role: 'AXTextField',
            label: 'Fixture Name', enabled: true, secure: false,
            canSetValue: true }] });
        break;
      case 'prepare':
        assert.equal(request.value, 'fixture-123');
        assert.match(String(request.permitRef), /^[a-f0-9-]{36}$/);
        reply(request, { kind: 'ready', preparationRef: randomUUID() });
        break;
      case 'commit':
        if (holdCommit) pendingCommit = request;
        else reply(request, 'verified');
        break;
      case 'stop': reply(request, true); break;
      case 'verify': reply(request, true); break;
      }
    }
  });
  async function waitFor(predicate: () => boolean): Promise<void> {
    for (let count = 0; count < 1_000; count++) {
      if (predicate()) return;
      if (child.exitCode !== null) throw new Error('controller exited early');
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error('private-pipe stage was not reached');
  }
  function start(taskId: string): void {
    send({ type: 'start_native_fill', requestId: taskId,
      bundleId: 'com.aurium.systemone.fixture', fieldLabel: 'Fixture Name',
      value: 'fixture-123', command: finalCommand(taskId) });
  }
  try {
    await waitFor(() => statuses.some(s => s.requestId === 'startup'
      && s.phase === 'ready'));
    const first = randomUUID();
    start(first);
    await waitFor(() => statuses.some(s => s.requestId === first
      && s.phase === 'verified_native_fill'));
    await waitFor(() => statuses.some(s => s.requestId === first
      && s.phase === 'ready'));
    assert.deepEqual(operations.slice(0, 3), ['observe', 'prepare', 'commit']);
    holdCommit = true;
    const second = randomUUID();
    start(second);
    await waitFor(() => pendingCommit !== undefined);
    const stopId = randomUUID();
    send({ type: 'stop', requestId: stopId, targetRequestId: second });
    await waitFor(() => operations.includes('stop'));
    await waitFor(() => statuses.some(s => s.requestId === stopId
      && s.phase === 'uncertain'));
    assert.equal(statuses.some(s => s.requestId === second
      && s.phase === 'verified_native_fill'), false);
    const tooEarly = randomUUID();
    start(tooEarly);
    await waitFor(() => statuses.some(s => s.requestId === tooEarly
      && s.phase === 'busy'));
    reply(pendingCommit!, 'verified');
    await waitFor(() => statuses.some(s => s.requestId === second
      && s.phase === 'blocked_recovery'));
    const third = randomUUID();
    start(third);
    await waitFor(() => statuses.some(s => s.requestId === third
      && s.phase === 'blocked_recovery'));
    child.stdin.end();
    const exit = await new Promise<number | null>(resolve => child.once('exit', resolve));
    assert.equal(exit, 0);
    const journal = new AttemptJournal(journalPath);
    try {
      assert.equal(journal.getTaskState(first), 'completed');
      assert.equal(journal.getTaskState(second), 'cancelled');
      assert.equal(journal.attemptsForTask(second)[0]?.outcome?.verification,
        'matched');
      assert.equal(journal.getTaskState(third), undefined);
      assert.equal(journal.getTaskState(tooEarly), undefined);
    } finally { journal.close(); }
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});
