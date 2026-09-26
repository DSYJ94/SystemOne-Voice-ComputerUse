import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schema } from '../../protocol/src/contract.ts';
import { digest } from '../../protocol/src/json.ts';
import { requestDecision } from '../src/provider-egress.ts';
import type { ProviderRegistration, EgressPolicy } from '../src/provider-egress.ts';

const provider: ProviderRegistration = { id: 'reference', name: 'clm', location: 'owned_service', revision: 'fixture-v1' };
const view = schema.examples[2].providerView;
const approved = () => ({ value: structuredClone(view), digest: digest(view), providerId: provider.id, providerRevision: provider.revision });

test('offline, disabled and changed-provider requests make zero transport calls', async () => {
  let calls = 0;
  const transport = { async send() { calls++; } };
  const policies: EgressPolicy[] = [
    { mode: 'offline', enabledProviderIds: [provider.id] },
    { mode: 'owned_service', enabledProviderIds: [] },
  ];
  for (const policy of policies) await assert.rejects(requestDecision(policy, provider, approved(), transport));
  await assert.rejects(requestDecision({ mode: 'owned_service', enabledProviderIds: [provider.id] },
    { ...provider, revision: 'changed' }, approved(), transport));
  assert.equal(calls, 0);
});

test('external provider requires opt-in before any I/O', async () => {
  let calls = 0;
  await assert.rejects(requestDecision({ mode: 'owned_service', enabledProviderIds: [provider.id] },
    { ...provider, name: 'jev', location: 'external_service' }, approved(), { async send() { calls++; } }));
  assert.equal(calls, 0);
});

test('only the approved provider projection reaches the transport', async () => {
  const privateRequest = { ...schema.examples[2], privateSecret: 'PRIVATE-CANARY' };
  const projection = approved();
  let calls = 0;
  await requestDecision({ mode: 'owned_service', enabledProviderIds: [provider.id] }, provider, projection, {
    async send(registration, wire) {
      calls++;
      assert.deepEqual(registration, provider);
      assert.deepEqual(JSON.parse(Buffer.from(wire).toString()), view);
      assert.ok(!Buffer.from(wire).includes(Buffer.from(privateRequest.privateSecret)));
    },
  });
  assert.equal(calls, 1);
});

test('unapproved candidate text and private fields cannot be sent', async () => {
  let calls = 0;
  const transport = { async send() { calls++; } };
  const policy: EgressPolicy = { mode: 'owned_service', enabledProviderIds: [provider.id] };
  const changed = approved(); changed.value.candidates[0].description = 'UNAPPROVED-CANDIDATE-CANARY';
  await assert.rejects(requestDecision(policy, provider, changed, transport));
  const privateFields = approved(); privateFields.value.bindings = ['SECRET-CANARY'];
  privateFields.digest = digest(privateFields.value);
  await assert.rejects(requestDecision(policy, provider, privateFields, transport));
  assert.equal(calls, 0);
});
