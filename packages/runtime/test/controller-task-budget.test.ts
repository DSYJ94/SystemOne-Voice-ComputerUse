import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AttemptJournal } from '../src/attempt-journal.ts';
import { NativeManagedController } from '../src/native-managed-controller.ts';
import { NativeFieldPipeWorker } from '../src/native-field-pipe-worker.ts';
import type { JSONValue } from '../../protocol/src/json.ts';

for (const expireAt of ['prepare', 'commit'] as const) {
  test(`controller reports a budget pause after ${expireAt}, never success`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'systemone-controller-budget-'));
    let now = 1000;
    const journal = new AttemptJournal(join(root, 'attempts.sqlite'), () => now);
    let commits = 0;
    let worker!: NativeFieldPipeWorker;
    worker = new NativeFieldPipeWorker(message => {
      if (message.type !== 'native_worker_request') return;
      let result: JSONValue;
      switch (message.operation) {
        case 'observe': result = { observationId: 'observation-1', scopeRef: 'fixture-only',
          bundleId: 'com.aurium.systemone.fixture', complete: true,
          controls: [{ id: 'field-1', role: 'AXTextField', label: 'Fixture Name',
            enabled: true, secure: false, canSetValue: true }] }; break;
        case 'prepare':
          if (expireAt === 'prepare') now += 300_000;
          result = { kind: 'ready', preparationRef: 'preparation-1' }; break;
        case 'commit':
          commits++;
          if (expireAt === 'commit') now += 300_000;
          result = 'verified'; break;
        case 'stop': result = true; break;
        default: throw new Error(`unexpected synthetic operation ${message.operation}`);
      }
      queueMicrotask(() => worker.receive({ type: 'native_worker_reply',
        requestId: message.requestId!, operation: message.operation!, result }));
    });
    const phases: string[] = [];
    let settled!: () => void;
    const finished = new Promise<void>(resolve => { settled = resolve; });
    const controller = new NativeManagedController(journal, (_requestId, phase) => {
      phases.push(phase);
      if (phase === 'ready') settled();
    }, true, worker);
    const requestId = 'budget-task';
    const bundleId = 'com.aurium.systemone.fixture';
    const command = { type: 'command', protocolVersion: '2.0', messageId: 'command-1',
      taskId: requestId, taskEpoch: 1, goalRevision: 1, source: 'text', mode: 'command',
      utteranceId: 'utterance-1', utteranceRevision: 1,
      text: `Fill Fixture Name in ${bundleId} with text: fixture-123`,
      isFinal: true, createdAt: new Date().toISOString(),
      originSurface: { adapter: 'native', surfaceId: 'systemone-panel',
        appBundleId: 'com.aurium.systemone.dev', windowId: 'command-panel',
        contentRevision: requestId } };
    try {
      controller.receive(Buffer.from(JSON.stringify({ type: 'start_native_fill', requestId,
        bundleId, fieldLabel: 'Fixture Name', value: 'fixture-123', command })));
      await finished;
      assert.equal(phases.includes('paused_budget'), true);
      assert.equal(phases.some(phase => phase.startsWith('verified') || phase === 'already_matched'), false);
      assert.equal(journal.getTaskState(requestId), 'paused');
      assert.equal(commits, expireAt === 'prepare' ? 0 : 1);
      if (expireAt === 'commit') {
        assert.equal(journal.attemptsForTask(requestId)[0]?.outcome?.effectStatus, 'applied');
      }
    } finally {
      await controller.close();
      worker.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
