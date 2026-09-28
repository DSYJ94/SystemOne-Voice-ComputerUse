import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const HOST_NAME = 'com.aurium.systemone.chrome';
const EXTENSION_ID = /^[a-p]{32}$/;
const CDHASH = /^[a-f0-9]{40,128}$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;
const SIGNING_ID = /^[A-Za-z0-9.-]{1,200}$/;

export const chromeRegistrationDirectory = join(homedir(), 'Library',
  'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function boundedJSON(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > 4_096) {
    throw new Error(`invalid regular JSON file: ${path}`);
  }
  const bytes = await readFile(path);
  if (bytes.length !== metadata.size) throw new Error(`JSON file changed while reading: ${path}`);
  return { value: JSON.parse(bytes.toString('utf8')), bytes };
}

async function validatedManifest(manifestPath, requireHost) {
  if (!isAbsolute(manifestPath)) throw new Error('staged manifest path must be absolute');
  const { value: manifest, bytes } = await boundedJSON(manifestPath);
  if (!plainObject(manifest) || manifest.name !== HOST_NAME
    || manifest.type !== 'stdio' || !isAbsolute(manifest.path)
    || typeof manifest.description !== 'string'
    || !Array.isArray(manifest.allowed_origins)
    || manifest.allowed_origins.length !== 1) {
    throw new Error('invalid SystemOne Chrome native-host manifest');
  }
  const origin = manifest.allowed_origins[0];
  const match = typeof origin === 'string'
    && /^chrome-extension:\/\/([a-p]{32})\/$/.exec(origin);
  if (!match || !EXTENSION_ID.test(match[1])) {
    throw new Error('native-host manifest needs one exact extension origin');
  }
  if (requireHost) {
    const host = await lstat(manifest.path);
    if (!host.isFile()) throw new Error('native host is not a regular file');
    await access(manifest.path, constants.X_OK);
    const { value: config } = await boundedJSON(
      join(dirname(manifest.path), 'ChromeNativeHost.json'));
    if (!plainObject(config) || config.extensionId !== match[1]
      || !SIGNING_ID.test(config.controllerSigningIdentifier)
      || (config.controllerTeamIdentifier !== null
        && config.controllerTeamIdentifier !== undefined
        && !TEAM_ID.test(config.controllerTeamIdentifier))
      || !Array.isArray(config.controllerCDHashes)
      || !config.controllerCDHashes.every(hash => CDHASH.test(hash))
      || (!config.controllerTeamIdentifier && config.controllerCDHashes.length === 0)) {
      throw new Error('native host configuration does not match the manifest');
    }
    await execFileAsync('/usr/bin/codesign', ['--verify', '--strict', manifest.path]);
  }
  return bytes;
}

async function existingRegistration(destination) {
  try {
    const metadata = await lstat(destination);
    if (!metadata.isFile()) throw new Error('registered manifest is not a regular file');
    return await readFile(destination);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Register only a validated, signed host. Never replace a different registration. */
export async function installChromeNativeHost(manifestPath,
  registrationDirectory = chromeRegistrationDirectory) {
  const bytes = await validatedManifest(manifestPath, true);
  await mkdir(registrationDirectory, { recursive: true, mode: 0o700 });
  if (!(await lstat(registrationDirectory)).isDirectory()) {
    throw new Error('Chrome registration directory must be a real directory');
  }
  const destination = join(registrationDirectory, `${HOST_NAME}.json`);
  const current = await existingRegistration(destination);
  if (current) {
    if (current.equals(bytes)) return { destination, changed: false };
    throw new Error('a different native-host registration already exists; refusing to replace it');
  }
  const temporary = join(registrationDirectory,
    `.${HOST_NAME}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally { await file.close(); }
    // A hard link makes the complete file visible without replacing a racing install.
    await link(temporary, destination);
  } catch (error) {
    if (error.code === 'EEXIST') {
      const raced = await existingRegistration(destination);
      if (raced?.equals(bytes)) return { destination, changed: false };
      throw new Error('native-host registration changed during install');
    }
    throw error;
  } finally { await unlink(temporary).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  }); }
  return { destination, changed: true };
}

export async function verifyChromeNativeHost(manifestPath,
  registrationDirectory = chromeRegistrationDirectory) {
  const bytes = await validatedManifest(manifestPath, true);
  const destination = join(registrationDirectory, `${HOST_NAME}.json`);
  const current = await existingRegistration(destination);
  if (!current?.equals(bytes)) throw new Error('Chrome registration does not match staged manifest');
  return destination;
}

/** Remove only the exact registration supplied by this installation. */
export async function removeChromeNativeHost(manifestPath,
  registrationDirectory = chromeRegistrationDirectory) {
  const bytes = await validatedManifest(manifestPath, false);
  const destination = join(registrationDirectory, `${HOST_NAME}.json`);
  const current = await existingRegistration(destination);
  if (current === null) return { destination, changed: false };
  if (!current.equals(bytes)) {
    throw new Error('registered manifest differs; refusing to remove it');
  }
  await unlink(destination);
  return { destination, changed: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [operation, manifestPath] = process.argv.slice(2);
  if (!manifestPath || process.argv.length !== 4
    || !['install', 'verify', 'remove'].includes(operation)) {
    process.stderr.write('Usage: node scripts/register-chrome-native-host.mjs install|verify|remove ABSOLUTE_STAGED_MANIFEST\n');
    process.exitCode = 2;
  } else {
    const actions = { install: installChromeNativeHost,
      verify: verifyChromeNativeHost, remove: removeChromeNativeHost };
    actions[operation](manifestPath).then(
      result => process.stdout.write(`${typeof result === 'string' ? result : result.destination}\n`),
      error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; },
    );
  }
}
