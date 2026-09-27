import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';

const MAX_ORIGINS = 16;
const MAX_CONTROLS = 80;
const MAX_SCAN_NODES = 5_000;

export interface ManagedObservationOptions {
  /** Exact network origins approved by the trusted task controller. */
  readonly allowedOrigins: readonly string[];
  /** Defaults to a visible browser. Tests may request headless mode. */
  readonly headless?: boolean;
}

export interface ManagedControl {
  /** Observation-scoped description only; it grants no ability to act. */
  readonly id: string;
  readonly role: string;
  readonly label: string;
  readonly context: string;
  readonly enabled: boolean;
}

export interface ManagedObservation {
  readonly observationId: string;
  readonly browserSessionId: string;
  readonly navigationRevision: number;
  readonly url: string;
  readonly title: string;
  readonly controls: readonly ManagedControl[];
  readonly coverage: {
    readonly mainDocument: true;
    readonly subframes: false;
    readonly openShadowRoots: false;
    readonly truncated: boolean;
    readonly hasUnobservedSubframes: boolean;
    readonly hasUnobservedShadowRoots: boolean;
    readonly complete: boolean;
  };
}

function approvedOrigins(origins: readonly string[]): Set<string> {
  if (origins.length < 1 || origins.length > MAX_ORIGINS) {
    throw new Error('managed browser needs 1–16 approved origins');
  }
  const approved = new Set<string>();
  for (const origin of origins) {
    let url: URL;
    try { url = new URL(origin); }
    catch { throw new Error('invalid managed-browser origin'); }
    if (url.origin !== origin || url.username || url.password
      || (url.protocol !== 'https:' && !(url.protocol === 'http:'
        && url.hostname === '127.0.0.1'))) {
      throw new Error('managed-browser origin must be HTTPS or exact loopback HTTP');
    }
    if (approved.has(origin)) throw new Error('duplicate managed-browser origin');
    approved.add(origin);
  }
  return approved;
}

function allowedRequest(urlText: string, method: string, origins: ReadonlySet<string>): boolean {
  try {
    const url = new URL(urlText);
    return origins.has(url.origin) && !url.username && !url.password
      && (method === 'GET' || method === 'HEAD');
  } catch { return false; }
}

/**
 * General read-only managed Chromium observation. The trusted caller must
 * supply an approved network scope. This owns no task authority, action permit,
 * provider egress or completion decision; none of its IDs can be dispatched.
 */
export class ManagedObservationSession {
  readonly #root: string;
  readonly #context: BrowserContext;
  readonly #page: Page;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #sessionId = randomUUID();
  #navigationRevision = 0;
  #closed = false;
  #observing = false;
  #closePromise: Promise<void> | undefined;

  private constructor(root: string, context: BrowserContext, page: Page,
    origins: ReadonlySet<string>) {
    this.#root = root;
    this.#context = context;
    this.#page = page;
    this.#allowedOrigins = origins;
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) this.#navigationRevision++;
    });
    context.on('page', extra => {
      if (extra !== page) void extra.close().catch(() => {});
    });
  }

  static async launch(startUrl: string,
    options: ManagedObservationOptions): Promise<ManagedObservationSession> {
    const origins = approvedOrigins(options.allowedOrigins);
    if (!allowedRequest(startUrl, 'GET', origins)) {
      throw new Error('start URL is outside approved managed-browser scope');
    }
    const root = mkdtempSync(join(tmpdir(), 'systemone-managed-observe-'));
    let context: BrowserContext | undefined;
    try {
      context = await chromium.launchPersistentContext(join(root, 'profile'), {
        headless: options.headless ?? false,
        acceptDownloads: false,
        serviceWorkers: 'block',
        timeout: 15_000,
      });
      await context.route('**/*', route => {
        const request = route.request();
        return allowedRequest(request.url(), request.method(), origins)
          ? route.continue() : route.abort('blockedbyclient');
      });
      await context.routeWebSocket('**/*', route => route.close());
      const pages = context.pages();
      const page = pages[0] ?? await context.newPage();
      for (const extra of pages.slice(1)) await extra.close();
      page.setDefaultTimeout(3_000);
      page.setDefaultNavigationTimeout(10_000);
      const session = new ManagedObservationSession(root, context, page, origins);
      await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
      await session.observe();
      return session;
    } catch (error) {
      await context?.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  async observe(): Promise<ManagedObservation> {
    if (this.#closed) throw new Error('managed browser is stopped');
    if (this.#observing) throw new Error('managed observation is already running');
    this.#observing = true;
    try {
      const revision = this.#navigationRevision;
      const beforeUrl = this.#page.url();
      if (!allowedRequest(beforeUrl, 'GET', this.#allowedOrigins)) {
        throw new Error('managed page left approved scope');
      }
      const description = await this.#page.evaluate(({ maxControls, maxScanNodes }) => {
        const controls: { role: string; label: string; context: string;
          enabled: boolean }[] = [];
        const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
        let scanned = 0;
        let hasOpenShadowRoots = false;
        let element: Element | null;
        while (scanned < maxScanNodes && controls.length < maxControls
          && (element = walker.nextNode() as Element | null)) {
          scanned++;
          if (element.shadowRoot) hasOpenShadowRoots = true;
          if (!element.matches('button,a,input,select,textarea,[role]')
            || element.closest('[contenteditable]')) continue;
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden'
            || element.getClientRects().length === 0) continue;
          const tag = element.tagName.toLowerCase();
          const inputType = element instanceof HTMLInputElement
            ? element.type.toLowerCase() : '';
          if (inputType === 'password' || inputType === 'hidden') continue;
          const html = element as HTMLElement;
          const formLabel = element instanceof HTMLInputElement
            || element instanceof HTMLSelectElement
            || element instanceof HTMLTextAreaElement
            ? Array.from(element.labels ?? []).map(label => label.innerText).join(' ') : '';
          const label = (element.getAttribute('aria-label')
            || formLabel || element.getAttribute('title')
            || element.getAttribute('placeholder')
            || (['input', 'textarea', 'select'].includes(tag) ? '' : html.innerText)
            || '').replace(/\s+/gu, ' ').trim().slice(0, 160);
          if (!label) continue;
          const container = element.closest('tr,li,fieldset,form,section,article,dialog,[role="row"],[role="dialog"]');
          const context = ((container as HTMLElement | null)?.innerText ?? '')
            .replace(/\s+/gu, ' ').trim().slice(0, 160);
          controls.push({ role: (element.getAttribute('role') || tag).slice(0, 40),
            label, context, enabled: !element.matches(':disabled')
              && element.getAttribute('aria-disabled') !== 'true' });
        }
        return { title: document.title.slice(0, 160),
          url: location.href.slice(0, 2_048), controls,
          truncated: scanned >= maxScanNodes || controls.length >= maxControls,
          hasOpenShadowRoots };
      }, { maxControls: MAX_CONTROLS, maxScanNodes: MAX_SCAN_NODES });
      if (this.#closed || this.#navigationRevision !== revision
        || this.#page.url() !== beforeUrl || description.url !== beforeUrl) {
        throw new Error('managed page changed during observation');
      }
      const hasUnobservedSubframes = this.#page.frames().length > 1;
      const observationId = randomUUID();
      return Object.freeze({ observationId,
        browserSessionId: this.#sessionId, navigationRevision: revision,
        url: beforeUrl, title: description.title,
        controls: Object.freeze(description.controls.map((control, index) => Object.freeze({
          id: `${observationId}:${index}`, ...control,
        }))),
        coverage: Object.freeze({ mainDocument: true as const, subframes: false as const,
          openShadowRoots: false as const, truncated: description.truncated,
          hasUnobservedSubframes,
          hasUnobservedShadowRoots: description.hasOpenShadowRoots,
          complete: !description.truncated && !hasUnobservedSubframes
            && !description.hasOpenShadowRoots }),
      });
    } finally {
      this.#observing = false;
    }
  }

  /** Closes the isolated browser profile. It is not an effect-dispatch barrier. */
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#context.close()
      .finally(() => { rmSync(this.#root, { recursive: true, force: true }); });
    return this.#closePromise;
  }
}
