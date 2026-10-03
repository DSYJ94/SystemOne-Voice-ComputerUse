import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { ManagedObservationSession } from '../src/managed-observation.ts';

const PAGE = `<!doctype html><title>Menu page</title>
<button id="toggle" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');
  document.getElementById('note').textContent='Expanded'">Show details</button><p id="note">Collapsed</p>
<div style="display:none"><a href="/de" title="Article – German">Deutsch</a></div>
<form method="post" action="/post"><button type="submit">Send</button></form>`;

test('collapsed-menu links are followable in scope and clicks verify a visible change', async t => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(request.url === '/de' ? '<title>Deutsch</title><p>Hallo</p>' : PAGE);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await ManagedObservationSession.launch(`${origin}/`, { allowedOrigins: [origin], headless: true });
  t.after(async () => { await session.close(); server.close(); });
  let observed = await session.observe();
  const hidden = observed.controls.find(control => control.label === 'Article – German');
  assert.ok(hidden?.hidden && hidden.destinationUrl === `${origin}/de` && !hidden.clickable && !hidden.editable);
  const toggle = observed.controls.find(control => control.label === 'Show details');
  assert.ok(toggle?.clickable && !toggle.hidden);
  // A POST form's submit button is neither submittable nor clickable.
  assert.ok(observed.controls.filter(control => control.label === 'Send').every(c => !c.submittable && !c.clickable));
  const click = await session.prepareClick(observed.observationId, toggle.id, new AbortController().signal);
  assert.equal(await click.send(), true);
  observed = await session.observe();
  const link = observed.controls.find(control => control.label === 'Article – German')!;
  assert.ok(link.hidden);
  const navigate = await session.prepareNavigate(observed.observationId, link.id, link.destinationUrl!,
    new AbortController().signal, { acceptInScopeRedirect: true });
  assert.equal(await navigate.send(), true);
  assert.equal((await session.observe()).title, 'Deutsch');
});
