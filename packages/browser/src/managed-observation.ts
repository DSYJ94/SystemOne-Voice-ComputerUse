import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { BrowserContext, ElementHandle, Page } from 'playwright';

const MAX_ORIGINS = 16;
const MAX_CONTROLS = 80;
const MAX_SCAN_NODES = 5_000;

export interface ManagedObservationOptions {
  /** Exact network origins approved by the trusted task controller. */
  readonly allowedOrigins: readonly string[];
  /** Optional HTTPS sites (a host the user named, plus its subdomains) for
   * multi-step browsing; redirects such as example.org → www.example.org stay
   * in scope. Exact origins above still apply on their own. */
  readonly allowedSites?: readonly string[];
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
  /** DOM capability only. Host permission is a separate one-use permit. */
  readonly editable: boolean;
  /** Exact approved HTTP(S) destination of a plain link; otherwise null. */
  readonly destinationUrl: string | null;
  /** Submit button of a GET form whose action stays in approved scope. */
  readonly submittable: boolean;
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

/** Driver preparation only. A trusted controller must own the journal and
 * one-use permit and call send immediately after its durable boundary. */
export interface PreparedManagedFill {
  readonly controlId: string;
  send(): Promise<boolean>;
  release(): void;
}

export interface PreparedManagedSubmit {
  readonly controlId: string;
  send(): Promise<boolean>;
  release(): void;
}

export interface PreparedManagedNavigate {
  readonly controlId: string;
  send(): Promise<boolean>;
  release(): void;
}

export class ManagedLaunchFailure extends Error {
  readonly browserFenced = false;
  constructor() { super('managed browser startup fence could not be confirmed'); }
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

const SITE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

function approvedSites(sites: readonly string[] | undefined): readonly string[] {
  if (!sites) return [];
  if (sites.length > MAX_ORIGINS || sites.some(site => !SITE.test(site))) {
    throw new Error('managed-browser sites must be lowercase DNS hosts');
  }
  return Object.freeze([...new Set(sites)]);
}

/** Exact origin, or an HTTPS host equal to / under a named site. */
interface Scope { readonly origins: ReadonlySet<string>; readonly sites: readonly string[]; }

function inScope(url: URL, scope: Scope): boolean {
  return scope.origins.has(url.origin) || (url.protocol === 'https:' && !url.port
    && scope.sites.some(site => url.hostname === site || url.hostname.endsWith('.' + site)));
}

function allowedRequest(urlText: string, method: string, scope: Scope | ReadonlySet<string>): boolean {
  const resolved: Scope = scope instanceof Set ? { origins: scope, sites: [] } : scope as Scope;
  try {
    const url = new URL(urlText);
    return inScope(url, resolved) && !url.username && !url.password
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
  readonly #allowedOrigins: Scope;
  readonly #sessionId = randomUUID();
  #navigationRevision = 0;
  #closed = false;
  #observing = false;
  #actionPending = false;
  #closePromise: Promise<void> | undefined;
  #handles = new Map<string, ElementHandle<Element>>();
  #lastObservation: ManagedObservation | undefined;

  get scopeRef(): string { return `managed-browser:${this.#sessionId}`; }

  private constructor(root: string, context: BrowserContext, page: Page,
    origins: Scope) {
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
    const origins: Scope = { origins: approvedOrigins(options.allowedOrigins),
      sites: approvedSites(options.allowedSites) };
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
      try { await context?.close(); }
      catch { throw new ManagedLaunchFailure(); }
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  async observe(): Promise<ManagedObservation> {
    if (this.#closed) throw new Error('managed browser is stopped');
    if (this.#observing || this.#actionPending) {
      throw new Error('managed observation or action is already running');
    }
    this.#observing = true;
    try {
      const revision = this.#navigationRevision;
      const beforeUrl = this.#page.url();
      if (!allowedRequest(beforeUrl, 'GET', this.#allowedOrigins)) {
        throw new Error('managed page left approved scope');
      }
      const collection = await this.#page.evaluateHandle(({ maxControls, maxScanNodes,
        allowedOrigins, allowedSites }) => {
        const scoped = (target: URL) => allowedOrigins.includes(target.origin)
          || (target.protocol === 'https:' && !target.port && allowedSites.some(site =>
            target.hostname === site || target.hostname.endsWith('.' + site)));
        const controls: { role: string; label: string; context: string;
          enabled: boolean; editable: boolean; destinationUrl: string | null;
          submittable: boolean }[] = [];
        const nodes: Element[] = [];
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
          const enabled = !element.matches(':disabled')
            && element.getAttribute('aria-disabled') !== 'true';
          const editable = enabled && (tag === 'textarea'
            || (tag === 'input' && ['text', 'search', 'email', 'url', 'tel']
              .includes(inputType))) && !element.hasAttribute('readonly');
          let destinationUrl: string | null = null;
          if (element instanceof HTMLAnchorElement && !element.hasAttribute('download')
            && (!element.target || element.target === '_self')) {
            try {
              const target = new URL(element.href);
              if (scoped(target) && !target.username
                && !target.password && target.href.length <= 2_048) {
                destinationUrl = target.href;
              }
            } catch { /* Unsupported link destination. */ }
          }
          let submittable = false;
          if (enabled && (element instanceof HTMLButtonElement || element instanceof HTMLInputElement)
            && element.type === 'submit' && element.form && element.form.method.toLowerCase() === 'get'
            && !element.formAction.startsWith('javascript:')) {
            try {
              const action = new URL(element.formAction || element.form.action);
              submittable = scoped(action) && !action.username && !action.password;
            } catch { /* Unsupported form action. */ }
          }
          controls.push({ role: (element.getAttribute('role') || tag).slice(0, 40),
            label, context, enabled, editable, destinationUrl, submittable });
          nodes.push(element);
        }
        return { title: document.title.slice(0, 160),
          url: location.href.slice(0, 2_048), controls, nodes,
          truncated: scanned >= maxScanNodes || controls.length >= maxControls,
          hasOpenShadowRoots };
      }, { maxControls: MAX_CONTROLS, maxScanNodes: MAX_SCAN_NODES,
        allowedOrigins: [...this.#allowedOrigins.origins],
        allowedSites: [...this.#allowedOrigins.sites] });
      let description: { title: string; url: string;
        controls: { role: string; label: string; context: string;
          enabled: boolean; editable: boolean; destinationUrl: string | null;
          submittable: boolean }[];
        truncated: boolean; hasOpenShadowRoots: boolean };
      const observationId = randomUUID();
      const nextHandles = new Map<string, ElementHandle<Element>>();
      try {
        description = await collection.evaluate(value => ({
          title: value.title, url: value.url, controls: value.controls,
          truncated: value.truncated, hasOpenShadowRoots: value.hasOpenShadowRoots,
        }));
        const nodeList = await collection.getProperty('nodes');
        try {
          const entries = await nodeList.getProperties();
          for (let index = 0; index < description.controls.length; index++) {
            const handle = entries.get(String(index))?.asElement();
            if (!handle) throw new Error('managed control handle unavailable');
            nextHandles.set(`${observationId}:${index}`, handle);
          }
          for (const [key, handle] of entries) {
            if (!/^\d+$/u.test(key) || Number(key) >= description.controls.length) {
              await handle.dispose();
            }
          }
        } finally { await nodeList.dispose(); }
      } catch (error) {
        await Promise.allSettled([...nextHandles.values()].map(handle => handle.dispose()));
        throw error;
      } finally { await collection.dispose(); }
      if (this.#closed || this.#navigationRevision !== revision
        || this.#page.url() !== beforeUrl || description.url !== beforeUrl) {
        await Promise.allSettled([...nextHandles.values()].map(handle => handle.dispose()));
        throw new Error('managed page changed during observation');
      }
      const hasUnobservedSubframes = this.#page.frames().length > 1;
      const observation = Object.freeze({ observationId,
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
      const priorHandles = this.#handles;
      this.#handles = nextHandles;
      this.#lastObservation = observation;
      await Promise.allSettled([...priorHandles.values()].map(handle => handle.dispose()));
      return observation;
    } finally {
      this.#observing = false;
    }
  }

  /** Preflight reads the retained DOM node without focus or mutation. It never
   * grants execution authority and is unavailable after another observation. */
  async prepareFill(observationId: string, controlId: string, value: string,
    signal: AbortSignal): Promise<PreparedManagedFill> {
    if (this.#closed || this.#observing || this.#actionPending) {
      throw new Error('managed browser is stopped or busy');
    }
    if (!value.isWellFormed() || Buffer.byteLength(value, 'utf8') > 4_096) {
      throw new Error('invalid managed fill value');
    }
    const observed = this.#lastObservation;
    const control = observed?.controls.find(item => item.id === controlId);
    const handle = this.#handles.get(controlId);
    if (!observed || observed.observationId !== observationId || !control
      || !handle || !control.editable || !control.enabled
      || signal.aborted) {
      throw new Error('managed fill target is stale or unsupported');
    }
    this.#actionPending = true;
    try {
      if (this.#navigationRevision !== observed.navigationRevision
        || this.#page.url() !== observed.url) {
        throw new Error('managed document changed before fill');
      }
      const current = await handle.evaluate(element => {
        const tag = element.tagName.toLowerCase();
        const inputType = element instanceof HTMLInputElement
          ? element.type.toLowerCase() : '';
        const container = element.closest('tr,li,fieldset,form,section,article,dialog,[role="row"],[role="dialog"]');
        const context = ((container as HTMLElement | null)?.innerText ?? '')
          .replace(/\s+/gu, ' ').trim().slice(0, 160);
        const formLabel = element instanceof HTMLInputElement
          || element instanceof HTMLSelectElement
          || element instanceof HTMLTextAreaElement
          ? Array.from(element.labels ?? []).map(label => label.innerText).join(' ') : '';
        const label = (element.getAttribute('aria-label') || formLabel
          || element.getAttribute('title') || element.getAttribute('placeholder')
          || '').replace(/\s+/gu, ' ').trim().slice(0, 160);
        const style = getComputedStyle(element);
        return { connected: element.isConnected && element.ownerDocument === document,
          role: (element.getAttribute('role') || tag).slice(0, 40), label, context,
          editable: (tag === 'textarea' || (tag === 'input'
            && ['text', 'search', 'email', 'url', 'tel'].includes(inputType)))
            && !element.hasAttribute('readonly') && !element.matches(':disabled')
            && element.getAttribute('aria-disabled') !== 'true'
            && !element.closest('[contenteditable]')
            && style.display !== 'none' && style.visibility !== 'hidden'
            && element.getClientRects().length > 0 };
      });
      if (this.#closed || signal.aborted || !current.connected || !current.editable
        || current.role !== control.role || current.label !== control.label
        || current.context !== control.context
        || this.#navigationRevision !== observed.navigationRevision
        || this.#page.url() !== observed.url
        || !(await handle.isVisible()) || !(await handle.isEditable())) {
        throw new Error('managed fill target changed during preflight');
      }
      let sent = false;
      let released = false;
      return Object.freeze({ controlId,
        send: async () => {
          if (sent || released || this.#closed || signal.aborted) {
            throw new Error('managed fill was revoked or replayed');
          }
          sent = true;
          try {
            // The Playwright command begins here; its actionability wait may
            // outlive Stop. The journal caller must classify that as uncertain.
            await handle.fill(value, { timeout: 3_000 });
            if (this.#closed || signal.aborted
              || this.#navigationRevision !== observed.navigationRevision
              || this.#page.url() !== observed.url) return false;
            return await handle.evaluate((element, expectedValue) =>
              (element instanceof HTMLInputElement
                || element instanceof HTMLTextAreaElement)
                && element.value === expectedValue, value);
          } finally { this.#actionPending = false; }
        },
        release: () => {
          if (!sent && !released) { released = true; this.#actionPending = false; }
        },
      });
    } catch (error) {
      this.#actionPending = false;
      throw error;
    }
  }

  /** Resolves one observed plain link to its exact approved destination.
   * send() navigates directly to the retained href; it never runs page script
   * by clicking the link. Dynamic/on-click-only links are unsupported. */
  async prepareNavigate(observationId: string, controlId: string,
    destinationUrl: string, signal: AbortSignal,
    options: { readonly acceptInScopeRedirect?: boolean } = {}): Promise<PreparedManagedNavigate> {
    if (this.#closed || this.#observing || this.#actionPending) {
      throw new Error('managed browser is stopped or busy');
    }
    const observed = this.#lastObservation;
    const control = observed?.controls.find(item => item.id === controlId);
    const handle = this.#handles.get(controlId);
    if (!observed || observed.observationId !== observationId || !control
      || !handle || !control.enabled || control.destinationUrl !== destinationUrl
      || !allowedRequest(destinationUrl, 'GET', this.#allowedOrigins)
      || signal.aborted) throw new Error('managed link is stale or unsupported');
    this.#actionPending = true;
    try {
      if (this.#navigationRevision !== observed.navigationRevision
        || this.#page.url() !== observed.url) {
        throw new Error('managed document changed before navigation');
      }
      const current = await handle.evaluate(element => {
        const container = element.closest('tr,li,fieldset,form,section,article,dialog,[role="row"],[role="dialog"]');
        const context = ((container as HTMLElement | null)?.innerText ?? '')
          .replace(/\s+/gu, ' ').trim().slice(0, 160);
        const html = element as HTMLElement;
        const label = (element.getAttribute('aria-label')
          || element.getAttribute('title') || html.innerText || '')
          .replace(/\s+/gu, ' ').trim().slice(0, 160);
        const style = getComputedStyle(element);
        return { connected: element.isConnected && element.ownerDocument === document,
          role: (element.getAttribute('role') || element.tagName.toLowerCase()).slice(0, 40),
          label, context, href: element instanceof HTMLAnchorElement ? element.href : null,
          plain: element instanceof HTMLAnchorElement
            && !element.hasAttribute('download')
            && (!element.target || element.target === '_self'),
          visible: style.display !== 'none' && style.visibility !== 'hidden'
            && element.getClientRects().length > 0,
          enabled: !element.matches(':disabled')
            && element.getAttribute('aria-disabled') !== 'true' };
      });
      if (this.#closed || signal.aborted || !current.connected || !current.plain
        || !current.visible || !current.enabled || current.href !== destinationUrl
        || current.role !== control.role || current.label !== control.label
        || current.context !== control.context
        || this.#navigationRevision !== observed.navigationRevision
        || this.#page.url() !== observed.url) {
        throw new Error('managed link changed during preflight');
      }
      let sent = false;
      let released = false;
      return Object.freeze({ controlId,
        send: async () => {
          if (sent || released || this.#closed || signal.aborted
            || this.#navigationRevision !== observed.navigationRevision
            || this.#page.url() !== observed.url) {
            throw new Error('managed navigation was revoked or replayed');
          }
          sent = true;
          try {
            const response = await this.#page.goto(destinationUrl,
              { waitUntil: 'domcontentloaded', timeout: 10_000 });
            return !this.#closed && !signal.aborted && response?.ok() === true
              && (this.#page.url() === destinationUrl || (options.acceptInScopeRedirect === true
                && allowedRequest(this.#page.url(), 'GET', this.#allowedOrigins)));
          } finally { this.#actionPending = false; }
        },
        release: () => {
          if (!sent && !released) { released = true; this.#actionPending = false; }
        },
      });
    } catch (error) {
      this.#actionPending = false;
      throw error;
    }
  }

  /** Submits the GET form of one observed submit button via requestSubmit, as
   * a user click would, so page validation runs. Success needs a new document
   * revision that is still inside approved scope; POST stays blocked anyway. */
  async prepareSubmit(observationId: string, controlId: string,
    signal: AbortSignal): Promise<PreparedManagedSubmit> {
    if (this.#closed || this.#observing || this.#actionPending) {
      throw new Error('managed browser is stopped or busy');
    }
    const observed = this.#lastObservation;
    const control = observed?.controls.find(item => item.id === controlId);
    const handle = this.#handles.get(controlId);
    if (!observed || observed.observationId !== observationId || !control || !handle
      || !control.enabled || !control.submittable || signal.aborted) {
      throw new Error('managed submit target is stale or unsupported');
    }
    this.#actionPending = true;
    try {
      const current = await handle.evaluate(element => {
        const button = element instanceof HTMLButtonElement || element instanceof HTMLInputElement
          ? element : null;
        const style = getComputedStyle(element);
        return { connected: element.isConnected && element.ownerDocument === document,
          submit: button?.type === 'submit' && !!button.form
            && button.form.method.toLowerCase() === 'get',
          action: button?.formAction || button?.form?.action || '',
          visible: style.display !== 'none' && style.visibility !== 'hidden'
            && element.getClientRects().length > 0,
          enabled: !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true' };
      });
      if (this.#closed || signal.aborted || !current.connected || !current.submit
        || !current.visible || !current.enabled
        || !allowedRequest(current.action, 'GET', this.#allowedOrigins)
        || this.#navigationRevision !== observed.navigationRevision
        || this.#page.url() !== observed.url) {
        throw new Error('managed submit target changed during preflight');
      }
      let sent = false;
      let released = false;
      return Object.freeze({ controlId,
        send: async () => {
          if (sent || released || this.#closed || signal.aborted
            || this.#navigationRevision !== observed.navigationRevision) {
            throw new Error('managed submit was revoked or replayed');
          }
          sent = true;
          try {
            const before = this.#navigationRevision;
            const navigated = this.#page.waitForEvent('framenavigated',
              { predicate: frame => frame === this.#page.mainFrame(), timeout: 10_000 });
            await handle.evaluate(element => {
              const button = element as HTMLButtonElement | HTMLInputElement;
              button.form?.requestSubmit(button);
            });
            await navigated;
            await this.#page.waitForLoadState('domcontentloaded', { timeout: 10_000 });
            return !this.#closed && !signal.aborted && this.#navigationRevision > before
              && allowedRequest(this.#page.url(), 'GET', this.#allowedOrigins);
          } finally { this.#actionPending = false; }
        },
        release: () => {
          if (!sent && !released) { released = true; this.#actionPending = false; }
        },
      });
    } catch (error) {
      this.#actionPending = false;
      throw error;
    }
  }

  /** Closes the isolated browser profile. It is not an effect-dispatch barrier. */
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#lastObservation = undefined;
    const handles = this.#handles;
    this.#handles = new Map();
    void Promise.allSettled([...handles.values()].map(handle => handle.dispose()));
    this.#closePromise = this.#context.close()
      .then(() => { rmSync(this.#root, { recursive: true, force: true }); });
    return this.#closePromise;
  }
}
