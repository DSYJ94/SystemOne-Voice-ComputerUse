import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ContractError, digest, parseJSON } from '../../protocol/src/json.ts';
import type { JSONValue } from '../../protocol/src/json.ts';
import { preflightCLMArtifacts, validateCLMArtifactManifest } from './clm-artifact-preflight.ts';
import type { CLMServingBackend, CLMServingRequest } from './clm-serving-boundary.ts';

const MAX_FRAME = 262_144;
const failure = () => new ContractError('reference backend unavailable');

/** Private-pipe supervisor. Abort kills only this worker and retains ownership
 * until child close; a late GPU result can never resurrect delivery or capacity.
 * Exported separately for process tests; production uses the verified factory. */
export class CLMReferenceProcess implements CLMServingBackend {
  readonly artifactManifestDigest: string;
  readonly tokenizerRevision: string;
  readonly ready: Promise<void>;
  #child: ChildProcessWithoutNullStreams;
  #buffer = Buffer.alloc(0);
  #sequence = 0;
  #stopping = false;
  #closed: Promise<void>;
  #pending: { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;

  constructor(child: ChildProcessWithoutNullStreams, manifestDigest: string, tokenizerRevision: string,
    initialization: unknown, startupTimeoutMs = 300_000) {
    this.#child = child;
    this.artifactManifestDigest = manifestDigest; this.tokenizerRevision = tokenizerRevision;
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    let initialized = false;
    const startupTimer = setTimeout(() => { void this.close(); }, startupTimeoutMs);
    this.#closed = new Promise<void>(resolve => {
      child.once('close', () => {
        this.#stopping = true; clearTimeout(startupTimer);
        this.#buffer = Buffer.alloc(0);
        readyReject(failure()); this.#pending?.reject(failure()); this.#pending = undefined;
        resolve();
      });
    });
    child.once('error', () => { void this.close(); });
    child.stdin.on('error', () => { void this.close(); });
    // stderr is consumed and discarded; never forward tokenizer/model text.
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.#stopping) return;
      try {
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        if (this.#buffer.length > MAX_FRAME) throw failure();
        const end = this.#buffer.indexOf(10);
        if (end < 0) return;
        // Exactly one reply per operation; no unsolicited frames or logs.
        if (end !== this.#buffer.length - 1) throw failure();
        const value = parseJSON(this.#buffer.subarray(0, end)) as Record<string, JSONValue>;
        this.#buffer = Buffer.alloc(0);
        if (!value || Array.isArray(value) || typeof value !== 'object') throw failure();
        if (!initialized) {
          if (Object.keys(value).length !== 3 || value.ready !== true
            || value.manifestDigest !== manifestDigest || value.tokenizerRevision !== tokenizerRevision) throw failure();
          initialized = true; clearTimeout(startupTimer); readyResolve();
        } else {
          const pending = this.#pending;
          if (!pending || value.id !== pending.id || typeof value.ok !== 'boolean'
            || Object.keys(value).length !== (value.ok ? 3 : 2)
            || (value.ok && !Object.hasOwn(value, 'value'))) throw failure();
          this.#pending = undefined;
          if (value.ok) pending.resolve(value.value);
          else pending.reject(failure());
        }
      } catch { void this.close(); }
    });
    this.#write(initialization);
  }

  #write(value: unknown): void {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    if (bytes.length > MAX_FRAME) { void this.close(); throw failure(); }
    this.#child.stdin.write(bytes);
  }

  async #call(operation: 'count' | 'answer', value: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted(); await this.ready; signal.throwIfAborted();
    if (this.#stopping || this.#pending) throw failure();
    const cancel = () => { void this.close(); };
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 30_000);
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        const id = ++this.#sequence;
        this.#pending = { id, resolve, reject };
        try { this.#write({ id, operation, value }); }
        catch { void this.close(); }
      });
      signal.throwIfAborted(); return result;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
  }

  async countTokens(texts: readonly string[], signal: AbortSignal): Promise<readonly number[]> {
    const result = await this.#call('count', texts, signal);
    if (!Array.isArray(result) || result.length !== texts.length
      || result.some(value => !Number.isSafeInteger(value) || value < 1)) {
      await this.close(); throw failure();
    }
    return Object.freeze([...result] as number[]);
  }

  answer(request: CLMServingRequest, signal: AbortSignal): Promise<unknown> {
    return this.#call('answer', request, signal);
  }

  async close(): Promise<void> {
    if (!this.#stopping) {
      this.#stopping = true;
      this.#child.kill('SIGTERM');
      const timer = setTimeout(() => { this.#child.kill('SIGKILL'); }, 2000);
      await this.#closed; clearTimeout(timer);
    } else await this.#closed;
  }
}

/** Mandatory byte preflight before imports/deserialization. No fixture mode,
 * remote encoder, CPU fallback, downloads or alternate worker source. */
export async function createVerifiedCLMReferenceBackend(options: {
  readonly artifactManifest: unknown; readonly artifactRoot: string;
  readonly pythonExecutable: string; readonly device: 'cuda' | 'mps';
  readonly signal?: AbortSignal;
}) {
  options.signal?.throwIfAborted();
  const manifest = validateCLMArtifactManifest(options.artifactManifest);
  if (!options.pythonExecutable.startsWith('/') || !['cuda', 'mps'].includes(options.device)) throw failure();
  if (options.device === 'mps') {
    if (!('platform' in manifest.runtime) || manifest.runtime.platform !== 'macos-arm64'
      || process.platform !== 'darwin' || process.arch !== 'arm64') throw failure();
    const lock = readFileSync(new URL('../python/requirements-macos.lock', import.meta.url));
    if (createHash('sha256').update(lock).digest('hex') !== manifest.runtime.requirementsSha256) throw failure();
  } else if (!('image' in manifest.runtime)) throw failure();
  const artifactRoot = options.artifactRoot;
  const preflight = await preflightCLMArtifacts(manifest, artifactRoot);
  options.signal?.throwIfAborted();
  const child = spawn(options.pythonExecutable,
    ['-B', fileURLToPath(new URL('../python/reference_backend.py', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // No API key, proxy credential, personal profile or owner environment.
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1',
        HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
        TOKENIZERS_PARALLELISM: 'false' },
    });
  const backend = new CLMReferenceProcess(child, digest(manifest as unknown as JSONValue), manifest.encoder.revision,
    { manifest, artifactRoot, device: options.device, manifestDigest: preflight.manifestDigest });
  const abort = () => { void backend.close(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try { await backend.ready; options.signal?.throwIfAborted(); return backend; }
  catch { await backend.close(); throw failure(); }
  finally { options.signal?.removeEventListener('abort', abort); }
}
