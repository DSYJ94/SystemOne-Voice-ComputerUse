import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createCLMHTTPTransport } from '../packages/providers/src/clm-http-transport.ts';
import { runJevBenchmark } from '../packages/providers/src/jev-benchmark.ts';
import { JEV_ENDPOINT, JEV_MODEL } from '../packages/providers/src/jev-wire.ts';
import type { ProbeFixture } from '../packages/providers/src/clm-reference-probe.ts';

// Usage: node scripts/benchmark-jev.ts OUTPUT CORPUS...
// The API key comes only from the login Keychain item `systemone-jev`; it is
// never printed, logged, written to the report or passed on a command line.
const [outputPath, ...corpusPaths] = process.argv.slice(2);
const lifecycle = new AbortController();
process.once('SIGINT', () => lifecycle.abort());
try {
  if (!outputPath || existsSync(outputPath) || corpusPaths.length === 0) throw new Error('usage');
  const corpora = corpusPaths.map(path => {
    const bytes = readFileSync(path);
    return { path, sha256: createHash('sha256').update(bytes).digest('hex'),
      fixtures: JSON.parse(bytes.toString()) as ProbeFixture[] };
  });
  const apiKey = execFileSync('security', ['find-generic-password', '-s', 'systemone-jev', '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const transport = createCLMHTTPTransport({ endpoint: JEV_ENDPOINT, apiKey, timeoutMs: 30_000 });
  const fixtures = corpora.flatMap(corpus => corpus.fixtures);
  // About 2M input tokens is roughly $0.08 at the documented jev-1.13 price.
  const results = await runJevBenchmark({ fixtures, transport, maxInputTokens: 2_000_000, signal: lifecycle.signal });
  writeFileSync(outputPath, JSON.stringify({ kind: 'jev-corpus-benchmark', model: JEV_MODEL, endpoint: JEV_ENDPOINT,
    corpora: corpora.map(({ path, sha256, fixtures }) => ({ path, sha256, cases: fixtures.length })),
    results, syntheticOnly: true, noExecutionAuthority: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const valid = results.filter(result => result.status === 'valid').length;
  console.log(`${valid}/${results.length} valid Jev answers; inspect the private report. No execution authority.`);
} catch {
  console.error('Jev benchmark refused or failed; check the Keychain item, corpus paths and that the output does not exist.');
  process.exitCode = 1;
}
