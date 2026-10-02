import { createHash } from 'node:crypto';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { ContractError, digest } from '../../protocol/src/json.ts';
import type { JSONValue } from '../../protocol/src/json.ts';

export const CLM_REFERENCE_REVISION = 'bb42c6c5bf914fd449bed2f6ca65be80602cb1f7';
export const CLM_HEAD_REVISION = 'e939398d4556fcd9400c76fa8c5a513202f42b0a';
export const CLM_HEAD_SHA256 = 'b2b4a8c9c2d39263eff78a351eb909a342ce9b3bf21a3f07c1d1bf15f1c4eda5';
const HASH = /^[a-f0-9]{64}$/;
const REVISION = /^(?!0{40}$)[a-f0-9]{40}$/;
const RECIPE = Object.freeze({ pooling: 'last_token', inputDimension: 4096, normalizeEncoder: true,
  normalizeHeads: true, maxLogitScale: 100, maxTokensPerText: 2048, overflow: 'reject', precision: 'bfloat16' });
const SECURITY = Object.freeze({ transport: 'tls', authentication: 'bearer', encoderAccess: 'private',
  requestLogging: 'disabled', downloads: 'disabled', hotReload: 'disabled', checkpointLoading: 'weights_only',
  trustRemoteCode: false });

export interface CLMArtifactFile {
  readonly path: string;
  readonly role: 'weights' | 'tokenizer' | 'config' | 'license';
  readonly sha256: string;
  readonly bytes: number;
}
export interface CLMArtifactManifest {
  readonly schemaVersion: 'systemone-clm-artifacts-v1' | 'systemone-clm-artifacts-v2';
  readonly referenceRevision: string;
  readonly encoder: { readonly repository: 'Qwen/Qwen3-8B'; readonly revision: string; readonly files: readonly CLMArtifactFile[] };
  readonly heads: { readonly repository: 'Contrastive-LM/CLM-v0.1-8B'; readonly revision: string; readonly files: readonly CLMArtifactFile[] };
  readonly runtime: { readonly image: string; readonly serverRevision: string } | {
    readonly platform: 'macos-arm64'; readonly pythonVersion: `3.12.${number}`;
    readonly requirementsSha256: string; readonly serverRevision: string;
  };
  readonly recipe: typeof RECIPE;
  readonly security: typeof SECURITY;
  readonly licenseReviewRef: string;
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('expected artifact manifest object');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) {
    throw new ContractError('artifact manifest fields mismatch');
  }
  return record;
}

function files(value: unknown, component: 'encoder' | 'heads'): readonly CLMArtifactFile[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) throw new ContractError('invalid artifact file count');
  const result = value.map(item => {
    const file = object(item, ['path', 'role', 'sha256', 'bytes']);
    if (typeof file.path !== 'string' || file.path.length > 256 || !/^[A-Za-z0-9_/-][A-Za-z0-9._/-]*$/.test(file.path)
      || file.path.startsWith('/') || file.path.split('/').some(part => !part || part.startsWith('.'))
      || !file.path.startsWith(`${component}/`)
      || !['weights', 'tokenizer', 'config', 'license'].includes(file.role as string)
      || typeof file.sha256 !== 'string' || !HASH.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || (file.bytes as number) < 1 || (file.bytes as number) > 100_000_000_000) {
      throw new ContractError('invalid artifact file identity or path');
    }
    if (component === 'encoder' && file.role === 'weights' && !file.path.endsWith('.safetensors')) {
      throw new ContractError('encoder weights must use safetensors');
    }
    return Object.freeze({ ...file }) as unknown as CLMArtifactFile;
  });
  if (new Set(result.map(file => file.path)).size !== result.length
    || result.reduce((sum, file) => sum + file.bytes, 0) > 100_000_000_000) throw new ContractError('duplicate or excessive artifacts');
  const roles = new Set(result.map(file => file.role));
  for (const role of component === 'encoder' ? ['weights', 'tokenizer', 'config', 'license'] : ['weights', 'license']) {
    if (!roles.has(role as CLMArtifactFile['role'])) throw new ContractError('required artifact role missing');
  }
  if (component === 'heads') {
    const weights = result.filter(file => file.role === 'weights');
    if (weights.length !== 1 || weights[0]?.path !== 'heads/CLM_v0.1-8B.pt' || weights[0]?.sha256 !== CLM_HEAD_SHA256) {
      throw new ContractError('reference head identity mismatch');
    }
  }
  return Object.freeze(result);
}

/** Checks declarations only. Does not download, import, load tensors or deploy.
 * No alias, moving revision or placeholder can establish artifact readiness. */
export function validateCLMArtifactManifest(value: unknown): CLMArtifactManifest {
  const manifest = object(value, ['schemaVersion', 'referenceRevision', 'encoder', 'heads', 'runtime', 'recipe', 'security', 'licenseReviewRef']);
  const encoder = object(manifest.encoder, ['repository', 'revision', 'files']);
  const heads = object(manifest.heads, ['repository', 'revision', 'files']);
  const native = manifest.schemaVersion === 'systemone-clm-artifacts-v2';
  const runtime = object(manifest.runtime, native
    ? ['platform', 'pythonVersion', 'requirementsSha256', 'serverRevision'] : ['image', 'serverRevision']);
  const recipe = object(manifest.recipe, Object.keys(RECIPE));
  const security = object(manifest.security, Object.keys(SECURITY));
  if ((!native && manifest.schemaVersion !== 'systemone-clm-artifacts-v1') || manifest.referenceRevision !== CLM_REFERENCE_REVISION
    || encoder.repository !== 'Qwen/Qwen3-8B' || typeof encoder.revision !== 'string' || !REVISION.test(encoder.revision)
    || heads.repository !== 'Contrastive-LM/CLM-v0.1-8B' || heads.revision !== CLM_HEAD_REVISION
    || (native ? runtime.platform !== 'macos-arm64' || typeof runtime.pythonVersion !== 'string'
      || !/^3\.12\.\d+$/.test(runtime.pythonVersion)
      || typeof runtime.requirementsSha256 !== 'string' || !HASH.test(runtime.requirementsSha256)
      : typeof runtime.image !== 'string' || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(runtime.image))
    || typeof runtime.serverRevision !== 'string' || !REVISION.test(runtime.serverRevision)
    || Object.entries(RECIPE).some(([key, expected]) => recipe[key] !== expected)
    || Object.entries(SECURITY).some(([key, expected]) => security[key] !== expected)
    || typeof manifest.licenseReviewRef !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(manifest.licenseReviewRef)) {
    throw new ContractError('unresolved artifact pin or incompatible serving declaration');
  }
  return Object.freeze({ schemaVersion: native ? 'systemone-clm-artifacts-v2' : 'systemone-clm-artifacts-v1', referenceRevision: CLM_REFERENCE_REVISION,
    encoder: Object.freeze({ repository: 'Qwen/Qwen3-8B', revision: encoder.revision, files: files(encoder.files, 'encoder') }),
    heads: Object.freeze({ repository: 'Contrastive-LM/CLM-v0.1-8B', revision: CLM_HEAD_REVISION, files: files(heads.files, 'heads') }),
    runtime: Object.freeze(native ? { platform: 'macos-arm64' as const,
      // Passed through verbatim: the worker binds this exact value against the
      // running interpreter, so it must be the version the manifest declares.
      pythonVersion: runtime.pythonVersion as `3.12.${number}`,
      requirementsSha256: runtime.requirementsSha256 as string, serverRevision: runtime.serverRevision }
      : { image: runtime.image as string, serverRevision: runtime.serverRevision }),
    recipe: RECIPE, security: SECURITY, licenseReviewRef: manifest.licenseReviewRef });
}

/** Verifies already-present local bytes with bounded streaming and no tensor
 * deserialization. Read-only artifact mounts and startup checks remain required
 * to bind these bytes to a later inference process. */
export async function verifyCLMArtifactFiles(rootPath: string, declared: readonly CLMArtifactFile[], signal?: AbortSignal) {
  if (!Array.isArray(declared) || declared.length < 1 || declared.length > 256) throw new ContractError('invalid local artifact count');
  const snapshot: readonly CLMArtifactFile[] = declared.map((file: CLMArtifactFile) => Object.freeze({ ...file }));
  if (new Set(snapshot.map(file => file.path)).size !== snapshot.length) throw new ContractError('duplicate local artifacts');
  for (const file of snapshot) {
    if (typeof file.path !== 'string' || !file.path || file.path.startsWith('/') || file.path.includes('\\')
      || file.path.split('/').some(part => !part || part.startsWith('.'))
      || typeof file.sha256 !== 'string' || !HASH.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 100_000_000_000) {
      throw new ContractError('invalid local artifact identity');
    }
  }
  if (snapshot.reduce((sum, file) => sum + file.bytes, 0) > 100_000_000_000) throw new ContractError('excessive local artifacts');
  signal?.throwIfAborted();
  const root = realpathSync(rootPath);
  const results: { path: string; sha256: string; bytes: number }[] = [];
  for (const file of snapshot) {
    signal?.throwIfAborted();
    const path = resolve(root, file.path);
    if (!path.startsWith(root + sep)) throw new ContractError('artifact escapes root');
    let current = root;
    for (const part of file.path.split('/')) {
      current = resolve(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new ContractError('artifact symlink denied');
    }
    if (realpathSync(path) !== path) throw new ContractError('artifact path changed');
    if (!lstatSync(path).isFile()) throw new ContractError('artifact is not a regular file');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      const current = lstatSync(path);
      if (realpathSync(path) !== path || !current.isFile() || current.ino !== before.ino || current.dev !== before.dev) {
        throw new ContractError('artifact path changed during open');
      }
      if (!before.isFile() || before.size !== file.bytes) throw new ContractError('artifact file size mismatch');
      const hash = createHash('sha256'); let bytes = 0;
      const stream = handle.createReadStream({ autoClose: false, ...(signal ? { signal } : {}) });
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > file.bytes) { stream.destroy(); throw new ContractError('artifact grew during verification'); }
        hash.update(chunk);
      }
      const after = await handle.stat();
      if (bytes !== file.bytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
        throw new ContractError('artifact changed during verification');
      }
      const actual = hash.digest('hex');
      if (actual !== file.sha256) throw new ContractError('artifact checksum mismatch');
      results.push(Object.freeze({ path: file.path, sha256: actual, bytes }));
    } finally { await handle.close(); }
  }
  return Object.freeze(results);
}

export async function preflightCLMArtifacts(value: unknown, rootPath: string, signal?: AbortSignal) {
  const manifest = validateCLMArtifactManifest(value);
  const verifiedFiles = await verifyCLMArtifactFiles(rootPath, [...manifest.encoder.files, ...manifest.heads.files], signal);
  return Object.freeze({ kind: 'systemone-clm-artifact-preflight', manifestDigest: digest(manifest as unknown as JSONValue),
    verifiedFiles, servingConfigurationDeclared: true, loadedArtifactIdentityVerified: false,
    inferenceQualified: false, licenseClearanceEstablished: false, paidDeploymentAuthorized: false });
}
