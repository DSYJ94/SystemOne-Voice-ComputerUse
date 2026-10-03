import { ContractError } from '../../protocol/src/json.ts';

/** Parse a small, explicit command without inventing a target or value. */
export function parseScopedNativeFill(text: string): {
  readonly fieldLabel: string;
  readonly value: string;
  readonly prefix: string;
} {
  if (!text.isWellFormed() || Buffer.byteLength(text, 'utf8') > 1_300) {
    throw new ContractError('scoped native command too large or malformed');
  }
  const match = /^(fill )(.+?)( with )(.+)$/i.exec(text);
  if (!match || !match[2] || !match[4]
    || match[2].trim() !== match[2] || match[4].trim() !== match[4]
    || match[2].length > 160 || Buffer.byteLength(match[4], 'utf8') > 1_024) {
    throw new ContractError('unsupported scoped native command');
  }
  return Object.freeze({ fieldLabel: match[2], value: match[4],
    prefix: match[1]! + match[2] + match[3]! });
}

export function parseScopedManagedFill(text: string): {
  readonly url: string;
  readonly fieldLabel: string;
  readonly value: string;
  readonly prefix: string;
} {
  if (!text.isWellFormed() || Buffer.byteLength(text, 'utf8') > 3_350) {
    throw new ContractError('scoped managed command too large or malformed');
  }
  const match = /^(fill )(.+?)( on )(\S+)( with )(.+)$/i.exec(text);
  if (!match || !match[2] || !match[4] || !match[6]
    || match[2].trim() !== match[2] || match[6].trim() !== match[6]
    || match[2].length > 160 || Buffer.byteLength(match[4], 'utf8') > 2_048
    || Buffer.byteLength(match[6], 'utf8') > 1_024) {
    throw new ContractError('unsupported scoped managed command');
  }
  return Object.freeze({ fieldLabel: match[2], url: match[4], value: match[6],
    prefix: match[1]! + match[2] + match[3]! + match[4] + match[5]! });
}

/** "go to <site>[ and search for <words>]" or "search <site> for <words>".
 * The site becomes the whole approved browsing scope (it and its subdomains,
 * HTTPS only; exact loopback for local tests). Search words are a literal
 * suffix of the final command, bound as a value; nothing else is typed. */
export function parseScopedBrowse(text: string): {
  readonly site: string | null;
  readonly startUrl: string;
  readonly searchText: string | null;
  readonly prefix: string | null;
} {
  if (!text.isWellFormed() || Buffer.byteLength(text, 'utf8') > 1_300) {
    throw new ContractError('browse command too large or malformed');
  }
  const goTo = /^((?:go to|open|visit|navigate to) )(\S+?)(?:( and (?:search|look up|find)(?: for)? )(.+))?$/i.exec(text);
  const search = goTo ? undefined : /^(search )(\S+)( for )(.+)$/i.exec(text);
  const target = goTo?.[2] ?? search?.[2];
  const searchText = goTo ? goTo[4] ?? null : search?.[4] ?? null;
  if (!target || (searchText !== null && (searchText.trim() !== searchText || !searchText
    || Buffer.byteLength(searchText, 'utf8') > 512))) {
    throw new ContractError('unsupported browse command');
  }
  const prefix = searchText === null ? null : text.slice(0, text.length - searchText.length);
  const loopback = /^(?:http:\/\/)?127\.0\.0\.1:(\d{1,5})\/?$/u.exec(target);
  if (loopback) {
    return Object.freeze({ site: null, startUrl: `http://127.0.0.1:${loopback[1]}/`, searchText, prefix });
  }
  const host = target.replace(/^https:\/\//iu, '').replace(/\/$/u, '').toLowerCase();
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(host)) {
    throw new ContractError('browse site must be a plain domain such as wikipedia.org');
  }
  return Object.freeze({ site: host, startUrl: `https://${host}/`, searchText, prefix });
}
