import { performance } from 'node:perf_hooks';
import { ContractError } from '../../protocol/src/json.ts';
import type { CLMTransport } from './clm-decision-client.ts';
import type { ProbeFixture } from './clm-reference-probe.ts';
import { decodeJevChoice, encodeJevProviderView, JEV_MODEL } from './jev-wire.ts';
import type { JevChoice } from './jev-wire.ts';

export interface JevBenchmarkResult {
  readonly fixtureId: string;
  readonly order: 'offered' | 'reversed';
  readonly status: 'valid' | 'invalid_output' | 'unavailable';
  readonly elapsedMs: number;
  readonly attempts: number;
  readonly answer: JevChoice | null;
  readonly expectedCandidateId: string;
}

/** Synthetic fixtures only; a result never carries execution authority.
 * The token guard bounds one run's input; it is not a billing control. */
export async function runJevBenchmark(options: {
  readonly fixtures: readonly ProbeFixture[]; readonly transport: CLMTransport;
  readonly maxInputTokens: number; readonly signal: AbortSignal;
  readonly sleep?: (ms: number) => Promise<void>; readonly maxAttempts?: number;
}): Promise<JevBenchmarkResult[]> {
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? 5;
  if (options.fixtures.some(fixture => fixture.synthetic !== true)) {
    throw new ContractError('benchmark accepts synthetic fixtures only');
  }
  const results: JevBenchmarkResult[] = [];
  let spent = 0;
  for (const fixture of options.fixtures) {
    for (const order of ['offered', 'reversed'] as const) {
      if (options.signal.aborted) throw new ContractError('benchmark cancelled');
      if (spent >= options.maxInputTokens) throw new ContractError('benchmark input-token guard reached');
      const body = encodeJevProviderView(fixture.providerView, order);
      const started = performance.now();
      let attempts = 0;
      let raw: unknown;
      let status: JevBenchmarkResult['status'] = 'valid';
      while (true) {
        attempts++;
        try { raw = await options.transport.send(body, options.signal); break; }
        catch (error) {
          const code = (error as { status?: number }).status;
          if ((code === 429 || code === 529) && attempts < maxAttempts) {
            await sleep(500 * 2 ** (attempts - 1) * (1 + Math.random() * 0.25));
            continue;
          }
          status = 'unavailable';
          break;
        }
      }
      let answer: JevChoice | null = null;
      if (status === 'valid') {
        try { answer = decodeJevChoice(raw, fixture.providerView, JEV_MODEL); spent += answer.inputTokens; }
        catch { status = 'invalid_output'; }
      }
      results.push({ fixtureId: fixture.id, order, status, elapsedMs: performance.now() - started, attempts,
        answer, expectedCandidateId: fixture.expectedCandidateId });
    }
  }
  return results;
}
