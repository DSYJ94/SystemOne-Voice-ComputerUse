import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../packages/protocol/src/json.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = mkdtempSync(join(tmpdir(), 'systemone-native-digest-'));
const controls = [{ id: 'node-1', role: 'AXTextField', label: 'Fixture Name',
  enabled: true, secure: false, canSetValue: true }];
const action = { taskId: 'task-1', scopeRef: 'native:scope-1',
  observationId: 'obs-1', candidateId: 'node-1', label: 'Fixture Name',
  valueDigest: digest('fixture-123'), policyRevision: 'native-ax-policy-v1' };
const pressControls = [{ id: 'node-2', role: 'AXButton', label: 'Documents',
  enabled: true, secure: false, canPress: true }];
const pressAction = { taskId: 'task-1', scopeRef: 'native:scope-1',
  observationId: 'obs-1', candidateId: 'node-2', role: 'AXButton',
  label: 'Documents', expectedWindowTitle: 'SystemOne Fixture — Documents',
  policyRevision: 'native-ax-press-fixture-v1' };
const fileControls = [
  { id: 'file-node', role: 'AXButton', label: 'Budget.xlsx',
    enabled: true, secure: false, canPress: true },
  { id: 'open-node', role: 'AXButton', label: 'Open selected file',
    enabled: true, secure: false, canPress: true },
];
const fileAction = { taskId: 'task-1', scopeRef: 'native:scope-1',
  observationId: 'obs-2', candidateId: 'file-node', role: 'AXButton',
  label: 'Budget.xlsx',
  expectedWindowTitle: 'SystemOne Fixture — Documents — Budget.xlsx selected',
  policyRevision: 'native-ax-press-fixture-v1' };
const openControls = [{ id: 'open-node', role: 'AXButton',
  label: 'Open selected file', enabled: true, secure: false, canPress: true }];
const openAction = { taskId: 'task-1', scopeRef: 'native:scope-1',
  observationId: 'obs-3', candidateId: 'open-node', role: 'AXButton',
  label: 'Open selected file',
  expectedWindowTitle: 'SystemOne Fixture — Documents — Budget.xlsx opened',
  policyRevision: 'native-ax-press-fixture-v1' };
try {
  const binary = join(build, 'NativeWorkerPermitDigestCheck');
  const moduleCache = join(build, 'module-cache');
  mkdirSync(moduleCache);
  const compile = spawnSync('swiftc', ['-swift-version', '6', '-parse-as-library',
    '-module-cache-path', moduleCache,
    join(root, 'packages/protocol/swift/Sources/ProtocolDigest/CanonicalJSON.swift'),
    join(root, 'apps/native-dev/NativeWorkerPermitDigest.swift'),
    join(root, 'apps/native-dev/NativeWorkerPermitDigestCheck.swift'),
    '-o', binary], { encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stderr);
  const check = spawnSync(binary, [digest(controls), digest(action),
    digest(pressControls), digest(pressAction),
    digest(fileControls), digest(fileAction),
    digest(openControls), digest(openAction)],
    { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  process.stdout.write(check.stdout);
} finally { rmSync(build, { recursive: true, force: true }); }
