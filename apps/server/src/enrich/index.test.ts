import { describe, expect, it } from 'vitest';
import { createLinkEnricher } from './index.ts';

type FetchCall = { url: string; init: RequestInit | undefined };

/** Fake fetch that answers each call from a queue of responses and records calls. */
function fakeFetch(...responses: Array<Response | (() => Response) | Error | Promise<Response>>) {
  const calls: FetchCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    if (next) return next;
    throw new Error('no response queued');
  };
  return { fetch: impl as typeof fetch, calls };
}

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    status: init.status ?? 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...(init.headers as Record<string, string>) },
  });
}

/** Lookup that resolves every hostname to the given addresses. */
const resolvesTo = (...addresses: string[]) => async () => addresses;

const PAGE = '<html><head><title>Hello</title><meta name="description" content="A page"></head></html>';

describe('createLinkEnricher', () => {
  describe('URL checks', () => {
    it('refuses non-http schemes without fetching', async () => {
      const { fetch, calls } = fakeFetch();
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('93.184.216.34') });
      expect(await enrich('ftp://example.com/file')).toBeNull();
      expect(await enrich('file:///etc/passwd')).toBeNull();
      expect(await enrich('javascript:alert(1)')).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it('refuses ports other than 80 and 443', async () => {
      const { fetch, calls } = fakeFetch();
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('93.184.216.34') });
      expect(await enrich('http://example.com:8080/')).toBeNull();
      expect(await enrich('https://example.com:8443/')).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it('refuses unparseable URLs', async () => {
      const { fetch, calls } = fakeFetch();
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('93.184.216.34') });
      expect(await enrich('not a url')).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it('refuses localhost by name without a DNS lookup', async () => {
      const { fetch, calls } = fakeFetch();
      let lookups = 0;
      const enrich = createLinkEnricher({
        fetch,
        lookup: async () => {
          lookups++;
          return ['93.184.216.34'];
        },
      });
      expect(await enrich('http://localhost/')).toBeNull();
      expect(await enrich('http://api.localhost/')).toBeNull();
      expect(lookups).toBe(0);
      expect(calls).toHaveLength(0);
    });
  });

  describe('blocked addresses', () => {
    const blockedIPv4 = [
      '0.0.0.0',
      '0.1.2.3',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '192.0.0.8',
      '198.18.0.1',
      '224.0.0.1',
      '239.255.255.255',
      '240.0.0.1',
      '255.255.255.255',
    ];

    const blockedIPv6 = [
      '::',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:10.0.0.1',
      '::ffff:169.254.169.254',
      '::127.0.0.1',
      'fc00::1',
      'fd12:3456:789a::1',
      'fe80::1',
      'febf::1',
      'fec0::1',
      'ff02::1',
      '2002:7f00:1::',
      '64:ff9b::7f00:1',
    ];

    it.each(blockedIPv4)('refuses a hostname that resolves to IPv4 %s', async (address) => {
      const { fetch, calls } = fakeFetch(html(PAGE));
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo(address) });
      expect(await enrich('https://example.com/')).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it.each(blockedIPv6)('refuses a hostname that resolves to IPv6 %s', async (address) => {
      const { fetch, calls } = fakeFetch(html(PAGE));
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo(address) });
      expect(await enrich('https://example.com/')).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it.each(['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://10.1.2.3/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fe80::1]/'])(
      'refuses IP literal hosts %s without a DNS lookup',
      async (url) => {
        const { fetch, calls } = fakeFetch(html(PAGE));
        let lookups = 0;
        const enrich = createLinkEnricher({
          fetch,
          lookup: async () => {
            lookups++;
            return ['93.184.216.34'];
          },
        });
        expect(await enrich(url)).toBeNull();
        expect(lookups).toBe(0);
        expect(calls).toHaveLength(0);
      },
    );

    it('refuses when any resolved address is private', async () => {
      const { fetch, calls } = fakeFetch(html(PAGE));
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('93.184.216.34', '10.0.0.5') });
      expect(await enrich('https://example.com/')).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it('refuses when DNS returns no addresses or fails', async () => {
      const { fetch, calls } = fakeFetch(html(PAGE), html(PAGE));
      const enrich = createLinkEnricher({
        fetch,
        lookup: async (hostname) => {
          if (hostname === 'empty.example') return [];
          throw new Error('ENOTFOUND');
        },
      });
      expect(await enrich('https://empty.example/')).toBeNull();
      expect(await enrich('https://missing.example/')).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it('allows public addresses, including IPv4-mapped public ones', async () => {
      const { fetch } = fakeFetch(html(PAGE));
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('::ffff:8.8.8.8') });
      expect(await enrich('https://example.com/')).toEqual({
        url: 'https://example.com/',
        title: 'Hello',
        description: 'A page',
      });
    });

    it('allows public IPv4 boundary addresses next to blocked ranges', async () => {
      const { fetch } = fakeFetch(html(PAGE));
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('172.32.0.1') });
      expect(await enrich('https://example.com/')).not.toBeNull();
    });
  });

  describe('redirects', () => {
    it('refuses a redirect to a private IP literal', async () => {
      const { fetch, calls } = fakeFetch(
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }),
      );
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('93.184.216.34') });
      expect(await enrich('https://example.com/')).toBeNull();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.init?.redirect).toBe('manual');
    });

    it('refuses a redirect to a hostname that resolves to a private address', async () => {
      const { fetch, calls } = fakeFetch(
        new Response(null, { status: 301, headers: { location: 'https://internal.example/' } }),
        html(PAGE),
      );
      const enrich = createLinkEnricher({
        fetch,
        lookup: async (hostname) => (hostname === 'internal.example' ? ['192.168.0.10'] : ['93.184.216.34']),
      });
      expect(await enrich('https://example.com/')).toBeNull();
      expect(calls.map((call) => call.url)).toEqual(['https://example.com/']);
    });

    it('re-validates the scheme and port of a redirect target', async () => {
      const { fetch, calls } = fakeFetch(
        new Response(null, { status: 302, headers: { location: 'http://example.com:8080/' } }),
        html(PAGE),
      );
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('93.184.216.34') });
      expect(await enrich('https://example.com/')).toBeNull();
      expect(calls).toHaveLength(1);
    });

    it('follows up to three redirects', async () => {
      const { fetch, calls } = fakeFetch(
        new Response(null, { status: 302, headers: { location: '/a' } }),
        new Response(null, { status: 302, headers: { location: '/b' } }),
        new Response(null, { status: 307, headers: { location: '/c' } }),
        html(PAGE),
      );
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('93.184.216.34') });
      const preview = await enrich('https://example.com/start');
      expect(preview?.title).toBe('Hello');
      expect(calls.map((call) => call.url)).toEqual([
        'https://example.com/start',
        'https://example.com/a',
        'https://example.com/b',
        'https://example.com/c',
      ]);
    });

    it('gives up after a fourth redirect', async () => {
      const { fetch, calls } = fakeFetch(
        new Response(null, { status: 302, headers: { location: '/a' } }),
        new Response(null, { status: 302, headers: { location: '/b' } }),
        new Response(null, { status: 302, headers: { location: '/c' } }),
        new Response(null, { status: 302, headers: { location: '/d' } }),
        html(PAGE),
      );
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('93.184.216.34') });
      expect(await enrich('https://example.com/')).toBeNull();
      expect(calls).toHaveLength(4);
    });

    it('returns null for a redirect without a location', async () => {
      const { fetch } = fakeFetch(new Response(null, { status: 302 }));
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('93.184.216.34') });
      expect(await enrich('https://example.com/')).toBeNull();
    });
  });

  describe('response handling', () => {
    it('parses og:title and og:description ahead of <title> and meta description', async () => {
      const page = `<head>
        <title>Plain title</title>
        <meta name="description" content="Plain description">
        <meta content="Social description" property="og:description">
        <meta property="og:title" content="Social title">
      </head>`;
      const { fetch } = fakeFetch(html(page));
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('93.184.216.34') });
      expect(await enrich('https://example.com/')).toEqual({
        url: 'https://example.com/',
        title: 'Social title',
        description: 'Social description',
      });
    });

    it('decodes basic HTML entities once', async () => {
      const page = '<title>Tom &amp; Jerry &lt;3 &quot;x&quot; &#39;y&#39; &#x41;&#66; &amp;lt;</title>';
      const { fetch } = fakeFetch(html(page));
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('93.184.216.34') });
      expect((await enrich('https://example.com/'))?.title).toBe(`Tom & Jerry <3 "x" 'y' AB &lt;`);
    });

    it('trims descriptions to 300 characters', async () => {
      const long = 'a'.repeat(500);
      const { fetch } = fakeFetch(html(`<meta name="description" content="${long}">`));
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('93.184.216.34') });
      expect((await enrich('https://example.com/'))?.description).toBe('a'.repeat(300));
    });

    it('returns null fields when the page has no title or description', async () => {
      const { fetch } = fakeFetch(html('<p>nothing here</p>'));
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('93.184.216.34') });
      expect(await enrich('https://example.com/')).toEqual({
        url: 'https://example.com/',
        title: null,
        description: null,
      });
    });

    it('parses only text/html', async () => {
      const { fetch } = fakeFetch(
        new Response(PAGE, { status: 200, headers: { 'content-type': 'application/pdf' } }),
      );
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('93.184.216.34') });
      expect(await enrich('https://example.com/file.pdf')).toBeNull();
    });

    it('returns null for non-2xx responses', async () => {
      const { fetch } = fakeFetch(html(PAGE, { status: 404 }));
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('93.184.216.34') });
      expect(await enrich('https://example.com/missing')).toBeNull();
    });

    it('returns null when fetch throws', async () => {
      const { fetch } = fakeFetch(new Error('socket hang up'));
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('93.184.216.34') });
      expect(await enrich('https://example.com/')).toBeNull();
    });

    it('returns null when the request times out', async () => {
      const fetch = ((_input: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as typeof globalThis.fetch;
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('93.184.216.34'), timeoutMs: 20 });
      expect(await enrich('https://example.com/')).toBeNull();
    });

    it('returns null when DNS never answers', async () => {
      const enrich = createLinkEnricher({
        fetch: fakeFetch(html(PAGE)).fetch,
        lookup: () => new Promise<string[]>(() => undefined),
        timeoutMs: 20,
      });
      expect(await enrich('https://example.com/')).toBeNull();
    });
  });

  describe('body size', () => {
    it('stops reading at maxBytes and parses what it has', async () => {
      const head = '<title>Early</title>';
      const padding = ' '.repeat(100);
      const late = '<meta name="description" content="Too late">';
      const { fetch } = fakeFetch(html(head + padding + late));
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('93.184.216.34'), maxBytes: 64 });
      expect(await enrich('https://example.com/')).toEqual({
        url: 'https://example.com/',
        title: 'Early',
        description: null,
      });
    });

    it('does not read an endless body past maxBytes', async () => {
      const chunk = new TextEncoder().encode('<title>Endless</title>' + 'x'.repeat(1000));
      let pulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      const { fetch } = fakeFetch(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } }),
      );
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('93.184.216.34'), maxBytes: 4096 });
      expect((await enrich('https://example.com/'))?.title).toBe('Endless');
      expect(pulled).toBeLessThanOrEqual(4096 + 2 * chunk.byteLength);
    });

    it('uses a 1 MB default limit', async () => {
      const big = 'x'.repeat(2 * 1024 * 1024);
      const { fetch } = fakeFetch(html(`<title>Big</title>${big}<meta name="description" content="Late">`));
      const enrich = createLinkEnricher({ fetch, lookup: resolvesTo('93.184.216.34') });
      expect(await enrich('https://example.com/')).toEqual({
        url: 'https://example.com/',
        title: 'Big',
        description: null,
      });
    });
  });
});
