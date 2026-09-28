import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';

test('probe CLI uses only the explicit loopback endpoint and records raw fixture replies', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'systemone-clm-probe-'));
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/systemone');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const keys = Object.keys(body.questions.next_action.criteria);
    const probabilities = Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 0.8 : 0.2 / (keys.length - 1)]));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ model: 'clm-latest', answers: { next_action: {
      type: 'choice', choice: keys[0], confidence: 0.6, probabilities,
    } }, usage: { billing_units: 1, input_tokens: 123, output_tokens: 0 } }));
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const output = join(directory, 'report.json');
    const child = spawn(process.execPath, [
      'scripts/probe-clm.ts', '--allow-owned-service', '--endpoint',
      `http://127.0.0.1:${address.port}/v1/systemone`,
      '--fixtures', 'packages/providers/fixtures/clm-probe-synthetic.json',
      '--output', output,
    ], { cwd: new URL('../../../', import.meta.url), stdio: 'ignore' });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.equal(requests, 3);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.deepEqual(report.results.map((result: { status: string }) => result.status), ['valid', 'valid', 'valid']);
    assert.deepEqual(report.results.map((result: { matchesExpected: boolean }) => result.matchesExpected),
      [true, true, false]);
    assert.equal(report.results[0].rawOutput.usage.input_tokens, 123);
    assert.equal(report.modelArtifactIdentityVerified, false);
    assert.equal(report.tokenizerTruncationVerified, false);
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
