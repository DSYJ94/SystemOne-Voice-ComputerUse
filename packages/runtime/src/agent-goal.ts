import { readdirSync } from 'node:fs';
import { ContractError, digest } from '../../protocol/src/json.ts';
import type { CommittedInput } from './committed-input.ts';
import { BARE_SITES } from './scoped-native-command.ts';
import type { TaskParameter } from './task-authority.ts';

/** What a spoken or typed goal makes available to the agent. The model can only
 * *choose* these; it never supplies text, URLs or app names itself. */
/** An exact piece of what the user said, with UTF-8 byte offsets into it. */
export interface Span { readonly text: string; readonly start: number; readonly end: number }

export interface AgentGoal {
  /** Exact span of the command the agent may type (quoted, or chosen by Jev from candidates). */
  readonly typedText: Span | null;
  /** Exact span naming a file or folder to find and open, when the request is about one. */
  readonly fileName: Span | null;
  /** The request mentions windows (minimise, full screen, zoom, hide, close). */
  readonly windows: boolean;
  /** The request is about a file or folder ("open the budget spreadsheet"). */
  readonly wantsFile: boolean;
  /** The typed text was quoted by the user, so it is exact and needs no choosing. */
  readonly quoted: boolean;
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
      ? new RegExp(`\\b(?:open|launch|start|switch to|use|in|into|to|on|from|up|close|quit|exit|shut|hide)\\s+(?:the\\s+|my\\s+)?${escaped}(?:\\s+app)?\\b`, 'u')
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
  if (!url) {
    // A well-known site named anywhere ("wikipedia alan turing") is offered too; Jev decides whether to use it.
    const known = [...text.toLowerCase().matchAll(/[a-z]+/gu)].map(match => match[0])
      .find(word => KNOWN_SITES.has(word) && !apps.some(name => name.toLowerCase() === word));
    if (known) url = `https://${BARE_SITES[known] ?? SITE_HOSTS[known] ?? `${known}.com`}/`;
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
  return Object.freeze({ typedText, fileName: null, quoted: !!quoted, url, app, clipboard, undo: /\bundo\b/iu.test(text),
    wantsFile: FILE_WORDS.test(text),
    windows: /\b(?:windows?|minimi[sz]e|maximi[sz]e|full ?screen|zoom|hide|close|quit|half|move|resize|bigger|smaller|cent(?:er|re)|side)\b/iu.test(text),
    quit: /\b(?:quit|close|exit|shut|kill|terminate|get rid of|log ?out|sign ?out)\b/iu.test(text),
    newTab: /\bnew tab\b/iu.test(text),
    needsText: !typedText && !clipboard
      && (/\b(?:reply|respond|write back|type)\b/iu.test(text) || /^\s*(?:message|text)\s+\w+/iu.test(text)) });
}

const FILE_WORDS = /\b(?:file|folder|document|doc|spreadsheet|pdf|presentation|deck|photo|image|screenshot)s?\b/iu;
/** Every run of 1..maxWords consecutive words of what was said, as exact spans. The
 * decision model picks which run (if any) is the text to type, so no phrasing has to
 * be anticipated: measured 17/18 on a labelled set, against 14/18 for lead-word rules. */
export function spanCandidates(text: string, maxWords = 8): Span[] {
  const words = [...text.matchAll(/\S+/gu)];
  const seen = new Set<string>();
  const out: Span[] = [];
  for (let i = 0; i < words.length; i++) {
    for (let j = i; j < Math.min(words.length, i + maxWords); j++) {
      const startChar = words[i]!.index;
      const piece = text.slice(startChar, words[j]!.index + words[j]![0].length).replace(/[.,!?;:"”]+$/u, '').replace(/^["“]/u, '');
      if (!piece || seen.has(piece)) continue;
      seen.add(piece);
      const from = text.indexOf(piece, startChar);
      const start = Buffer.byteLength(text.slice(0, from), 'utf8');
      out.push({ text: piece, start, end: start + Buffer.byteLength(piece, 'utf8') });
    }
  }
  return out;
}

export type SpanRole = 'typed' | 'file';

/** Lets the decision model pick the exact words to type (and a file name) from runs of
 * what the user said. Natural speech without "and" or commas then works, and typed
 * text is still always the user's own words. */
export async function refineGoal(text: string, goal: AgentGoal,
  pick: ((request: string, role: SpanRole, spans: readonly string[]) => Promise<number | null>) | undefined): Promise<AgentGoal> {
  if (!pick) return goal;
  const spans = spanCandidates(text);
  const choose = async (role: SpanRole, fallback: Span | null) => {
    if (!spans.length) return fallback;
    try {
      const index = await pick(text, role, spans.map(span => span.text));
      return index === null ? null : spans[index] ?? null;
    } catch { return fallback; }
  };
  const [typedText, fileName] = await Promise.all([
    goal.quoted ? Promise.resolve(goal.typedText) : choose('typed', goal.typedText),
    goal.wantsFile ? choose('file', null) : Promise.resolve(null),
  ]);
  return Object.freeze({ ...goal, typedText, fileName,
    needsText: !typedText && !goal.clipboard && goal.needsText });
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
