import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readTrace, writeTaskDataset } from '../packages/runtime/src/training-data.ts';

// The app already keeps datasets/tasks/<task>.jsonl up to date after every task and every
// 👍/👎. This rebuilds all of them from the traces (e.g. after a format change) and prints
// what has been collected. Usage: npm run traces:export
const dir = process.env.SYSTEMONE_TRACE_DIR ?? join(homedir(), 'Library/Application Support/SystemOne-Dev/traces');
const datasets = join(dirname(dir), 'datasets');
let files: string[] = [];
try { files = readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort(); }
catch { console.log(`No traces yet in ${dir}.`); process.exit(0); }
const tally = { tasks: 0, examples: 0, good: 0, bad: 0, reasons: new Map<string, number>(), notes: 0 };
for (const file of files) {
  const path = join(dir, file);
  const events = readTrace(path);
  tally.tasks++;
  tally.examples += writeTaskDataset(path, datasets);
  const verdict = events.findLast(event => event.kind === 'feedback');
  if (verdict?.value === 'good') tally.good++;
  if (verdict?.value === 'bad') {
    tally.bad++;
    if (verdict.reason) tally.reasons.set(verdict.reason, (tally.reasons.get(verdict.reason) ?? 0) + 1);
    if (verdict.note) tally.notes++;
  }
}
console.log(`${tally.tasks} tasks → ${tally.examples} examples in ${join(datasets, 'tasks')}`);
console.log(`feedback: ${tally.good} 👍, ${tally.bad} 👎 (${[...tally.reasons].map(([reason, n]) => `${reason} ${n}`).join(', ') || 'no reasons'}; ${tally.notes} corrections)`);
