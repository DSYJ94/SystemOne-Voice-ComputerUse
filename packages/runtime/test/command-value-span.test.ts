import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schema } from '../../protocol/src/contract.ts';
import { digest } from '../../protocol/src/json.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { CommittedInputSession } from '../src/committed-input.ts';
import { bindCommandValue } from '../src/command-value-span.ts';
import { TaskAdmissionRegistry } from '../src/task-authority.ts';

function fixture(prefix: string, value: string) {
  const endpoint = bindEndpoint(['command']);
  const revision = { taskId: 'task-001', taskEpoch: 1, goalRevision: 1 };
  const session = new CommittedInputSession(endpoint, revision);
  const input = session.accept(endpoint, Buffer.from(JSON.stringify({
    ...structuredClone(schema.examples[0]), source: 'text', mode: 'command',
    utteranceId: 'typed-1', utteranceRevision: 3, text: prefix + value,
  }))).input;
  return { session, revision, input };
}

function admit(f: ReturnType<typeof fixture>, parameter: ReturnType<typeof bindCommandValue>) {
  return new TaskAdmissionRegistry(f.revision, f.session).admit(f.input, {
    admissionId: 'admission-1', goal: f.input.text, outcomeKind: 'FILL',
    scopeRef: 'scope-1', completionVerifierRef: 'exact-field-v1',
    policyRevision: 'policy-v1', approvedEffects: ['READ', 'LOCAL_EDIT'],
    parameters: [parameter],
  });
}

test('final typed value preserves original Unicode bytes and immutable revision offsets', () => {
  const prefix = 'Fill café in TextEdit with text: ';
  const value = 'café e\u0301 😀.txt';
  const f = fixture(prefix, value);
  const parameter = bindCommandValue(f.input, 'fill-value', prefix, value);
  assert.equal(parameter.sourceStart, Buffer.byteLength(prefix, 'utf8'));
  assert.equal(parameter.sourceEnd, Buffer.byteLength(prefix + value, 'utf8'));
  assert.equal(parameter.sourceRef, 'utterance.typed-1.r3');
  assert.equal(parameter.valueDigest, digest(value));
  assert.equal(admit(f, parameter).parameters[0]?.valueDigest, digest(value));
});

test('changed value, offset inside multibyte character and wrong revision fail before admission', () => {
  const prefix = 'Fill field with text: ';
  const value = '😀.txt';
  const f = fixture(prefix, value);
  assert.throws(() => bindCommandValue(f.input, 'fill-value', prefix, 'evil.txt'), /differs/);
  const parameter = bindCommandValue(f.input, 'fill-value', prefix, value);
  assert.throws(() => admit(f, { ...parameter,
    sourceStart: parameter.sourceStart! + 1 }), /splits UTF-8/);
  assert.throws(() => admit(f, { ...parameter,
    sourceRef: 'utterance.typed-1.r2' }), /invalid final command value span/);
  assert.throws(() => admit(f, { ...parameter,
    sourceEnd: parameter.sourceEnd! - 1 }), /digest mismatch/);
});
