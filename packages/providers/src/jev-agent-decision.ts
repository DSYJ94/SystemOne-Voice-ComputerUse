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
  // Set once per task by asksForAnswer; then every step knows the user wants to be told something.
  let wantsAnswer = false;
  const describeState = (view: AgentSnapshot, history: readonly string[], origin?: string) => {
    const tabs = view.elements.filter(element => element.role === 'AXTab' && element.closable);
    const plain = (name: string) => name.replace(/[\u200e\u200f]/gu, '').trim().toLowerCase();
    const windowless = !!view.windows && !view.windows.some(window => plain(window.app) === plain(view.app) && !window.minimized);
    const where = (view.pid ? `Current app: ${view.app}${view.frontmost === false ? ' (open, but behind other windows: not in front)' : ''}${
      windowless ? ' (running, but no window of it is open: only its menu bar shows)' : `, window “${view.windowTitle || 'untitled'}”`}${
      view.url ? `, showing ${view.url}` : ''}.` : 'No app window is in front yet.')
      + (typeof view.scrollY === 'number' ? view.scrollY <= 0 ? ' The page is scrolled to the very top.'
        : ` The page is scrolled ${view.scrollY} pixels down from the top.` : '')
      + (view.mac ? ` The Mac: ${[view.mac.darkMode === undefined ? '' : `dark mode ${view.mac.darkMode ? 'on' : 'off'}`,
        view.mac.wifiOn === undefined ? '' : `Wi‑Fi ${view.mac.wifiOn ? 'on' : 'off'}`,
        view.mac.volume === undefined ? '' : `volume ${view.mac.volume}%${view.mac.muted ? ' (muted)' : ''}`].filter(Boolean).join(', ')}.` : '')
      + ((view.displays?.length ?? 0) > 1 ? ` Displays: ${view.displays!.map(display => `“${display.name}”${
        display.pointer ? ' (the pointer is here)' : ''}`).join(', ')}.` : '')
      + (tabs.length ? ` Open browser tabs: ${tabs.map(tab => `“${tab.label.slice(0, 50)}”${tab.selected ? ' (current)' : ''}`)
        .join(', ')}.` : '')
      + (view.runningApps?.length ? ` Other open apps: ${view.runningApps.slice(0, 20).join(', ')}.` : '');
    return ((options.context ? `A previous, separate request (already over; do not redo it): ${options.context} ` : '') + `Goal: ${options.goal}.${
      origin ? ` When the user asked, they were in ${origin}; “this”/“the current” in the goal means that.` : ''} ${where}`
      + (history.length ? ` Done so far: ${history.slice(-12).join(' ')}` : ' Nothing has been done yet.')
      + (wantsAnswer ? ' The user asked to be told something: if the answer is in the text on screen, tell it to them'
        + ' (a "Tell the user" option); only if it is not visible, go to where it is.' : '')
      + ' Prefer the most direct step; never undo a step that already did what was asked.').slice(0, 24_000);
  };
  const project = (set: BuiltCandidateSet, view: AgentSnapshot, history: readonly string[], origin?: string) =>
    approveCandidateProjection({ set, stateText: describeState(view, history, origin), questionText: QUESTION,
      provider: PROVIDER, disclosureReview: () => true });
  const decision: AgentDecision = {
    /** Separate yes/no judgment of completion, from the same state the chooser sees. */
    async done(view, signal, history, origin) {
      const told = history.flatMap(item => /^Told the user: “(.*)”\.$/u.exec(item)?.[1] ?? []);
      if (wantsAnswer && told.length) {
        // A question is done when it has been answered, not when the screen looks a certain way.
        const answered = { projectionRevision: 'agent-answered-v1',
          stateText: `The user asked: “${options.goal.slice(0, 600)}”. SystemOne told them: ${told.map(text => `“${text}”`).join(', ')}.`,
          questionText: 'Has the user\'s question been fully answered?',
          candidates: [{ candidateId: 'done', description: 'Yes. What they were told answers everything they asked.' },
            { candidateId: 'not_done', description: 'No. Part of what they asked has not been answered yet.' }] };
        const raw = await transport.send(encodeJevProviderView(answered), signal);
        return decodeJevChoice(raw, answered).probabilities.done ?? 0;
      }
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
    async findAnswer(view, texts, signal, history, origin) {
      // Framing chosen by measurement (8/9 on a labelled probe, incl. every "not on screen" case);
      // the full step state made Jev answer "none" even when the answer was visible.
      const providerView = { projectionRevision: 'agent-answer-v3',
        stateText: `The user asked: “${options.goal.slice(0, 600)}”. These texts are on screen.`,
        questionText: 'Which text contains the information the user asked for?',
        candidates: [...texts.map((text, index) => ({ candidateId: `t${index}`, description: `This text contains it: “${text.slice(0, 300)}”.` })),
          ...(texts.length > 1 ? [{ candidateId: 'all', description: 'Several of these texts together contain it (the user asked for a list or a summary of them).' }] : []),
          { candidateId: 'none', description: 'The information is not in any of these texts.' }] };
      const raw = await transport.send(encodeJevProviderView(providerView), signal);
      const [best] = Object.entries(decodeJevChoice(raw, providerView).probabilities).sort((a, b) => b[1] - a[1]);
      if (!best || best[0] === 'none' || best[1] < 0.5) return null;
      return best[0] === 'all' ? -1 : Number(best[0].slice(1));
    },
    async chooseOne(question, items, signal) {
      // Long lists (an app's whole menu bar) are judged in parallel rounds, then a final.
      const ask = async (ids: readonly number[]) => {
        const providerView = { projectionRevision: 'agent-choose-v2', stateText: `The user said: “${options.goal.slice(0, 600)}”`,
          questionText: question, candidates: [...ids.map(id => ({ candidateId: `i${id}`,
            description: `“${items[id]!.slice(0, 200)}”, the one that fits.` })),
          { candidateId: 'none', description: 'None of these fits what the user asked.' }] };
        const raw = await transport.send(encodeJevProviderView(providerView), signal);
        return Object.entries(decodeJevChoice(raw, providerView).probabilities).sort((a, b) => b[1] - a[1]);
      };
      let finalists = items.map((_, id) => id);
      if (finalists.length > 60) {
        const rounds: number[][] = [];
        for (let i = 0; i < finalists.length; i += 60) rounds.push(finalists.slice(i, i + 60));
        finalists = [...new Set((await Promise.all(rounds.map(async round => (await ask(round))
          .filter(([id]) => id !== 'none').slice(0, 2).map(([id]) => Number(id.slice(1)))))).flat())];
      }
      if (!finalists.length) return null;
      const [best] = await ask(finalists);
      return best && best[0] !== 'none' && best[1] >= 0.2 ? Number(best[0].slice(1)) : null;
    },
    async asksForAnswer(request, signal) {
      const view = { projectionRevision: 'agent-intent-v1', stateText: `The user said: “${request.slice(0, 1_200)}”`,
        questionText: 'Does the user want to be told something (an answer, a value, or text read out), or want something done on the computer?',
        candidates: [
          { candidateId: 'answer', description: 'Only told something: a question to answer or something to read out; nothing on the computer needs to be opened, played, typed, sent or changed.' },
          { candidateId: 'act', description: 'Something done on the computer (open, play, click, type, send, move, change), even if it also involves finding something first.' }] };
      const raw = await transport.send(encodeJevProviderView(view), signal ?? AbortSignal.timeout(15_000));
      wantsAnswer = (decodeJevChoice(raw, view).probabilities.answer ?? 0) >= 0.5;
      return wantsAnswer;
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
