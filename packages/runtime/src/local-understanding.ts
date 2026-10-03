import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The on-device alternative to Jev for understanding a request: a very small local
 * model (Qwen2.5-0.5B via MLX, scripts/local-model/worker.py) proposes the words to
 * type. No network once installed. Installed once, in the background, under the app's
 * support folder; until it is ready the caller falls back to Jev and says so. */
export type LocalStatus = 'not_installed' | 'installing' | 'starting' | 'ready' | 'failed';

const WORKER = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/local-model/worker.py');
const MLX_LM = 'mlx-lm==0.32.0';
const PYTHONS = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];

export class LocalUnderstanding {
  readonly #dir: string;
  #status: LocalStatus;
  #problem = '';
  #worker: ChildProcessWithoutNullStreams | undefined;
  #buffer = '';
  #next = 0;
  readonly #pending = new Map<string, (answer: { answer?: string; ms?: number; error?: string }) => void>();
  #starting: Promise<void> | undefined;

  constructor(dir: string) {
    this.#dir = dir;
    this.#status = existsSync(join(dir, 'installed')) ? 'starting' : 'not_installed';
  }

  get status(): LocalStatus { return this.#status; }
  get problem(): string { return this.#problem; }

  /** Starts installing (first time) or loading the model; never blocks a request. */
  prepare(): void {
    if (this.#starting || this.#status === 'ready' || this.#status === 'failed') return;
    this.#starting = (existsSync(join(this.#dir, 'installed')) ? Promise.resolve() : this.#install())
      .then(() => this.#start())
      .catch(error => { this.#status = 'failed'; this.#problem = String(error).slice(0, 200); })
      .finally(() => { this.#starting = undefined; });
  }

  /** The words the local model says should be typed, or null for none. Throws when not ready. */
  async words(text: string, timeoutMs = 3_000): Promise<{ readonly answer: string | null; readonly ms: number }> {
    if (this.#status !== 'ready' || !this.#worker) { this.prepare(); throw new Error(`local model ${this.#status}`); }
    const id = `q${++this.#next}`;
    const reply = await new Promise<{ answer?: string; ms?: number; error?: string }>((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error('local model timed out')); }, timeoutMs);
      this.#pending.set(id, value => { clearTimeout(timer); resolve(value); });
      this.#worker!.stdin.write(`${JSON.stringify({ id, text })}\n`);
    });
    if (reply.error || typeof reply.answer !== 'string') throw new Error(reply.error ?? 'no answer');
    const answer = reply.answer.trim();
    return { answer: !answer || answer.toUpperCase() === 'NONE' ? null : answer, ms: reply.ms ?? 0 };
  }

  stop(): void { this.#worker?.kill(); this.#worker = undefined; }

  async #install(): Promise<void> {
    this.#status = 'installing';
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const python = PYTHONS.find(path => existsSync(path));
    if (!python) throw new Error('no Python 3 found for the local model');
    const venv = join(this.#dir, 'venv');
    await run(python, ['-m', 'venv', venv]);
    await run(join(venv, 'bin/pip'), ['install', '--quiet', '--disable-pip-version-check', MLX_LM]);
    // Loading once downloads the pinned model (~280 MB) into the support folder.
    await run(join(venv, 'bin/python'), [WORKER, '--download'], { HF_HOME: join(this.#dir, 'hf') });
    writeFileSync(join(this.#dir, 'installed'), `${MLX_LM}\n`, { mode: 0o600 });
  }

  #start(): Promise<void> {
    this.#status = 'starting';
    return new Promise((resolve, reject) => {
      const worker = spawn(join(this.#dir, 'venv/bin/python'), [WORKER], {
        env: { ...process.env, HF_HOME: join(this.#dir, 'hf'), HF_HUB_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' },
        stdio: ['pipe', 'pipe', 'pipe'] });
      this.#worker = worker;
      worker.stderr.resume();
      worker.on('exit', () => {
        this.#worker = undefined;
        if (this.#status === 'starting') reject(new Error('local model exited while loading'));
        if (this.#status === 'ready') this.#status = 'starting'; // Restarted on the next request.
        for (const resolvePending of this.#pending.values()) resolvePending({ error: 'local model stopped' });
        this.#pending.clear();
      });
      worker.stdout.on('data', chunk => {
        this.#buffer += String(chunk);
        let newline: number;
        while ((newline = this.#buffer.indexOf('\n')) >= 0) {
          const line = this.#buffer.slice(0, newline);
          this.#buffer = this.#buffer.slice(newline + 1);
          let message: Record<string, unknown>;
          try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          if (message.ready === true) { this.#status = 'ready'; resolve(); continue; }
          const id = typeof message.id === 'string' ? message.id : undefined;
          const pending = id ? this.#pending.get(id) : undefined;
          if (id && pending) {
            this.#pending.delete(id);
            pending(message as { answer?: string; ms?: number; error?: string });
          }
        }
      });
    });
  }
}

function run(command: string, args: readonly string[], env: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', chunk => { errors = (errors + String(chunk)).slice(-400); });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} failed: ${errors.trim()}`)));
  });
}
