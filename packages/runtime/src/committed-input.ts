import { receive } from '../../protocol/src/session.ts';
import type { Endpoint, TaskRevision } from '../../protocol/src/session.ts';
import type { Message } from '../../protocol/src/contract.ts';
import { ContractError } from '../../protocol/src/json.ts';

export interface CommittedInput extends Message {
  type: 'command';
  source: 'voice' | 'text';
  mode: 'command' | 'dictation';
  utteranceId: string;
  utteranceRevision: number;
  text: string;
  isFinal: true;
}

export type InputRoute =
  | { readonly kind: 'interpret_command'; readonly input: CommittedInput }
  | { readonly kind: 'literal_dictation'; readonly input: CommittedInput };

/** One host-issued input session for a single task revision. Pure routing only:
 * no task admission, model requests, approvals, permits or driver calls occur here.
 * Dictation still needs a separately validated editable destination.
 */
export class CommittedInputSession {
  readonly #endpoint: Endpoint;
  readonly #revision: TaskRevision;
  readonly #utterances = new Set<string>();
  readonly #messages = new Set<string>();
  #closed = false;

  constructor(endpoint: Endpoint, revision: TaskRevision) {
    this.#endpoint = endpoint;
    this.#revision = Object.freeze({ ...revision });
  }

  accept(endpoint: Endpoint, bytes: Uint8Array): InputRoute {
    if (this.#closed || endpoint !== this.#endpoint) throw new ContractError('input session closed or wrong endpoint');
    const message = receive(endpoint, bytes);
    if (message.type !== 'command') throw new ContractError('expected committed command');
    for (const key of ['taskId', 'taskEpoch', 'goalRevision'] as const) {
      if (message[key] !== this.#revision[key]) throw new ContractError('input revision mismatch');
    }
    // Schema validation establishes these fields. This guard supplies the type
    // refinement without permitting a type assertion to bypass input validation.
    if (!isCommittedInput(message)) throw new ContractError('invalid committed input');
    if (this.#utterances.has(message.utteranceId) || this.#messages.has(message.messageId)) {
      throw new ContractError('committed input replay');
    }
    if (this.#utterances.size >= 1_000) throw new ContractError('input session budget exceeded');
    this.#utterances.add(message.utteranceId);
    this.#messages.add(message.messageId);
    return { kind: message.mode === 'dictation' ? 'literal_dictation' : 'interpret_command', input: message };
  }

  close(): void { this.#closed = true; }
}

function isCommittedInput(message: Message): message is CommittedInput {
  return message.type === 'command' && message.isFinal === true
    && (message.source === 'voice' || message.source === 'text')
    && (message.mode === 'command' || message.mode === 'dictation')
    && typeof message.utteranceId === 'string' && typeof message.utteranceRevision === 'number'
    && typeof message.text === 'string';
}
