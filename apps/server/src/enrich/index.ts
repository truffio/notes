import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import type { LinkEnricher, LinkPreview } from '@notes/core';

type FetchLike = (
  url: string,
  init: { redirect: 'manual'; signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

export interface LinkEnricherOptions {
  /** Test seam. The default re-checks addresses at connect time; see createPinnedFetch. */
  fetch?: FetchLike;
  lookup?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  maxBytes?: number;
}

/** A note can hold hundreds of URLs, and each one costs a fetch of up to DEFAULT_MAX_BYTES. */
export const MAX_ENRICHED_URLS = 5;

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_CHARS = 300;
const ALLOWED_PORTS = new Set(['80', '443']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** Blocked IPv4 ranges as [base, prefix length]. */
const BLOCKED_IPV4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const BLOCKED_IPV4_RANGES = BLOCKED_IPV4.map(([base, bits]) => [ipv4ToInt(base), 2 ** (32 - bits)] as const);

/** Creates a link enricher that fetches a page's title and description. Never throws. */
export function createLinkEnricher(options: LinkEnricherOptions = {}): LinkEnricher {
  const lookup = options.lookup ?? defaultLookup;
  const doFetch = options.fetch ?? createPinnedFetch(lookup);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return async (url) => {
    try {
      return await withDeadline(
        (signal) => fetchPreview(url, { doFetch, lookup, maxBytes, signal }),
        timeoutMs,
      );
    } catch {
      return null;
    }
  };
}

/**
 * A fetch that checks addresses at the moment it connects. Checking a hostname
 * and then calling global fetch leaves a gap: fetch resolves it again, so a DNS
 * record with a short TTL can pass the check and then point at a private address.
 * Here the addresses that were checked are the ones the socket connects to.
 */
export function createPinnedFetch(
  resolve: (hostname: string) => Promise<string[]>,
  isBlocked: (address: string) => boolean = isBlockedAddress,
): FetchLike {
  const pinned = ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolve(hostname).then(
      (addresses) => {
        const first = addresses[0];
        if (first === undefined || addresses.some(isBlocked)) {
          callback(new Error(`Blocked address for ${hostname}`));
        } else if (options.all) {
          callback(null, addresses.map((address) => ({ address, family: isIP(address) })));
        } else {
          callback(null, first, isIP(first));
        }
      },
      (error: unknown) => callback(error),
    );
  }) as LookupFunction;

  return (url, init) =>
    new Promise((resolveResponse, reject) => {
      const target = new URL(url);
      const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const outgoing = request(
        target,
        // No keep-alive agent, so every request goes through the lookup above.
        // Identity because, unlike fetch, this does not decompress responses.
        { agent: false, lookup: pinned, signal: init.signal, headers: { ...init.headers, 'accept-encoding': 'identity' } },
        (incoming) => {
          try {
            resolveResponse(toResponse(incoming));
          } catch (error) {
            incoming.destroy();
            reject(error instanceof Error ? error : new Error('Invalid response'));
          }
        },
      );
      outgoing.on('error', reject);
      outgoing.end();
    });
}

function toResponse(incoming: IncomingMessage): Response {
  const status = incoming.statusCode ?? 502;
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    for (const item of [value ?? []].flat()) headers.append(name, item);
  }
  const body = NULL_BODY_STATUSES.has(status) ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
  return new Response(body, { status, headers });
}

interface FetchContext {
  doFetch: FetchLike;
  lookup: (hostname: string) => Promise<string[]>;
  maxBytes: number;
  signal: AbortSignal;
}

async function fetchPreview(input: string, context: FetchContext): Promise<LinkPreview | null> {
  let target = parseTarget(input);
  if (!target) return null;

  for (let redirects = 0; ; redirects++) {
    if (!(await isAllowedTarget(target, context.lookup))) return null;

    const response = await context.doFetch(target.href, {
      redirect: 'manual',
      signal: context.signal,
      headers: { accept: 'text/html' },
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return readPreview(input, response, context);
    }

    void response.body?.cancel().catch(() => undefined);
    const location = response.headers.get('location');
    if (redirects >= MAX_REDIRECTS || !location) return null;
    target = parseTarget(new URL(location, target).href);
    if (!target) return null;
  }
}

async function readPreview(input: string, response: Response, context: FetchContext): Promise<LinkPreview | null> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'text/html') {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }

  const html = await readCapped(response, context.maxBytes);
  const meta = parseMeta(html);
  return {
    url: input,
    title: meta.title,
    description: meta.description,
  };
}

/** Reads at most maxBytes of the body and stops. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const part = value.subarray(0, maxBytes - total);
      chunks.push(part);
      total += part.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

interface Meta {
  title: string | null;
  description: string | null;
}

function parseMeta(html: string): Meta {
  let ogTitle: string | null = null;
  let ogDescription: string | null = null;
  let metaDescription: string | null = null;

  // Excluding `<` keeps these patterns linear. With `[^>]*` a page of repeated
  // `<meta` is quadratic, and that blocks the event loop past any timeout.
  for (const tag of html.match(/<meta\b[^<>]*>/gi) ?? []) {
    const key = (readAttribute(tag, 'property') ?? readAttribute(tag, 'name'))?.toLowerCase();
    const content = readAttribute(tag, 'content');
    if (!key || content === null) continue;
    if (key === 'og:title' && ogTitle === null) ogTitle = content;
    if (key === 'og:description' && ogDescription === null) ogDescription = content;
    if (key === 'description' && metaDescription === null) metaDescription = content;
  }

  return {
    title: clean(ogTitle ?? readTitle(html)),
    description: clean(ogDescription ?? metaDescription),
  };
}

function readTitle(html: string): string | null {
  const open = /<title\b[^<>]*>/i.exec(html);
  if (!open) return null;
  const rest = html.slice(open.index + open[0].length);
  const close = /<\/title>/i.exec(rest);
  return close ? rest.slice(0, close.index) : null;
}

function readAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(tag);
  return match?.[2] ?? null;
}

function clean(raw: string | null): string | null {
  if (raw === null) return null;
  // jsonb cannot hold a NUL, and one bad title would lose every preview on the note.
  const text = decodeEntities(raw).replaceAll('\0', '').replace(/\s+/g, ' ').trim();
  const trimmed = Array.from(text).slice(0, MAX_CHARS).join('').trim();
  return trimmed === '' ? null : trimmed;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return fromCodePoint(parseInt(body.slice(2), 16), match);
    if (body.startsWith('#')) return fromCodePoint(parseInt(body.slice(1), 10), match);
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function fromCodePoint(codePoint: number, fallback: string): string {
  // Surrogates are excluded because jsonb rejects them when unpaired.
  const invalid = codePoint >= 0xd800 && codePoint <= 0xdfff;
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || invalid) return fallback;
  return String.fromCodePoint(codePoint);
}

function parseTarget(input: string): URL | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (!ALLOWED_PORTS.has(port)) return null;
  return url;
}

async function isAllowedTarget(url: URL, lookup: (hostname: string) => Promise<string[]>): Promise<boolean> {
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (hostname === '' || hostname === 'localhost' || hostname.endsWith('.localhost')) return false;
  if (isIP(hostname) !== 0) return !isBlockedAddress(hostname);

  const addresses = await lookup(hostname);
  return addresses.length > 0 && addresses.every((address) => !isBlockedAddress(address));
}

/** Fails closed: anything that is not a recognizable public IP counts as blocked. */
function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIPv4Int(ipv4ToInt(address));
  if (family === 6) return isBlockedIPv6(address);
  return true;
}

function ipv4ToInt(address: string): number {
  return address.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

function isBlockedIPv4Int(value: number): boolean {
  return BLOCKED_IPV4_RANGES.some(([base, size]) => Math.floor(value / size) === Math.floor(base / size));
}

function isBlockedIPv6(address: string): boolean {
  const bytes = parseIPv6(address);
  if (!bytes) return true;

  const ipv4At = (offset: number) =>
    bytes[offset]! * 2 ** 24 + bytes[offset + 1]! * 2 ** 16 + bytes[offset + 2]! * 256 + bytes[offset + 3]!;
  const isZero = (from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0);

  // ::/96 covers unspecified, loopback and the deprecated IPv4-compatible form.
  if (isZero(0, 12)) return true;
  // ::ffff:0:0/96 IPv4-mapped.
  if (isZero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return isBlockedIPv4Int(ipv4At(12));
  // 64:ff9b::/96 NAT64, checked against the embedded IPv4 address.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && isZero(4, 12)) {
    return isBlockedIPv4Int(ipv4At(12));
  }
  // 2002::/16 6to4, checked against the embedded IPv4 address.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return isBlockedIPv4Int(ipv4At(2));

  // 2001::/32 Teredo and 2001:db8::/32 documentation.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  // fc00::/7 unique local.
  if ((bytes[0]! & 0xfe) === 0xfc) return true;
  // fe80::/10 link-local.
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true;
  // fec0::/10 site-local (deprecated).
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return true;
  // ff00::/8 multicast.
  if (bytes[0] === 0xff) return true;

  return false;
}

/** Expands an IPv6 literal (with optional zone id and dotted IPv4 tail) into 16 bytes. */
function parseIPv6(address: string): number[] | null {
  let text = (address.split('%')[0] ?? '').toLowerCase();

  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null;
    const value = ipv4ToInt(tail);
    text = `${text.slice(0, lastColon + 1)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const split = (part: string) => (part === '' ? [] : part.split(':'));

  let groups: string[];
  if (halves.length === 1) {
    groups = split(halves[0] ?? '');
  } else {
    const head = split(halves[0] ?? '');
    const rest = split(halves[1] ?? '');
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...rest];
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const addresses = await dnsLookup(hostname, { all: true });
  return addresses.map((entry) => entry.address);
}

/** Runs the task with an abort signal that fires, and the result is null, once the deadline passes. */
async function withDeadline<T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Link enrichment timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([task(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
