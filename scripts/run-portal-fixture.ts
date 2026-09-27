import { startPortalFixture } from '../packages/fixtures/portal.ts';

const fixture = await startPortalFixture();
console.log(`Synthetic portal URL: ${fixture.url}/`);
console.log('Keep this terminal open. Press Ctrl-C to stop the fixture.');

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await fixture.close();
}
process.on('SIGINT', () => { void close().catch(() => { process.exitCode = 1; }); });
process.on('SIGTERM', () => { void close().catch(() => { process.exitCode = 1; }); });
