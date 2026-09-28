import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeCLMProbeResponse, encodeCLMProbeRequest, probeCLM } from '../src/clm-reference-probe.ts';
import type { ProbeFixture } from '../src/clm-reference-probe.ts';

const fixture: ProbeFixture = {
  id: 'finder-documents-01', synthetic: true, expectedCandidateId: 'documents', targetPresent: true,
  providerView: {
    projectionRevision: 'probe.v1',
    stateText: 'Goal: find Budget.xlsx. Finder is open with Recents selected. Scope: locate only.',
    questionText: 'Choose one next action that advances the goal, or help if none is safe.',
    candidates: [
      { candidateId: 'documents', description: 'Select Documents in the Finder sidebar to show the Documents folder.' },
      { candidateId: 'help', description: 'Pause and ask the user because no offered action can safely advance the task.' },
    ],
  },
};
const valid = () => ({ model: 'clm-latest', answers: { next_action: {
  type: 'choice', choice: 'documents', confidence: 0.6,
  probabilities: { documents: 0.8, help: 0.2 },
} }, usage: { billing_units: 1, input_tokens: 97, output_tokens: 0 } });

test('probe serializes full semantic choices in the pinned CLM wire shape', () => {
  const request = JSON.parse(Buffer.from(encodeCLMProbeRequest(fixture)).toString());
  assert.deepEqual(Object.keys(request), ['state', 'model', 'questions', 'temperature']);
  assert.equal(request.state, fixture.providerView.stateText);
  assert.equal(request.questions.next_action.instructions, fixture.providerView.questionText);
  assert.deepEqual(request.questions.next_action.criteria, {
    documents: fixture.providerView.candidates[0]?.description,
    help: fixture.providerView.candidates[1]?.description,
  });
});

test('probe rejects duplicate IDs, private fields and absent expected IDs before transport', async () => {
  let calls = 0;
  const transport = { async send() { calls++; return valid(); } };
  const duplicate = structuredClone(fixture);
  (duplicate.providerView.candidates[1] as { candidateId: string }).candidateId = 'documents';
  await assert.rejects(probeCLM(duplicate, transport));
  const extra = structuredClone(fixture) as ProbeFixture & { secret?: string };
  (extra.providerView as typeof extra.providerView & { bindings?: string[] }).bindings = ['PRIVATE-CANARY'];
  await assert.rejects(probeCLM(extra, transport));
  const absent = { ...fixture, expectedCandidateId: 'unknown' };
  await assert.rejects(probeCLM(absent, transport));
  assert.equal(calls, 0);
});

test('probe captures raw output, token count and transport errors without action authority', async () => {
  const result = await probeCLM(fixture, { async send() { return valid(); } });
  assert.equal(result.status, 'valid');
  assert.equal(result.choice, 'documents');
  assert.equal(result.inputTokens, 97);
  assert.deepEqual(result.rawOutput, valid());
  const unavailable = await probeCLM(fixture, { async send() { throw Error('fixture service down'); } });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.choice, null);
});

test('malformed distribution, unknown choice and model mismatch are never valid', async () => {
  const cases = [
    { ...valid(), model: 'clm-raw' },
    { ...valid(), answers: { next_action: { ...valid().answers.next_action, choice: 'invented' } } },
    { ...valid(), answers: { next_action: { ...valid().answers.next_action, probabilities: { documents: 0.8, help: 0.5 } } } },
    { ...valid(), answers: { next_action: { ...valid().answers.next_action, probabilities: { documents: 0.8, invented: 0.2 } } } },
    { ...valid(), usage: { input_tokens: -1 } },
  ];
  for (const response of cases) {
    assert.throws(() => decodeCLMProbeResponse(response, fixture));
    const result = await probeCLM(fixture, { async send() { return response; } });
    assert.equal(result.status, 'invalid_output');
    assert.equal(result.choice, null);
  }
});

test('transport-side fixture mutation cannot change the candidate set used for validation', async () => {
  const mutable = structuredClone(fixture);
  const result = await probeCLM(mutable, { async send() {
    (mutable.providerView.candidates[0] as { candidateId: string }).candidateId = 'forged';
    return valid();
  } });
  assert.equal(result.status, 'valid');
  assert.equal(result.choice, 'documents');
});
