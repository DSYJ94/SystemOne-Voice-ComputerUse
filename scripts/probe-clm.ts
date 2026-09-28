import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { encodeCLMProbeRequest, probeCLM } from '../packages/providers/src/clm-reference-probe.ts';
import type { ProbeFixture, ProbeTransport } from '../packages/providers/src/clm-reference-probe.ts';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value || value.startsWith('--')) throw new Error(`missing ${name}`);
  return value;
}

function endpoint(): URL {
  if (!process.argv.includes('--allow-owned-service')) throw new Error('explicit --allow-owned-service required');
  const url = new URL(argument('--endpoint'));
  const loopback = ['127.0.0.1', '::1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.pathname !== '/v1/systemone' || url.search || url.hash || url.username || url.password ||
      (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) {
    throw new Error('endpoint must be HTTPS or loopback HTTP at /v1/systemone');
  }
  return url;
}

async function main(): Promise<void> {
  const url = endpoint();
  const fixturePath = resolve(argument('--fixtures'));
  const outputPath = resolve(argument('--output'));
  const bytes = readFileSync(fixturePath);
  if (bytes.length > 1_000_000) throw new Error('fixture file exceeds 1 MB');
  const fixtures: unknown = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(fixtures) || fixtures.length < 1 || fixtures.length > 100) {
    throw new Error('expected 1-100 synthetic fixtures');
  }
  for (const fixture of fixtures as ProbeFixture[]) encodeCLMProbeRequest(fixture);
  const key = process.env.CLM_PROBE_API_KEY;
  const transport: ProbeTransport = {
    async send(body) {
      const response = await fetch(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: Buffer.from(body),
      });
      if (!response.ok) throw new Error(`CLM HTTP ${response.status}`);
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > 262_144) throw new Error('CLM response too large');
      if (!response.body) throw new Error('CLM response body missing');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 262_144) {
          await reader.cancel();
          throw new Error('CLM response too large');
        }
        chunks.push(value);
      }
      return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
    },
  };
  const results = [];
  for (const fixture of fixtures as ProbeFixture[]) results.push(await probeCLM(fixture, transport));
  const report = {
    kind: 'fixture-only-clm-reference-probe',
    sourceRevision: 'bb42c6c5bf914fd449bed2f6ca65be80602cb1f7',
    fixtureSha256: createHash('sha256').update(bytes).digest('hex'),
    endpoint: url.origin + url.pathname,
    modelAlias: 'clm-latest',
    modelArtifactIdentityVerified: false,
    tokenizerTruncationVerified: false,
    noExecutionAuthority: true,
    results,
  };
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const valid = results.filter(result => result.status === 'valid');
  const correct = valid.filter(result => result.choice === result.expectedCandidateId);
  process.stdout.write(`CLM probe: ${valid.length}/${results.length} valid, ${correct.length} expected choices; report: ${outputPath}\n`);
  if (valid.length !== results.length) process.exitCode = 1;
}

main().catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
