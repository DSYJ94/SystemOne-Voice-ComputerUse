import { lstat, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXTENSION_ID = /^[a-p]{32}$/;
const SIGNING_ID = /^[A-Za-z0-9.-]{1,200}$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;
const CDHASH = /^[a-f0-9]{40,128}$/;

/** Stage files before signing the app bundle. This never installs into Chrome. */
export async function stageChromeNativeHost({ extensionId, hostPath,
  manifestPath, controllerSigningIdentifier, controllerTeamIdentifier = null,
  controllerCDHashes = [] }) {
  if (!EXTENSION_ID.test(extensionId) || !isAbsolute(hostPath)
    || !isAbsolute(manifestPath) || !SIGNING_ID.test(controllerSigningIdentifier)
    || (controllerTeamIdentifier !== null && !TEAM_ID.test(controllerTeamIdentifier))
    || !Array.isArray(controllerCDHashes)
    || !controllerCDHashes.every(hash => CDHASH.test(hash))
    || (controllerTeamIdentifier === null && controllerCDHashes.length === 0)) {
    throw new Error('invalid Chrome native-host staging inputs');
  }
  // The signed configuration is located next to the executable itself. A
  // symlink would make that location ambiguous after host path resolution.
  if (!(await lstat(hostPath)).isFile()) throw new Error('native host is not a regular file');
  const configurationPath = join(dirname(hostPath), 'ChromeNativeHost.json');
  if (resolve(configurationPath) === resolve(manifestPath)) {
    throw new Error('native host manifest conflicts with signed configuration');
  }
  const configuration = {
    extensionId, controllerSigningIdentifier, controllerTeamIdentifier,
    controllerCDHashes,
  };
  const manifest = {
    name: 'com.aurium.systemone.chrome',
    description: 'SystemOne existing Chrome bridge',
    path: hostPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  await writeFile(configurationPath, `${JSON.stringify(configuration, null, 2)}\n`,
    { flag: 'wx', mode: 0o644 });
  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: 'wx', mode: 0o644 });
  } catch (error) {
    await rm(configurationPath);
    throw error;
  }
  return { configurationPath, manifestPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [extensionId, hostPath, manifestPath, controllerSigningIdentifier,
    trustKind, trustValue] = process.argv.slice(2);
  const trust = trustKind === '--team-id'
    ? { controllerTeamIdentifier: trustValue }
    : trustKind === '--cdhash' ? { controllerCDHashes: [trustValue] } : {};
  stageChromeNativeHost({ extensionId, hostPath, manifestPath,
    controllerSigningIdentifier, ...trust }).then(
    paths => { process.stdout.write(`${paths.configurationPath}\n${paths.manifestPath}\n`); },
    error => { process.stderr.write(`Chrome host staging failed: ${error.message}\n`); process.exitCode = 1; },
  );
}
