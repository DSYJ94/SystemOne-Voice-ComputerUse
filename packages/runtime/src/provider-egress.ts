import { validateProviderView } from '../../protocol/src/contract.ts';
import { ContractError, digest } from '../../protocol/src/json.ts';
import type { JSONValue } from '../../protocol/src/json.ts';

export interface ProviderRegistration {
  readonly id: string;
  readonly name: 'clm' | 'laya' | 'jev';
  readonly location: 'local' | 'owned_service' | 'external_service';
  readonly revision: string;
}
export interface EgressPolicy {
  readonly mode: 'offline' | 'owned_service' | 'external_opt_in';
  readonly enabledProviderIds: readonly string[];
}
export interface ApprovedProjection {
  readonly value: JSONValue;
  readonly digest: string;
  readonly providerId: string;
  readonly providerRevision: string;
}
export interface DecisionTransport {
  send(provider: Readonly<ProviderRegistration>, payload: Uint8Array): Promise<unknown>;
}

/** Caller is the trusted host, not a provider response or UI-content parser.
 * The projection must already have passed host disclosure review. This is an
 * additional pre-I/O boundary, not a secret detector or an approval issuer.
 */
export async function requestDecision(
  policy: EgressPolicy, registration: ProviderRegistration,
  approved: ApprovedProjection, transport: DecisionTransport,
): Promise<unknown> {
  // Copy primitives before crossing an async boundary; never trust returned metadata.
  const provider = Object.freeze({ ...registration });
  if (!policy.enabledProviderIds.includes(provider.id)) throw new ContractError('provider disabled');
  if (policy.mode === 'offline' && provider.location !== 'local') throw new ContractError('offline egress denied');
  if (policy.mode === 'owned_service' && provider.location === 'external_service') throw new ContractError('external egress denied');
  if (provider.name === 'jev' && provider.location !== 'external_service') throw new ContractError('invalid Jev registration');
  if (approved.providerId !== provider.id || approved.providerRevision !== provider.revision) {
    throw new ContractError('projection approved for a different provider');
  }
  validateProviderView(approved.value);
  if (digest(approved.value) !== approved.digest) throw new ContractError('projection changed');
  const payload = new TextEncoder().encode(JSON.stringify(approved.value));
  return transport.send(provider, payload);
}
