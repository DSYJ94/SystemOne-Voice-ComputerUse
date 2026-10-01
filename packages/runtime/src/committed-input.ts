import { receive } from '../../protocol/src/session.ts';
import type { Endpoint, TaskRevision } from '../../protocol/src/session.ts';
import type { Message } from '../../protocol/src/contract.ts';
import { ContractError, digest, parseJSON } from '../../protocol/src/json.ts';

export interface CommittedInput extends Message {
  type: 'command';
  source: 'voice' | 'text';
  mode: 'command' | 'dictation';
  utteranceId: string;
  utteranceRevision: number;
  text: string;
  isFinal: true;
}

export interface CorrectionSource {
  readonly taskId: string;
  readonly taskEpoch: number;
  readonly goalRevision: number;
  readonly commandMessageId: string;
  readonly commandDigest: string;
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
  readonly #issued = new WeakSet<object>();
  readonly #claimed = new WeakSet<object>();
  readonly #transferred = new WeakSet<object>();
  readonly #corrections = new WeakSet<object>();
  #correctionSource: CorrectionSource | undefined;
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
    const input = Object.freeze({ ...message });
    this.#utterances.add(input.utteranceId);
    this.#messages.add(input.messageId);
    this.#issued.add(input);
    return { kind: input.mode === 'dictation' ? 'literal_dictation' : 'interpret_command', input };
  }

  /** One-use in-process proof that this exact command passed the bound input
   * endpoint. This is not OS peer authentication and is never serialized. */
  claimForAdmission(input: CommittedInput): void {
    if (this.#closed || !this.#issued.has(input) || this.#claimed.has(input)) {
      throw new ContractError('command was not issued by this input session or was claimed');
    }
    this.#claimed.add(input);
  }

  /** Called by durable correction cancellation, not ordinary admission. */
  claimForCorrection(input: CommittedInput): void {
    if (input.mode !== 'command' || input.goalRevision < 2) throw new ContractError('invalid correction command');
    this.claimForAdmission(input);
    this.#corrections.add(input);
  }

  /** Transfer a claimed correction exactly once; never accept its JSON again.
   * The journal separately verifies this provenance against durable cancellation
   * before admitting the derived task. The host must fence the old worker first. */
  transferClaimedCorrection(input: CommittedInput, revision: TaskRevision): {
    readonly session: CommittedInputSession; readonly input: CommittedInput;
  } {
    if (this.#closed || !this.#issued.has(input) || !this.#corrections.has(input)
      || this.#transferred.has(input) || input.mode !== 'command' || input.goalRevision < 2
      || !/^[A-Za-z0-9_.:-]{1,160}$/.test(revision.taskId) || revision.taskId === input.taskId
      || revision.taskEpoch !== 1 || revision.goalRevision !== input.goalRevision) {
      throw new ContractError('invalid or replayed correction transfer');
    }
    this.#transferred.add(input);
    const session = new CommittedInputSession(this.#endpoint, revision);
    const transferred = Object.freeze({ ...input, ...revision });
    session.#issued.add(transferred);
    // Prevent the same command from also being reaccepted through this session.
    session.#messages.add(input.messageId); session.#utterances.add(input.utteranceId);
    session.#correctionSource = Object.freeze({ taskId: input.taskId, taskEpoch: input.taskEpoch,
      goalRevision: input.goalRevision, commandMessageId: input.messageId,
      commandDigest: digest(parseJSON(Buffer.from(JSON.stringify(input)))) });
    return Object.freeze({ session, input: transferred });
  }

  get correctionSource(): CorrectionSource | undefined { return this.#correctionSource; }

  close(): void { this.#closed = true; }
}

function isCommittedInput(message: Message): message is CommittedInput {
  return message.type === 'command' && message.isFinal === true
    && (message.source === 'voice' || message.source === 'text')
    && (message.mode === 'command' || message.mode === 'dictation')
    && typeof message.utteranceId === 'string' && typeof message.utteranceRevision === 'number'
    && typeof message.text === 'string';
}
