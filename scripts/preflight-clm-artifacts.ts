import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseJSON } from '../packages/protocol/src/json.ts';
import { preflightCLMArtifacts } from '../packages/providers/src/clm-artifact-preflight.ts';

function argument(name: string): string {
  const index = process.argv.indexOf(name); const value = process.argv[index + 1];
  if (index < 0 || !value || value.startsWith('--')) throw new Error(`missing ${name}`);
  return value;
}

async function main() {
  const bytes = readFileSync(resolve(argument('--manifest')));
  if (bytes.length > 65_536) throw new Error('artifact manifest exceeds 64 KiB');
  const report = await preflightCLMArtifacts(parseJSON(bytes), resolve(argument('--artifacts')));
  const outputPath = resolve(argument('--output'));
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(`Verified ${report.verifiedFiles.length} local artifact files; inference remains unqualified.\n`);
}

main().catch(() => { process.stderr.write('CLM artifact preflight failed; check immutable pins, recipe and local file identities.\n'); process.exitCode = 1; });
