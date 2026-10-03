import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Prints the most recent local agent traces (never uploaded anywhere).
// Usage: npm run traces [-- <count>]
const dir = process.env.SYSTEMONE_TRACE_DIR ?? join(homedir(), 'Library/Application Support/SystemOne-Dev/traces');
const count = Number(process.argv[2] ?? 5);
let files: string[] = [];
try { files = readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort().slice(-count); }
catch { console.log(`No traces yet in ${dir}.`); process.exit(0); }
for (const file of files) {
  const events = readFileSync(join(dir, file), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const goal = events.find(event => event.kind === 'goal')?.goal ?? '(unknown goal)';
  console.log(`\n${file.slice(0, 19)}  “${goal}”`);
  for (const event of events) {
    if (event.kind === 'step') {
      console.log(`  ${event.step}. [${event.app}${event.url ? ` ${String(event.url).slice(0, 60)}` : ''}] `
        + `${event.chosen} “${String(event.label).slice(0, 70)}”${event.risky ? ' (risky)' : ''}  `
        + `(${event.options} options, ${event.elements} elements; read ${event.observeMs ?? '?'} ms, Jev ${event.decideMs ?? '?'} ms)`);
    } else if (event.kind === 'result') {
      console.log(`     → ${event.changed ? 'changed' : 'nothing visibly changed'} (act ${event.actMs ?? '?'} ms, check ${event.verifyMs ?? '?'} ms)`);
    }
  }
}
