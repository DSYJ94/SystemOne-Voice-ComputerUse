import type { BrowseDecision } from '../../browser/src/managed-browse-task.ts';
import { approveCandidateProjection } from '../../runtime/src/action-candidates.ts';
import type { EgressPolicy, ProviderRegistration } from '../../runtime/src/provider-egress.ts';
import { CLMDecisionClient } from './clm-decision-client.ts';
import type { CLMTransport } from './clm-decision-client.ts';
import { createCLMHTTPTransport } from './clm-http-transport.ts';
import type { FixtureDecisionEvent } from './jev-fixture-decision.ts';
import { JEV_CODEC, JEV_ENDPOINT, JEV_MODEL } from './jev-wire.ts';

const PROVIDER: ProviderRegistration = Object.freeze({ id: 'typesafe-jev', name: 'jev',
  location: 'external_service', revision: JEV_MODEL });
const POLICY: EgressPolicy = Object.freeze({ mode: 'external_opt_in', enabledProviderIds: [PROVIDER.id] });
// Development thresholds, NOT calibrated. Browsing often has two reasonable
// next steps (type in the search box, or follow a matching link); every step
// is user-confirmed or explicitly auto-allowed and verified, so a near-tie
// takes the top choice. An exact tie or a weak top choice still abstains.
const CALIBRATION = Object.freeze({ revision: 'jev-browse-dev-uncalibrated-2', temperature: 1,
  minProbability: 0.35, minMargin: 0.000001 });
const QUESTION = 'Choose the one offered action that best advances the goal on this page. '
  + 'Choose finish only if the goal is already achieved on the current page.';

/** Jev chooses one host-built candidate per page. It receives the user's goal,
 * the page title/URL and the candidate descriptions (visible labels and
 * approved link URLs); never handles, permits, cookies or page bodies. */
export function createJevBrowseDecision(options: {
  readonly apiKey?: string; readonly goal: string;
  readonly report: (event: FixtureDecisionEvent) => void; readonly transport?: CLMTransport;
}): BrowseDecision {
  const transport = options.transport ?? createCLMHTTPTransport({ endpoint: JEV_ENDPOINT,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}), timeoutMs: 15_000 });
  const client = new CLMDecisionClient(POLICY, PROVIDER, CALIBRATION, transport, JEV_CODEC);
  const project = (set: Parameters<BrowseDecision['select']>[0], observed: Parameters<BrowseDecision['select']>[1],
    history: readonly string[]) => {
    const stateText = `Goal: ${options.goal}. Current page: “${observed.title || 'untitled'}” at ${observed.url}.`
      + (history.length ? ` Done so far: ${history.join(' ')}` : ' Nothing has been done yet.')
      + ' Scope: stay on this site; only follow offered links, type the user\'s own search words, or submit a search.';
    return approveCandidateProjection({ set, stateText: stateText.slice(0, 24_000),
      questionText: QUESTION, provider: PROVIDER, disclosureReview: () => true });
  };
  const decision: BrowseDecision = {
    /** Preliminary round: up to two plausible effect candidates, unreported. */
    async bestActions(set, observed, signal, history) {
      const proposal = await client.decide(set, project(set, observed, history), signal);
      return Object.entries(proposal.probabilities ?? {})
        .filter(([id, probability]) => probability >= 0.05 && set.resolve(id, set.observationId, set.candidateSetDigest))
        .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => id);
    },
    async select(set, observed, signal, history) {
    const proposal = await client.decide(set, project(set, observed, history), signal);
    const binding = proposal.candidateId
      && set.resolve(proposal.candidateId, set.observationId, set.candidateSetDigest);
    const label = binding ? observed.controls.find(c => c.id === binding.targetRef)?.label ?? null
      : proposal.status === 'abstained' || proposal.status === 'selected' ? null : proposal.status;
    options.report(Object.freeze({ provider: 'jev', model: JEV_MODEL, status: proposal.status,
      reason: proposal.reason, label, probability: proposal.topProbability }));
    return proposal.status === 'selected' || proposal.status === 'finish' ? proposal.candidateId : null;
  } };
  return Object.freeze(decision);
}
