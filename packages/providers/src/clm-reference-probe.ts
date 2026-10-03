import { performance } from 'node:perf_hooks';
import { validateProviderView } from '../../protocol/src/contract.ts';
import { ContractError } from '../../protocol/src/json.ts';
import type { JSONValue } from '../../protocol/src/json.ts';
import { encodeCLMProviderView, decodeCLMChoice } from './clm-wire.ts';

export interface ProbeFixture {
  readonly id: string;
  readonly synthetic: true;
  readonly providerView: {
    readonly projectionRevision: string;
    readonly stateText: string;
    readonly questionText: string;
    readonly candidates: readonly { readonly candidateId: string; readonly description: string }[];
  };
  readonly expectedCandidateId: string;
  readonly targetPresent: boolean;
}

export interface ProbeTransport { send(body: Uint8Array): Promise<unknown>; }

export interface ProbeResult {
  readonly fixtureId: string;
  readonly elapsedMs: number;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly choice: string | null;
  readonly probabilities: Readonly<Record<string, number>> | null;
  readonly expectedCandidateId: string;
  readonly targetPresent: boolean;
  readonly matchesExpected: boolean | null;
  readonly status: 'valid' | 'invalid_output' | 'unavailable';
  readonly error?: string;
  readonly rawOutput?: unknown;
}

export function encodeCLMProbeRequest(fixture: ProbeFixture): Uint8Array {
  if (!fixture || fixture.synthetic !== true || !/^[A-Za-z0-9_.:-]{1,160}$/.test(fixture.id)) {
    throw new ContractError('probe requires a named synthetic fixture');
  }
  validateProviderView(fixture.providerView as unknown as JSONValue);
  const candidates = fixture.providerView.candidates;
  if (candidates.length < 2) throw new ContractError('probe requires at least two candidates');
  const ids = candidates.map(item => item.candidateId);
  if (new Set(ids).size !== ids.length) throw new ContractError('duplicate candidate IDs');
  if (typeof fixture.targetPresent !== 'boolean' || !ids.includes(fixture.expectedCandidateId)) {
    throw new ContractError('expected candidate is absent');
  }
  return encodeCLMProviderView(fixture.providerView);
}

export function decodeCLMProbeResponse(raw: unknown, fixture: ProbeFixture):
  Pick<ProbeResult, 'model' | 'inputTokens' | 'choice' | 'probabilities'> {
  return decodeCLMChoice(raw, fixture.providerView);
}

/** Fixture-only measurement. A result never conveys an execution permit. */
export async function probeCLM(fixture: ProbeFixture, transport: ProbeTransport): Promise<ProbeResult> {
  const snapshot = structuredClone(fixture);
  const body = encodeCLMProbeRequest(snapshot);
  const started = performance.now();
  const targetPresent = snapshot.targetPresent;
  try {
    const rawOutput = await transport.send(body);
    const elapsedMs = performance.now() - started;
    try {
      const parsed = decodeCLMProbeResponse(rawOutput, snapshot);
      return { fixtureId: snapshot.id, elapsedMs, expectedCandidateId: snapshot.expectedCandidateId,
        targetPresent, matchesExpected: parsed.choice === snapshot.expectedCandidateId,
        status: 'valid', rawOutput, ...parsed };
    } catch (error) {
      return { fixtureId: snapshot.id, elapsedMs, expectedCandidateId: snapshot.expectedCandidateId,
        targetPresent, status: 'invalid_output', model: null, inputTokens: null,
        choice: null, probabilities: null, matchesExpected: null,
        rawOutput, error: String(error) };
    }
  } catch (error) {
    return { fixtureId: snapshot.id, elapsedMs: performance.now() - started,
      expectedCandidateId: snapshot.expectedCandidateId, targetPresent,
      status: 'unavailable', model: null, inputTokens: null, choice: null,
      probabilities: null, matchesExpected: null, error: String(error) };
  }
}
