import { approveCandidateProjection } from '../../runtime/src/action-candidates.ts';
import type { BuiltCandidateSet } from '../../runtime/src/action-candidates.ts';
import type { JSONValue } from '../../protocol/src/json.ts';
import type { AgentSnapshot } from '../../runtime/src/agent-ax-client.ts';
import type { EgressPolicy, ProviderRegistration } from '../../runtime/src/provider-egress.ts';
import type { AgentDecision } from '../../runtime/src/universal-agent-task.ts';
import { CLMDecisionClient } from './clm-decision-client.ts';
import type { CLMTransport } from './clm-decision-client.ts';
import { createCLMHTTPTransport } from './clm-http-transport.ts';
import type { FixtureDecisionEvent } from './jev-fixture-decision.ts';
import { decodeJevChoice, encodeJevProviderView, JEV_CODEC, JEV_ENDPOINT, JEV_MODEL } from './jev-wire.ts';

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
  /** Receives every question put to Jev and its answer, verbatim: training data for a future chooser. */
  readonly judgment?: (event: Record<string, JSONValue>) => void;
}): AgentDecision {
  const network = options.transport ?? createCLMHTTPTransport({ endpoint: JEV_ENDPOINT,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}), timeoutMs: 15_000 });
  const transport: CLMTransport = !options.judgment ? network : Object.freeze({
    async send(body: Uint8Array, signal: AbortSignal) {
      const started = performance.now();
      const answer = await network.send(body, signal);
      try {
        options.judgment!({ kind: 'judgment', ms: Math.round(performance.now() - started),
          request: JSON.parse(Buffer.from(body).toString('utf8')) as JSONValue, answer: answer as JSONValue });
      } catch { /* Recording never affects a decision. */ }
      return answer;
    } });
  const client = new CLMDecisionClient(POLICY, PROVIDER, CALIBRATION, transport, JEV_CODEC);
  const describeState = (view: AgentSnapshot, history: readonly string[], origin?: string) => {
    const tabs = view.elements.filter(element => element.role === 'AXTab' && element.closable);
    const where = (view.pid ? `Current app: ${view.app}${view.frontmost === false ? ' (open, but behind other windows: not in front)' : ''}, window “${view.windowTitle || 'untitled'}”${
      view.url ? `, showing ${view.url}` : ''}.` : 'No app window is in front yet.')
      + (typeof view.scrollY === 'number' ? view.scrollY <= 0 ? ' The page is scrolled to the very top.'
        : ` The page is scrolled ${view.scrollY} pixels down from the top.` : '')
      + (tabs.length ? ` Open browser tabs: ${tabs.map(tab => `“${tab.label.slice(0, 50)}”${tab.selected ? ' (current)' : ''}`)
        .join(', ')}.` : '')
      + (view.runningApps?.length ? ` Other open apps: ${view.runningApps.slice(0, 20).join(', ')}.` : '');
    return ((options.context ? `A previous, separate request (already over; do not redo it): ${options.context} ` : '') + `Goal: ${options.goal}.${
      origin ? ` When the user asked, they were in ${origin}; “this”/“the current” in the goal means that.` : ''} ${where}`
      + (history.length ? ` Done so far: ${history.slice(-12).join(' ')}` : ' Nothing has been done yet.')
      + ' Prefer the most direct step; never undo a step that already did what was asked.').slice(0, 24_000);
  };
  const project = (set: BuiltCandidateSet, view: AgentSnapshot, history: readonly string[], origin?: string) =>
    approveCandidateProjection({ set, stateText: describeState(view, history, origin), questionText: QUESTION,
      provider: PROVIDER, disclosureReview: () => true });
  const decision: AgentDecision = {
    /** Separate yes/no judgment of completion, from the same state the chooser sees. */
    async done(view, signal, history, origin) {
      const providerView = { projectionRevision: 'agent-done-v1', stateText: describeState(view, history, origin),
        questionText: 'Has everything the user asked for already happened, so nothing else needs to be done?',
        candidates: [
          { candidateId: 'done', description: 'Yes. Every part of the request has happened; stop now.' },
          { candidateId: 'not_done', description: 'No. At least one part of the request has not happened yet.' }] };
      const raw = await transport.send(encodeJevProviderView(providerView), signal);
      return decodeJevChoice(raw, providerView).probabilities.done ?? 0;
    },
    async pickSpan(request, role, spans, signal) {
      // Each candidate states what is left over as instructions; this framing measured best.
      const question = role === 'typed'
        ? 'Some requests include words to type into a search box, message or note. Which candidate is exactly those words, with no instruction words such as play, open, find, click or the app or site name? If the request has no words to type, choose none.'
        : 'Which candidate is exactly the name of the file or folder the user wants opened, without instruction words? If no file or folder is named, choose none.';
      const describe = (text: string) => {
        const at = request.indexOf(text);
        const rest = `${request.slice(0, at)} … ${request.slice(at + text.length)}`.trim().slice(0, 600);
        return role === 'typed' ? `Type exactly “${text.slice(0, 400)}”. The rest (“${rest}”) is instructions, not text to type.`
          : `The file or folder is named “${text.slice(0, 400)}”. The rest (“${rest}”) is the instruction.`;
      };
      const ask = async (ids: readonly number[]) => {
        const view = { projectionRevision: `agent-span-${role}-v2`, stateText: `The user said: “${request.slice(0, 1_200)}”`,
          questionText: question, candidates: [...ids.map(id => ({ candidateId: `s${id}`, description: describe(spans[id]!) })),
            { candidateId: 'none', description: role === 'typed' ? 'None: the request has no words to type.'
              : 'None: no file or folder is named.' }] };
        const raw = await transport.send(encodeJevProviderView(view), signal ?? AbortSignal.timeout(15_000));
        return Object.entries(decodeJevChoice(raw, view).probabilities).sort((a, b) => b[1] - a[1]);
      };
      const all = spans.map((_, id) => id);
      let finalists = all;
      if (all.length > 60) {
        // Long requests: judged in parallel rounds; each round's best runs go to a final.
        const rounds: number[][] = [];
        for (let i = 0; i < all.length; i += 60) rounds.push(all.slice(i, i + 60));
        const picks = await Promise.all(rounds.map(async round => (await ask(round))
          .filter(([id]) => id !== 'none').slice(0, 2).map(([id]) => Number(id.slice(1)))));
        finalists = [...new Set(picks.flat())];
      }
      const [best] = await ask(finalists);
      return !best || best[0] === 'none' ? null : Number(best[0].slice(1));
    },
    async bestActions(set, view, signal, history, origin) {
      const proposal = await client.decide(set, project(set, view, history, origin), signal);
      return Object.entries(proposal.probabilities ?? {})
        .filter(([id, probability]) => probability >= 0.05 && set.resolve(id, set.observationId, set.candidateSetDigest))
        .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => id);
    },
    async select(set, view, signal, history, origin) {
      let proposal = await client.decide(set, project(set, view, history, origin), signal);
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
