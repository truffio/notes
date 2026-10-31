import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPgliteDatabase, createRepositories, migrate, type Database, type Repositories } from '@notes/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpServer } from './server.ts';

let db: Database;
let repos: Repositories;
let alice: string;
let bob: string;
const clients: Client[] = [];

async function connect(userId: string): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ repos, userId }).connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0]!.text;
  return { isError: result.isError === true, text };
}

beforeEach(async () => {
  db = createPgliteDatabase();
  await migrate(db);
  repos = createRepositories(db);
  alice = (await repos.users.upsertByTelegramId('1', 'Alice')).id;
  bob = (await repos.users.upsertByTelegramId('2', 'Bob')).id;
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await db.close();
});

describe('tool list', () => {
  it('exposes exactly the read-only tools', async () => {
    const { tools } = await (await connect(alice)).listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'get_note',
      'list_recent_notes',
      'list_tags',
      'search_notes',
    ]);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it('does not accept a user id as input', async () => {
    const { tools } = await (await connect(alice)).listTools();
    for (const tool of tools) expect(JSON.stringify(tool.inputSchema)).not.toMatch(/user/i);
  });
});

describe('tools', () => {
  it('searches, filters by tag and limits', async () => {
    await repos.notes.create(alice, { text: 'buy milk', source: 'web', tags: ['shop'] });
    await repos.notes.create(alice, { text: 'milk the idea', source: 'web' });
    const client = await connect(alice);
    expect(JSON.parse((await call(client, 'search_notes', { query: 'milk' })).text)).toHaveLength(2);
    const tagged = JSON.parse((await call(client, 'search_notes', { query: 'milk', tag: 'shop' })).text);
    expect(tagged.map((note: { text: string }) => note.text)).toEqual(['buy milk']);
    expect(JSON.parse((await call(client, 'search_notes', { query: 'milk', limit: 1 })).text)).toHaveLength(1);
  });

  it('gets a note and reports a missing one', async () => {
    const note = await repos.notes.create(alice, { text: 'hello', source: 'web' });
    const client = await connect(alice);
    expect(JSON.parse((await call(client, 'get_note', { id: note.id })).text).text).toBe('hello');
    const missing = await call(client, 'get_note', { id: '00000000-0000-4000-8000-000000000000' });
    expect(missing.isError).toBe(true);
  });

  it('returns a tool error for an invalid id', async () => {
    const result = await call(await connect(alice), 'get_note', { id: 'not-a-uuid' });
    expect(result).toEqual({ isError: true, text: 'Invalid note id' });
  });

  it('lists tags and recent notes newest first', async () => {
    await repos.notes.create(alice, { text: 'first', source: 'web', tags: ['a'] });
    await repos.notes.create(alice, { text: 'second', source: 'web', tags: ['a', 'b'] });
    const client = await connect(alice);
    const tags = JSON.parse((await call(client, 'list_tags')).text);
    expect(tags.map((tag: { name: string; noteCount: number }) => [tag.name, tag.noteCount])).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
    const recent = JSON.parse((await call(client, 'list_recent_notes', { limit: 1 })).text);
    expect(recent.map((note: { text: string }) => note.text)).toEqual(['second']);
  });
});

describe('user isolation', () => {
  it('never shows one user the notes or tags of another', async () => {
    const secret = await repos.notes.create(alice, { text: 'alice secret', source: 'web', tags: ['private'] });
    const mine = await repos.notes.create(bob, { text: 'bob public', source: 'web', tags: ['open'] });
    const client = await connect(bob);

    expect(JSON.parse((await call(client, 'search_notes', { query: 'secret' })).text)).toEqual([]);
    expect(JSON.parse((await call(client, 'search_notes', { query: 'secret', tag: 'private' })).text)).toEqual([]);
    expect((await call(client, 'get_note', { id: secret.id })).isError).toBe(true);
    expect((await call(client, 'get_note', { id: mine.id })).isError).toBe(false);
    expect(JSON.parse((await call(client, 'list_tags')).text).map((tag: { name: string }) => tag.name)).toEqual([
      'open',
    ]);
    const recent = JSON.parse((await call(client, 'list_recent_notes')).text);
    expect(recent.map((note: { id: string }) => note.id)).toEqual([mine.id]);
  });

  it('ignores a smuggled user id argument', async () => {
    await repos.notes.create(alice, { text: 'alice secret', source: 'web' });
    const client = await connect(bob);
    const result = await call(client, 'list_recent_notes', { userId: alice });
    expect(JSON.parse(result.text)).toEqual([]);
  });
});
