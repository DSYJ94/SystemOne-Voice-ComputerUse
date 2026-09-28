import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { startPortalFixture } from '../../fixtures/portal.ts';
import { AttemptJournal } from '../src/attempt-journal.ts';

test('controller admits exact managed link destination and keeps arrival distinct from OPEN',
  async () => {
    const portal = await startPortalFixture();
    const root = mkdtempSync(join(tmpdir(), 'systemone-managed-navigation-'));
    const journalPath = join(root, 'attempts.sqlite');
    const source = fileURLToPath(new URL('../src/native-managed-controller.ts', import.meta.url));
    const child = spawn(process.execPath, [source, journalPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SYSTEMONE_MANAGED_HEADLESS: '1' },
    });
    const statuses: Array<{ requestId: string; phase: string }> = [];
    let output = '';
    child.stdout.on('data', chunk => {
      output += String(chunk);
      while (output.includes('\n')) {
        const index = output.indexOf('\n');
        const item = JSON.parse(output.slice(0, index)) as
          { type: string; requestId?: string; phase?: string };
        output = output.slice(index + 1);
        if (item.type === 'status' && item.requestId && item.phase) {
          statuses.push({ requestId: item.requestId, phase: item.phase });
        }
      }
    });
    const wait = async (requestId: string, phase: string) => {
      for (let count = 0; count < 500; count++) {
        if (statuses.some(item => item.requestId === requestId
          && item.phase === phase)) return;
        if (child.exitCode !== null) throw Error('controller exited early');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw Error(`missing ${phase}`);
    };
    const send = (taskId: string, destinationUrl: string) => {
      const url = `${portal.url}/`;
      const linkLabel = 'Browse all invoices';
      const command = {
        type: 'command', protocolVersion: '2.0', messageId: randomUUID(),
        taskId, taskEpoch: 1, goalRevision: 1, source: 'text',
        mode: 'command', utteranceId: randomUUID(), utteranceRevision: 1,
        text: `Navigate via ${linkLabel} on ${url} to ${destinationUrl}`,
        isFinal: true, createdAt: new Date().toISOString(),
        originSurface: { adapter: 'native', surfaceId: 'systemone-panel',
          appBundleId: 'com.aurium.systemone.dev', windowId: 'command-panel',
          contentRevision: taskId },
      };
      child.stdin.write(`${JSON.stringify({ type: 'start_navigate',
        requestId: taskId, url, linkLabel, destinationUrl, command })}\n`);
    };
    try {
      await wait('startup', 'ready');
      const wrong = randomUUID();
      send(wrong, `${portal.url}/invoices/INV-104`);
      await wait(wrong, 'unsupported');
      await wait(wrong, 'ready');
      assert.equal(portal.requestCount('/invoices'), 0);
      assert.equal(portal.requestCount('/invoices/INV-104'), 0);

      const right = randomUUID();
      send(right, `${portal.url}/invoices`);
      await wait(right, 'verified_navigation');
      assert.equal(portal.requestCount('/invoices'), 1);
      assert.equal(portal.requestCount('/invoices/INV-104'), 0);
      const stopId = randomUUID();
      child.stdin.write(`${JSON.stringify({ type: 'stop', requestId: stopId,
        targetRequestId: right })}\n`);
      await wait(stopId, 'stopped');
      child.stdin.end();
      const exit = await new Promise<number | null>(resolve => child.once('exit', resolve));
      assert.equal(exit, 0);
      const journal = new AttemptJournal(journalPath);
      try {
        assert.equal(journal.getTaskState(right), 'completed');
        assert.equal(journal.attemptsForTask(right).length, 1);
        assert.equal(journal.attemptsForTask(right)[0]?.outcome?.verification,
          'matched');
        assert.equal(journal.getTaskState(wrong), undefined);
      } finally { journal.close(); }
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      await portal.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
