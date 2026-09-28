import { ContractError, digest } from '../../protocol/src/json.ts';
import type { CommittedInput } from './committed-input.ts';
import type { TaskParameter } from './task-authority.ts';

/** Bind a literal value to the final, host-issued command before driver I/O.
 * The suffix format makes even repeated or quoted text unambiguous. Offsets
 * are bytes into the immutable UTF-8 command text, not JS/Swift indices. */
export function bindCommandValue(input: CommittedInput, parameterRef: string,
  prefix: string, value: string): TaskParameter {
  if (!prefix.isWellFormed() || !value.isWellFormed()
    || input.text !== prefix + value) {
    throw new ContractError('command value differs from final input');
  }
  const sourceStart = Buffer.byteLength(prefix, 'utf8');
  const sourceEnd = sourceStart + Buffer.byteLength(value, 'utf8');
  return Object.freeze({ parameterRef,
    sourceRef: `utterance.${input.utteranceId}.r${input.utteranceRevision}`,
    valueDigest: digest(value), sourceStart, sourceEnd,
    offsetUnit: 'utf8_bytes' });
}
