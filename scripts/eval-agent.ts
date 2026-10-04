import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { SCENARIOS } from '../packages/runtime/eval/scenarios.ts';
import { runScenario } from '../packages/runtime/eval/sim.ts';
import type { RunResult } from '../packages/runtime/eval/sim.ts';
import { createJevAgentDecision } from '../packages/providers/src/jev-agent-decision.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LocalUnderstanding } from '../packages/runtime/src/local-understanding.ts';
import { pickLocally } from '../packages/runtime/src/native-managed-controller.ts';

// Stage B eval: every scenario through the real agent loop with live Jev.
// Usage: npm run eval:agent [-- <name-filter>]
const filter = process.argv[2];
// UNDERSTANDING=local: the on-device model picks the words to type (as the ⚙ toggle does).
const local = process.env.UNDERSTANDING === 'local'
  ? new LocalUnderstanding(process.env.SYSTEMONE_LOCAL_MODEL_DIR ?? join(homedir(), 'Library/Application Support/SystemOne-Dev/local-model'))
  : undefined;
if (local) {
  local.prepare();
  while (local.status !== 'ready' && local.status !== 'failed') await new Promise(resolve => setTimeout(resolve, 500));
  if (local.status === 'failed') throw new Error(`local model failed: ${local.problem}`);
}
const decide = (goal: string) => {
  const decision = createJevAgentDecision({ apiKey, goal, report: () => {} });
  if (!local) return decision;
  const jev = decision.pickSpan!.bind(decision);
  return { ...decision, pickSpan: (text: string, role: 'typed' | 'file', spans: readonly string[]) =>
    role === 'file' ? jev(text, role, spans) : pickLocally(local, text, spans) };
};
const apiKey = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'systemone-jev', '-w'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
// Each paraphrase runs as its own case, so a wording-specific fix shows up as failures.
const chosen = SCENARIOS.flatMap(scenario => [scenario, ...(scenario.paraphrases ?? [])
  .map((goal, index) => ({ ...scenario, name: `${scenario.name}~${index + 1}`, goal }))])
  .filter(scenario => !filter || scenario.name.includes(filter));
const results: RunResult[] = [];
const queue = [...chosen];
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const result = await runScenario(next, decide)
      .catch(error => ({ name: next!.name, goal: next!.goal, state: `crash: ${error}`, success: false, harmed: false,
        steps: [], ms: 0 }));
    results.push(result);
    process.stdout.write(`${result.success && !result.harmed ? 'PASS' : 'FAIL'}  ${result.name.padEnd(26)} `
      + `${String(result.steps.length).padStart(2)} steps ${String(result.ms).padStart(6)} ms  ${result.state}`
      + `${result.harmed ? '  HARMED' : ''}\n${result.success && !result.harmed && !process.env.VERBOSE ? '' : `      ${result.steps.join(' → ')}\n`}`);
  }
}));
const passed = results.filter(result => result.success && !result.harmed).length;
console.log(`\n${passed}/${results.length} passed; median ${median(results.map(r => r.ms))} ms per task`
  + ` (words to type picked by ${local ? 'the on-device model' : 'Jev'}).`);
local?.stop();
mkdirSync('private-traces', { recursive: true });
writeFileSync(`private-traces/agent-eval-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`,
  JSON.stringify({ model: 'jev-1.13.0', passed, total: results.length, results }, null, 2), { mode: 0o600 });

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
