import { ContractError, parseJSON } from '../../protocol/src/json.ts';
import { validateProviderView } from '../../protocol/src/contract.ts';
import { requestDecision } from '../../runtime/src/provider-egress.ts';
import type { ApprovedProjection, EgressPolicy, ProviderRegistration } from '../../runtime/src/provider-egress.ts';
import type { BuiltCandidateSet } from '../../runtime/src/action-candidates.ts';
import { decodeCLMChoice, encodeCLMProviderView } from './clm-wire.ts';
import type { CLMProviderView } from './clm-wire.ts';

/** Provider wire format. CLM and Jev share the /v1/systemone choice shape but
 * differ in model identity and temperature; everything else is host policy. */
export interface DecisionCodec {
  readonly provider: 'clm' | 'jev';
  encode(view: CLMProviderView, temperature: number): Uint8Array;
  decode(raw: unknown, view: CLMProviderView): {
    readonly choice: string; readonly probabilities: Readonly<Record<string, number>>; readonly inputTokens: number };
}
export const CLM_CODEC: DecisionCodec = Object.freeze({ provider: 'clm',
  encode: encodeCLMProviderView, decode: decodeCLMChoice });

export interface CLMTransport {
  send(body: Uint8Array, signal: AbortSignal): Promise<unknown>;
}
export interface CLMCalibration {
  readonly revision: string;
  readonly temperature: number;
  readonly minProbability: number;
  readonly minMargin: number;
}
export interface CLMProposal {
  readonly observationId: string;
  readonly candidateSetDigest: string;
  readonly providerRevision: string;
  readonly calibrationRevision: string;
  readonly candidateId: string | null;
  readonly status: 'selected' | 'request_help' | 'wait' | 'abstained';
  readonly reason: 'accepted' | 'low_confidence' | 'non_effect_choice' | 'unavailable' | 'invalid_output';
  readonly inputTokens: number | null;
  /** Probability of the model's top choice, for display only; never authority. */
  readonly topProbability: number | null;
}

/** Produces a bounded proposal, never an admission, permission or verifier.
 * Host registration/disclosure policy is enforced before serialization/I/O.
 * Calibration values must come from a reviewed host record; synthetic tests do
 * not establish calibration or artifact qualification for live execution. */
export class CLMDecisionClient {
  readonly #policy: EgressPolicy;
  readonly #provider: ProviderRegistration;
  readonly #calibration: CLMCalibration;
  readonly #transport: CLMTransport;
  readonly #codec: DecisionCodec;

  constructor(policy: EgressPolicy, provider: ProviderRegistration,
    calibration: CLMCalibration, transport: CLMTransport, codec: DecisionCodec = CLM_CODEC) {
    if (provider.name !== codec.provider || !/^[A-Za-z0-9_.:-]{1,160}$/.test(calibration.revision)
      || !Number.isFinite(calibration.temperature) || calibration.temperature <= 0 || calibration.temperature > 100
      || ![calibration.minProbability, calibration.minMargin].every(x => Number.isFinite(x) && x >= 0 && x <= 1)) {
      throw new ContractError('invalid CLM registration or host calibration');
    }
    this.#policy = Object.freeze({ ...policy, enabledProviderIds: Object.freeze([...policy.enabledProviderIds]) });
    this.#provider = Object.freeze({ ...provider }); this.#calibration = Object.freeze({ ...calibration });
    this.#transport = transport; this.#codec = codec;
  }

  async decide(set: BuiltCandidateSet, approved: ApprovedProjection, signal: AbortSignal): Promise<CLMProposal> {
    if (signal.aborted) throw new ContractError('CLM decision cancelled before I/O');
    const snapshot = parseJSON(Buffer.from(JSON.stringify(approved.value)));
    validateProviderView(snapshot);
    const view = snapshot as unknown as CLMProviderView;
    if (!Array.isArray(view.candidates) || view.candidates.length !== set.candidates.length
      || view.candidates.some((c, i) => c.candidateId !== set.candidates[i]?.candidateId
        || c.description !== set.candidates[i]?.description)) {
      throw new ContractError('CLM projection differs from the offered candidate set');
    }
    const base = { observationId: set.observationId, candidateSetDigest: set.candidateSetDigest,
      providerRevision: this.#provider.revision, calibrationRevision: this.#calibration.revision };
    let transportFailed = false;
    const raw = await requestDecision(this.#policy, this.#provider, approved, {
      send: async (_provider, payload) => {
        if (signal.aborted) throw new ContractError('CLM decision cancelled before transport');
        // Use exactly the projection that passed the pre-I/O boundary.
        const projected = parseJSON(payload) as unknown as CLMProviderView;
        const body = this.#codec.encode(projected, this.#calibration.temperature);
        try { return await this.#transport.send(body, signal); }
        catch { transportFailed = true; return null; }
      },
    });
    if (signal.aborted) throw new ContractError('CLM decision cancelled after transport');
    if (transportFailed) return Object.freeze({ ...base, candidateId: null, status: 'abstained',
      reason: 'unavailable', inputTokens: null, topProbability: null });
    try {
      const choice = this.#codec.decode(raw, view);
      const probabilities = Object.values(choice.probabilities).sort((a, b) => b - a);
      if (probabilities[0]! < this.#calibration.minProbability
        || probabilities[0]! === probabilities[1]!
        || probabilities[0]! - probabilities[1]! < this.#calibration.minMargin) {
        return Object.freeze({ ...base, candidateId: null, status: 'abstained',
          reason: 'low_confidence', inputTokens: choice.inputTokens, topProbability: probabilities[0]! });
      }
      const candidate = set.candidates.find(c => c.candidateId === choice.choice)!;
      if (candidate.operation === 'wait' || candidate.operation === 'request_help') {
        return Object.freeze({ ...base, candidateId: choice.choice, status: candidate.operation,
          reason: 'non_effect_choice', inputTokens: choice.inputTokens, topProbability: probabilities[0]! });
      }
      if (set.abstained || !set.resolve(choice.choice, set.observationId, set.candidateSetDigest)) {
        throw new ContractError('CLM candidate does not resolve');
      }
      return Object.freeze({ ...base, candidateId: choice.choice, status: 'selected',
        reason: 'accepted', inputTokens: choice.inputTokens, topProbability: probabilities[0]! });
    } catch { return Object.freeze({ ...base, candidateId: null, status: 'abstained',
      reason: 'invalid_output', inputTokens: null, topProbability: null }); }
  }
}
