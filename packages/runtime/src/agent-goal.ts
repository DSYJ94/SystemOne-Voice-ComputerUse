import { readdirSync } from 'node:fs';
import { ContractError, digest } from '../../protocol/src/json.ts';
import type { CommittedInput } from './committed-input.ts';
import { BARE_SITES } from './scoped-native-command.ts';
import type { TaskParameter } from './task-authority.ts';

/** What a spoken or typed goal makes available to the agent. The model can only
 * *choose* these; it never supplies text, URLs or app names itself. */
export interface AgentGoal {
  /** Exact span of the command the agent may type (quoted, or after "search for"/"type"). */
  readonly typedText: { readonly text: string; readonly start: number; readonly end: number } | null;
  readonly url: string | null;
  readonly app: string | null;
  /** The request moves text between places ("copy …", "paste …"). */
  readonly clipboard: boolean;
  /** The request asks to undo something. */
  readonly undo: boolean;
  /** The request asks to quit or close an app (or a window/tab). Without it, steps that
   * end an app or session ("Quit …", "Log out") are never offered. */
  readonly quit: boolean;
  /** The request asks to write or reply but gives no words to write. */
  readonly needsText: boolean;
  /** The request asks for a new tab; otherwise a browser navigates the tab in front. */
  readonly newTab: boolean;
}

/** App names that are also ordinary words ("notes", "music"): these need a verb or
 * preposition before them to count as the app. Distinctive names count anywhere. */
const COMMON_WORD_APPS = new Set(['notes', 'music', 'mail', 'messages', 'calendar', 'photos', 'maps', 'news', 'books',
  'stocks', 'home', 'clock', 'weather', 'reminders', 'contacts', 'preview', 'shortcuts', 'podcasts', 'freeform',
  'passwords', 'phone', 'games', 'tips', 'stickies', 'chess', 'calculator', 'dictionary', 'terminal', 'console',
  'font book', 'image capture', 'screenshot', 'tv', 'safari', 'finder', 'code', 'mirror', 'journal', 'keynote', 'pages',
  'numbers', 'automator', 'siri', 'feedback assistant', 'zoom', 'arc', 'things', 'bear', 'signal', 'spark', 'steam']);
/** Sites known well enough to open from "go to the gmail inbox" (with an article). */
const KNOWN_SITES = new Set(['gmail', 'youtube', 'google', 'wikipedia', 'amazon', 'netflix', 'reddit', 'github',
  'linkedin', 'facebook', 'instagram', 'outlook', 'twitter', 'spotify', 'notion', 'figma', 'slack', 'whatsapp', 'bbc',
  'ebay', 'chatgpt', 'claude', 'perplexity', 'calendly', 'dropbox', 'drive', 'docs', 'maps']);
const SITE_HOSTS: Readonly<Record<string, string>> = { drive: 'drive.google.com', docs: 'docs.google.com',
  maps: 'maps.google.com', whatsapp: 'web.whatsapp.com', chatgpt: 'chatgpt.com', claude: 'claude.ai',
  twitter: 'x.com' };

const NOT_SITES = new Set(['the', 'a', 'an', 'my', 'this', 'that', 'it', 'new', 'next', 'first', 'last', 'video',
  'page', 'app', 'file', 'folder', 'tab', 'window', 'link', 'settings', 'menu']);

export function installedApps(): string[] {
  const names = new Set<string>();
  for (const root of ['/Applications', '/System/Applications', '/System/Applications/Utilities']) {
    try { for (const entry of readdirSync(root)) if (entry.endsWith('.app')) names.add(entry.slice(0, -4)); }
    catch { /* Not a Mac or unreadable; no app candidates. */ }
  }
  return [...names];
}

export function parseAgentGoal(text: string, apps: readonly string[]): AgentGoal {
  if (!text.isWellFormed() || !text.trim() || Buffer.byteLength(text, 'utf8') > 1_300) {
    throw new ContractError('agent goal empty or too large');
  }
  const lower = text.toLowerCase();
  let app: string | null = null;
  for (const name of apps) {
    const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const pattern = COMMON_WORD_APPS.has(name.toLowerCase())
      ? new RegExp(`\\b(?:open|launch|start|switch to|use|in|into|to|on|from|close|quit|exit|hide)\\s+(?:the\\s+)?${escaped}(?:\\s+app)?\\b`, 'u')
      : new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u');
    if (name.length >= 3 && pattern.test(lower) && (!app || name.length > app.length)) app = name;
  }
  let url: string | null = null;
  const site = /\b(?:go to|visit|navigate to|on|open)\s+(?:(the|my)\s+)?((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,63}(?:\/\S*)?|[a-z0-9-]{2,63})\b/iu
    .exec(text);
  if (site?.[2] && (!site[1] || site[2].includes('.') || KNOWN_SITES.has(site[2].toLowerCase()))) {
    const target = site[2].replace(/^https?:\/\//iu, '').replace(/[.,!?]$/u, '').toLowerCase();
    const bare = !target.includes('.');
    const verb = /^(?:go to|visit|navigate to|on)\b/iu.test(site[0]) || KNOWN_SITES.has(target);
    if (!bare) url = `https://${target}`;
    else if (verb && !NOT_SITES.has(target) && !apps.some(name => name.toLowerCase() === target)) {
      url = `https://${BARE_SITES[target] ?? SITE_HOSTS[target] ?? `${target}.com`}/`;
    }
  }
  const searchOn = url ? null : /\bsearch\s+([a-z0-9-]+(?:\.[a-z0-9-]+)*)\s+for\b/iu.exec(text);
  if (searchOn?.[1] && !NOT_SITES.has(searchOn[1].toLowerCase())) {
    const target = searchOn[1].toLowerCase();
    url = target.includes('.') ? `https://${target}/` : `https://${BARE_SITES[target] ?? `${target}.com`}/`;
  }
  let typedText: AgentGoal['typedText'] = null;
  const quoted = /["“]([^"”]{1,512})["”]/u.exec(text);
  const phrase = quoted ? null
    : /\b(?:saying|that says|with the (?:text|message)|reply with|note that|search(?:\s+[\w.'-]+){0,3}\s+for|search|type|write|enter|look up)\s+(.+?)(?:\s*,|\s+(?:and|then)\s+(?!.*\b(?:saying|says)\b).*)?$/iu.exec(text);
  const value = quoted?.[1] ?? phrase?.[1] ?? null;
  if (value && value.trim() === value && Buffer.byteLength(value, 'utf8') <= 512) {
    const index = quoted ? quoted.index + quoted[0].indexOf(value) : phrase!.index + phrase![0].lastIndexOf(value);
    const start = Buffer.byteLength(text.slice(0, index), 'utf8');
    typedText = { text: value, start, end: start + Buffer.byteLength(value, 'utf8') };
  }
  const clipboard = /\b(?:copy|paste|clipboard)\b/iu.test(text);
  return Object.freeze({ typedText, url, app, clipboard, undo: /\bundo\b/iu.test(text),
    quit: /\b(?:quit|close|exit|shut down|log ?out|sign ?out)\b/iu.test(text),
    newTab: /\bnew tab\b/iu.test(text),
    needsText: !typedText && !clipboard
      && (/\b(?:reply|respond|write back|type)\b/iu.test(text) || /^\s*(?:message|text)\s+\w+/iu.test(text)) });
}

/** Binds an exact byte span of the final command (not only a suffix). */
export function bindCommandSpan(input: CommittedInput, parameterRef: string,
  span: { readonly text: string; readonly start: number; readonly end: number }): TaskParameter {
  const bytes = Buffer.from(input.text, 'utf8');
  if (span.start < 0 || span.end > bytes.length || span.start >= span.end
    || bytes.subarray(span.start, span.end).toString('utf8') !== span.text) {
    throw new ContractError('command span differs from final input');
  }
  return Object.freeze({ parameterRef, sourceRef: `utterance.${input.utteranceId}.r${input.utteranceRevision}`,
    valueDigest: digest(span.text), sourceStart: span.start, sourceEnd: span.end, offsetUnit: 'utf8_bytes' as const });
}
