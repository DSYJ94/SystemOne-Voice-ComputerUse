import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ContractError, digest } from '../../protocol/src/json.ts';
import { bindEndpoint } from '../../protocol/src/session.ts';
import { PersistentTaskActor } from './persistent-task-actor.ts';
import { UserPromptLedger } from './user-prompts.ts';
import type { NativeRecoveryPrompt } from './native-fixture-authority.ts';

/** Host-private prompt state for one retained native actor. The inherited UI
 * must confirm actual presentation before its exact one-use reply is accepted. */
export class NativeActorRecovery {
  readonly #actor: PersistentTaskActor;
  #prompt: { descriptor: NativeRecoveryPrompt; endpoint: ReturnType<typeof bindEndpoint>;
    ledger: UserPromptLedger; presented: boolean } | undefined;
  constructor(actor: PersistentTaskActor) { this.#actor = actor; }
  async prepare(uiSessionRef: string): Promise<NativeRecoveryPrompt> {
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(uiSessionRef)) throw new ContractError('invalid UI session');
    this.close();
    const binding = await this.#actor.prepareRecovery();
    const presentation = Object.freeze({ title: 'Resume native field task?',
      text: `${this.#actor.snapshot.admission!.goal}\nCheckpoint: ${binding.checkpointRef}\nRevision: ${binding.goalRevision}. Original limits still apply.`,
      resumeLabel: 'Resume', cancelLabel: 'Keep Paused' });
    const descriptor: NativeRecoveryPrompt = Object.freeze({ ...binding, promptId: randomUUID(),
      actorRef: 'native-dev-ui', uiSessionRef, presentation, presentationDigest: digest(presentation) });
    const endpoint = bindEndpoint(['clarification_reply', 'resume_request']);
    this.#prompt = { descriptor, endpoint, presented: false,
      ledger: new UserPromptLedger(endpoint, binding, descriptor.actorRef, uiSessionRef, () => performance.now()) };
    return descriptor;
  }
  presented(promptId: string, presentationDigest: string, uiSessionRef: string): void {
    const prompt = this.#prompt;
    if (!prompt || prompt.presented || prompt.descriptor.promptId !== promptId
      || prompt.descriptor.presentationDigest !== presentationDigest || prompt.descriptor.uiSessionRef !== uiSessionRef) {
      throw new ContractError('field recovery presentation mismatch');
    }
    prompt.ledger.presentResume(prompt.descriptor, 20_000);
    this.#actor.bindPrompt(prompt.ledger); prompt.presented = true;
  }
  dismiss(promptId: string, uiSessionRef: string): void {
    if (this.#prompt?.descriptor.promptId !== promptId || this.#prompt.descriptor.uiSessionRef !== uiSessionRef) {
      throw new ContractError('stale field recovery dismissal');
    }
    this.close();
  }
  activate(bytes: Uint8Array): void {
    const prompt = this.#prompt;
    if (!prompt?.presented) throw new ContractError('no displayed field recovery prompt');
    const intent = prompt.ledger.acceptResume(prompt.endpoint, bytes, prompt.descriptor.recoveryObservationId);
    this.#actor.resume(prompt.ledger, intent); this.#prompt = undefined;
  }
  close(): void { this.#prompt?.ledger.close(); this.#prompt = undefined; }
}
