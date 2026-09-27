import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeMessage, encodeMessage, schema } from '../src/contract.ts';
import { canonicalJSON, digest, parseJSON, MAX_MESSAGE_BYTES } from '../src/json.ts';
import { FrameDecoder, frame } from '../src/framing.ts';

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

for (const [i, example] of schema.examples.entries()) {
  test(`protocol example ${i + 1} round-trips`, () => {
    assert.deepEqual(decodeMessage(encodeMessage(decodeMessage(bytes(example)))), example);
  });
}

test('golden candidate, projection and action digests match the Python oracle', () => {
  const request = schema.examples[2];
  assert.equal(digest(request.observation.candidates), request.observation.candidateSetDigest);
  assert.equal(digest(request.providerView), request.providerViewDigest);
  assert.equal(digest({ candidate: request.observation.candidates[0], scopeRef: request.context.scopeRef,
    bindings: request.context.bindings }), schema.examples[4].actionDigest);
});

for (const raw of ['{"x":1,"x":2}', '{"a":{"x":1,"\\u0078":2}}', '{"n":1e999}',
  '{"n":-1e999}', '{"n":9007199254740993}', '{"x":NaN}', '{"x":Infinity}',
  '{"x":1,}', '// comment\n{}', '{"x":"\\ud800"}', '\ufeff{}']) {
  test(`strict parser rejects ${JSON.stringify(raw)}`, () => assert.throws(() => parseJSON(Buffer.from(raw))));
}

test('parser preserves bytes represented by composed/decomposed Unicode and safe integers', () => {
  const value = { text: 'é e\u0301 😀 /', n: Number.MAX_SAFE_INTEGER };
  assert.deepEqual(parseJSON(bytes(value)), value);
  assert.equal(canonicalJSON({ z: 'é', a: [1, true, null] }), '{"a":[1,true,null],"z":"é"}');
  assert.throws(() => digest({ p: 0.5 }));
  assert.throws(() => digest({ 'é': 1 }));
});

test('parser bounds byte size, recursion and invalid UTF-8', () => {
  assert.throws(() => parseJSON(Buffer.alloc(MAX_MESSAGE_BYTES + 1)));
  assert.throws(() => parseJSON(Buffer.from('['.repeat(70) + '0' + ']'.repeat(70))));
  assert.throws(() => parseJSON(new Uint8Array([0x22, 0xff, 0x22])));
});

const invalidCases: [string, number, (value: any) => void][] = [
  ['old version', 0, x => { x.protocolVersion = '1.0'; }],
  ['partial command', 0, x => { x.isFinal = false; }],
  ['unknown fields', 0, x => { x.shell = 'not executable'; }],
  ['bad timestamp', 5, x => { x.finishedAt = 'tomorrow'; }],
  ['empty success evidence', 5, x => { x.evidence = []; }],
  ['success with unknown effect', 5, x => { x.effectStatus = 'unknown'; }],
  ['not dispatched but applied', 5, x => { x.deliveryStatus = 'not_dispatched'; }],
  ['multi-use permit', 7, x => { x.uses = 2; }],
  ['multi-use approval', 12, x => { x.uses = 2; }],
  ['approval without prompt', 12, x => { delete x.promptId; }],
  ['execution without policy revision', 4, x => { delete x.policyRevision; }],
  ['permit without policy revision', 7, x => { delete x.policyRevision; }],
  ['clarification without observation identity', 13, x => { delete x.observationId; }],
  ['resume without checkpoint digest', 14, x => { delete x.checkpointDigest; }],
  ['resume with old protocol', 14, x => { x.protocolVersion = '1.0'; }],
  ['false barrier', 9, x => { x.barrierApplied = false; }],
  ['missing document identity', 11, x => { delete x.data.surface.documentId; }],
  ['scroll without amount', 1, x => { x.data.candidates[0].operation = 'scroll'; }],
  ['foreign set_value parameter', 1, x => {
    x.data.candidates[0].operation = 'set_value';
    x.data.candidates[0].parameters = { textRef: 'text', urlRef: 'url' };
  }],
];
for (const [name, index, mutate] of invalidCases) {
  test(`schema rejects ${name}`, () => {
    const example = structuredClone(schema.examples[index]); mutate(example);
    assert.throws(() => decodeMessage(bytes(example)));
  });
}

test('uncertain objective preserves known delivery and effect', () => {
  for (const [effectStatus, deliveryStatus] of [['applied', 'dispatched'], ['not_applied', 'not_dispatched']]) {
    const receipt = { ...schema.examples[8], effectStatus, deliveryStatus };
    assert.deepEqual(decodeMessage(bytes(receipt)), receipt);
  }
});

test('framing accepts fragments and coalesced messages', () => {
  const message = decodeMessage(bytes(schema.examples[0]));
  const wire = frame(message);
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(wire.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(Buffer.concat([wire.subarray(3), wire])), [message, message]);
  decoder.end();
  assert.throws(() => decoder.push(wire));
});

test('invalid framing poisons the transport; truncated input cannot complete', () => {
  const decoder = new FrameDecoder();
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(MAX_MESSAGE_BYTES + 1);
  assert.throws(() => decoder.push(oversized));
  assert.throws(() => decoder.push(Buffer.alloc(0)));
  const truncated = new FrameDecoder(); truncated.push(Buffer.from([0, 0]));
  assert.throws(() => truncated.end());
});
