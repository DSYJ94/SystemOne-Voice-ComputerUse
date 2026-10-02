import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildActionCandidates, fromNativeObservation } from '../../runtime/src/action-candidates.ts';
import { encodeCLMProbeRequest } from '../src/clm-reference-probe.ts';
import type { ProbeFixture } from '../src/clm-reference-probe.ts';

type CorpusFixture = ProbeFixture & { category?: string; taskKey?: string; diagnostic?: true };
const load = (name: string) => JSON.parse(readFileSync(
  new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as CorpusFixture[];
const calibration = load('clm-calibration-synthetic.json');
const diagnostic = load('clm-diagnostic-documents.json');
const smoke = load('clm-probe-synthetic.json');
const goal = (fixture: ProbeFixture) => /^Goal: (.*?)\. Current state:/.exec(fixture.providerView.stateText)?.[1];

test('calibration corpus has at least 50 schema-valid, task-disjoint synthetic cases', () => {
  assert.ok(calibration.length >= 50);
  for (const fixture of [...calibration, ...diagnostic]) encodeCLMProbeRequest(fixture);
  const ids = [...calibration, ...diagnostic, ...smoke].map(fixture => fixture.id);
  assert.equal(new Set(ids).size, ids.length);
  const tasks = calibration.map(fixture => fixture.taskKey?.toLowerCase());
  assert.equal(new Set(tasks).size, tasks.length);
  calibration.forEach(fixture => assert.equal(goal(fixture), fixture.taskKey));
  // The smoke task family (and its diagnostic edits) never enters calibration.
  const reserved = [...smoke, ...diagnostic].map(fixture => fixture.providerView.stateText);
  for (const fixture of calibration) {
    assert.ok(!/Budget\.xlsx|INV-104|INV-999/.test(fixture.providerView.stateText), fixture.id);
    assert.ok(!reserved.includes(fixture.providerView.stateText), fixture.id);
  }
  assert.ok(diagnostic.every(fixture => fixture.diagnostic === true && !fixture.category));
});

test('calibration cases mirror the host projection: templates plus exact fallbacks', () => {
  const fallbacks = buildActionCandidates({ source: fromNativeObservation({ observationId: 'corpus-obs',
    scopeRef: 'corpus-scope', bundleId: 'com.aurium.fixture', complete: true, controls: [] }),
    policyRevision: 'corpus-policy' }).candidates.map(candidate => ({
    candidateId: candidate.candidateId as string, description: candidate.description as string }));
  assert.deepEqual(fallbacks.map(item => item.candidateId), ['wait', 'request_help']);
  const templates = [
    /^Invoke the visible (AXButton|AXMenuItem) “[^”]+” in .+, then independently verify .+\.$/u,
    /^Follow the visible link “[^”]+” in .+ to the approved destination https:\/\/portal\.example\.test\/\S*, then verify exact URL arrival\.$/u,
    /^Set the visible \S+ field “[^”]+” in .+ to the user's bound text, then verify its current value\.$/u,
  ];
  const categories = new Map<string, number>();
  for (const fixture of calibration) {
    const candidates = fixture.providerView.candidates;
    assert.deepEqual(candidates.slice(-2), fallbacks, fixture.id);
    candidates.slice(0, -2).forEach((candidate, index) => {
      assert.equal(candidate.candidateId, `c${index}`);
      assert.ok(templates.some(pattern => pattern.test(candidate.description)), candidate.description);
    });
    assert.ok(candidates.some(candidate => candidate.candidateId === fixture.expectedCandidateId));
    assert.equal(fixture.targetPresent, !['wait', 'request_help'].includes(fixture.expectedCandidateId));
    categories.set(fixture.category!, (categories.get(fixture.category!) ?? 0) + 1);
  }
  // Abstention and waiting are calibrated, not only successful advances.
  for (const category of ['advance', 'identity', 'missing-target', 'scope', 'wait']) {
    assert.ok((categories.get(category) ?? 0) >= 5, category);
  }
});
