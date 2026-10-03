import { execFileSync } from 'node:child_process';
import { parseAgentGoal, refineGoal } from '../src/agent-goal.ts';
import { createJevAgentDecision } from '../../providers/src/jev-agent-decision.ts';

// Labelled set for choosing the words to type: natural and dictation-style requests,
// including ones that type nothing. Usage: node packages/runtime/eval/span-bench.ts
const CASES: readonly [string, string | null][] = [
  ['youtube search lofi beats play the first result', 'lofi beats'],
  ['go to youtube search lofi beats find me the video with the most views', 'lofi beats'],
  ['search youtube for lofi beats, play the first result and make it full screen', 'lofi beats'],
  ['go to YouTube search Concord aeroplane find me the video with the largest views then click on it', 'Concord aeroplane'],
  ['wikipedia alan turing', 'alan turing'],
  ['go to wikipedia search alan turing please', 'alan turing'],
  ['find the emails about invoice', 'invoice'],
  ['add buy milk to Notes', 'buy milk'],
  ['slack sam on my way', 'on my way'],
  ['on Slack tell Sam on my way', 'on my way'],
  ['tell Priya on slack running 5 minutes late', 'running 5 minutes late'],
  ['reply to Sam I will be late', 'I will be late'],
  ['message Priya on Slack saying running 5 minutes late', 'running 5 minutes late'],
  ['open the email from Acme about the invoice', null],
  ['close the empty new tabs', null],
  ['play the next video', null],
  ['Reply in the current chat', null],
  ['switch to Slack and open the general channel', null],
  ['open chrome', null],
  ['play the video', null],
  ['close whatsapp', null],
  ['go to the research page', null],
];
const apiKey = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'systemone-jev', '-w'], { encoding: 'utf8' }).trim();
let right = 0;
const started = performance.now();
await Promise.all(CASES.map(async ([text, want]) => {
  const decision = createJevAgentDecision({ apiKey, goal: text, report: () => {} });
  const goal = await refineGoal(text, parseAgentGoal(text, ['Notes', 'Slack', 'Google Chrome', 'WhatsApp']), decision.pickSpan!.bind(decision));
  const got = goal.typedText?.text ?? null;
  if ((got ?? '').toLowerCase() === (want ?? '').toLowerCase()) right++;
  else console.log(`  wrong: ${text} → ${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
}));
console.log(`${right}/${CASES.length} typed-text choices right (${Math.round(performance.now() - started)} ms for all, in parallel)`);
