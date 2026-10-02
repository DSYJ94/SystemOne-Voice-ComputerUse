import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCLMHTTPTransport } from '../src/clm-http-transport.ts';
import { runJevBenchmark } from '../src/jev-benchmark.ts';
import { decodeJevChoice, encodeJevProviderView, JEV_ENDPOINT, JEV_MODEL } from '../src/jev-wire.ts';
import type { ProbeFixture } from '../src/clm-reference-probe.ts';

const view = {
  projectionRevision: 'calibration.v1',
  stateText: 'Goal: open the team directory. Current state: links Team directory and Sign out.',
  questionText: 'Choose the one offered action that advances the goal within its scope.',
  candidates: [
    { candidateId: 'c0', description: 'Follow the visible link “Team directory” to the directory.' },
    { candidateId: 'c1', description: 'Follow the visible link “Sign out” to sign out of the portal.' },
    { candidateId: 'request_help', description: 'Pause and ask the user because no offered action can safely advance this task.' },
  ],
};
const fixture: ProbeFixture = { id: 'jev-fixture', synthetic: true, expectedCandidateId: 'c0', targetPresent: true,
  providerView: view };
const reply = (probabilities = { c0: 0.8, c1: 0.05, request_help: 0.15 }, choice = 'c0') => ({ model: JEV_MODEL,
  answers: { next_action: { type: 'choice', choice, confidence: 0.7, probabilities } },
  usage: { input_tokens: 120, output_tokens: 3 } });

test('Jev request is the documented choice shape with a pinned version and no temperature', () => {
  const request = JSON.parse(Buffer.from(encodeJevProviderView(view)).toString());
  assert.deepEqual(Object.keys(request), ['state', 'model', 'questions']);
  assert.equal(request.model, 'jev-1.13.0');
  assert.deepEqual(Object.keys(request.questions.next_action.criteria), ['c0', 'c1', 'request_help']);
  const reversed = JSON.parse(Buffer.from(encodeJevProviderView(view, 'reversed')).toString());
  assert.deepEqual(Object.keys(reversed.questions.next_action.criteria), ['request_help', 'c1', 'c0']);
  assert.throws(() => encodeJevProviderView(view, 'offered', 'jev-latest'), /pinned version/);
  assert.throws(() => encodeJevProviderView({ ...view, candidates: [...view.candidates, view.candidates[0]!] }));
  assert.throws(() => encodeJevProviderView({ ...view, bindings: ['PRIVATE'] } as unknown as typeof view));
});

test('Jev replies need the pinned model, exact keys, a normalized distribution and a consistent choice', () => {
  assert.equal(decodeJevChoice(reply(), view).choice, 'c0');
  const bad = [
    { ...reply(), model: 'jev-latest' },
    reply({ c0: 0.8, c1: 0.2 } as never),
    reply({ c0: 0.8, c1: 0.05, request_help: 0.15, extra: 0 } as never),
    reply({ c0: 0.8, c1: 0.5, request_help: 0.15 }),
    reply({ c0: 0.8, c1: 0.05, request_help: 0.15 }, 'c1'),
    reply({ c0: Number.NaN, c1: 0.05, request_help: 0.15 }),
    { ...reply(), usage: {} },
    { ...reply(), answers: { other: reply().answers.next_action } },
  ];
  for (const raw of bad) assert.throws(() => decodeJevChoice(raw, view));
});

test('benchmark backs off on 429/529, records both orders and never accepts invalid output', async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const transport = { async send() {
    calls++;
    if (calls === 1) throw Object.assign(new Error('rate'), { status: 429 });
    if (calls === 3) return { ...reply(), model: 'jev-latest' };
    return reply();
  } };
  const results = await runJevBenchmark({ fixtures: [fixture], transport, maxInputTokens: 10_000,
    signal: new AbortController().signal, sleep: async ms => { sleeps.push(ms); } });
  assert.deepEqual(results.map(r => [r.order, r.status, r.attempts]), [['offered', 'valid', 2], ['reversed', 'invalid_output', 1]]);
  assert.equal(sleeps.length, 1);
  const failing = { async send() { throw Object.assign(new Error('auth'), { status: 401 }); } };
  const unavailable = await runJevBenchmark({ fixtures: [fixture], transport: failing, maxInputTokens: 10_000,
    signal: new AbortController().signal, sleep: async () => {} });
  assert.ok(unavailable.every(r => r.status === 'unavailable' && r.attempts === 1 && r.answer === null));
  await assert.rejects(runJevBenchmark({ fixtures: [{ ...fixture, synthetic: false as true }], transport,
    maxInputTokens: 1, signal: new AbortController().signal }), /synthetic/);
  await assert.rejects(runJevBenchmark({ fixtures: [fixture, { ...fixture, id: 'second' }], transport: { async send() { return reply(); } },
    maxInputTokens: 100, signal: new AbortController().signal }), /token guard/);
});

test('transport sends bearer auth to the TypeSafe endpoint and surfaces HTTP status only', async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: new Headers(init.headers).get('authorization') });
    return new Response('{"detail":"PRIVATE"}', { status: 529, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const transport = createCLMHTTPTransport({ endpoint: JEV_ENDPOINT, apiKey: 'test-key', fetcher });
  await assert.rejects(transport.send(encodeJevProviderView(view), new AbortController().signal),
    (error: Error & { status?: number }) => error.status === 529 && !error.message.includes('PRIVATE'));
  assert.deepEqual(seen, [{ url: JEV_ENDPOINT, auth: 'Bearer test-key' }]);
  assert.throws(() => createCLMHTTPTransport({ endpoint: JEV_ENDPOINT }), /authentication/);
});
