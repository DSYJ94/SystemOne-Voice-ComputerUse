import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { startPortalFixture } from '../../fixtures/portal.ts';
import { AttemptJournal } from '../src/attempt-journal.ts';

function command(taskId: string, url: string, valid = true) {
  return { type: 'command', protocolVersion: '2.0', messageId: randomUUID(),
    taskId, taskEpoch: 1, goalRevision: 1, source: 'text', mode: 'command',
    utteranceId: randomUUID(), utteranceRevision: 1,
    text: valid ? `Download fixture invoice INV-105 from ${url}` : 'Unbound fixture goal',
    isFinal: true, createdAt: new Date().toISOString(),
    originSurface: { adapter: 'native', surfaceId: 'systemone-panel',
      appBundleId: 'com.aurium.systemone.dev', windowId: 'command-panel',
      contentRevision: taskId } };
}

async function harness(t: { after(callback: () => void | Promise<void>): void },
  delayMs = 250) {
  const portal = await startPortalFixture({ downloadDelayMs: delayMs });
  const root = mkdtempSync(join(tmpdir(), 'systemone-portal-controller-'));
  const journalPath = join(root, 'attempts.sqlite');
  const source = fileURLToPath(new URL('../src/native-managed-controller.ts', import.meta.url));
  const child = spawn(process.execPath, [source, journalPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SYSTEMONE_MANAGED_HEADLESS: '1' },
  });
  const statuses: Array<{ requestId: string; phase: string }> = [];
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += String(bytes); });
  child.stdout.on('data', bytes => {
    buffer += String(bytes);
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.type === 'status') statuses.push(message as {
        requestId: string; phase: string });
    }
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await portal.close();
    rmSync(root, { recursive: true, force: true });
  });
  const wait = async (requestId: string, phase: string) => {
    for (let i = 0; i < 1_000; i++) {
      if (statuses.some(item => item.requestId === requestId && item.phase === phase)) return;
      if (child.exitCode !== null) throw new Error(`controller exited: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`missing ${phase}; statuses=${JSON.stringify(statuses)} stderr=${stderr}`);
  };
  const send = (value: unknown) => { child.stdin.write(`${JSON.stringify(value)}\n`); };
  const url = `${portal.url}/`;
  await wait('startup', 'ready');
  return { portal, root, journalPath, child, wait, send, url, statuses };
}

test('development controller runs the exact four-step portal workflow and saves verified bytes', async t => {
  const h = await harness(t);
  const invalid = randomUUID();
  h.send({ type: 'start_portal_workflow', requestId: invalid,
    url: h.url, command: command(invalid, h.url, false) });
  await h.wait(invalid, 'error');
  await h.wait(invalid, 'ready');
  assert.equal(h.portal.requestCount('/'), 0, 'bad command cannot launch browser');
  const taskId = randomUUID();
  h.send({ type: 'start_portal_workflow', requestId: taskId,
    url: h.url, command: command(taskId, h.url) });
  await h.wait(taskId, 'verified_portal_download');
  await h.wait(taskId, 'ready');
  const destination = join(h.root, 'fixture-output', 'INV-105.txt');
  assert.match(await readFile(destination, 'utf8'),
    /Invoice: INV-105\nTitle: April Service Statement\nAccount: Harbor Works/);
  const journal = new AttemptJournal(h.journalPath);
  try {
    assert.equal(journal.getTaskState(taskId), 'completed');
    assert.deepEqual(journal.attemptsForTask(taskId).map(item => item.candidateId),
      ['scripted-search', 'scripted-open', 'scripted-download', 'scripted-save']);
  } finally { journal.close(); }
  h.child.stdin.end();
  assert.equal((await once(h.child, 'exit'))[0], 0);
});

test('Stop during delayed download cannot report completion or save the fixture file', async t => {
  const h = await harness(t, 10_000);
  const taskId = randomUUID();
  h.send({ type: 'start_portal_workflow', requestId: taskId,
    url: h.url, command: command(taskId, h.url) });
  await h.wait(taskId, 'portal_opened');
  const journal = new AttemptJournal(h.journalPath);
  try {
    let crossed = false;
    for (let i = 0; i < 500; i++) {
      const download = journal.attemptsForTask(taskId).find(item =>
        item.candidateId === 'scripted-download');
      if (download && journal.eventKinds(download.executionId)
        .includes('dispatch_boundary')) { crossed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(crossed, true, 'download dispatch boundary was not reached');
  } finally { journal.close(); }
  const stopId = randomUUID();
  h.send({ type: 'stop', requestId: stopId, targetRequestId: taskId });
  await h.wait(stopId, 'stopped');
  await h.wait(taskId, 'blocked_recovery');
  assert.equal(h.statuses.some(item => item.requestId === taskId
    && item.phase === 'verified_portal_download'), false);
  assert.equal(existsSync(join(h.root, 'fixture-output', 'INV-105.txt')), false);
  assert.equal(h.portal.requestCount('/downloads/INV-105'), 0);
  h.child.stdin.end();
  assert.equal((await once(h.child, 'exit'))[0], 0);
  const source = fileURLToPath(new URL('../src/native-managed-controller.ts', import.meta.url));
  const restarted = spawn(process.execPath, [source, h.journalPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SYSTEMONE_MANAGED_HEADLESS: '1' },
  });
  try {
    let output = '';
    let startup: string | undefined;
    restarted.stdout.on('data', bytes => {
      output += String(bytes);
      while (output.includes('\n')) {
        const index = output.indexOf('\n');
        const message = JSON.parse(output.slice(0, index)) as Record<string, unknown>;
        output = output.slice(index + 1);
        if (message.type === 'status' && message.requestId === 'startup') {
          startup = message.phase as string;
        }
      }
    });
    for (let i = 0; i < 500 && startup === undefined; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(startup, 'blocked_recovery');
    restarted.stdin.end();
    assert.equal((await once(restarted, 'exit'))[0], 0);
  } finally {
    if (restarted.exitCode === null) restarted.kill('SIGTERM');
  }
});
