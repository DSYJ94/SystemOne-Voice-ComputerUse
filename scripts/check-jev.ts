import { execFileSync } from 'node:child_process';
import { JEV_MODEL } from '../packages/providers/src/jev-wire.ts';

// Confirms the login Keychain key authenticates against TypeSafe's free model
// listing. The key is never printed, logged or passed on a command line.
try {
  const apiKey = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'systemone-jev', '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim();
  const response = await fetch('https://api.typesafe.ai/v1/models', { redirect: 'error',
    headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
  if (response.status === 401) throw new Error('TypeSafe rejected the key (401). Replace the Keychain item systemone-jev.');
  if (!response.ok) throw new Error(`TypeSafe model listing returned HTTP ${response.status}.`);
  await response.body?.cancel();
  console.log(`Jev ready: key accepted, decisions pinned to ${JEV_MODEL}.`);
} catch (error) {
  console.error(error instanceof Error && error.message.startsWith('TypeSafe') ? error.message
    : 'Jev unavailable: store the key with  security add-generic-password -a "$USER" -s systemone-jev -w  and check the network.');
  process.exitCode = 1;
}
