import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { basename, join } from 'node:path';
import { readTrace } from './training-data.ts';
import type { TraceEvent } from './training-data.ts';

/** Structured telemetry: one record per task, in the shape the company database stores
 * (infra/telemetry/schema.sql), so the same data serves problem reports, analytics and
 * training. Records are written to a local outbox after every task and every 👎/👍;
 * uploading is a separate, later step once an endpoint exists. Version every change. */
export const TELEMETRY_SCHEMA_VERSION = 1;

export type QuestionKind = 'choose_step' | 'is_done' | 'which_answer' | 'pick_words' | 'question_or_action'
  | 'which_item' | 'other';

export interface TaskRecord {
  readonly schemaVersion: number;
  readonly installId: string;
  readonly task: {
    readonly taskId: string;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
    readonly goal: string;
    readonly outcome: string | null;
    readonly stopReason: string | null;
    readonly understoodBy: string | null;
    readonly wantsAnswer: boolean | null;
    readonly typedText: string | null;
    readonly stepCount: number;
    readonly appVersion: string;
    readonly osVersion: string;
  };
  readonly steps: readonly {
    readonly step: number; readonly at: string; readonly app: string; readonly window: string; readonly url: string;
    readonly via: string | null; readonly kind: string; readonly label: string; readonly risky: boolean;
    readonly optionCount: number | null; readonly elementCount: number | null; readonly readMs: number | null;
    readonly decideMs: number | null; readonly doneProbability: number | null; readonly changed: boolean | null;
    readonly actMs: number | null; readonly verifyMs: number | null;
  }[];
  readonly judgments: readonly {
    readonly seq: number; readonly at: string; readonly kind: QuestionKind; readonly model: string | null;
    readonly instructions: string; readonly state: string; readonly options: Readonly<Record<string, string>>;
    readonly probabilities: Readonly<Record<string, number>>; readonly pick: string | null;
    /** The step this judgment decided, when it was the deciding one. */
    readonly decidedStep: number | null; readonly latencyMs: number | null;
  }[];
  readonly feedback: readonly {
    readonly seq: number; readonly at: string; readonly value: string; readonly reason: string | null;
    readonly note: string | null; readonly attachments: readonly string[];
  }[];
  readonly localModels: readonly { readonly at: string; readonly kind: string; readonly ms: number | null;
    readonly answer: string | null; readonly accepted: boolean | null }[];
}

/** Classifies a Jev question by its instructions (the questions SystemOne asks are fixed texts). */
export function questionKind(instructions: string): QuestionKind {
  if (/words to type|exact words|file or folder/u.test(instructions)) return 'pick_words';
  if (/told something|done on the computer/u.test(instructions)) return 'question_or_action';
  if (/contains the information|answers the user/u.test(instructions)) return 'which_answer';
  if (/fully answered|already happened|nothing else needs/u.test(instructions)) return 'is_done';
  if (/Settings pane|menu command|menu-bar icon/u.test(instructions)) return 'which_item';
  if (/offered action|moves the user toward/u.test(instructions)) return 'choose_step';
  return 'other';
}

export function taskRecord(events: readonly TraceEvent[], taskId: string, installId: string, appVersion = 'dev'): TaskRecord {
  const at = (event: TraceEvent | undefined) => (event?.at as string | undefined) ?? null;
  const understanding = events.find(event => event.kind === 'understanding');
  const steps = events.filter(event => event.kind === 'step').map(step => {
    const result = events.find(event => event.kind === 'result' && event.step === step.step);
    const num = (value: unknown) => typeof value === 'number' ? value : null;
    return { step: Number(step.step), at: String(step.at ?? ''), app: String(step.app ?? ''), window: String(step.window ?? ''),
      url: String(step.url ?? ''), via: step.via ?? null, kind: String(step.chosen ?? ''), label: String(step.label ?? ''),
      risky: step.risky === true, optionCount: num(step.options), elementCount: num(step.elements), readMs: num(step.readMs),
      decideMs: num(step.decideMs), doneProbability: num(step.done), changed: typeof result?.changed === 'boolean' ? result.changed : null,
      actMs: num(result?.actMs), verifyMs: num(result?.verifyMs) };
  });
  let seq = 0;
  const judgments = events.flatMap((event, index) => {
    if (event.kind !== 'judgment') return [];
    const question = event.request?.questions?.next_action ?? {};
    const probabilities: Record<string, number> = event.answer?.answers?.next_action?.probabilities ?? {};
    const pick = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const nextIndex = events.findIndex((item, position) => position > index && item.kind !== 'judgment');
    const next = nextIndex >= 0 ? events[nextIndex] : undefined;
    return [{ seq: ++seq, at: String(event.at ?? ''), kind: questionKind(String(question.instructions ?? '')),
      model: event.answer?.model ?? event.request?.model ?? null, instructions: String(question.instructions ?? ''),
      state: String(event.request?.state ?? ''), options: question.criteria ?? {}, probabilities, pick,
      decidedStep: next?.kind === 'step' ? Number(next.step) : null, latencyMs: typeof event.ms === 'number' ? event.ms : null }];
  });
  let feedbackSeq = 0;
  const feedback = events.filter(event => event.kind === 'feedback').map(event => ({ seq: ++feedbackSeq, at: String(event.at ?? ''),
    value: String(event.value), reason: event.reason ?? null, note: event.note ?? null,
    attachments: Array.isArray(event.attachments) ? event.attachments.map(String) : [] }));
  const localModels = events.filter(event => event.kind === 'local_model' || event.kind === 'compose').map(event => ({
    at: String(event.at ?? ''), kind: event.kind === 'compose' ? 'answers' : 'understanding',
    ms: typeof event.ms === 'number' ? event.ms : null, answer: event.answer ?? null,
    accepted: typeof event.accepted === 'boolean' ? event.accepted : typeof event.grounded === 'boolean' ? event.grounded : null }));
  const end = events.findLast(event => event.kind === 'end');
  return Object.freeze({ schemaVersion: TELEMETRY_SCHEMA_VERSION, installId,
    task: { taskId, startedAt: at(events.find(event => event.kind === 'goal')), endedAt: at(end),
      goal: String(events.find(event => event.kind === 'goal')?.goal ?? ''), outcome: end?.outcome ?? null,
      stopReason: events.findLast(event => event.kind === 'stopped')?.reason ?? null, understoodBy: understanding?.by ?? null,
      wantsAnswer: typeof understanding?.answer === 'boolean' ? understanding.answer : null, typedText: understanding?.typed ?? null,
      stepCount: steps.length, appVersion, osVersion: `macOS (Darwin ${release()})` },
    steps, judgments, feedback, localModels });
}

/** A random id for this Mac's install, created once (no hardware or account identifiers). */
export function installId(supportDir: string): string {
  const path = join(supportDir, 'install-id');
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const id = randomUUID();
  mkdirSync(supportDir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${id}\n`, { mode: 0o600 });
  return id;
}

/** Rewrites this task's record in datasets/outbox (awaiting upload once an endpoint exists). */
export function writeOutbox(tracePath: string, supportDir: string): string {
  const task = basename(tracePath).replace(/\.jsonl$/u, '');
  const record = taskRecord(readTrace(tracePath), task, installId(supportDir));
  const dir = join(supportDir, 'datasets', 'outbox');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = join(dir, `${task}.json`);
  writeFileSync(out, JSON.stringify(record), { mode: 0o600 });
  return out;
}
