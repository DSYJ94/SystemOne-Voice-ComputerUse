import { approveCandidateProjection } from '../../runtime/src/action-candidates.ts';
import type { BuiltCandidateSet } from '../../runtime/src/action-candidates.ts';
import type { AgentSnapshot } from '../../runtime/src/agent-ax-client.ts';
import type { EgressPolicy, ProviderRegistration } from '../../runtime/src/provider-egress.ts';
import type { AgentDecision } from '../../runtime/src/universal-agent-task.ts';
import { CLMDecisionClient } from './clm-decision-client.ts';
import type { CLMTransport } from './clm-decision-client.ts';
import { createCLMHTTPTransport } from './clm-http-transport.ts';
import type { FixtureDecisionEvent } from './jev-fixture-decision.ts';
import { JEV_CODEC, JEV_ENDPOINT, JEV_MODEL } from './jev-wire.ts';

const PROVIDER: ProviderRegistration = Object.freeze({ id: 'typesafe-jev', name: 'jev',
  location: 'external_service', revision: JEV_MODEL });
const POLICY: EgressPolicy = Object.freeze({ mode: 'external_opt_in', enabledProviderIds: [PROVIDER.id] });
// Development thresholds, NOT calibrated; risky steps always need a yes.
const CALIBRATION = Object.freeze({ revision: 'jev-agent-dev-uncalibrated-1', temperature: 1,
  minProbability: 0.3, minMargin: 0.000001 });
const QUESTION = 'Choose the one offered action that best moves the user toward their goal right now. '
  + 'Choose finish only if the goal is already achieved on screen.';

/** Jev for the universal agent: sees the goal, the current app/window/page URL,
 * verified-step history and candidate descriptions (visible labels) only. */
export function createJevAgentDecision(options: {
  readonly apiKey?: string; readonly goal: string;
  /** What the previous request did, so follow-ups ("now play the second one") make sense. */
  readonly context?: string;
  readonly report: (event: FixtureDecisionEvent) => void; readonly transport?: CLMTransport;
}): AgentDecision {
  const transport = options.transport ?? createCLMHTTPTransport({ endpoint: JEV_ENDPOINT,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}), timeoutMs: 15_000 });
  const client = new CLMDecisionClient(POLICY, PROVIDER, CALIBRATION, transport, JEV_CODEC);
  const project = (set: BuiltCandidateSet, view: AgentSnapshot, history: readonly string[]) => {
    const where = (view.pid ? `Current app: ${view.app}, window “${view.windowTitle || 'untitled'}”${
      view.url ? `, showing ${view.url}` : ''}.` : 'No app window is in front yet.')
      + (view.runningApps?.length ? ` Other open apps: ${view.runningApps.slice(0, 20).join(', ')}.` : '');
    const stateText = (options.context ? `Earlier: ${options.context} ` : '') + `Goal: ${options.goal}. ${where}`
      + (history.length ? ` Done so far: ${history.slice(-12).join(' ')}` : ' Nothing has been done yet.')
      + ' Prefer the most direct step; do not repeat a step that changed nothing.';
    return approveCandidateProjection({ set, stateText: stateText.slice(0, 24_000), questionText: QUESTION,
      provider: PROVIDER, disclosureReview: () => true });
  };
  const decision: AgentDecision = {
    async bestActions(set, view, signal, history) {
      const proposal = await client.decide(set, project(set, view, history), signal);
      return Object.entries(proposal.probabilities ?? {})
        .filter(([id, probability]) => probability >= 0.05 && set.resolve(id, set.observationId, set.candidateSetDigest))
        .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => id);
    },
    async select(set, view, signal, history) {
      let proposal = await client.decide(set, project(set, view, history), signal);
      // Jev reports two-decimal probabilities, so exact ties are common. Break
      // a tie between strong contenders by the host's ranking (options are
      // ordered by how well they match the user's words).
      if (proposal.status === 'abstained' && proposal.reason === 'low_confidence' && proposal.probabilities) {
        const top = Math.max(...Object.values(proposal.probabilities));
        const tied = set.candidates.map(c => c.candidateId as string)
          .filter(id => Math.abs((proposal.probabilities![id] ?? 0) - top) < 1e-9);
        if (top >= CALIBRATION.minProbability && tied.length > 1) {
          const winner = tied[0]!;
          const operation = set.candidates.find(c => c.candidateId === winner)?.operation;
          proposal = { ...proposal, candidateId: winner, reason: 'accepted',
            status: operation === 'finish' ? 'finish' : operation === 'wait' ? 'wait'
              : operation === 'request_help' ? 'request_help' : 'selected' };
        }
      }
      const chosen = proposal.candidateId ? set.candidates.find(c => c.candidateId === proposal.candidateId) : undefined;
      const label = chosen ? String(chosen.description).replace(/^In [^:]+: /u, '').slice(0, 120)
        : proposal.status === 'abstained' ? null : proposal.status;
      options.report(Object.freeze({ provider: 'jev', model: JEV_MODEL, status: proposal.status,
        reason: proposal.reason, label, probability: proposal.topProbability }));
      return proposal.status === 'selected' || proposal.status === 'finish' || proposal.status === 'wait'
      ? proposal.candidateId : null;
    },
  };
  return Object.freeze(decision);
}
