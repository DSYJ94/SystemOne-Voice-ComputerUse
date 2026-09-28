import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildActionCandidates, approveCandidateProjection,
  fromChromeObservation, fromManagedObservation, fromNativeObservation } from
  '../src/action-candidates.ts';
import { requestDecision } from '../src/provider-egress.ts';

const provider = { id: 'clm-owned', name: 'clm' as const,
  location: 'owned_service' as const, revision: 'pinned-test-revision' };

test('native candidate contains a complete action but hides secure and disabled fields', () => {
  const source = fromNativeObservation({ observationId: 'native-obs',
    scopeRef: 'native-scope', bundleId: 'com.aurium.fixture', complete: true,
    controls: [
      { id: 'private-field-handle', role: 'AXTextField', label: 'Fixture Name',
        enabled: true, secure: false, canSetValue: true },
      { id: 'secure-handle', role: 'AXTextField', label: 'Password',
        enabled: true, secure: true, canSetValue: true },
      { id: 'disabled-handle', role: 'AXTextField', label: 'Disabled',
        enabled: false, secure: false, canSetValue: true },
      { id: 'unlabeled-handle', role: 'AXTextField', label: '',
        enabled: true, secure: false, canSetValue: true },
    ] });
  const set = buildActionCandidates({ source,
    text: { textRef: 'committed-text', source: 'final_command',
      allowedTargetRefs: ['private-field-handle'] },
    policyRevision: 'native-ax-policy-v1' });
  const action = set.candidates.find(item => item.operation === 'set_value')!;
  assert.equal(action.targetRef, 'private-field-handle');
  assert.deepEqual(action.parameters, { textRef: 'committed-text' });
  assert.deepEqual(action.effects, ['LOCAL_EDIT']);
  assert.ok(String(action.description).includes('Fixture Name'));
  assert.equal(set.candidates.filter(item => item.operation === 'set_value').length, 1);
  assert.equal(set.resolve(action.candidateId as string, 'native-obs',
    set.candidateSetDigest)?.targetRef, 'private-field-handle');
  assert.equal(set.resolve(action.candidateId as string, 'stale-obs',
    set.candidateSetDigest), undefined);
  assert.equal(set.resolve(action.candidateId as string, 'native-obs',
    '0'.repeat(64)), undefined);
  assert.throws(() => { action.description = 'Changed after binding'; }, TypeError);
  const noScope = buildActionCandidates({ source,
    text: { textRef: 'committed-text', source: 'final_command',
      allowedTargetRefs: [] }, policyRevision: 'native-ax-policy-v1' });
  assert.equal(noScope.candidates.some(item => item.operation === 'set_value'), false);

  const reviewed: string[] = [];
  const projection = approveCandidateProjection({ set,
    stateText: 'Goal: fill the synthetic fixture name.\nCurrent app: Fixture.',
    questionText: 'Choose one safe next action.', provider,
    disclosureReview: (field, text) => { reviewed.push(`${field}:${text}`); return true; } });
  const wire = JSON.stringify(projection.value);
  assert.ok(!wire.includes('private-field-handle'));
  assert.ok(!wire.includes('committed-text'));
  assert.ok(!wire.includes('Password'));
  assert.ok(wire.includes('Current app: Fixture.'));
  assert.ok(reviewed.some(item => item.startsWith(`candidate:${action.candidateId}:`)));
  assert.equal(projection.providerId, provider.id);
});

test('managed navigation requires an exact bound same-origin link', () => {
  const source = fromManagedObservation({ observationId: 'managed-obs',
    browserSessionId: 'browser-session', navigationRevision: 1,
    url: 'http://127.0.0.1:49081/', title: 'Invoice Portal',
    controls: [
      { id: 'browse-link', role: 'a', label: 'Browse invoices', context: 'Home',
        enabled: true, editable: false,
        destinationUrl: 'http://127.0.0.1:49081/invoices' },
      { id: 'outside-link', role: 'a', label: 'External sample', context: 'Home',
        enabled: true, editable: false,
        destinationUrl: 'https://outside.invalid/path' },
      { id: 'fake-link', role: 'button', label: 'Not a link', context: 'Home',
        enabled: true, editable: false,
        destinationUrl: 'http://127.0.0.1:49081/invoices' },
    ],
    coverage: { mainDocument: true, subframes: false,
      openShadowRoots: false, truncated: false,
      hasUnobservedSubframes: false,
      hasUnobservedShadowRoots: false, complete: true } });
  const set = buildActionCandidates({ source,
    destinations: [{ urlRef: 'approved-route',
      exactUrl: 'http://127.0.0.1:49081/invoices' }],
    policyRevision: 'managed-navigation-v1' });
  const navigation = set.candidates.filter(item => item.operation === 'navigate');
  assert.equal(navigation.length, 1);
  assert.equal(navigation[0]?.targetRef, 'browse-link');
  assert.deepEqual(navigation[0]?.parameters, { urlRef: 'approved-route' });
  assert.deepEqual(navigation[0]?.effects, ['NAVIGATE', 'EXTERNAL_READ']);
  assert.throws(() => buildActionCandidates({ source,
    destinations: [{ urlRef: 'outside', exactUrl: 'https://outside.invalid/path' }],
    policyRevision: 'managed-navigation-v1' }), /unapproved destination URL/);
});

test('incomplete or ambiguous Chrome observations abstain from executable actions', () => {
  const source = fromChromeObservation({ observationId: 'chrome-obs',
    title: 'Invoice Portal Fixture', url: 'http://127.0.0.1:49081/',
    complete: true, elements: [
      { id: 'chrome-obs:0', role: 'input', label: 'Find invoice',
        disabled: false, editable: true },
      { id: 'chrome-obs:1', role: 'input', label: 'Find invoice',
        disabled: false, editable: true },
    ] });
  const input = { source, text: { textRef: 'value-binding',
    source: 'final_command' as const,
    allowedTargetRefs: ['chrome-obs:0', 'chrome-obs:1'] },
    policyRevision: 'chrome-loopback-fill-v1' };
  const ambiguous = buildActionCandidates(input);
  assert.equal(ambiguous.candidates.some(item => item.operation === 'set_value'), false);
  assert.deepEqual(ambiguous.candidates.map(item => item.operation),
    ['wait', 'request_help']);
  assert.deepEqual(ambiguous.candidates[1]?.parameters,
    { reason: 'ambiguous_target' });
  const incomplete = buildActionCandidates({ ...input,
    source: { ...source, complete: false } });
  assert.equal(incomplete.abstained, true);
  assert.equal(incomplete.resolve('c0', 'chrome-obs',
    incomplete.candidateSetDigest), undefined);
});

test('candidate overflow abstains and disclosure review covers every description', async () => {
  const source = { surface: 'native' as const, observationId: 'many-fields',
    complete: true,
    controls: Array.from({ length: 63 }, (_, index) => ({
      targetRef: `field-${index}`, role: 'AXTextField', label: `Field ${index}`,
      context: '', visible: true, enabled: true, editable: true,
      destinationUrl: null,
    })) };
  const set = buildActionCandidates({ source,
    text: { textRef: 'text-1', source: 'approved_binding',
      allowedTargetRefs: source.controls.map(control => control.targetRef) },
    policyRevision: 'native-ax-policy-v1' });
  assert.equal(set.abstained, true);
  assert.deepEqual(set.candidates.map(item => item.operation),
    ['wait', 'request_help']);
  let sent = 0;
  assert.throws(() => approveCandidateProjection({ set,
    stateText: 'Goal: use a fixture field.',
    questionText: 'Choose one safe action.', provider,
    disclosureReview: field => field !== 'candidate:request_help' }),
  /candidate description disclosure denied/);
  const approved = approveCandidateProjection({ set,
    stateText: 'Goal: use a fixture field.',
    questionText: 'Choose one safe action.', provider,
    disclosureReview: () => true });
  await assert.rejects(requestDecision({ mode: 'offline',
    enabledProviderIds: [provider.id] }, provider, approved,
  { send: async () => { sent++; return {}; } }), /offline egress denied/);
  assert.equal(sent, 0);
});
