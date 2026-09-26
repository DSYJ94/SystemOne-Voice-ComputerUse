import { writeFileSync } from 'node:fs';
import { schema } from '../packages/protocol/src/contract.ts';
import { canonicalJSON, digest } from '../packages/protocol/src/json.ts';
import type { JSONValue } from '../packages/protocol/src/json.ts';

const request = schema.examples[2];
const candidate = request.observation.candidates[0];
const vectors: Record<string, JSONValue> = {
  candidates: request.observation.candidates,
  providerView: request.providerView,
  action: { candidate, scopeRef: request.context.scopeRef, bindings: request.context.bindings },
  unicode: { text: 'café e\u0301 😀 / \u0000', values: [true, false, null, 9007199254740991] },
};
writeFileSync(new URL('../tests/fixtures/digests.json', import.meta.url), JSON.stringify(
  Object.entries(vectors).map(([name, value]) => ({ name, value, canonical: canonicalJSON(value), sha256: digest(value) })),
  null, 2,
) + '\n');
