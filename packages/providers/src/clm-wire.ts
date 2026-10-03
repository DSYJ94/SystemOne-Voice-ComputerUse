import { validateProviderView } from '../../protocol/src/contract.ts';
import { ContractError } from '../../protocol/src/json.ts';
import type { JSONValue } from '../../protocol/src/json.ts';

export interface CLMProviderView {
  readonly projectionRevision: string;
  readonly stateText: string;
  readonly questionText: string;
  readonly candidates: readonly { readonly candidateId: string; readonly description: string }[];
}
export interface CLMChoice {
  readonly model: 'clm-latest';
  readonly inputTokens: number;
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
}

/** Pinned reference shape; semantic descriptions, never local bindings/handles. */
export function encodeCLMProviderView(view: CLMProviderView, temperature = 1): Uint8Array {
  validateProviderView(view as unknown as JSONValue);
  if (!Number.isFinite(temperature) || temperature <= 0 || temperature > 100) {
    throw new ContractError('invalid CLM temperature');
  }
  const ids = view.candidates.map(value => value.candidateId);
  if (ids.length < 2 || new Set(ids).size !== ids.length) throw new ContractError('invalid CLM candidate IDs');
  return Buffer.from(JSON.stringify({ state: view.stateText, model: 'clm-latest', questions: {
    next_action: { type: 'choice', instructions: view.questionText,
      criteria: Object.fromEntries(view.candidates.map(value => [value.candidateId, value.description])) },
  }, temperature }));
}

export function decodeCLMChoice(raw: unknown, view: CLMProviderView): CLMChoice {
  const envelope = object(raw);
  if (envelope.model !== 'clm-latest') throw new ContractError('unexpected model alias');
  const answers = object(envelope.answers);
  if (Object.keys(answers).length !== 1 || !Object.hasOwn(answers, 'next_action')) {
    throw new ContractError('unexpected question IDs');
  }
  const answer = object(answers.next_action);
  if (answer.type !== 'choice' || typeof answer.choice !== 'string') throw new ContractError('invalid choice answer');
  const distribution = object(answer.probabilities);
  const expected = view.candidates.map(value => value.candidateId);
  if (new Set(expected).size !== expected.length || Object.keys(distribution).length !== expected.length
    || expected.some(id => !Object.hasOwn(distribution, id))) throw new ContractError('distribution candidate mismatch');
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
  if (Math.abs((distribution[answer.choice] as number)
    - Math.max(...expected.map(id => distribution[id] as number))) > 0.000001) {
    throw new ContractError('choice disagrees with distribution');
  }
  const tokens = object(envelope.usage).input_tokens;
  if (!Number.isSafeInteger(tokens) || (tokens as number) < 0) throw new ContractError('invalid token accounting');
  return Object.freeze({ model: 'clm-latest', inputTokens: tokens as number, choice: answer.choice,
    probabilities: Object.freeze({ ...distribution } as Record<string, number>) });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('expected object');
  return value as Record<string, unknown>;
}
