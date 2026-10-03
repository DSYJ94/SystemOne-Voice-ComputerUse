import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** One training example per question put to Jev, labelled with what happened next.
 * Kept up to date automatically after every task and every 👍/👎, one file per task in
 * `datasets/tasks/`, so nobody has to run an export. */
export type TraceEvent = Record<string, any>;

export function taskExamples(events: readonly TraceEvent[], task: string): Record<string, unknown>[] {
  const goal = events.find(event => event.kind === 'goal')?.goal ?? '';
  const outcome = events.findLast(event => event.kind === 'end')?.outcome ?? null;
  const verdict = events.findLast(event => event.kind === 'feedback');
  const understanding = events.find(event => event.kind === 'understanding')?.by ?? null;
  const examples: Record<string, unknown>[] = [];
  events.forEach((event, index) => {
    if (event.kind !== 'judgment') return;
    const question = event.request?.questions?.next_action ?? {};
    const probabilities: Record<string, number> = event.answer?.answers?.next_action?.probabilities ?? {};
    const pick = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    // The judgment right before a step record decided that step; its result follows.
    const nextIndex = events.findIndex((item, at) => at > index && item.kind !== 'judgment');
    const next = nextIndex >= 0 ? events[nextIndex] : undefined;
    const decided = next?.kind === 'step';
    const result = decided ? events.find((item, at) => at > nextIndex && item.kind === 'result' && item.step === next.step) : undefined;
    examples.push({ task, goal, question: question.instructions ?? '', state: event.request?.state ?? '',
      options: question.criteria ?? {}, probabilities, pick,
      executed: decided ? { step: next.step, kind: next.chosen, label: next.label } : null,
      changed: result ? result.changed : null, outcome, understanding,
      feedback: verdict ? { value: verdict.value, reason: verdict.reason ?? null, note: verdict.note ?? null } : null,
      ms: event.ms ?? null });
  });
  return examples;
}

export function readTrace(path: string): TraceEvent[] {
  return readFileSync(path, 'utf8').trim().split('\n').flatMap(line => {
    try { return [JSON.parse(line) as TraceEvent]; } catch { return []; }
  });
}

/** Rewrites this task's dataset file from its trace (private, mode 600). */
export function writeTaskDataset(tracePath: string, datasetsDir: string): number {
  const task = basename(tracePath).replace(/\.jsonl$/u, '');
  const examples = taskExamples(readTrace(tracePath), task);
  if (!examples.length) return 0;
  const dir = join(datasetsDir, 'tasks');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = join(dir, `${task}.jsonl`);
  writeFileSync(out, examples.map(example => JSON.stringify(example)).join('\n') + '\n', { mode: 0o600 });
  chmodSync(out, 0o600);
  return examples.length;
}
