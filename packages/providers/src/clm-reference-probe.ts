import { performance } from 'node:perf_hooks';
import { validateProviderView } from '../../protocol/src/contract.ts';
import { ContractError } from '../../protocol/src/json.ts';
import type { JSONValue } from '../../protocol/src/json.ts';

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

const QUESTION_ID = 'next_action';
const MODEL = 'clm-latest';

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
  const criteria = Object.fromEntries(candidates.map(item => [item.candidateId, item.description]));
  return new TextEncoder().encode(JSON.stringify({
    state: fixture.providerView.stateText,
    model: MODEL,
    questions: { [QUESTION_ID]: {
      type: 'choice', instructions: fixture.providerView.questionText, criteria,
    } },
    temperature: 1.0,
  }));
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('expected object');
  return value as Record<string, unknown>;
}

export function decodeCLMProbeResponse(raw: unknown, fixture: ProbeFixture):
  Pick<ProbeResult, 'model' | 'inputTokens' | 'choice' | 'probabilities'> {
  const envelope = object(raw);
  if (envelope.model !== MODEL) throw new ContractError('unexpected model alias');
  const answers = object(envelope.answers);
  if (Object.keys(answers).length !== 1 || !(QUESTION_ID in answers)) throw new ContractError('unexpected question IDs');
  const answer = object(answers[QUESTION_ID]);
  if (answer.type !== 'choice' || typeof answer.choice !== 'string') throw new ContractError('invalid choice answer');
  const distribution = object(answer.probabilities);
  const expected = fixture.providerView.candidates.map(item => item.candidateId);
  if (Object.keys(distribution).length !== expected.length ||
      expected.some(id => !Object.hasOwn(distribution, id))) {
    throw new ContractError('distribution candidate mismatch');
  }
  let total = 0;
  for (const id of expected) {
    const probability = distribution[id];
    if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new ContractError('invalid probability');
    }
    total += probability;
  }
  if (Math.abs(total - 1) > 0.001) throw new ContractError('distribution does not sum to one');
  if (!expected.includes(answer.choice)) throw new ContractError('unknown choice');
  const maximum = Math.max(...expected.map(id => distribution[id] as number));
  if (Math.abs((distribution[answer.choice] as number) - maximum) > 0.000001) {
    throw new ContractError('choice disagrees with distribution');
  }
  const usage = object(envelope.usage);
  const tokens = usage.input_tokens;
  if (!Number.isSafeInteger(tokens) || (tokens as number) < 0) throw new ContractError('invalid token accounting');
  return { model: MODEL, inputTokens: tokens as number, choice: answer.choice,
    probabilities: distribution as Record<string, number> };
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
