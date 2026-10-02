import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseJSON } from '../packages/protocol/src/json.ts';
import { encodeCLMProviderView, decodeCLMChoice } from '../packages/providers/src/clm-wire.ts';
import { createVerifiedCLMReferenceBackend } from '../packages/providers/src/clm-reference-process.ts';
import type { CLMServingRequest } from '../packages/providers/src/clm-serving-boundary.ts';
import type { ProbeFixture } from '../packages/providers/src/clm-reference-probe.ts';

const [manifestPath, artifactRoot, pythonExecutable, device, outputPath] = process.argv.slice(2);
let backend: Awaited<ReturnType<typeof createVerifiedCLMReferenceBackend>> | undefined;
const lifecycle = new AbortController();
const cancel = () => { lifecycle.abort(); void backend?.close(); };
process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
try {
  if (!manifestPath || !artifactRoot || !pythonExecutable || !['mps', 'cuda'].includes(device ?? '')
    || !outputPath || existsSync(outputPath) || process.argv.length !== 7) throw new Error();
  const manifest = parseJSON(readFileSync(manifestPath));
  const bytes = readFileSync(new URL('../packages/providers/fixtures/clm-probe-synthetic.json', import.meta.url));
  const fixtures = JSON.parse(bytes.toString()) as ProbeFixture[];
  const started = performance.now();
  backend = await createVerifiedCLMReferenceBackend({ artifactManifest: manifest, artifactRoot,
    pythonExecutable, device: device as 'mps' | 'cuda', signal: lifecycle.signal });
  const startupMs = performance.now() - started;
  const results = [];
  for (let repetition = 0; repetition < 2; repetition++) {
    for (const fixture of fixtures) {
      const request = parseJSON(encodeCLMProviderView(fixture.providerView)) as unknown as CLMServingRequest;
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      lifecycle.signal.addEventListener('abort', interrupt, { once: true });
      if (lifecycle.signal.aborted) interrupt();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const raw = await backend.answer(request, controller.signal) as { metrics?: unknown };
        const choice = decodeCLMChoice(raw, fixture.providerView);
        results.push({ fixtureId: fixture.id, repetition, ...choice,
          expectedCandidateId: fixture.expectedCandidateId, expectedChoiceMatched: choice.choice === fixture.expectedCandidateId,
          metrics: raw.metrics ?? null });
      } finally { clearTimeout(timeout); lifecycle.signal.removeEventListener('abort', interrupt); }
    }
  }
  writeFileSync(outputPath, JSON.stringify({ kind: 'local-clm-gpu-smoke-experiment',
    artifactManifestDigest: backend.artifactManifestDigest, fixtureSha256: createHash('sha256').update(bytes).digest('hex'),
    device, startupMs, results, persistentCacheEnabled: false, noExecutionAuthority: true,
    inferenceQualified: false, fullReferenceParityQualified: false, acceptanceCorpusCompleted: false,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Six local GPU fixture requests completed; inspect latency/memory and choice results. V1 remains unqualified.');
} catch {
  console.error('Local GPU experiment refused or failed; check pins, artifacts, GPU capacity and startup configuration.');
  process.exitCode = 1;
} finally {
  await backend?.close(); process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);
}
