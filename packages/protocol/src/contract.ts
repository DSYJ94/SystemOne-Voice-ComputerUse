import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ContractError, parseJSON } from './json.ts';
import type { JSONValue } from './json.ts';

export const MESSAGE_TYPES = [
  'command', 'approval', 'clarification_reply', 'resume_request',
  'observation', 'decision_request', 'decision_proposal',
  'execution_request', 'execution_receipt', 'cancel', 'execution_permit',
  'cancel_ack', 'task_status',
] as const;
export type MessageType = typeof MESSAGE_TYPES[number];

/** Structurally validated envelope; not executable authority. */
export interface Message {
  [key: string]: JSONValue;
  type: MessageType;
  protocolVersion: '2.0';
  messageId: string;
  taskId: string;
  taskEpoch: number;
  goalRevision: number;
}

export const schema = JSON.parse(readFileSync(new URL('../protocol.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: true });
addFormats.default(ajv);
// The reviewed schema uses required/const constraints across allOf branches.
// No coercion, defaults, removal of fields, remote refs or provider-supplied schema.
const validator = ajv.compile<Message>(schema);

export function validateProviderView(value: JSONValue): void {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/ProviderView`);
  if (!validate || !validate(value)) throw new ContractError('invalid provider view');
}

export function validateCandidate(value: JSONValue): void {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/Candidate`);
  if (!validate || !validate(value)) throw new ContractError('invalid action candidate');
}

export function decodeMessage(bytes: Uint8Array): Message {
  const value = parseJSON(bytes);
  if (!validator(value)) throw new ContractError('message does not satisfy protocol 2.0');
  return value;
}

export function encodeMessage(message: Message): Uint8Array {
  const wire = new TextEncoder().encode(JSON.stringify(message));
  // Validate outbound records too; the returned value is never treated as a permit.
  decodeMessage(wire);
  return wire;
}
