import { readFileSync } from 'node:fs';
import { parseJSON } from '../packages/protocol/src/json.ts';
import { createVerifiedCLMReferenceBackend } from '../packages/providers/src/clm-reference-process.ts';
import { listenVerifiedCLMServingGateway } from '../packages/providers/src/clm-serving-boundary.ts';

// Explicit local configuration; never accept request-selected artifacts/devices.
const [manifestPath, artifactRoot, pythonExecutable, device, portText] = process.argv.slice(2);
let backend: Awaited<ReturnType<typeof createVerifiedCLMReferenceBackend>> | undefined;
const startup = new AbortController();
const abortStartup = () => startup.abort();
process.once('SIGTERM', abortStartup); process.once('SIGINT', abortStartup);
try {
  if (!manifestPath || !artifactRoot || !pythonExecutable || !['cuda', 'mps'].includes(device ?? '')
    || !portText || !/^\d+$/.test(portText) || process.argv.length !== 7) throw new Error();
  const apiKey = process.env.CLM_SERVING_API_KEY;
  if (!apiKey || !/^[\x21-\x7e]{32,512}$/.test(apiKey)) throw new Error();
  const artifactManifest = parseJSON(readFileSync(manifestPath));
  backend = await createVerifiedCLMReferenceBackend({ artifactManifest, artifactRoot, pythonExecutable,
    device: device as 'cuda' | 'mps', signal: startup.signal });
  const server = await listenVerifiedCLMServingGateway({ artifactManifest, artifactRoot, backend, apiKey,
    port: Number(portText), maxConcurrent: 1 });
  if (startup.signal.aborted) { server.closeAllConnections(); server.close(); throw new Error(); }
  process.removeListener('SIGTERM', abortStartup); process.removeListener('SIGINT', abortStartup);
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    server.closeAllConnections(); server.close(); await backend!.close();
  };
  process.once('SIGTERM', () => { void stop(); }); process.once('SIGINT', () => { void stop(); });
  console.log('Verified local CLM listener started; inference qualification remains required.');
} catch {
  await backend?.close(); console.error('CLM startup refused; check configuration and verified local artifacts.');
  process.exitCode = 1;
}
