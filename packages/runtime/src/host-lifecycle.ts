import { ContractError } from '../../protocol/src/json.ts';

export interface HostLifecycleSnapshot {
  readonly type: 'host_lifecycle';
  readonly requestId: string;
  readonly sequence: number;
  readonly sleeping: boolean;
  readonly sessionActive: boolean;
}

/** Trusted host snapshots on its owned pipe. Full snapshots and monotonic
 * sequence prevent an old wake from undoing a newer session suspension.
 * Availability cannot supply a command, resume intent, or execution authority. */
export class HostLifecycleGate {
  #sequence = 0;
  #known: boolean;
  #sleeping = false;
  #sessionActive = true;

  constructor(requireInitialSnapshot = false) { this.#known = !requireInitialSnapshot; }
  get sequence(): number { return this.#sequence; }
  get available(): boolean { return this.#known && !this.#sleeping && this.#sessionActive; }

  accept(value: unknown): { readonly accepted: boolean; readonly interrupted: boolean } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('invalid host snapshot');
    const message = value as Record<string, unknown>;
    if (Object.keys(message).sort().join(',') !== 'requestId,sequence,sessionActive,sleeping,type'
      || message.type !== 'host_lifecycle' || typeof message.requestId !== 'string'
      || !/^[A-Za-z0-9_.:-]{1,160}$/.test(message.requestId)
      || !Number.isSafeInteger(message.sequence) || (message.sequence as number) < 1
      || typeof message.sleeping !== 'boolean' || typeof message.sessionActive !== 'boolean') {
      throw new ContractError('invalid host snapshot');
    }
    if ((message.sequence as number) <= this.#sequence) return { accepted: false, interrupted: false };
    const before = this.available;
    this.#sequence = message.sequence as number; this.#known = true;
    this.#sleeping = message.sleeping; this.#sessionActive = message.sessionActive;
    return { accepted: true, interrupted: before && !this.available };
  }
}
