import { generateKeyPairSync, sign } from 'node:crypto';
import { ContractError, canonicalJSON } from '../../protocol/src/json.ts';
import type { PreparedAttempt } from './attempt-journal.ts';
import type { JSONValue } from '../../protocol/src/json.ts';
import type { KeyObject } from 'node:crypto';

const DOMAIN = 'systemone.native.commit.v1';

/** Ephemeral per-controller signing key. The AppKit parent pins this public
 * key to the running bundled controller identity before worker dispatch. */
export class NativeHostPermitSigner {
  readonly #privateKey: KeyObject;
  readonly publicKey: string;

  constructor() {
    const pair = generateKeyPairSync('ed25519');
    this.#privateKey = pair.privateKey;
    const key = pair.publicKey.export({ format: 'jwk' });
    if (typeof key.x !== 'string') throw new ContractError('missing Ed25519 public key');
    this.publicKey = key.x;
  }

  sign(permit: PreparedAttempt, preparationRef: string,
    nowMs = Date.now()): { readonly permit: Record<string, JSONValue>;
      readonly preparationRef: string; readonly expiresAtMs: number;
      readonly signature: string } {
    if (!Number.isSafeInteger(nowMs) || typeof preparationRef !== 'string') {
      throw new ContractError('invalid native permit time or preparation reference');
    }
    const copied: Record<string, JSONValue> = {
      executionId: permit.executionId, permitRef: permit.permitRef,
      taskId: permit.taskId, taskEpoch: permit.taskEpoch,
      goalRevision: permit.goalRevision, scopeRef: permit.scopeRef,
      observationId: permit.observationId, candidateId: permit.candidateId,
      candidateSetDigest: permit.candidateSetDigest,
      actionDigest: permit.actionDigest, policyRevision: permit.policyRevision,
      leaseGeneration: permit.leaseGeneration,
    };
    const expiresAtMs = nowMs + 10_000;
    const claim: JSONValue = { domain: DOMAIN, permit: copied,
      preparationRef, expiresAtMs };
    const signature = sign(null, Buffer.from(canonicalJSON(claim), 'utf8'),
      this.#privateKey).toString('base64url');
    return { permit: copied, preparationRef, expiresAtMs, signature };
  }
}
