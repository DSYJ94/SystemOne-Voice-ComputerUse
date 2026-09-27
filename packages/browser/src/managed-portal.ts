import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';

const INVOICE_ID = /^INV-\d{3}$/;

export interface PortalRow {
  readonly id: string;
  readonly title: string;
  readonly account: string;
}

export type PortalObservation =
  | { readonly kind: 'home'; readonly revision: number; readonly url: string }
  | { readonly kind: 'results'; readonly revision: number; readonly url: string;
      readonly rows: readonly PortalRow[] }
  | { readonly kind: 'detail'; readonly revision: number; readonly url: string;
      readonly invoiceId: string; readonly title: string; readonly account: string };

export interface PortalDownload {
  readonly invoiceId: string;
  readonly filename: string;
  /** Inside this session's private temporary directory; removed on close. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Explicit fixture task; values must come from the admitted user/fixture scope. */
export interface PortalGoal {
  readonly kind: 'LOCATE' | 'OPEN' | 'DOWNLOAD';
  readonly invoiceId: string;
  readonly title: string;
  readonly account: string;
}

export type PortalGoalResult =
  | { readonly status: 'matched'; readonly revision: number }
  | { readonly status: 'not_matched' | 'unavailable'; readonly reason: string };

/**
 * A deliberately narrow managed Chromium driver for the local synthetic portal.
 * It launches a fresh Playwright profile; it never attaches to Chrome's existing
 * profile, tabs or remote-debugging endpoint. Host authority/Stop are not wired.
 */
export class ManagedPortalSession {
  readonly #origin: string;
  readonly #root: string;
  readonly #context: BrowserContext;
  readonly #page: Page;
  #revision = 0;
  #closed = false;
  #stopPromise: Promise<boolean> | undefined;
  readonly #downloads = new Map<string, { receipt: PortalDownload; revision: number }>();

  get origin(): string { return this.#origin; }

  private constructor(origin: string, root: string, context: BrowserContext, page: Page) {
    this.#origin = origin;
    this.#root = root;
    this.#context = context;
    this.#page = page;
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) this.#revision++;
    });
  }

  static async launch(portalUrl: string, options: { headless?: boolean } = {}): Promise<ManagedPortalSession> {
    const parsed = new URL(portalUrl);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'
      || !parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash
      || parsed.username || parsed.password) {
      throw new Error('managed portal requires an exact loopback fixture origin');
    }
    const root = mkdtempSync(join(tmpdir(), 'systemone-managed-'));
    const profile = join(root, 'profile');
    mkdirSync(profile);
    let context: BrowserContext | undefined;
    try {
      context = await chromium.launchPersistentContext(profile, {
        headless: options.headless ?? true,
        acceptDownloads: true,
        serviceWorkers: 'block',
        timeout: 15_000,
      });
      const allowedOrigin = parsed.origin;
      await context.route('**/*', route => {
        let allowed = false;
        try {
          const requestUrl = new URL(route.request().url());
          allowed = requestUrl.protocol === 'http:' && requestUrl.origin === allowedOrigin;
        } catch { /* malformed URL stays denied */ }
        return allowed ? route.continue() : route.abort('blockedbyclient');
      });
      const pages = context.pages();
      const page = pages[0] ?? await context.newPage();
      for (const extra of pages.slice(1)) await extra.close();
      page.setDefaultTimeout(3_000);
      page.setDefaultNavigationTimeout(5_000);
      const session = new ManagedPortalSession(allowedOrigin, root, context, page);
      const response = await page.goto(allowedOrigin, { waitUntil: 'domcontentloaded' });
      if (!response?.ok()) throw new Error('fixture home did not load');
      await session.observe();
      return session;
    } catch (error) {
      await context?.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  async observe(): Promise<PortalObservation> {
    this.#assertOpen();
    const url = this.#exactURL();
    const main = this.#page.locator('main[data-page]');
    if (await main.count() !== 1) throw new Error('portal page identity is ambiguous');
    const kind = await main.getAttribute('data-page');
    if (kind === 'home') return Object.freeze({ kind, revision: this.#revision, url });
    if (kind === 'search-results') {
      const rows = await this.#page.locator('tr[data-invoice-id]').evaluateAll(elements =>
        elements.map(element => ({
          id: element.getAttribute('data-invoice-id') ?? '',
          title: element.querySelector('td:nth-child(2)')?.textContent?.trim() ?? '',
          account: element.querySelector('td:nth-child(3)')?.textContent?.trim() ?? '',
        })));
      if (rows.some(row => !INVOICE_ID.test(row.id))
        || new Set(rows.map(row => row.id)).size !== rows.length) {
        throw new Error('portal result identity is invalid');
      }
      return Object.freeze({ kind: 'results', revision: this.#revision, url,
        rows: Object.freeze(rows.map(row => Object.freeze(row))) });
    }
    if (kind === 'invoice-detail') {
      const invoiceId = await main.getAttribute('data-invoice-id') ?? '';
      if (!INVOICE_ID.test(invoiceId) || url !== `${this.#origin}/invoices/${invoiceId}`) {
        throw new Error('portal detail identity mismatch');
      }
      const title = (await main.locator('h1').textContent())?.trim() ?? '';
      const account = (await main.locator('dt', { hasText: 'Account' })
        .locator('xpath=following-sibling::dd[1]').textContent())?.trim() ?? '';
      return Object.freeze({ kind: 'detail', revision: this.#revision, url, invoiceId, title, account });
    }
    throw new Error(`unsupported portal page ${String(kind)} at ${url}`);
  }

  async search(query: string): Promise<PortalObservation> {
    this.#assertOpen();
    this.#exactURL();
    if (query.length > 100) throw new Error('search term too long');
    await this.#page.getByRole('textbox', { name: 'Find invoice' }).fill(query);
    this.#assertOpen();
    await this.#page.getByRole('button', { name: 'Search' }).click();
    const observation = await this.observe();
    if (observation.kind !== 'results' || new URL(observation.url).pathname !== '/invoices') {
      throw new Error('search did not reach results');
    }
    return observation;
  }

  async openInvoice(id: string, observedRevision: number): Promise<PortalObservation> {
    this.#assertOpen();
    if (!INVOICE_ID.test(id)) throw new Error('invalid invoice ID');
    const before = await this.observe();
    if (before.kind !== 'results' || before.revision !== observedRevision
      || before.rows.filter(row => row.id === id).length !== 1) {
      throw new Error('invoice is not uniquely present in the current results');
    }
    this.#assertOpen();
    const row = this.#page.locator(`tr[data-invoice-id="${id}"]`);
    await row.getByRole('link', { name: `Open ${id}`, exact: true }).click();
    const after = await this.observe();
    if (after.kind !== 'detail' || after.invoiceId !== id) {
      throw new Error('opened invoice does not match the selected result');
    }
    return after;
  }

  async downloadInvoice(id: string, observedRevision: number): Promise<PortalDownload> {
    this.#assertOpen();
    if (!INVOICE_ID.test(id)) throw new Error('invalid invoice ID');
    const before = await this.observe();
    if (before.kind !== 'detail' || before.revision !== observedRevision
      || before.invoiceId !== id) {
      throw new Error('download target is not the current exact invoice');
    }
    this.#assertOpen();
    const [download] = await Promise.all([
      this.#page.waitForEvent('download', { timeout: 3_000 }),
      this.#page.getByRole('link', { name: `Download ${id}`, exact: true }).click(),
    ]);
    const filename = `${id}.txt`;
    if (download.url() !== `${this.#origin}/downloads/${id}`
      || download.suggestedFilename() !== filename) {
      await download.cancel();
      throw new Error('download identity or filename changed');
    }
    const path = join(this.#root, filename);
    await download.saveAs(path);
    const bytes = await readFile(path);
    const expected = `SYNTHETIC FIXTURE\nInvoice: ${id}\nTitle: ${before.title}\nAccount: ${before.account}\n`;
    if (bytes.length > 8_192 || bytes.toString('utf8') !== expected) {
      await unlink(path);
      throw new Error('download contents do not match the opened invoice');
    }
    const receipt = Object.freeze({ invoiceId: id, filename, path, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') });
    this.#downloads.set(id, { receipt, revision: before.revision });
    return receipt;
  }

  /** Re-observe before declaring completion. A receipt is session-owned and its
   * file is re-read; a reported click or search result alone cannot finish a
   * stronger task. This verifies only the synthetic portal workflow. */
  async verifyGoal(goal: PortalGoal, evidenceRevision: number,
    receipt?: PortalDownload): Promise<PortalGoalResult> {
    this.#assertOpen();
    if (!INVOICE_ID.test(goal.invoiceId) || !goal.title || !goal.account) {
      throw new Error('invalid portal goal');
    }
    let current: PortalObservation;
    try { current = await this.observe(); }
    catch { return { status: 'unavailable', reason: 'current portal observation is unavailable' }; }
    if (current.revision !== evidenceRevision) {
      return { status: 'unavailable', reason: 'evidence is stale' };
    }
    if (goal.kind === 'LOCATE') {
      if (current.kind !== 'results') {
        return { status: 'not_matched', reason: 'current page has no results' };
      }
      const matches = current.rows.filter(row => row.id === goal.invoiceId
        && row.title === goal.title && row.account === goal.account);
      return matches.length === 1
        ? { status: 'matched', revision: current.revision }
        : { status: 'not_matched', reason: 'exact invoice is not in current results' };
    }
    if (current.kind !== 'detail' || current.invoiceId !== goal.invoiceId
      || current.title !== goal.title || current.account !== goal.account) {
      return { status: 'not_matched', reason: 'exact invoice detail is not open' };
    }
    if (goal.kind === 'OPEN') return { status: 'matched', revision: current.revision };
    if (goal.kind !== 'DOWNLOAD') throw new Error('unsupported portal goal kind');
    const saved = this.#downloads.get(goal.invoiceId);
    if (!receipt || !saved || saved.receipt !== receipt
      || saved.revision !== current.revision) {
      return { status: 'unavailable', reason: 'current session has no matching download evidence' };
    }
    let bytes: Buffer;
    try { bytes = await readFile(receipt.path); }
    catch { return { status: 'unavailable', reason: 'download file is unavailable' }; }
    const expected = `SYNTHETIC FIXTURE\nInvoice: ${goal.invoiceId}\nTitle: ${goal.title}\nAccount: ${goal.account}\n`;
    if (bytes.toString('utf8') !== expected || bytes.length !== receipt.bytes
      || createHash('sha256').update(bytes).digest('hex') !== receipt.sha256) {
      return { status: 'not_matched', reason: 'download file no longer matches the exact invoice' };
    }
    return { status: 'matched', revision: current.revision };
  }

  /** Fences this isolated context. A successful close prevents later Playwright
   * dispatch, but does not undo an action that already reached the page. */
  stop(): Promise<{ workerFenced: boolean }> {
    if (this.#stopPromise) return this.#stopPromise.then(workerFenced => ({ workerFenced }));
    this.#closed = true;
    this.#stopPromise = this.#context.close({ reason: 'SystemOne task stopped' })
      .then(() => {
        rmSync(this.#root, { recursive: true, force: true });
        return true;
      }, () => false);
    return this.#stopPromise.then(workerFenced => ({ workerFenced }));
  }

  async close(): Promise<void> {
    const result = await this.stop();
    if (!result.workerFenced) throw new Error('managed browser close was not confirmed');
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('managed portal session is closed');
  }

  #exactURL(): string {
    const raw = this.#page.url();
    const parsed = new URL(raw);
    if (parsed.origin !== this.#origin || parsed.protocol !== 'http:') {
      throw new Error('browser left the permitted fixture origin');
    }
    return raw;
  }
}
