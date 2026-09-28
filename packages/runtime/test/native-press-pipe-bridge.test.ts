import assert from 'node:assert/strict';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AttemptJournal } from '../src/attempt-journal.ts';
import { canonicalJSON } from '../../protocol/src/json.ts';
import type { JSONValue } from '../../protocol/src/json.ts';

interface WorkerRequest {
  readonly type: 'native_worker_request';
  readonly requestId: string;
  readonly operation: string;
  readonly taskId: string;
  readonly [key: string]: unknown;
}

function command(taskId: string): Record<string, unknown> {
  return { type: 'command', protocolVersion: '2.0', messageId: randomUUID(),
    taskId, taskEpoch: 1, goalRevision: 1, source: 'text', mode: 'command',
    utteranceId: randomUUID(), utteranceRevision: 1,
    text: 'Navigate synthetic fixture to Documents', isFinal: true,
    createdAt: new Date().toISOString(),
    originSurface: { adapter: 'native', surfaceId: 'systemone-panel',
      appBundleId: 'com.aurium.systemone.dev', windowId: 'command-panel',
      contentRevision: taskId } };
}

test('controller child journals signed native press, verifies, and fences late Stop',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'systemone-native-press-pipe-'));
    const journalPath = join(root, 'attempts.sqlite');
    const source = fileURLToPath(new URL('../src/native-managed-controller.ts',
      import.meta.url));
    const child = spawn(process.execPath, [source, journalPath],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    const statuses: Array<{ requestId: string; phase: string }> = [];
    const operations: string[] = [];
    let publicKey: string | undefined;
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
        if (message.type === 'native_permit_key') {
          assert.equal(publicKey, undefined);
          publicKey = String(message.publicKey);
          continue;
        }
        assert.equal(message.type, 'native_worker_request');
        const request = message as unknown as WorkerRequest;
        operations.push(request.operation);
        switch (request.operation) {
        case 'observe_press':
          assert.equal(request.bundleId, 'com.aurium.systemone.fixture');
          reply(request, { observationId: randomUUID(),
            scopeRef: `native:${randomUUID()}`,
            bundleId: 'com.aurium.systemone.fixture', complete: true,
            windowTitles: ['SystemOne Fixture'],
            controls: [{ id: 'documents-node', role: 'AXButton',
              label: 'Documents', enabled: true, secure: false,
              canPress: true }] });
          break;
        case 'prepare_press':
          assert.equal(request.expectedWindowTitle,
            'SystemOne Fixture — Documents');
          assert.equal(request.policyRevision, 'native-ax-press-fixture-v1');
          assert.match(String(request.actionDigest), /^[a-f0-9]{64}$/);
          reply(request, { kind: 'ready', preparationRef: randomUUID() });
          break;
        case 'commit_press': {
          assert.ok(publicKey);
          const claim: JSONValue = { domain: 'systemone.native.commit.v1',
            permit: request.permit as JSONValue,
            preparationRef: String(request.preparationRef),
            expiresAtMs: Number(request.expiresAtMs) };
          assert.equal((request.permit as Record<string, unknown>).policyRevision,
            'native-ax-press-fixture-v1');
          assert.equal(verify(null, Buffer.from(canonicalJSON(claim)),
            createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey },
              format: 'jwk' }),
            Buffer.from(String(request.signature), 'base64url')), true);
          if (holdCommit) pendingCommit = request;
          else reply(request, 'returned_unverified');
          break;
        }
        case 'verify_press':
          assert.equal(request.expectedWindowTitle,
            'SystemOne Fixture — Documents');
          reply(request, true);
          break;
        case 'stop': reply(request, true); break;
        default: assert.fail(`unexpected worker operation ${request.operation}`);
        }
      }
    });
    async function waitFor(predicate: () => boolean): Promise<void> {
      for (let count = 0; count < 1_000; count++) {
        if (predicate()) return;
        if (child.exitCode !== null) throw new Error('controller exited early');
        await new Promise(resolve => setTimeout(resolve, 2));
      }
      throw new Error('native press pipe stage not reached');
    }
    function start(taskId: string): void {
      send({ type: 'start_native_press', requestId: taskId,
        bundleId: 'com.aurium.systemone.fixture', folderName: 'Documents',
        expectedWindowTitle: 'SystemOne Fixture — Documents',
        command: command(taskId) });
    }
    try {
      await waitFor(() => statuses.some(s => s.requestId === 'startup'
        && s.phase === 'ready'));
      const first = randomUUID();
      start(first);
      await waitFor(() => statuses.some(s => s.requestId === first
        && s.phase === 'verified_native_navigation'));
      await waitFor(() => statuses.some(s => s.requestId === first
        && s.phase === 'ready'));
      assert.deepEqual(operations.slice(0, 4),
        ['observe_press', 'prepare_press', 'commit_press', 'verify_press']);
      holdCommit = true;
      const second = randomUUID();
      start(second);
      await waitFor(() => pendingCommit !== undefined);
      const stopId = randomUUID();
      send({ type: 'stop', requestId: stopId, targetRequestId: second });
      await waitFor(() => statuses.some(s => s.requestId === stopId
        && s.phase === 'uncertain'));
      reply(pendingCommit!, 'returned_unverified');
      await waitFor(() => statuses.some(s => s.requestId === second
        && s.phase === 'blocked_recovery'));
      assert.equal(statuses.some(s => s.requestId === second
        && s.phase === 'verified_native_navigation'), false);
      const third = randomUUID();
      start(third);
      await waitFor(() => statuses.some(s => s.requestId === third
        && s.phase === 'blocked_recovery'));
      child.stdin.end();
      const exit = await new Promise<number | null>(resolve => child.once('exit',
        resolve));
      assert.equal(exit, 0);
      const journal = new AttemptJournal(journalPath);
      try {
        assert.equal(journal.getTaskState(first), 'completed');
        assert.equal(journal.attemptsForTask(first)[0]?.outcome?.verification,
          'matched');
        assert.equal(journal.getTaskState(second), 'cancelled');
        assert.equal(journal.attemptsForTask(second)[0]?.outcome?.effectStatus,
          'unknown');
        assert.equal(journal.getTaskState(third), undefined);
      } finally { journal.close(); }
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      rmSync(root, { recursive: true, force: true });
    }
  });

test('controller child keeps LOCATE and OPEN tasks across separately signed presses',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'systemone-native-locate-pipe-'));
    const journalPath = join(root, 'attempts.sqlite');
    const source = fileURLToPath(new URL('../src/native-managed-controller.ts',
      import.meta.url));
    const child = spawn(process.execPath, [source, journalPath],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    const statuses: Array<{ requestId: string; phase: string }> = [];
    const operations: string[] = [];
    const signedCandidates: string[] = [];
    let publicKey: string | undefined;
    let title = 'SystemOne Fixture';
    let currentCandidate = '';
    let output = '';
    function send(value: Record<string, unknown>): void {
      child.stdin.write(JSON.stringify(value) + '\n');
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
        if (message.type === 'native_permit_key') {
          publicKey = String(message.publicKey);
          continue;
        }
        assert.equal(message.type, 'native_worker_request');
        const request = message as unknown as WorkerRequest;
        operations.push(request.operation);
        switch (request.operation) {
        case 'observe_press':
          reply(request, { observationId: randomUUID(),
            scopeRef: 'native:stable-fixture-scope',
            bundleId: 'com.aurium.systemone.fixture', complete: true,
            windowTitles: [title],
            controls: [
              { id: 'documents-node', role: 'AXButton', label: 'Documents',
                enabled: true, secure: false, canPress: true },
              ...(title === 'SystemOne Fixture — Documents'
                ? [{ id: 'file-node', role: 'AXButton', label: 'Budget.xlsx',
                  enabled: true, secure: false, canPress: true }] : []),
              ...(title === 'SystemOne Fixture — Documents — Budget.xlsx selected'
                ? [{ id: 'open-node', role: 'AXButton',
                    label: 'Open selected file', enabled: true,
                    secure: false, canPress: true }] : []),
            ] });
          break;
        case 'prepare_press':
          currentCandidate = String(request.candidateId);
          assert.equal(currentCandidate === 'documents-node'
            ? request.expectedWindowTitle === 'SystemOne Fixture — Documents'
            : currentCandidate === 'file-node'
              ? request.expectedWindowTitle
                === 'SystemOne Fixture — Documents — Budget.xlsx selected'
              : currentCandidate === 'open-node'
                && request.expectedWindowTitle
                  === 'SystemOne Fixture — Documents — Budget.xlsx opened',
            true);
          reply(request, { kind: 'ready', preparationRef: randomUUID() });
          break;
        case 'commit_press': {
          assert.ok(publicKey);
          const claim: JSONValue = { domain: 'systemone.native.commit.v1',
            permit: request.permit as JSONValue,
            preparationRef: String(request.preparationRef),
            expiresAtMs: Number(request.expiresAtMs) };
          assert.equal(verify(null, Buffer.from(canonicalJSON(claim)),
            createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey },
              format: 'jwk' }),
            Buffer.from(String(request.signature), 'base64url')), true);
          signedCandidates.push(String(
            (request.permit as Record<string, unknown>).candidateId));
          title = currentCandidate === 'documents-node'
            ? 'SystemOne Fixture — Documents'
            : currentCandidate === 'file-node'
              ? 'SystemOne Fixture — Documents — Budget.xlsx selected'
              : 'SystemOne Fixture — Documents — Budget.xlsx opened';
          reply(request, 'returned_unverified');
          break;
        }
        case 'verify_press':
          reply(request, title === request.expectedWindowTitle);
          break;
        case 'stop': reply(request, true); break;
        default: assert.fail('unexpected worker operation ' + request.operation);
        }
      }
    });
    async function waitFor(predicate: () => boolean): Promise<void> {
      for (let count = 0; count < 1_000; count++) {
        if (predicate()) return;
        if (child.exitCode !== null) throw new Error('controller exited early');
        await new Promise(resolve => setTimeout(resolve, 2));
      }
      throw new Error('native locate pipe stage not reached');
    }
    try {
      await waitFor(() => statuses.some(s => s.requestId === 'startup'
        && s.phase === 'ready'));
      const taskId = randomUUID();
      send({ type: 'start_native_locate', requestId: taskId,
        bundleId: 'com.aurium.systemone.fixture', folderName: 'Documents',
        fileName: 'Budget.xlsx',
        expectedWindowTitle:
          'SystemOne Fixture — Documents — Budget.xlsx selected',
        command: { ...command(taskId),
          text: 'Locate synthetic fixture file Documents/Budget.xlsx' } });
      await waitFor(() => statuses.some(s => s.requestId === taskId
        && s.phase === 'verified_native_locate'));
      assert.equal(title, 'SystemOne Fixture — Documents — Budget.xlsx selected');
      assert.deepEqual(signedCandidates, ['documents-node', 'file-node']);
      assert.deepEqual(operations.slice(0, 8),
        ['observe_press', 'prepare_press', 'commit_press', 'verify_press',
          'observe_press', 'prepare_press', 'commit_press', 'verify_press']);
      await waitFor(() => statuses.some(s => s.requestId === taskId
        && s.phase === 'ready'));
      title = 'SystemOne Fixture';
      const openTaskId = randomUUID();
      send({ type: 'start_native_open', requestId: openTaskId,
        bundleId: 'com.aurium.systemone.fixture', folderName: 'Documents',
        fileName: 'Budget.xlsx',
        expectedWindowTitle:
          'SystemOne Fixture — Documents — Budget.xlsx opened',
        command: { ...command(openTaskId),
          text: 'Open synthetic fixture file Documents/Budget.xlsx' } });
      await waitFor(() => statuses.some(s => s.requestId === openTaskId
        && s.phase === 'verified_native_open'));
      assert.equal(title, 'SystemOne Fixture — Documents — Budget.xlsx opened');
      assert.deepEqual(signedCandidates,
        ['documents-node', 'file-node', 'documents-node', 'file-node', 'open-node']);
      assert.deepEqual(operations.slice(8, 20),
        ['observe_press', 'prepare_press', 'commit_press', 'verify_press',
          'observe_press', 'prepare_press', 'commit_press', 'verify_press',
          'observe_press', 'prepare_press', 'commit_press', 'verify_press']);
      child.stdin.end();
      const exit = await new Promise<number | null>(resolve => child.once('exit',
        resolve));
      assert.equal(exit, 0);
      const journal = new AttemptJournal(journalPath);
      try {
        assert.equal(journal.getTaskState(taskId), 'completed');
        const attempts = journal.attemptsForTask(taskId);
        assert.equal(attempts.length, 2);
        assert.ok(attempts.every(attempt =>
          attempt.outcome?.verification === 'matched'));
        assert.equal(journal.getTaskState(openTaskId), 'completed');
        const openAttempts = journal.attemptsForTask(openTaskId);
        assert.equal(openAttempts.length, 3);
        assert.ok(openAttempts.every(attempt =>
          attempt.outcome?.verification === 'matched'));
      } finally { journal.close(); }
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      rmSync(root, { recursive: true, force: true });
    }
  });
