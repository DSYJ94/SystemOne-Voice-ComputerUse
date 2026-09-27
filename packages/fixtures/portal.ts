import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { once } from 'node:events';

interface Invoice {
  readonly id: string;
  readonly title: string;
  readonly account: string;
  readonly issued: string;
}

const INVOICES: readonly Invoice[] = Object.freeze([
  { id: 'INV-104', title: 'April Service Statement', account: 'Northstar Studio', issued: '2026-04-03' },
  { id: 'INV-105', title: 'April Service Statement', account: 'Harbor Works', issued: '2026-04-04' },
  { id: 'INV-106', title: 'May Service Statement', account: 'Northstar Studio', issued: '2026-05-03' },
]);

function script(downloadDelayMs: number): string { return `document.addEventListener('DOMContentLoaded', () => {
  const link = document.getElementById('delayed-download');
  if (link) window.setTimeout(() => { link.hidden = false; }, ${downloadDelayMs});
});\n`; }

const STYLE = `body{font:16px system-ui,sans-serif;max-width:760px;margin:3rem auto;padding:0 1rem;color:#202124}
a{color:#174ea6}label{display:block;margin-bottom:.4rem}input{font:inherit;padding:.35rem}
button{font:inherit;padding:.4rem .7rem}table{border-collapse:collapse;width:100%;margin-top:1rem}
th,td{border:1px solid #ccd0d5;text-align:left;padding:.6rem}caption{text-align:left;font-weight:bold;margin-bottom:.5rem}
.note{color:#555}\n`;

export interface PortalFixture {
  readonly url: string;
  requestCount(path: string): number;
  close(): Promise<void>;
}

/** Isolated, read-only fixture: never accepts uploads, credentials or user files. */
export async function startPortalFixture(options: { downloadDelayMs?: number } = {}): Promise<PortalFixture> {
  const downloadDelayMs = options.downloadDelayMs ?? 250;
  if (!Number.isSafeInteger(downloadDelayMs) || downloadDelayMs < 0
    || downloadDelayMs > 10_000) throw new Error('invalid fixture download delay');
  let expectedHost = '';
  const requests = new Map<string, number>();
  const server = createServer((request, response) => {
    if (request.headers.host !== expectedHost) {
      respond(response, 421, 'text/plain; charset=utf-8', 'Wrong fixture host.\n', request.method);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      respond(response, 405, 'text/plain; charset=utf-8', 'Method not allowed.\n', request.method);
      return;
    }
    let url: URL;
    try { url = new URL(request.url ?? '/', `http://${expectedHost}`); }
    catch {
      respond(response, 400, 'text/plain; charset=utf-8', 'Invalid URL.\n', request.method);
      return;
    }
    const path = url.pathname;
    requests.set(path, (requests.get(path) ?? 0) + 1);
    if (path === '/portal.js') {
      respond(response, 200, 'text/javascript; charset=utf-8', script(downloadDelayMs), request.method);
    } else if (path === '/portal.css') {
      respond(response, 200, 'text/css; charset=utf-8', STYLE, request.method);
    } else if (path === '/') {
      respond(response, 200, 'text/html; charset=utf-8', page('Invoice Portal Fixture',
        `<main data-page="home"><h1>Invoice Portal Fixture</h1>
         <p class="note">Synthetic documents only. Search by title, account or invoice ID.</p>
         ${searchForm('')}<p><a href="/invoices">Browse all invoices</a></p></main>`), request.method);
    } else if (path === '/invoices') {
      const q = url.searchParams.get('q') ?? '';
      if (q.length > 100) {
        respond(response, 400, 'text/plain; charset=utf-8', 'Search term too long.\n', request.method);
        return;
      }
      const term = q.trim().toLocaleLowerCase('en-US');
      const matches = INVOICES.filter(invoice => !term ||
        [invoice.id, invoice.title, invoice.account].some(value =>
          value.toLocaleLowerCase('en-US').includes(term)));
      const rows = matches.map(invoice => `<tr data-invoice-id="${invoice.id}">
        <td>${invoice.id}</td><td>${escapeHTML(invoice.title)}</td>
        <td>${escapeHTML(invoice.account)}</td><td>${invoice.issued}</td>
        <td><a href="/invoices/${invoice.id}">Open ${invoice.id}</a></td></tr>`).join('');
      respond(response, 200, 'text/html; charset=utf-8', page('Invoice search',
        `<main data-page="search-results"><h1>Invoice search</h1>${searchForm(q)}
         <p role="status">${matches.length} results</p>
         <table><caption>Synthetic invoices</caption><thead><tr>
         <th>ID</th><th>Title</th><th>Account</th><th>Issued</th><th>Action</th>
         </tr></thead><tbody>${rows}</tbody></table></main>`), request.method);
    } else {
      const detail = /^\/invoices\/(INV-\d{3})$/.exec(path);
      const download = /^\/downloads\/(INV-\d{3})$/.exec(path);
      if (detail) {
        const invoice = INVOICES.find(item => item.id === detail[1]);
        if (invoice) {
          respond(response, 200, 'text/html; charset=utf-8', page(invoice.title,
            `<main data-page="invoice-detail" data-invoice-id="${invoice.id}">
             <p><a href="/invoices">Back to results</a></p>
             <h1>${escapeHTML(invoice.title)}</h1>
             <dl><dt>Invoice ID</dt><dd>${invoice.id}</dd>
             <dt>Account</dt><dd>${escapeHTML(invoice.account)}</dd>
             <dt>Issued</dt><dd>${invoice.issued}</dd></dl>
             <p class="note">The download control appears after a short scripted delay.</p>
             <a id="delayed-download" hidden href="/downloads/${invoice.id}">Download ${invoice.id}</a>
             </main>`), request.method);
          return;
        }
      }
      if (download) {
        const invoice = INVOICES.find(item => item.id === download[1]);
        if (invoice) {
          response.setHeader('Content-Disposition', `attachment; filename="${invoice.id}.txt"`);
          respond(response, 200, 'text/plain; charset=utf-8',
            `SYNTHETIC FIXTURE\nInvoice: ${invoice.id}\nTitle: ${invoice.title}\nAccount: ${invoice.account}\n`,
            request.method);
          return;
        }
      }
      respond(response, 404, 'text/plain; charset=utf-8', 'Fixture route not found.\n', request.method);
    }
  });
  server.listen(0, '127.0.0.1');
  try { await once(server, 'listening'); }
  catch (error) { server.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('fixture did not bind a TCP port');
  }
  expectedHost = `127.0.0.1:${address.port}`;
  return Object.freeze({
    url: `http://${expectedHost}`,
    requestCount: (path: string) => requests.get(path) ?? 0,
    close: async () => { server.close(); await once(server, 'close'); },
  });
}

function searchForm(q: string): string {
  return `<form role="search" action="/invoices" method="get">
    <label for="query">Find invoice</label>
    <input id="query" name="q" value="${escapeHTML(q)}" maxlength="100" autocomplete="off">
    <button type="submit">Search</button></form>`;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHTML(title)}</title><link rel="stylesheet" href="/portal.css">
    <script defer src="/portal.js"></script></head><body>${body}</body></html>`;
}

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function respond(response: ServerResponse, status: number, contentType: string,
  body: string, method: string | undefined): void {
  const bytes = Buffer.from(body, 'utf8');
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(method === 'HEAD' ? undefined : bytes);
}
