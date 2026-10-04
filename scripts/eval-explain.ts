import { execFileSync } from 'node:child_process';
import { SCENARIOS } from '../packages/runtime/eval/scenarios.ts';
import { runScenario } from '../packages/runtime/eval/sim.ts';
import { createJevAgentDecision } from '../packages/providers/src/jev-agent-decision.ts';
// One scenario (or paraphrase "name~N") with every Jev question and its top answers, for diagnosing a failure.
// Usage: node scripts/eval-explain.ts <name>[~N]   (STATE=1 prints the state text, TOP=n the answers shown)
const [name, index] = process.argv[2]!.split('~');
const base = SCENARIOS.find(item => item.name === name)!;
const scenario = index ? { ...base, goal: base.paraphrases![Number(index) - 1]! } : base;
const apiKey = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'systemone-jev', '-w'], { encoding: 'utf8' }).trim();
const result = await runScenario(scenario, goal => createJevAgentDecision({ apiKey, goal, report: () => {}, judgment: event => {
  const request = event.request as any; const answer = event.answer as any;
  for (const [key, question] of Object.entries<any>(request.questions ?? {})) {
    const probabilities = Object.entries<number>(answer?.answers?.[key]?.probabilities ?? {}).sort((a, b) => b[1] - a[1]);
    console.log(`-- ${Object.keys(question.criteria ?? {}).length} options: ${String(question.instructions).slice(0, 70)}`);
    if (process.env.STATE) console.log('   STATE', String(request.state).slice(0, 1500));
    for (const [id, p] of probabilities.slice(0, Number(process.env.TOP ?? 5))) console.log(`   ${p.toFixed(2)} ${id}: ${String(question.criteria?.[id] ?? '').slice(0, 170)}`);
  }
} }));
console.log(result.success, result.state, result.steps.join(' → '));
