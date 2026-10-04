import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createJevAgentDecision } from '../../packages/providers/src/jev-agent-decision.ts';
const root = process.env.VISION_BENCH_DIR ?? '';
if (!root) throw new Error('set VISION_BENCH_DIR (see scripts/vision-bench/README.md)');
const apiKey = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'systemone-jev', '-w'], { encoding: 'utf8' }).trim();
const sample = JSON.parse(readFileSync(root + '/sample.json', 'utf8'));
const ocr = JSON.parse(readFileSync(root + '/ocr.json', 'utf8'));
const inside = (x: number, y: number, b: number[]) => x >= b[0]! && x <= b[0]! + b[2]! && y >= b[1]! && y <= b[1]! + b[3]!;
const rows: any[] = [];
await Promise.all(sample.map(async (item: any, i: number) => {
  const texts = ocr[i].texts as { text: string; box: number[] }[];
  const centre = (t: { box: number[] }) => [t.box[0]! + t.box[2]! / 2, t.box[1]! + t.box[3]! / 2] as const;
  const reachable = texts.some(t => inside(...centre(t), item.bbox));
  const d = createJevAgentDecision({ apiKey, goal: item.instruction, report: () => {} });
  const s = performance.now();
  const pick = texts.length ? await d.chooseOne!('Which text on the screen is the thing to click to do this?', texts.map(t => t.text), AbortSignal.timeout(30_000)).catch(() => null) : null;
  const jevMs = Math.round(performance.now() - s);
  const hit = pick !== null && inside(...centre(texts[pick]!), item.bbox);
  rows.push({ i, split: item.split, type: item.data_type, hit, reachable, ms: ocr[i].ms + jevMs, ocrMs: ocr[i].ms, jevMs });
}));
writeFileSync(root + '/result-ocr.json', JSON.stringify(rows));
const pct = (xs: any[], f: (r: any) => boolean) => xs.length ? Math.round(100 * xs.filter(f).length / xs.length) : 0;
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
for (const type of ['text', 'icon']) {
  const xs = rows.filter(r => r.type === type);
  console.log(`OCR + Jev, ${type}: ${pct(xs, r => r.hit)}% hit (ceiling ${pct(xs, r => r.reachable)}%: a recognised text lies inside the target); median ${med(xs.map(r => r.ms))} ms (OCR ${med(xs.map(r => r.ocrMs))} + Jev ${med(xs.map(r => r.jevMs))})`);
}
console.log('overall', pct(rows, r => r.hit) + '%');
