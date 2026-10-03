import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approveCandidateProjection, buildActionCandidates } from '../../runtime/src/action-candidates.ts';
import type { EgressPolicy, ProviderRegistration } from '../../runtime/src/provider-egress.ts';
import { CLMDecisionClient } from '../src/clm-decision-client.ts';
import type { CLMTransport } from '../src/clm-decision-client.ts';

const provider: ProviderRegistration = { id: 'owned-clm', name: 'clm', location: 'owned_service', revision: 'synthetic-v1' };
const policy: EgressPolicy = { mode: 'owned_service', enabledProviderIds: [provider.id] };
const calibration = { revision: 'synthetic-only', temperature: 1, minProbability: 0.8, minMargin: 0.2 };
const set = buildActionCandidates({ source: { surface: 'native', observationId: 'observation-1', complete: true,
  controls: [{ targetRef: 'PRIVATE-HANDLE', role: 'AXButton', label: 'Documents', context: 'synthetic Finder',
    visible: true, enabled: true, editable: false, invokable: true, destinationUrl: null }] },
  invocations: [{ targetRef: 'PRIVATE-HANDLE', expectedRef: 'PRIVATE-PREDICATE', expectedDescription: 'the Documents folder title' }],
  policyRevision: 'fixture-v1' });
const approve = () => approveCandidateProjection({ set, stateText: 'Synthetic task: locate Budget.xlsx.',
  questionText: 'Choose the next safe offered action.', provider, disclosureReview: () => true });
const reply = (choice = 'c0', probabilities = { c0: 0.95, wait: 0.025, request_help: 0.025 }) => ({
  model: 'clm-latest', answers: { next_action: { type: 'choice', choice, probabilities } }, usage: { input_tokens: 100 } });
const client = (transport: CLMTransport, p = policy, registration = provider, c = calibration) => new CLMDecisionClient(p, registration, c, transport);

test('CLM decision sends only approved semantic choices and returns an observation-bound proposal', async () => {
  let calls = 0;
  const result = await client({ async send(body) {
    calls++;
    const text = Buffer.from(body).toString();
    assert.ok(!text.includes('PRIVATE-HANDLE')); assert.ok(!text.includes('PRIVATE-PREDICATE'));
    const wire = JSON.parse(text);
    assert.equal(wire.temperature, calibration.temperature);
    assert.deepEqual(wire.questions.next_action.criteria, Object.fromEntries(set.candidates.map(c => [c.candidateId, c.description])));
    return reply();
  } }).decide(set, approve(), new AbortController().signal);
  assert.equal(calls, 1);
  assert.deepEqual(result, { observationId: set.observationId, candidateSetDigest: set.candidateSetDigest,
    providerRevision: provider.revision, calibrationRevision: calibration.revision,
    candidateId: 'c0', status: 'selected', reason: 'accepted', inputTokens: 100 });
  assert.ok(Object.isFrozen(result));
  assert.equal(Object.hasOwn(result, 'permit'), false);
});

test('disabled, offline, revision, altered projection, disclosure and cancelled checks precede all CLM I/O', async () => {
  let calls = 0;
  const transport = { async send() { calls++; return reply(); } };
  const signal = new AbortController().signal;
  await assert.rejects(client(transport, { ...policy, enabledProviderIds: [] }).decide(set, approve(), signal));
  await assert.rejects(client(transport, { ...policy, mode: 'offline' }).decide(set, approve(), signal));
  await assert.rejects(client(transport, policy, { ...provider, revision: 'different' }).decide(set, approve(), signal));
  const changed = approve(); (changed.value as any).stateText = 'unapproved';
  await assert.rejects(client(transport).decide(set, changed, signal));
  const mismatched = approve(); (mismatched.value as any).candidates[0].candidateId = 'invented';
  await assert.rejects(client(transport).decide(set, mismatched, signal));
  await assert.rejects(client(transport).decide(set, { ...approve(), value: null }, signal));
  assert.throws(() => approveCandidateProjection({ set, stateText: 'synthetic', questionText: 'next?', provider,
    disclosureReview: field => !field.startsWith('candidate:') }));
  await assert.rejects(client(transport).decide(set, approve(), AbortSignal.abort()));
  assert.equal(calls, 0);
});

test('CLM confidence, ties and non-effect choices do not propose execution', async () => {
  for (const response of [reply('c0', { c0: 0.6, wait: 0.3, request_help: 0.1 }),
    reply('c0', { c0: 0.5, wait: 0.5, request_help: 0 })]) {
    const result = await client({ async send() { return response; } }, policy, provider,
      { ...calibration, minProbability: 0, minMargin: response.answers.next_action.probabilities.c0 === 0.5 ? 0 : 0.5 })
      .decide(set, approve(), new AbortController().signal);
    assert.equal(result.status, 'abstained'); assert.equal(result.reason, 'low_confidence'); assert.equal(result.candidateId, null);
  }
  for (const choice of ['wait', 'request_help']) {
    const probabilities = { c0: 0.025, wait: choice === 'wait' ? 0.95 : 0.025, request_help: choice === 'request_help' ? 0.95 : 0.025 };
    const result = await client({ async send() { return reply(choice, probabilities); } }).decide(set, approve(), new AbortController().signal);
    assert.equal(result.status, choice); assert.equal(result.reason, 'non_effect_choice');
    assert.equal(set.resolve(result.candidateId!, result.observationId, result.candidateSetDigest), undefined);
  }
});

test('unknown IDs, malformed probabilities, aliases and token counts abstain', async () => {
  const cases: unknown[] = [null, { ...reply(), model: 'other' }, reply('invented'),
    reply('wait'), reply('c0', { c0: 1, wait: 1, request_help: 0 }),
    reply('c0', { c0: NaN, wait: 0, request_help: 0 }),
    { ...reply(), usage: { input_tokens: -1 } },
    { ...reply(), answers: { ...reply().answers, injected: {} } }];
  for (const response of cases) {
    const result = await client({ async send() { return response; } }).decide(set, approve(), new AbortController().signal);
    assert.equal(result.status, 'abstained'); assert.equal(result.reason, 'invalid_output'); assert.equal(result.candidateId, null);
  }
});

test('transport failure abstains and cancellation rejects late model output', async () => {
  const unavailable = await client({ async send() { throw Error('fixture unavailable'); } }).decide(set, approve(), new AbortController().signal);
  assert.equal(unavailable.reason, 'unavailable'); assert.equal(unavailable.candidateId, null);
  const controller = new AbortController();
  await assert.rejects(client({ async send() { controller.abort(); return reply(); } }).decide(set, approve(), controller.signal), /cancelled/);
});

test('transport mutation cannot change the approved candidate set or host calibration', async () => {
  const approved = approve(); const mutableCalibration = { ...calibration };
  const decision = client({ async send() {
    (approved.value as any).candidates[0].candidateId = 'forged'; mutableCalibration.minProbability = 1;
    return reply();
  } }, policy, provider, mutableCalibration);
  const result = await decision.decide(set, approved, new AbortController().signal);
  assert.equal(result.status, 'selected'); assert.equal(result.candidateId, 'c0');
});
