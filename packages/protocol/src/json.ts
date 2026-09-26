import { createHash } from 'node:crypto';
import { parseTree, visit as visitJSON } from 'jsonc-parser';
import type { Node, ParseError } from 'jsonc-parser';

export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export const MAX_MESSAGE_BYTES = 1_048_576;
const MAX_DEPTH = 64;

export class ContractError extends Error {}

/** No comments, trailing commas, duplicate keys, lossy integers or invalid UTF-8. */
export function parseJSON(bytes: Uint8Array): JSONValue {
  if (bytes.byteLength > MAX_MESSAGE_BYTES) throw new ContractError('message too large');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new ContractError('invalid UTF-8'); }
  // Bound descent while the library parses, before constructing a full AST.
  let nesting = 0;
  const enter = () => { if (++nesting > MAX_DEPTH) throw new ContractError('JSON too deep'); };
  const leave = () => { nesting--; };
  visitJSON(text, { onObjectBegin: enter, onArrayBegin: enter,
    onObjectEnd: leave, onArrayEnd: leave }, { disallowComments: true });
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (!tree || errors.length) throw new ContractError('invalid JSON');
  function visit(node: Node, depth: number): void {
    if (depth > MAX_DEPTH) throw new ContractError('JSON too deep');
    if (node.type === 'object') {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value;
        if (typeof key !== 'string' || keys.has(key)) throw new ContractError('duplicate JSON key');
        keys.add(key);
      }
    }
    if (node.type === 'number') {
      const n: number = node.value;
      if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) {
        throw new ContractError('non-finite or unsafe number');
      }
    }
    if (node.type === 'string' && !(node.value as string).isWellFormed()) {
      throw new ContractError('unpaired surrogate');
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
  }
  visit(tree, 0);
  return JSON.parse(text) as JSONValue;
}

/** Restricted fixture canonicalization, versioned by protocol 2.0. */
export function canonicalJSON(value: JSONValue, depth = 0): string {
  if (depth > MAX_DEPTH) throw new ContractError('digest too deep');
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new ContractError('digest numbers must be safe integers');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new ContractError('unpaired surrogate');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(v => canonicalJSON(v, depth + 1)).join(',')}]`;
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ContractError('unsupported digest value');
  }
  const keys = Object.keys(value).sort();
  if (keys.some(k => /[^\x00-\x7f]/u.test(k))) throw new ContractError('digest keys must be ASCII');
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJSON(value[k]!, depth + 1)}`).join(',')}}`;
}

export function digest(value: JSONValue): string {
  return createHash('sha256').update(canonicalJSON(value), 'utf8').digest('hex');
}
