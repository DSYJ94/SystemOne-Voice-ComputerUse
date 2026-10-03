import { approveCandidateProjection } from '../../runtime/src/action-candidates.ts';
import type { BuiltCandidateSet } from '../../runtime/src/action-candidates.ts';
import type { NativeFixtureDecision } from '../../runtime/src/native-fixture-task.ts';
import type { NativePressObservation } from '../../runtime/src/native-press-authority.ts';
import type { EgressPolicy, ProviderRegistration } from '../../runtime/src/provider-egress.ts';
import { CLMDecisionClient } from './clm-decision-client.ts';
import type { CLMProposal, CLMTransport } from './clm-decision-client.ts';
import { createCLMHTTPTransport } from './clm-http-transport.ts';
import { JEV_CODEC, JEV_ENDPOINT, JEV_MODEL } from './jev-wire.ts';

const FIXTURE_BUNDLE = 'com.aurium.systemone.fixture';
const PROVIDER: ProviderRegistration = Object.freeze({ id: 'typesafe-jev', name: 'jev',
  location: 'external_service', revision: JEV_MODEL });
// Explicit per-task opt-in is the only way this policy is constructed.
const POLICY: EgressPolicy = Object.freeze({ mode: 'external_opt_in', enabledProviderIds: [PROVIDER.id] });
// Development thresholds, NOT calibrated: no reviewed corpus fit exists yet.
const CALIBRATION = Object.freeze({ revision: 'jev-fixture-dev-uncalibrated', temperature: 1,
  minProbability: 0.5, minMargin: 0.1 });
const QUESTION = 'Choose the one offered action that advances the goal within its scope.';

export interface FixtureDecisionEvent {
  readonly provider: 'jev';
  readonly model: string;
  readonly status: CLMProposal['status'];
  readonly reason: CLMProposal['reason'];
  readonly label: string | null;
  readonly probability: number | null;
}

/** Jev selector for the synthetic fixture only. It sees fixture window text
 * and control labels, never handles, permits or the journal; the task still
 * verifies every press independently. */
export function createJevFixtureDecision(options: {
  readonly apiKey?: string; readonly goal: string; readonly report: (event: FixtureDecisionEvent) => void;
  readonly transport?: CLMTransport;
}): NativeFixtureDecision {
  const transport = options.transport ?? createCLMHTTPTransport({ endpoint: JEV_ENDPOINT,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}), timeoutMs: 15_000 });
  const client = new CLMDecisionClient(POLICY, PROVIDER, CALIBRATION, transport, JEV_CODEC);
  return Object.freeze({ offerAllControls: true,
    async select(set: BuiltCandidateSet, observed: NativePressObservation, signal: AbortSignal) {
      if (observed.bundleId !== FIXTURE_BUNDLE) return null;
      const labels = observed.controls.filter(c => c.enabled).map(c => `“${c.label}”`).join(', ');
      const stateText = `Goal: ${options.goal}. Current state: the window is titled “${observed.windowTitles[0]}”`
        + ` and shows the controls ${labels}. Scope: do only what the goal asks.`;
      const approved = approveCandidateProjection({ set, stateText, questionText: QUESTION,
        provider: PROVIDER, disclosureReview: () => observed.bundleId === FIXTURE_BUNDLE });
      const proposal = await client.decide(set, approved, signal);
      const binding = proposal.candidateId && set.resolve(proposal.candidateId, set.observationId, set.candidateSetDigest);
      const label = binding ? observed.controls.find(c => c.id === binding.targetRef)?.label ?? null
        : proposal.status === 'wait' || proposal.status === 'request_help' ? proposal.status : null;
      options.report(Object.freeze({ provider: 'jev', model: JEV_MODEL, status: proposal.status,
        reason: proposal.reason, label, probability: proposal.topProbability }));
      return proposal.status === 'selected' ? proposal.candidateId : null;
    } });
}
