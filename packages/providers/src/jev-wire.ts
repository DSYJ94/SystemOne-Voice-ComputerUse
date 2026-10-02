import { validateProviderView } from '../../protocol/src/contract.ts';
import { ContractError } from '../../protocol/src/json.ts';
import type { JSONValue } from '../../protocol/src/json.ts';
import type { CLMProviderView } from './clm-wire.ts';

/** Versioned ID, not the moving `jev-latest` alias: thresholds and benchmark
 * results bind to the model that answered. Change deliberately, never silently. */
export const JEV_MODEL = 'jev-1.13.0';
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export interface JevChoice {
  readonly model: string;
  readonly inputTokens: number;
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

/** TypeSafe `/v1/systemone` choice request over the same minimized view CLM
 * receives. Jev reads option order (documented jev-1.13 jaggedness), so the
 * caller chooses the criteria order explicitly; CLM's temperature is absent. */
export function encodeJevProviderView(view: CLMProviderView, order: 'offered' | 'reversed' = 'offered',
  model = JEV_MODEL): Uint8Array {
  validateProviderView(view as unknown as JSONValue);
  const ids = view.candidates.map(value => value.candidateId);
  if (ids.length < 2 || ids.length > 255 || new Set(ids).size !== ids.length) {
    throw new ContractError('invalid Jev candidate IDs');
  }
  if (!/^jev-\d+\.\d+\.\d+$/.test(model)) throw new ContractError('Jev model must be a pinned version');
  const candidates = order === 'reversed' ? [...view.candidates].reverse() : view.candidates;
  return Buffer.from(JSON.stringify({ state: view.stateText, model, questions: {
    next_action: { type: 'choice', instructions: view.questionText,
      criteria: Object.fromEntries(candidates.map(value => [value.candidateId, value.description])) },
  } }));
}

export function decodeJevChoice(raw: unknown, view: CLMProviderView, model = JEV_MODEL): JevChoice {
  const envelope = object(raw);
  if (envelope.model !== model) throw new ContractError('unexpected Jev model version');
  const answers = object(envelope.answers);
  if (Object.keys(answers).length !== 1 || !Object.hasOwn(answers, 'next_action')) {
    throw new ContractError('unexpected question IDs');
  }
  const answer = object(answers.next_action);
  if (answer.type !== 'choice' || typeof answer.choice !== 'string') throw new ContractError('invalid choice answer');
  const confidence = answer.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new ContractError('invalid confidence');
  }
  const distribution = object(answer.probabilities);
  const expected = view.candidates.map(value => value.candidateId);
  if (Object.keys(distribution).length !== expected.length || expected.some(id => !Object.hasOwn(distribution, id))) {
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
  if (!expected.includes(answer.choice) || Math.abs((distribution[answer.choice] as number)
    - Math.max(...expected.map(id => distribution[id] as number))) > 0.000001) {
    throw new ContractError('choice disagrees with distribution');
  }
  const tokens = object(envelope.usage).input_tokens;
  if (!Number.isSafeInteger(tokens) || (tokens as number) < 0) throw new ContractError('invalid token accounting');
  return Object.freeze({ model, inputTokens: tokens as number, choice: answer.choice, confidence,
    probabilities: Object.freeze(Object.fromEntries(expected.map(id => [id, distribution[id] as number]))) });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('expected object');
  return value as Record<string, unknown>;
}
