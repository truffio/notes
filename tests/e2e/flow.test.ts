import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Channel, InboundHandler, LinkEnricher, List, Note, Page, Reminder, Tag } from '@notes/core';
import { createPgliteDatabase, createRepositories, migrate, type Database, type Repositories } from '@notes/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticate, createMcpServer } from '../../apps/mcp/src/server.ts';
import { createApp, type AppDeps } from '../../apps/server/src/app.ts';

const ALICE = '100';
const BOB = '200';
const STRANGER = '999';
const HOUR = 60 * 60 * 1000;

/** A class on purpose: `send` depends on `this`, as a real channel's might. */
class FakeChannel implements Channel {
  readonly name = 'fake';
  readonly sent: { recipientId: string; text: string }[] = [];

  async start(_handler: InboundHandler): Promise<void> {}
  async stop(): Promise<void> {}

  async send(recipientId: string, text: string): Promise<void> {
    this.sent.push({ recipientId, text });
  }
}

let db: Database;
let repos: Repositories;
let channel: FakeChannel;
let system: ReturnType<typeof createApp>;
let time: Date;
let nextUpdate: number;
let errors: unknown[];
const cleanups: (() => Promise<unknown>)[] = [];

const enrich: LinkEnricher = async (url) => ({ url, title: 'Oat guide', description: 'All about oats' });

function build(overrides: Partial<AppDeps> = {}) {
  return createApp({
    repos,
    channel,
    allowedSenderIds: new Set([ALICE, BOB]),
    baseUrl: 'https://notes.test',
    now: () => time,
    enrich,
    onError: (error) => errors.push(error),
    ...overrides,
  });
}

beforeEach(async () => {
  db = createPgliteDatabase();
  await migrate(db);
  repos = createRepositories(db);
  channel = new FakeChannel();
  time = new Date('2026-03-02T12:00:00.000Z');
  nextUpdate = 1;
  errors = [];
  system = build();
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await db.close();
  expect(errors).toEqual([]);
});

function say(senderId: string, text: string): Promise<string | null> {
  return system.handler({
    channel: 'telegram',
    updateId: String(nextUpdate++),
    senderId,
    senderName: `User ${senderId}`,
    text,
  });
}

const loginToken = (reply: string | null) => /\/login#token=([0-9a-f]{64})$/u.exec(reply ?? '')![1]!;
const loginBody = (token: string) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token }),
});

interface Browser {
  get<T>(path: string): Promise<T>;
  call(method: string, path: string, body?: unknown): Promise<Response>;
}

/** Signs in the way a person does: `/login` in the chat, then the link in a browser. */
async function signIn(senderId: string): Promise<Browser> {
  const response = await system.app.request('/api/auth/login', loginBody(loginToken(await say(senderId, '/login'))));
  expect(response.status).toBe(200);
  const cookie = response.headers.get('Set-Cookie')!.split(';')[0]!;
  const me = await system.app.request('/api/me', { headers: { Cookie: cookie } });
  const { csrfToken } = (await me.json()) as { csrfToken: string };
  const call = (method: string, path: string, body?: unknown) =>
    Promise.resolve(
      system.app.request(`/api${path}`, {
        method,
        headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return {
    call,
    get: async <T>(path: string) => {
      const result = await call('GET', path);
      expect(result.status).toBe(200);
      return (await result.json()) as T;
    },
  };
}

async function mcpClient(userId: string): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ repos, userId }).connect(serverSide);
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  await client.connect(clientSide);
  cleanups.push(() => client.close());
  return client;
}

async function listen(app: { fetch: (request: Request) => Response | Promise<Response> }): Promise<string> {
  const server = await new Promise<ServerType>((resolve) => {
    const started: ServerType = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(started));
  });
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('message to note to search', () => {
  it('saves a tagged message and finds it from the web', async () => {
    expect(await say(ALICE, 'Compare oat milk brands #Shopping https://example.com/oats')).toBe('Saved. #shopping');

    const browser = await signIn(ALICE);
    const found = await browser.get<Page<Note>>('/notes?q=oat');
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({ source: 'telegram', tags: ['shopping'] });
    expect(found.items[0]!.text).toContain('Compare oat milk brands');

    expect((await browser.get<Page<Note>>('/notes?q=missing')).items).toEqual([]);
    expect((await browser.get<Page<Note>>('/notes?tag=shopping')).items).toHaveLength(1);
    expect((await browser.get<{ items: Tag[] }>('/tags')).items).toMatchObject([{ name: 'shopping', noteCount: 1 }]);

    await vi.waitFor(async () => {
      const [note] = (await browser.get<Page<Note>>('/notes')).items;
      expect(note!.links).toEqual([
        { url: 'https://example.com/oats', title: 'Oat guide', description: 'All about oats' },
      ]);
    });
  });
});

describe('reminders', () => {
  it('creates them from both syntaxes and delivers each at the right time', async () => {
    expect(await say(ALICE, 'remind me tomorrow at 9am to call Sam')).toMatch(/^Reminder set for/u);
    expect(await say(ALICE, '/remind in 2 hours to water the plants')).toMatch(/^Reminder set for/u);

    const browser = await signIn(ALICE);
    const pending = (await browser.get<{ items: Reminder[] }>('/reminders')).items;
    expect(pending.map((reminder) => [reminder.text, reminder.remindAt])).toEqual([
      ['water the plants', '2026-03-02T14:00:00.000Z'],
      ['call Sam', '2026-03-03T09:00:00.000Z'],
    ]);

    time = new Date('2026-03-02T13:59:59.000Z');
    expect(await system.worker.tick()).toBe(0);
    expect(channel.sent).toEqual([]);

    time = new Date('2026-03-02T14:00:00.000Z');
    expect(await system.worker.tick()).toBe(1);
    expect(channel.sent).toEqual([{ recipientId: ALICE, text: 'water the plants' }]);

    time = new Date('2026-03-03T09:00:00.000Z');
    expect(await system.worker.tick()).toBe(1);
    expect(channel.sent.at(-1)).toEqual({ recipientId: ALICE, text: 'call Sam' });

    time = new Date(time.getTime() + HOUR);
    expect(await system.worker.tick()).toBe(0);
    expect(channel.sent).toHaveLength(2);
    expect((await browser.get<{ items: Reminder[] }>('/reminders')).items).toEqual([]);
  });

  it('retries a failed delivery rather than losing it', async () => {
    await say(ALICE, '/remind in 1 hour to stretch');
    const send = vi.spyOn(channel, 'send').mockRejectedValueOnce(new Error('network down'));

    time = new Date(time.getTime() + HOUR);
    expect(await system.worker.tick()).toBe(0);
    expect(errors.splice(0)).toHaveLength(1);

    time = new Date(time.getTime() + HOUR);
    expect(await system.worker.tick()).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(channel.sent).toEqual([{ recipientId: ALICE, text: 'stretch' }]);
  });
});

describe('lists', () => {
  it('shows a list made in the chat through the API', async () => {
    expect(await say(ALICE, 'list groceries: milk, eggs')).toBe('Added 2 items to groceries.');
    const browser = await signIn(ALICE);
    const { items } = await browser.get<{ items: List[] }>('/lists');
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe('groceries');
    expect(items[0]!.items.map((item) => item.text)).toEqual(['milk', 'eggs']);
  });
});

describe('isolation', () => {
  it('shows a second user none of the first user data', async () => {
    await say(ALICE, 'private thought #secret');
    await say(ALICE, '/remind in 1 hour to do the private thing');
    await say(ALICE, 'list hidden: one, two');
    const alice = await signIn(ALICE);
    const noteId = (await alice.get<Page<Note>>('/notes?q=thought')).items[0]!.id;
    const tagId = (await alice.get<{ items: Tag[] }>('/tags')).items[0]!.id;
    const list = (await alice.get<{ items: List[] }>('/lists')).items[0]!;
    const reminderId = (await alice.get<{ items: Reminder[] }>('/reminders')).items[0]!.id;

    const bob = await signIn(BOB);
    expect((await bob.get<Page<Note>>('/notes')).items).toEqual([]);
    expect((await bob.get<Page<Note>>('/notes?q=private')).items).toEqual([]);
    expect((await bob.get<Page<Note>>('/notes?tag=secret')).items).toEqual([]);
    expect((await bob.get<{ items: Tag[] }>('/tags')).items).toEqual([]);
    expect((await bob.get<{ items: List[] }>('/lists')).items).toEqual([]);
    expect((await bob.get<{ items: Reminder[] }>('/reminders')).items).toEqual([]);

    const attempts: [string, string, unknown?][] = [
      ['PATCH', `/notes/${noteId}`, { text: 'mine now' }],
      ['DELETE', `/notes/${noteId}`],
      ['PATCH', `/tags/${tagId}`, { name: 'mine' }],
      ['DELETE', `/tags/${tagId}`],
      ['POST', `/lists/${list.id}/items`, { text: 'mine' }],
      ['DELETE', `/lists/${list.id}`],
      ['PATCH', `/list-items/${list.items[0]!.id}`, { checked: true }],
      ['DELETE', `/list-items/${list.items[0]!.id}`],
      ['DELETE', `/reminders/${reminderId}`],
    ];
    for (const [method, path, body] of attempts) {
      expect((await bob.call(method, path, body)).status, `${method} ${path}`).toBe(404);
    }

    // Two notes: a reminder also saves one.
    expect((await alice.get<Page<Note>>('/notes')).items).toHaveLength(2);
    expect((await alice.get<{ items: Tag[] }>('/tags')).items).toHaveLength(1);
    expect((await alice.get<{ items: List[] }>('/lists')).items[0]!.items).toHaveLength(2);
    expect((await alice.get<{ items: Reminder[] }>('/reminders')).items).toHaveLength(1);
  });

  it('refuses a sender outside the allowlist and stores nothing', async () => {
    for (const text of ['hello', '/login', '/mcptoken laptop', 'remind me tomorrow to call', 'list a: b']) {
      expect(await say(STRANGER, text)).toBe('Sorry, this bot is private.');
    }
    const { rows } = await db.query<{ telegram_id: string }>('SELECT telegram_id FROM users');
    expect(rows).toEqual([]);
    const { rows: notes } = await db.query('SELECT id FROM notes');
    expect(notes).toEqual([]);
  });

  it('ends a session when its user leaves the allowlist', async () => {
    const browser = await signIn(ALICE);
    system = build({ allowedSenderIds: new Set([BOB]) });
    expect((await browser.call('GET', '/me')).status).toBe(401);
  });
});

describe('MCP token', () => {
  async function createToken(sender: string, name: string): Promise<string> {
    const reply = await say(sender, `/mcptoken ${name}`);
    return /\n([0-9a-f]{64})$/u.exec(reply!)![1]!;
  }

  it('is accepted by the hashing apps/mcp uses and reads only its owner data', async () => {
    await say(ALICE, 'mcp visible note');
    await say(BOB, 'bob note visible to bob');
    const userId = await authenticate(repos, await createToken(ALICE, 'laptop'));
    const alice = await repos.users.upsertByTelegramId(ALICE, 'Alice');
    expect(userId).toBe(alice.id);
    expect(await authenticate(repos, 'not-a-token')).toBeNull();

    const client = await mcpClient(userId!);
    const result = await client.callTool({ name: 'search_notes', arguments: { query: 'visible' } });
    const notes = JSON.parse((result.content as { text: string }[])[0]!.text) as Note[];
    expect(notes.map((note) => note.text)).toEqual(['mcp visible note']);
  });

  it('stops working once revoked, and only by its owner', async () => {
    const token = await createToken(ALICE, 'laptop');
    expect(await say(BOB, '/mcprevoke laptop')).toBe('There is no MCP token named "laptop".');
    expect(await authenticate(repos, token)).not.toBeNull();
    expect(await say(ALICE, '/mcprevoke laptop')).toMatch(/^Revoked the token/u);
    expect(await authenticate(repos, token)).toBeNull();
  });
});

describe('real HTTP server', () => {
  it('rate limits login by socket address without crashing', async () => {
    const url = await listen(system.app);

    const signedIn = await fetch(`${url}/api/auth/login`, loginBody(loginToken(await say(ALICE, '/login'))));
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get('Set-Cookie')).toMatch(/HttpOnly/iu);

    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      statuses.push((await fetch(`${url}/api/auth/login`, loginBody('wrong'))).status);
    }
    expect(statuses.slice(0, 9)).toEqual(Array<number>(9).fill(401));
    expect(statuses[9]).toBe(429);
  });

  describe('static hosting', () => {
    let webRoot: string;
    let parent: string;

    beforeEach(async () => {
      parent = await mkdtemp(join(tmpdir(), 'notes-e2e-'));
      cleanups.push(() => rm(parent, { recursive: true, force: true }));
      webRoot = join(parent, 'dist');
      await mkdir(join(webRoot, 'assets'), { recursive: true });
      await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Shell</title>');
      await writeFile(join(webRoot, 'assets', 'app.js'), 'console.log("app")');
      await writeFile(join(parent, 'secret.txt'), 'outside the web root');
      system = build({ webRoot });
    });

    it('serves the app shell for client routes and files as themselves', async () => {
      const url = await listen(system.app);
      for (const path of ['/', '/login', '/tags', '/lists']) {
        const response = await fetch(`${url}${path}`);
        expect(response.status, path).toBe(200);
        expect(response.headers.get('Content-Type'), path).toMatch(/text\/html/u);
        expect(await response.text(), path).toContain('<title>Shell</title>');
      }
      expect(await (await fetch(`${url}/assets/app.js`)).text()).toBe('console.log("app")');
    });

    it('never serves the shell for /api paths', async () => {
      const url = await listen(system.app);
      const signedIn = await fetch(`${url}/api/auth/login`, loginBody(loginToken(await say(ALICE, '/login'))));
      const cookie = signedIn.headers.get('Set-Cookie')!.split(';')[0]!;

      for (const path of ['/api', '/api/', '/api/nothing', '/api/notes/a/b/c', '/api/index.html']) {
        const anonymous = await fetch(`${url}${path}`);
        expect(anonymous.status, path).toBe(401);
        expect(await anonymous.text(), path).not.toContain('Shell');

        const known = await fetch(`${url}${path}`, { headers: { Cookie: cookie } });
        expect(known.status, path).toBe(404);
        expect(await known.json(), path).toEqual({ error: 'Not found' });
      }
    });

    it('does not read outside the web root', async () => {
      const url = await listen(system.app);
      for (const path of ['/..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/assets/..%2f..%2fsecret.txt']) {
        expect(await (await fetch(`${url}${path}`)).text(), path).not.toContain('outside the web root');
      }
    });

    it('sets security headers on pages, API responses and errors', async () => {
      const url = await listen(system.app);
      for (const path of ['/login', '/api/me']) {
        const { headers } = await fetch(`${url}${path}`);
        const policy = headers.get('Content-Security-Policy') ?? '';
        expect(policy, path).toContain("default-src 'self'");
        expect(policy, path).toContain("frame-ancestors 'none'");
        expect(policy, path).not.toContain('unsafe');
        expect(headers.get('X-Frame-Options'), path).toBe('DENY');
        expect(headers.get('X-Content-Type-Options'), path).toBe('nosniff');
        expect(headers.get('Referrer-Policy'), path).toBe('no-referrer');
      }
      expect((await fetch(`${url}/api/me`)).headers.get('Cache-Control')).toBe('no-store');
    });
  });
});

describe('Telegram webhook route', () => {
  const body = { method: 'POST', body: '{}' };

  it('does not exist when polling', async () => {
    expect((await system.app.request('/telegram/webhook', body)).status).toBe(404);
  });

  it('exists in webhook mode, and a failure there reaches onError without detail', async () => {
    system = build({
      webhook: {
        path: '/telegram/webhook',
        callback: async () => {
          throw new Error('https://api.telegram.org/bot123:abc/sendMessage failed');
        },
      },
    });
    const response = await system.app.request('/telegram/webhook', body);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(errors.splice(0)).toHaveLength(1);
  });
});
