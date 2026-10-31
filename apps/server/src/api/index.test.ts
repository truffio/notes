import type { CommandHandler, MessageParser, User } from '@notes/core';
import { createPgliteDatabase, createRepositories, migrate, type Database, type Repositories } from '@notes/db';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpTokenCommand } from '../auth/apiTokens.ts';
import { createLoginCommand } from '../auth/login.ts';
import { hashToken } from '../auth/tokens.ts';
import { createApi } from './index.ts';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

const parse: MessageParser = (input) => ({
  text: input.replace(/#\w+/gu, '').trim(),
  tags: [...input.matchAll(/#(\w+)/gu)].map((match) => match[1]!.toLowerCase()),
  urls: [],
  list: null,
});

let db: Database;
let repos: Repositories;
let app: Hono;
let time: Date;
let loginCommand: CommandHandler;
let alice: User;
let bob: User;
let nextAddress: number;

const now = () => time;
const advance = (ms: number) => {
  time = new Date(time.getTime() + ms);
};
const fromAddress = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });

function post(path: string, body: unknown, headers: Record<string, string> = {}, env?: object, target = app) {
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
  return target.request(`/api${path}`, init, env ?? fromAddress(`10.0.0.${nextAddress++}`));
}

async function loginToken(user: User): Promise<string> {
  const reply = await loginCommand({ user, args: '' });
  return /#token=([0-9a-f]{64})$/u.exec(reply)![1]!;
}

/** A signed-in browser: sends the cookie and, for writes, the CSRF token. */
interface Client {
  cookie: string;
  csrfToken: string;
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
}

async function signIn(user: User): Promise<Client> {
  const response = await post('/auth/login', { token: await loginToken(user) });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('Set-Cookie')!.split(';')[0]!;
  const me = await app.request('/api/me', { headers: { Cookie: cookie } });
  const { csrfToken } = (await me.json()) as { csrfToken: string };
  return {
    cookie,
    csrfToken,
    call: async (method, path, body, headers = {}) =>
      app.request(`/api${path}`, {
        method,
        headers: {
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      }),
  };
}

beforeEach(async () => {
  db = createPgliteDatabase();
  await migrate(db);
  repos = createRepositories(db);
  time = new Date('2026-01-01T00:00:00.000Z');
  nextAddress = 1;
  app = createApi({ repos, parse, secureCookies: true, now });
  loginCommand = createLoginCommand({ repos, baseUrl: 'https://notes.test/', now });
  alice = await repos.users.upsertByTelegramId('1', 'Alice');
  bob = await repos.users.upsertByTelegramId('2', 'Bob');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.close();
});

describe('/login command', () => {
  it('replies with a fragment link and stores only the hash', async () => {
    const reply = await loginCommand({ user: alice, args: '' });
    const token = /https:\/\/notes\.test\/login#token=([0-9a-f]{64})$/u.exec(reply)![1]!;
    const { rows } = await db.query<{ token_hash: string; expires_at: Date }>('SELECT * FROM login_tokens');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(hashToken(token));
    expect(rows[0]!.token_hash).not.toBe(token);
    expect(new Date(rows[0]!.expires_at).getTime()).toBe(time.getTime() + 10 * MINUTE);
  });
});

describe('/mcptoken command', () => {
  const command = () => createMcpTokenCommand({ repos });

  it('issues a token that resolves to the user and stores only the hash', async () => {
    const reply = await command()({ user: alice, args: ' laptop ' });
    const token = /\n([0-9a-f]{64})$/u.exec(reply)![1]!;
    expect(await repos.auth.getUserIdByApiToken(hashToken(token))).toBe(alice.id);
    expect(await repos.auth.getUserIdByApiToken(token)).toBeNull();
    const { rows } = await db.query<{ name: string }>('SELECT name FROM api_tokens');
    expect(rows).toEqual([expect.objectContaining({ name: 'laptop' })]);
  });

  it('asks for a usable name', async () => {
    expect(await command()({ user: alice, args: '  ' })).toContain('Usage');
    expect(await command()({ user: alice, args: 'x'.repeat(65) })).toContain('Usage');
    expect((await db.query('SELECT 1 FROM api_tokens')).rows).toEqual([]);
  });
});

describe('login flow', () => {
  it('logs in, serves the session and logs out', async () => {
    const response = await post('/auth/login', { token: await loginToken(alice) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const setCookie = response.headers.get('Set-Cookie')!;
    expect(setCookie).toMatch(/HttpOnly/iu);
    expect(setCookie).toMatch(/SameSite=Lax/iu);
    expect(setCookie).toMatch(/Path=\//iu);
    expect(setCookie).toMatch(/Secure/iu);
    expect(setCookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);

    const cookie = setCookie.split(';')[0]!;
    const me = await app.request('/api/me', { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: Record<string, unknown>; csrfToken: string };
    expect(body.user).toEqual({ id: alice.id, displayName: 'Alice', timezone: 'UTC' });
    expect(body.csrfToken).toMatch(/^[0-9a-f]{64}$/u);

    const logout = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: cookie, 'X-CSRF-Token': body.csrfToken },
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get('Set-Cookie')).toMatch(/Max-Age=0/iu);
    expect((await app.request('/api/me', { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it('omits Secure when secure cookies are off', async () => {
    const insecure = createApi({ repos, parse, secureCookies: false, now });
    const response = await post('/auth/login', { token: await loginToken(alice) }, {}, undefined, insecure);
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).not.toMatch(/Secure/iu);
  });

  it('stores session tokens only as hashes', async () => {
    const response = await post('/auth/login', { token: await loginToken(alice) });
    const token = response.headers.get('Set-Cookie')!.split(';')[0]!.split('=')[1]!;
    const { rows } = await db.query<{ token_hash: string }>('SELECT token_hash FROM sessions');
    expect(rows).toEqual([{ token_hash: hashToken(token) }]);
  });

  it('accepts a login token only once', async () => {
    const token = await loginToken(alice);
    expect((await post('/auth/login', { token })).status).toBe(200);
    const again = await post('/auth/login', { token });
    expect(again.status).toBe(401);
    expect(again.headers.get('Set-Cookie')).toBeNull();
  });

  it('expires login tokens after 10 minutes', async () => {
    const early = await loginToken(alice);
    advance(10 * MINUTE - 1);
    expect((await post('/auth/login', { token: early })).status).toBe(200);

    const late = await loginToken(alice);
    advance(10 * MINUTE);
    expect((await post('/auth/login', { token: late })).status).toBe(401);
  });

  it('expires sessions after 30 days', async () => {
    const client = await signIn(alice);
    advance(30 * DAY - 1);
    expect((await client.call('GET', '/me')).status).toBe(200);
    advance(1);
    expect((await client.call('GET', '/me')).status).toBe(401);
  });

  it('rejects unknown and malformed login tokens', async () => {
    expect((await post('/auth/login', { token: 'nope' })).status).toBe(401);
    expect((await post('/auth/login', { token: 1 })).status).toBe(400);
    expect((await post('/auth/login', {})).status).toBe(400);
    expect((await post('/auth/login', '{oops')).status).toBe(400);
    expect((await post('/auth/login', '[]')).status).toBe(400);
  });

  it('rejects a login that is not sent as JSON', async () => {
    const token = await loginToken(alice);
    const response = await post('/auth/login', { token }, { 'Content-Type': 'text/plain' });
    expect(response.status).toBe(400);
    expect((await post('/auth/login', { token })).status).toBe(200);
  });

  it('rate limits by client address and recovers', async () => {
    const attacker = fromAddress('203.0.113.9');
    for (let i = 0; i < 10; i++) {
      expect((await post('/auth/login', { token: 'x' }, {}, attacker)).status).toBe(401);
    }
    const limited = await post('/auth/login', { token: await loginToken(alice) }, {}, attacker);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');

    // A spoofed forwarding header changes nothing, and other addresses are unaffected.
    expect((await post('/auth/login', { token: 'x' }, { 'X-Forwarded-For': '1.2.3.4' }, attacker)).status).toBe(429);
    expect((await post('/auth/login', { token: 'x' })).status).toBe(401);

    advance(MINUTE);
    expect((await post('/auth/login', { token: 'x' }, {}, attacker)).status).toBe(401);
  });
});

describe('authentication', () => {
  const routes: Array<[string, string]> = [
    ['POST', '/auth/logout'],
    ['GET', '/me'],
    ['PATCH', '/me'],
    ['GET', '/notes'],
    ['POST', '/notes'],
    ['PATCH', `/notes/${MISSING_ID}`],
    ['DELETE', `/notes/${MISSING_ID}`],
    ['GET', '/tags'],
    ['PATCH', `/tags/${MISSING_ID}`],
    ['DELETE', `/tags/${MISSING_ID}`],
    ['GET', '/lists'],
    ['POST', `/lists/${MISSING_ID}/items`],
    ['DELETE', `/lists/${MISSING_ID}`],
    ['PATCH', `/list-items/${MISSING_ID}`],
    ['DELETE', `/list-items/${MISSING_ID}`],
    ['GET', '/reminders'],
    ['DELETE', `/reminders/${MISSING_ID}`],
  ];

  it('answers 401 on every route without a session', async () => {
    for (const [method, path] of routes) {
      const response = await app.request(`/api${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(await response.json()).toEqual({ error: expect.any(String) });
    }
  });

  it('answers 401 for a forged session cookie and for bad ids', async () => {
    const headers = { Cookie: 'session=forged' };
    expect((await app.request('/api/me', { headers })).status).toBe(401);
    expect((await app.request('/api/notes/not-a-uuid', { method: 'DELETE' })).status).toBe(401);
  });

  it('answers 403 on every write without a CSRF token', async () => {
    const client = await signIn(alice);
    for (const [method, path] of routes.filter(([method]) => method !== 'GET')) {
      const response = await app.request(`/api${path}`, { method, headers: { Cookie: client.cookie } });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    expect((await client.call('GET', '/me')).status).toBe(200);
  });
});

describe('CSRF', () => {
  it('rejects a wrong token, and the token of another session', async () => {
    const client = await signIn(alice);
    const other = await signIn(bob);
    for (const token of ['wrong', `${client.csrfToken}0`, other.csrfToken, 'é'.repeat(32)]) {
      const encoded = Buffer.from(token, 'utf8').toString('latin1');
      const response = await client.call('POST', '/notes', { text: 'x' }, { 'X-CSRF-Token': encoded });
      expect(response.status).toBe(403);
    }
    expect((await repos.notes.list(alice.id)).items).toEqual([]);
  });

  it('checks the token before the payload', async () => {
    const client = await signIn(alice);
    const response = await client.call('DELETE', '/notes/not-a-uuid', undefined, { 'X-CSRF-Token': 'wrong' });
    expect(response.status).toBe(403);
  });

  it('keeps the session after a failed logout', async () => {
    const client = await signIn(alice);
    expect((await client.call('POST', '/auth/logout', {}, { 'X-CSRF-Token': 'wrong' })).status).toBe(403);
    expect((await client.call('GET', '/me')).status).toBe(200);
  });
});

describe('me', () => {
  it('updates a valid timezone', async () => {
    const client = await signIn(alice);
    const response = await client.call('PATCH', '/me', { timezone: 'America/Toronto' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: { id: alice.id, displayName: 'Alice', timezone: 'America/Toronto' },
      csrfToken: client.csrfToken,
    });
  });

  it('rejects an invalid timezone', async () => {
    const client = await signIn(alice);
    for (const timezone of ['Mars/Olympus', '', 5, null]) {
      expect((await client.call('PATCH', '/me', { timezone })).status).toBe(400);
    }
    expect((await repos.users.get(alice.id))!.timezone).toBe('UTC');
  });
});

describe('notes', () => {
  it('creates a note from parsed text and tags', async () => {
    const client = await signIn(alice);
    const response = await client.call('POST', '/notes', { text: 'buy milk #Home' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ text: 'buy milk', source: 'web', tags: ['home'] });
  });

  it('keeps existing tags on edit and adds new ones', async () => {
    const client = await signIn(alice);
    const note = await repos.notes.create(alice.id, { text: 'draft', source: 'web', tags: ['home', 'work'] });

    const kept = await client.call('PATCH', `/notes/${note.id}`, { text: 'edited' });
    expect(await kept.json()).toMatchObject({ text: 'edited', tags: ['home', 'work'] });

    const added = await client.call('PATCH', `/notes/${note.id}`, { text: 'edited again #urgent #home' });
    expect(await added.json()).toMatchObject({ text: 'edited again', tags: ['home', 'urgent', 'work'] });
  });

  it('saves the raw text if the parser throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = createApi({
      repos,
      secureCookies: true,
      now,
      parse: () => {
        throw new Error('parser bug');
      },
    });
    const client = await signIn(alice);
    const response = await failing.request('/api/notes', {
      method: 'POST',
      headers: { Cookie: client.cookie, 'X-CSRF-Token': client.csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'keep me #tag' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ text: 'keep me #tag', tags: [] });
  });

  it('filters, searches and pages', async () => {
    const client = await signIn(alice);
    for (const text of ['one #a', 'two #a', 'three']) await client.call('POST', '/notes', { text });
    advance(1);

    const tagged = (await (await client.call('GET', '/notes?tag=a')).json()) as { items: unknown[] };
    expect(tagged.items).toHaveLength(2);
    const found = (await (await client.call('GET', '/notes?q=thr')).json()) as { items: Array<{ text: string }> };
    expect(found.items.map((note) => note.text)).toEqual(['three']);

    const seen: string[] = [];
    let path = '/notes?limit=2';
    for (;;) {
      const response = await client.call('GET', path);
      expect(response.status).toBe(200);
      const page = (await response.json()) as { items: Array<{ id: string }>; nextCursor: string | null };
      seen.push(...page.items.map((note) => note.id));
      if (!page.nextCursor) break;
      path = `/notes?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`;
    }
    expect(new Set(seen).size).toBe(3);
  });

  it('rejects bad query values before they reach Postgres', async () => {
    const client = await signIn(alice);
    const bad = [
      'limit=abc',
      'limit=-1',
      'limit=',
      'cursor=junk',
      `cursor=${encodeURIComponent(`2026-01-01T00:00:00.000Z|${'-'.repeat(36)}`)}`,
      `cursor=${encodeURIComponent(`2026|${MISSING_ID}`)}`,
      `cursor=${encodeURIComponent(`0000-01-01T00:00:00.000Z|${MISSING_ID}`)}`,
      `tag=${'x'.repeat(65)}`,
      'tag=%00',
      'q=%00',
      `q=${'a'.repeat(501)}`,
    ];
    for (const query of bad) {
      expect((await client.call('GET', `/notes?${query}`)).status, query).toBe(400);
    }
    expect((await client.call('GET', `/notes?q=${'é'.repeat(500)}`)).status).toBe(200);
  });

  it('validates text', async () => {
    const client = await signIn(alice);
    const note = await repos.notes.create(alice.id, { text: 'x', source: 'web' });
    expect((await client.call('POST', '/notes', { text: 'x'.repeat(10000) })).status).toBe(200);
    for (const text of ['x'.repeat(10001), '', '   ', 'a\0b', 5, null, undefined]) {
      expect((await client.call('POST', '/notes', { text })).status).toBe(400);
      expect((await client.call('PATCH', `/notes/${note.id}`, { text })).status).toBe(400);
    }
    expect((await client.call('POST', '/notes', { text: `#${'x'.repeat(65)}` })).status).toBe(400);
    expect((await client.call('POST', '/notes', { text: `#${'x'.repeat(64)}` })).status).toBe(200);
  });

  it('answers 400 for invalid JSON, 413 for a huge body', async () => {
    const client = await signIn(alice);
    expect((await client.call('POST', '/notes', '{oops')).status).toBe(400);
    expect((await client.call('POST', '/notes', 'null')).status).toBe(400);
    expect((await client.call('POST', '/notes', { text: 'x'.repeat(200 * 1024) })).status).toBe(413);
  });

  it('accepts the longest text even when fully escaped', async () => {
    const client = await signIn(alice);
    const body = `{"text":"${'\\ud83d\\ude00'.repeat(5000)}"}`;
    expect((await client.call('POST', '/notes', body)).status).toBe(200);
  });
});

describe('path parameters', () => {
  it('answers 400 for a non-UUID id on every route', async () => {
    const client = await signIn(alice);
    const calls: Array<[string, string, unknown?]> = [
      ['PATCH', '/notes/1', { text: 'x' }],
      ['DELETE', '/notes/1'],
      ['PATCH', '/tags/1', { name: 'x' }],
      ['DELETE', '/tags/1'],
      ['POST', '/lists/1/items', { text: 'x' }],
      ['DELETE', '/lists/1'],
      ['PATCH', '/list-items/1', { checked: true }],
      ['DELETE', '/list-items/1'],
      ['DELETE', '/reminders/1'],
      ['DELETE', `/notes/${MISSING_ID}x`],
    ];
    for (const [method, path, body] of calls) {
      expect((await client.call(method, path, body)).status, `${method} ${path}`).toBe(400);
    }
  });

  it('answers 404 for an id that does not exist', async () => {
    const client = await signIn(alice);
    const calls: Array<[string, string, unknown?]> = [
      ['PATCH', `/notes/${MISSING_ID}`, { text: 'x' }],
      ['DELETE', `/notes/${MISSING_ID}`],
      ['PATCH', `/tags/${MISSING_ID}`, { name: 'x' }],
      ['DELETE', `/tags/${MISSING_ID}`],
      ['POST', `/lists/${MISSING_ID}/items`, { text: 'x' }],
      ['DELETE', `/lists/${MISSING_ID}`],
      ['PATCH', `/list-items/${MISSING_ID}`, { checked: true }],
      ['DELETE', `/list-items/${MISSING_ID}`],
      ['DELETE', `/reminders/${MISSING_ID}`],
    ];
    for (const [method, path, body] of calls) {
      expect((await client.call(method, path, body)).status, `${method} ${path}`).toBe(404);
    }
  });

  it('answers JSON 404 for an unknown route', async () => {
    const client = await signIn(alice);
    const response = await client.call('GET', '/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });
});

describe('tags', () => {
  it('lists and renames', async () => {
    const client = await signIn(alice);
    await repos.notes.create(alice.id, { text: 'x', source: 'web', tags: ['home'] });
    const { items } = (await (await client.call('GET', '/tags')).json()) as { items: Array<{ id: string }> };
    expect(items).toEqual([expect.objectContaining({ name: 'home', noteCount: 1 })]);
    const response = await client.call('PATCH', `/tags/${items[0]!.id}`, { name: ' house ' });
    expect(await response.json()).toMatchObject({ name: 'house', noteCount: 1 });
  });

  it('answers 409 when the name is taken', async () => {
    const client = await signIn(alice);
    await repos.notes.create(alice.id, { text: 'x', source: 'web', tags: ['home', 'work'] });
    const tags = await repos.tags.list(alice.id);
    const response = await client.call('PATCH', `/tags/${tags[0]!.id}`, { name: 'work' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: expect.any(String) });
  });

  it('validates the name', async () => {
    const client = await signIn(alice);
    await repos.notes.create(alice.id, { text: 'x', source: 'web', tags: ['home'] });
    const [tag] = await repos.tags.list(alice.id);
    expect((await client.call('PATCH', `/tags/${tag!.id}`, { name: 'x'.repeat(64) })).status).toBe(200);
    for (const name of ['', '  ', 'x'.repeat(65), 'a\0b', 5]) {
      expect((await client.call('PATCH', `/tags/${tag!.id}`, { name })).status).toBe(400);
    }
  });
});

describe('lists', () => {
  it('adds, checks and deletes items', async () => {
    const client = await signIn(alice);
    const list = await repos.lists.addItemsByName(alice.id, 'groceries', ['milk']);
    const response = await client.call('POST', `/lists/${list.id}/items`, { text: 'eggs' });
    const item = (await response.json()) as { id: string };
    expect(item).toMatchObject({ text: 'eggs', checked: false });

    const checked = await client.call('PATCH', `/list-items/${item.id}`, { checked: true });
    expect(await checked.json()).toMatchObject({ id: item.id, checked: true });
    expect((await client.call('PATCH', `/list-items/${item.id}`, { checked: 'yes' })).status).toBe(400);
    expect((await client.call('POST', `/lists/${list.id}/items`, { text: '' })).status).toBe(400);

    expect((await client.call('DELETE', `/list-items/${item.id}`)).status).toBe(200);
    const { items } = (await (await client.call('GET', '/lists')).json()) as { items: Array<{ items: unknown[] }> };
    expect(items[0]!.items).toHaveLength(1);
    expect((await client.call('DELETE', `/lists/${list.id}`)).status).toBe(200);
    expect(await repos.lists.all(alice.id)).toEqual([]);
  });
});

describe('reminders', () => {
  it('lists pending reminders and cancels once', async () => {
    const client = await signIn(alice);
    const reminder = await repos.reminders.create(alice.id, {
      noteId: null,
      text: 'call',
      remindAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    const { items } = (await (await client.call('GET', '/reminders')).json()) as { items: Array<{ id: string }> };
    expect(items.map((item) => item.id)).toEqual([reminder.id]);
    expect((await client.call('DELETE', `/reminders/${reminder.id}`)).status).toBe(200);
    expect((await client.call('DELETE', `/reminders/${reminder.id}`)).status).toBe(404);
    expect(await repos.reminders.listPending(alice.id)).toEqual([]);
  });
});

describe('cross-user isolation', () => {
  let client: Client;

  beforeEach(async () => {
    client = await signIn(bob);
  });

  it('hides and protects notes', async () => {
    const note = await repos.notes.create(alice.id, { text: 'secret', source: 'web', tags: ['private'] });
    expect((await client.call('PATCH', `/notes/${note.id}`, { text: 'hacked #evil' })).status).toBe(404);
    expect((await client.call('DELETE', `/notes/${note.id}`)).status).toBe(404);
    for (const path of ['/notes', '/notes?q=secret', '/notes?tag=private']) {
      expect(await (await client.call('GET', path)).json()).toEqual({ items: [], nextCursor: null });
    }
    expect(await repos.notes.get(alice.id, note.id)).toMatchObject({ text: 'secret', tags: ['private'] });
    expect(await repos.tags.list(bob.id)).toEqual([]);
  });

  it('hides and protects tags', async () => {
    await repos.notes.create(alice.id, { text: 'x', source: 'web', tags: ['private'] });
    const [tag] = await repos.tags.list(alice.id);
    expect((await client.call('PATCH', `/tags/${tag!.id}`, { name: 'hacked' })).status).toBe(404);
    expect((await client.call('DELETE', `/tags/${tag!.id}`)).status).toBe(404);
    expect(await (await client.call('GET', '/tags')).json()).toEqual({ items: [] });
    expect((await repos.tags.list(alice.id))[0]).toMatchObject({ name: 'private' });
  });

  it('answers 404, not 409, for a tag of another user even when the name collides', async () => {
    await repos.notes.create(alice.id, { text: 'x', source: 'web', tags: ['private'] });
    await repos.notes.create(bob.id, { text: 'y', source: 'web', tags: ['mine'] });
    const [tag] = await repos.tags.list(alice.id);
    expect((await client.call('PATCH', `/tags/${tag!.id}`, { name: 'mine' })).status).toBe(404);
  });

  it('hides and protects lists and their items', async () => {
    const list = await repos.lists.addItemsByName(alice.id, 'private', ['milk']);
    const itemId = list.items[0]!.id;
    expect((await client.call('POST', `/lists/${list.id}/items`, { text: 'evil' })).status).toBe(404);
    expect((await client.call('PATCH', `/list-items/${itemId}`, { checked: true })).status).toBe(404);
    expect((await client.call('DELETE', `/list-items/${itemId}`)).status).toBe(404);
    expect((await client.call('DELETE', `/lists/${list.id}`)).status).toBe(404);
    expect(await (await client.call('GET', '/lists')).json()).toEqual({ items: [] });
    expect((await repos.lists.all(alice.id))[0]!.items).toEqual([{ id: itemId, text: 'milk', checked: false }]);
  });

  it('hides and protects reminders', async () => {
    const reminder = await repos.reminders.create(alice.id, {
      noteId: null,
      text: 'private',
      remindAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    expect((await client.call('DELETE', `/reminders/${reminder.id}`)).status).toBe(404);
    expect(await (await client.call('GET', '/reminders')).json()).toEqual({ items: [] });
    expect(await repos.reminders.listPending(alice.id)).toHaveLength(1);
  });

  it('keeps each session on its own profile', async () => {
    const other = await signIn(alice);
    await client.call('PATCH', '/me', { timezone: 'Asia/Tokyo' });
    const me = (await (await other.call('GET', '/me')).json()) as { user: { id: string; timezone: string } };
    expect(me.user).toMatchObject({ id: alice.id, timezone: 'UTC' });
  });
});

describe('unexpected errors', () => {
  it('answers 500 with a generic message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = await signIn(alice);
    const broken = createApi({
      repos: {
        ...repos,
        notes: {
          ...repos.notes,
          list: () => {
            throw new Error('connection to db.internal:5432 failed');
          },
        },
      },
      parse,
      secureCookies: true,
      now,
    });
    const response = await broken.request('/api/notes', { headers: { Cookie: client.cookie } });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(log).toHaveBeenCalled();
  });
});
