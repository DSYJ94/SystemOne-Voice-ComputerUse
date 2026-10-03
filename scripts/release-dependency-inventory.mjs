import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source inventory only: never inspect profiles, credentials or model bytes.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'docs/release/dependency-inventory.json');
const args = process.argv.slice(2);
if (args.length !== 1 || !['--write', '--check'].includes(args[0])) {
  console.error('Usage: node scripts/release-dependency-inventory.mjs --write|--check');
  process.exit(2);
}
const sources = {};
function read(path) {
  const bytes = readFileSync(resolve(root, path));
  sources[path] = { sha256: createHash('sha256').update(bytes).digest('hex') };
  return bytes.toString('utf8');
}
function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const manifest = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const python = read('requirements-test.txt');
  const nodeVersion = read('.node-version').trim();
  const bundle = read('scripts/build-bundled-dev.sh');
  const clm = JSON.parse(read('packages/providers/fixtures/clm-artifact-manifest.pending.json'));
  const declarations = JSON.parse(read('docs/release/dependencies.pending.json'));
  const dependencyRecord = read('docs/DEPENDENCIES.md');
  const publishedHeadSha256 = /Published head SHA-256: `([a-f0-9]{64})`/.exec(dependencyRecord)?.[1];
  requireCondition(publishedHeadSha256, 'Missing published head hash in dependency record');
  requireCondition(lock.lockfileVersion === 3, 'Expected npm lockfile v3');
  requireCondition(/^\d+\.\d+\.\d+$/.test(nodeVersion), 'Node must be exactly pinned');
  const npm = Object.entries(lock.packages).filter(([path]) => path !== '').map(([path, pkg]) => {
    requireCondition(path.startsWith('node_modules/') && !pkg.link, `Unsupported package path: ${path}`);
    requireCondition(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version), `Unpinned version: ${path}`);
    requireCondition(typeof pkg.license === 'string' && pkg.license.length > 0, `Missing license: ${path}`);
    requireCondition(typeof pkg.resolved === 'string' && pkg.resolved.startsWith('https://registry.npmjs.org/'), `Unreviewed registry: ${path}`);
    requireCondition(/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.integrity), `Missing SHA-512 integrity: ${path}`);
    return {
      path, name: path.split('node_modules/').at(-1), version: pkg.version,
      scope: pkg.dev ? 'development' : 'bundled-runtime', optional: pkg.optional === true,
      os: pkg.os ?? [], cpu: pkg.cpu ?? [], resolved: pkg.resolved,
      integrity: pkg.integrity, declaredLicense: pkg.license,
      dependencies: pkg.dependencies ?? {}, optionalDependencies: pkg.optionalDependencies ?? {},
      noticeStatus: 'pending-full-distribution-notices',
    };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  for (const section of ['dependencies', 'devDependencies']) {
    requireCondition(JSON.stringify(manifest[section]) === JSON.stringify(lock.packages[''][section]), `Manifest/lock drift: ${section}`);
    for (const [name, version] of Object.entries(manifest[section])) {
      requireCondition(lock.packages[`node_modules/${name}`]?.version === version, `Direct pin mismatch: ${name}`);
    }
  }
  const pythonTests = python.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#')).map(line => {
    const match = /^([\w.-]+)(?:\[([\w,-]+)\])?==(\d+(?:\.\d+)+(?:\.post\d+)?)$/.exec(line);
    requireCondition(match, `Unpinned Python requirement: ${line}`);
    return { name: match[1], extras: match[2]?.split(',') ?? [], version: match[3],
      scope: 'test-only-not-shipped', artifactHashes: null, declaredLicense: null,
      reviewStatus: 'pending-artifact-hashes-and-per-package-license-review' };
  });
  requireCondition(new Set(pythonTests.map(pkg => pkg.name)).size === pythonTests.length, 'Duplicate Python requirement');
  requireCondition(declarations.node.version === nodeVersion, 'Node declaration drift');
  requireCondition(bundle.includes(`expected_hash=${declarations.node.sha256}`), 'Node bundle hash drift');
  requireCondition(bundle.includes(`node-v${nodeVersion}-darwin-arm64`), 'Node bundle version drift');
  requireCondition(declarations.browsers.playwrightVersion === manifest.dependencies.playwright, 'Playwright declaration drift');
  requireCondition(bundle.includes('chromium_headless_shell-$revision') && bundle.includes('chromium-$revision'), 'Browser bundle membership changed');
  const browsers = JSON.parse(read('node_modules/playwright-core/browsers.json'));
  const core = JSON.parse(read('node_modules/playwright-core/package.json'));
  requireCondition(core.version === manifest.dependencies.playwright, 'Installed Playwright metadata is not version matched; run npm ci --ignore-scripts');
  for (const name of declarations.browsers.names) {
    const browser = browsers.browsers.find(item => item.name === name);
    requireCondition(browser?.revision === declarations.browsers.revision && browser?.browserVersion === declarations.browsers.browserVersion, `Browser metadata drift: ${name}`);
  }
  const inventory = {
    schemaVersion: 'systemone-release-dependency-inventory-v1',
    status: 'pending-release-review',
    qualification: 'Source declarations and lockfile inventory; not a distributable SBOM, artifact attestation or legal clearance.',
    sources,
    npm,
    pythonTests,
    nonNpm: declarations,
    clm: { location: 'owned-private-server-planned', declarations: clm,
      artifactBytesVerified: false, inferenceQualified: false,
      publishedHeadSha256,
      publishedHeadHashStatus: 'upstream-reported-not-local-byte-verification',
      openGates: ['encoder-tokenizer-revisions', 'artifact-file-hashes', 'container-digest',
        'owned-server-revision', 'exact-artifact-license-review', 'runtime-attestation-and-calibration'] },
    releaseGates: ['full-license-and-notice-collection', 'artifact-sbom-and-transitive-native-components',
      'authenticated-download-provenance', 'security-update-and-advisory-review',
      'release-signing-notarization', 'clean-mac-install-update-rollback',
      'existing-profile-chrome-qualification', 'enabled-mode-privacy-review'],
  };
  const bytes = JSON.stringify(inventory, null, 2) + '\n';
  if (args[0] === '--write') writeFileSync(output, bytes);
  else requireCondition(readFileSync(output, 'utf8') === bytes, 'Inventory stale; regenerate with npm run inventory:write and review the diff');
  console.log(`Inventory ${args[0] === '--write' ? 'written' : 'validated'}: ${npm.length} npm records (${npm.filter(pkg => pkg.scope === 'bundled-runtime').length} runtime), ${pythonTests.length} Python test records; release review remains pending.`);
} catch (error) {
  console.error(`Release dependency inventory failed: ${error.message}`);
  process.exitCode = 1;
}
