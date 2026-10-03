import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Turns local agent traces into a training dataset for a future SystemOne chooser.
// Each example is one question put to Jev, verbatim: the state text, the question, every
// option's description, Jev's probabilities, and labels from what happened next:
//   executed   – this judgment picked the step that was actually performed;
//   changed    – that step visibly changed the screen;
//   outcome    – how the whole task ended (completed / paused / stopped / error);
//   feedback   – the user's 👍 ("good") or 👎 ("bad") on the task, when given.
// The dataset stays on this Mac (mode 600), outside the repository. It contains whatever
// was on screen (names, email subjects), so review before sharing it with anyone.
// Usage: npm run traces:export
const dir = process.env.SYSTEMONE_TRACE_DIR ?? join(homedir(), 'Library/Application Support/SystemOne-Dev/traces');
const outDir = join(dirname(dir), 'datasets');
let files: string[] = [];
try { files = readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort(); }
catch { console.log(`No traces yet in ${dir}.`); process.exit(0); }

type Event = Record<string, any>;
const examples: Record<string, unknown>[] = [];
const tally = { tasks: 0, withJudgments: 0, judgments: 0, good: 0, bad: 0, completed: 0 };
for (const file of files) {
  const events: Event[] = readFileSync(join(dir, file), 'utf8').trim().split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  tally.tasks++;
  const goal = events.find(event => event.kind === 'goal')?.goal ?? '';
  const outcome = events.findLast(event => event.kind === 'end')?.outcome ?? null;
  const feedback = events.findLast(event => event.kind === 'feedback')?.value ?? null;
  if (feedback === 'good') tally.good++;
  if (feedback === 'bad') tally.bad++;
  if (outcome === 'completed') tally.completed++;
  const judgments = events.filter(event => event.kind === 'judgment');
  if (judgments.length) tally.withJudgments++;
  events.forEach((event, index) => {
    if (event.kind !== 'judgment') return;
    const question = event.request?.questions?.next_action ?? {};
    const probabilities: Record<string, number> = event.answer?.answers?.next_action?.probabilities ?? {};
    const pick = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    // The judgment right before a step record decided that step; its result follows.
    const next = events.slice(index + 1).find(item => item.kind !== 'judgment');
    const decided = next?.kind === 'step' && events.slice(index + 1, events.indexOf(next)).every(item => item.kind !== 'judgment');
    const result = decided ? events.slice(events.indexOf(next) + 1).find(item => item.kind === 'result' && item.step === next.step) : undefined;
    tally.judgments++;
    examples.push({ task: file.replace(/\.jsonl$/u, ''), goal, question: question.instructions ?? '',
      state: event.request?.state ?? '', options: question.criteria ?? {}, probabilities, pick,
      executed: decided ? { step: next.step, kind: next.chosen, label: next.label } : null,
      changed: result ? result.changed : null, outcome, feedback, ms: event.ms ?? null });
  });
}
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const out = join(outDir, `jev-choices-${new Date().toISOString().replace(/[:.]/gu, '-')}.jsonl`);
writeFileSync(out, examples.map(example => JSON.stringify(example)).join('\n') + (examples.length ? '\n' : ''), { mode: 0o600 });
chmodSync(out, 0o600);
console.log(`${tally.tasks} tasks (${tally.withJudgments} with full judgments, ${tally.completed} completed; `
  + `feedback: ${tally.good} 👍, ${tally.bad} 👎) → ${tally.judgments} examples\n${out}`);
