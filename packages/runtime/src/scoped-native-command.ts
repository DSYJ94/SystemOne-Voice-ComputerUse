import { ContractError } from '../../protocol/src/json.ts';

/** Parse a small, explicit command without inventing a target or value. */
export function parseScopedNativeFill(text: string): {
  readonly fieldLabel: string;
  readonly value: string;
  readonly prefix: string;
} {
  if (!text.isWellFormed() || Buffer.byteLength(text, 'utf8') > 1_300) {
    throw new ContractError('scoped native command too large or malformed');
  }
  const match = /^(fill )(.+?)( with )(.+)$/i.exec(text);
  if (!match || !match[2] || !match[4]
    || match[2].trim() !== match[2] || match[4].trim() !== match[4]
    || match[2].length > 160 || Buffer.byteLength(match[4], 'utf8') > 1_024) {
    throw new ContractError('unsupported scoped native command');
  }
  return Object.freeze({ fieldLabel: match[2], value: match[4],
    prefix: match[1]! + match[2] + match[3]! });
}

export function parseScopedManagedFill(text: string): {
  readonly url: string;
  readonly fieldLabel: string;
  readonly value: string;
  readonly prefix: string;
} {
  if (!text.isWellFormed() || Buffer.byteLength(text, 'utf8') > 3_350) {
    throw new ContractError('scoped managed command too large or malformed');
  }
  const match = /^(fill )(.+?)( on )(\S+)( with )(.+)$/i.exec(text);
  if (!match || !match[2] || !match[4] || !match[6]
    || match[2].trim() !== match[2] || match[6].trim() !== match[6]
    || match[2].length > 160 || Buffer.byteLength(match[4], 'utf8') > 2_048
    || Buffer.byteLength(match[6], 'utf8') > 1_024) {
    throw new ContractError('unsupported scoped managed command');
  }
  return Object.freeze({ fieldLabel: match[2], url: match[4], value: match[6],
    prefix: match[1]! + match[2] + match[3]! + match[4] + match[5]! });
}
