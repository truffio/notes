import type { InboundMessage, MessageParser, ReminderTimeParser } from '@notes/core';
import { createPgliteDatabase, createRepositories, migrate, type Database, type Repositories } from '@notes/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCaptureHandler } from './handler.ts';

let db: Database;
let repos: Repositories;

beforeEach(async () => {
  db = createPgliteDatabase();
  await migrate(db);
  repos = createRepositories(db);
});

afterEach(() => db.close());

const parse: MessageParser = (input) => {
  const tags = [...input.matchAll(/#(\w+)/g)].map((m) => m[1]!);
  const urls = input.match(/https?:\/\/\S+/g) ?? [];
  const list = /^(\w+): (.+,.+)$/.exec(input);
  return {
    text: input.replace(/\s*#\w+/g, '').trim(),
    tags,
    urls,
    list: list ? { name: list[1]!, items: list[2]!.split(',').map((i) => i.trim()) } : null,
  };
};

const parseTime: ReminderTimeParser = (input) =>
  input.startsWith('remind ') ? { remindAt: new Date('2030-01-01T12:00:00Z'), text: input.slice(7) } : null;

let counter = 0;
const msg = (text: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: 'telegram',
  updateId: String(++counter),
  senderId: '1',
  senderName: 'Alice',
  text,
  ...extra,
});

function make(overrides: Partial<Parameters<typeof createCaptureHandler>[0]> = {}) {
  return createCaptureHandler({
    repos,
    allowedSenderIds: new Set(['1']),
    commands: { ping: async ({ args }) => `pong ${args}` },
    parse,
    parseTime,
    enrich: async (url) => ({ url, title: 'Title', description: null, image: null }),
    ...overrides,
  });
}

const userId = async () => (await repos.users.upsertByTelegramId('1', 'Alice')).id;
const allNotes = async () => (await repos.notes.list(await userId())).items;

describe('capture handler', () => {
  it('refuses senders outside the allowlist without creating a user', async () => {
    const reply = await make()(msg('hi', { senderId: '99' }));
    expect(reply).toMatch(/private/i);
    const { rows } = await db.query('SELECT 1 FROM users');
    expect(rows).toEqual([]);
  });

  it('saves a note with tags and confirms in one line', async () => {
    const reply = await make()(msg('buy milk #home'));
    expect(reply).toBe('Saved. #home');
    const [note] = await allNotes();
    expect(note).toMatchObject({ text: 'buy milk', tags: ['home'], source: 'telegram' });
  });

  it('dispatches commands and answers unknown ones', async () => {
    const handler = make();
    expect(await handler(msg('/ping  a b'))).toBe('pong a b');
    expect(await handler(msg('/nope'))).toMatch(/unknown command/i);
    expect(await allNotes()).toEqual([]);
  });

  it('ignores a redelivered command', async () => {
    const handler = make();
    const message = msg('/ping x');
    expect(await handler(message)).toBe('pong x');
    expect(await handler(message)).toBeNull();
  });

  it('saves a reminder with its note and confirms in the user timezone', async () => {
    const user = await repos.users.upsertByTelegramId('1', 'Alice');
    await repos.users.setTimezone(user.id, 'Asia/Tokyo');
    const reply = await make()(msg('remind call mom'));
    expect(reply).toContain('1 Jan 2030');
    expect(reply).toContain('21:00');
    const pending = await repos.reminders.listPending(user.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ text: 'call mom', remindAt: '2030-01-01T12:00:00.000Z' });
    expect(pending[0]!.noteId).not.toBeNull();
  });

  it('adds list items by name', async () => {
    const reply = await make()(msg('groceries: eggs, bread'));
    expect(reply).toBe('Added 2 items to groceries.');
    const lists = await repos.lists.all(await userId());
    expect(lists[0]!.items.map((i) => i.text)).toEqual(['eggs', 'bread']);
  });

  it('saves the raw text when a parser throws', async () => {
    const onError = vi.fn();
    const handler = make({
      parse: () => {
        throw new Error('parse boom');
      },
      parseTime: () => {
        throw new Error('time boom');
      },
      onError,
    });
    expect(await handler(msg('raw #text'))).toBe('Saved.');
    expect((await allNotes())[0]!.text).toBe('raw #text');
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('stores link previews in the background', async () => {
    await make()(msg('see https://example.com'));
    await vi.waitFor(async () => expect((await allNotes())[0]!.links).toHaveLength(1));
  });

  it('keeps the note when enrichment fails', async () => {
    const onError = vi.fn();
    await make({
      enrich: async () => {
        throw new Error('network');
      },
      onError,
    })(msg('see https://example.com'));
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    const notes = await allNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.links).toEqual([]);
  });

  describe('idempotency', () => {
    it('a failed save rolls back the mark, so a redelivery saves exactly one note', async () => {
      let failures = 1;
      const flaky: Repositories = {
        ...repos,
        transaction: (fn) =>
          repos.transaction((tx) =>
            fn({
              ...tx,
              notes: {
                ...tx.notes,
                create: async (...args) => {
                  if (failures-- > 0) throw new Error('db down');
                  return tx.notes.create(...args);
                },
              },
            }),
          ),
      };
      const handler = make({ repos: flaky });
      const message = msg('important');
      await expect(handler(message)).rejects.toThrow('db down');
      expect(await allNotes()).toEqual([]);
      expect(await handler(message)).toBe('Saved.');
      expect(await handler(message)).toBeNull();
      expect(await allNotes()).toHaveLength(1);
    });

    it('a normal redelivery adds no second note, reminder or list item', async () => {
      const handler = make();
      const note = msg('plain');
      const reminder = msg('remind x');
      const list = msg('shop: a, b');
      for (const message of [note, reminder, list]) {
        expect(await handler(message)).not.toBeNull();
        expect(await handler(message)).toBeNull();
      }
      const id = await userId();
      expect(await allNotes()).toHaveLength(2);
      expect(await repos.reminders.listPending(id)).toHaveLength(1);
      expect((await repos.lists.all(id))[0]!.items).toHaveLength(2);
    });

    it('concurrent duplicates save once', async () => {
      const handler = make();
      const message = msg('twice');
      const replies = await Promise.all([handler(message), handler(message)]);
      expect(replies.filter((r) => r !== null)).toHaveLength(1);
      expect(await allNotes()).toHaveLength(1);
    });
  });
});
