import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictError,
  createPgliteDatabase,
  createRepositories,
  migrate,
  type Database,
  type Repositories,
} from './index.ts';
import { migrations } from './schema.ts';

let db: Database;
let repos: Repositories;
let alice: string;
let bob: string;

beforeEach(async () => {
  db = createPgliteDatabase();
  await migrate(db);
  repos = createRepositories(db);
  alice = (await repos.users.upsertByTelegramId('1', 'Alice')).id;
  bob = (await repos.users.upsertByTelegramId('2', 'Bob')).id;
});

afterEach(() => db.close());

describe('notes', () => {
  it('keeps users apart', async () => {
    const note = await repos.notes.create(alice, { text: 'secret', source: 'web' });
    expect(await repos.notes.get(bob, note.id)).toBeNull();
    expect(await repos.notes.delete(bob, note.id)).toBe(false);
    expect((await repos.notes.list(bob, { q: 'secret' })).items).toEqual([]);
    expect(await repos.notes.update(bob, note.id, { text: 'x', tags: [] })).toBeNull();
  });

  it('pages through every note exactly once', async () => {
    for (let i = 0; i < 5; i++) await repos.notes.create(alice, { text: `n${i}`, source: 'web' });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await repos.notes.list(alice, { limit: 2, cursor });
      seen.push(...page.items.map((note) => note.text));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect([...seen].sort()).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
  });

  it('searches by prefix and filters by tag', async () => {
    await repos.notes.create(alice, { text: 'Buy élégant groceries', source: 'web', tags: ['home'] });
    await repos.notes.create(alice, { text: 'groceries elsewhere', source: 'web' });
    expect((await repos.notes.list(alice, { q: 'groc' })).items).toHaveLength(2);
    expect((await repos.notes.list(alice, { q: 'élég' })).items).toHaveLength(1);
    expect((await repos.notes.list(alice, { q: 'groc', tag: 'home' })).items).toHaveLength(1);
    expect((await repos.notes.list(alice, { q: '!!!' })).items).toEqual([]);
  });
});

describe('tags', () => {
  it('counts notes and refuses a name collision', async () => {
    await repos.notes.create(alice, { text: 'a', source: 'web', tags: ['x', 'y'] });
    const [x, y] = await repos.tags.list(alice);
    expect(x).toMatchObject({ name: 'x', noteCount: 1 });
    await expect(repos.tags.rename(alice, x!.id, 'y')).rejects.toBeInstanceOf(ConflictError);
    expect(await repos.tags.rename(bob, y!.id, 'z')).toBeNull();
  });
});

describe('lists', () => {
  it('appends to an existing list by name, ignoring case', async () => {
    await repos.lists.addItemsByName(alice, 'Groceries', ['milk']);
    const list = await repos.lists.addItemsByName(alice, 'groceries', ['eggs']);
    expect(list.items.map((item) => item.text)).toEqual(['milk', 'eggs']);
    expect(await repos.lists.setItemChecked(bob, list.items[0]!.id, true)).toBeNull();
    expect(await repos.lists.addItem(bob, list.id, 'x')).toBeNull();
  });
});

describe('reminders', () => {
  const at = (ms: number) => new Date(1_700_000_000_000 + ms);

  it('claims each due reminder only once and retries on failure', async () => {
    const reminder = await repos.reminders.create(alice, { noteId: null, text: 'call', remindAt: at(0) });
    expect(await repos.reminders.claimDue(at(-1), at(-1000), 10)).toEqual([]);
    expect(await repos.reminders.claimDue(at(1), at(-1000), 10)).toHaveLength(1);
    expect(await repos.reminders.claimDue(at(2), at(-1000), 10)).toEqual([]);
    await repos.reminders.markFailed(reminder.id, at(100));
    expect(await repos.reminders.claimDue(at(99), at(-1000), 10)).toEqual([]);
    const [again] = await repos.reminders.claimDue(at(100), at(-1000), 10);
    expect(again?.attempts).toBe(2);
  });

  it('never claims more than the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await repos.reminders.create(alice, { noteId: null, text: `r${i}`, remindAt: at(i) });
    }
    const first = await repos.reminders.claimDue(at(100), at(-1000), 2);
    expect(first.map((r) => r.text).sort()).toEqual(['r0', 'r1']);
    expect(first.every((r) => r.status === 'sending' && r.attempts === 1)).toBe(true);
    expect(await repos.reminders.claimDue(at(100), at(-1000), 2)).toHaveLength(2);
    expect(await repos.reminders.claimDue(at(100), at(-1000), 2)).toHaveLength(1);
  });

  it('runs the locking select once, as a materialized CTE rather than a rescannable subquery', async () => {
    const seen: string[] = [];
    const recording = createRepositories({
      ...db,
      query: async <T>(sql: string, params?: unknown[]) => {
        seen.push(sql);
        return db.query<T>(sql, params);
      },
    });
    await recording.reminders.claimDue(at(0), at(-1000), 2);
    expect(seen[0]).toMatch(/WITH due AS MATERIALIZED \(\s*SELECT id FROM reminders/u);
    expect(seen[0]).not.toMatch(/WHERE id IN/u);
  });

  it('does not link a reminder to a note of another user', async () => {
    const theirs = await repos.notes.create(bob, { text: 'bob note', source: 'web' });
    const mine = await repos.notes.create(alice, { text: 'alice note', source: 'web' });
    const foreign = await repos.reminders.create(alice, { noteId: theirs.id, text: 'x', remindAt: at(0) });
    expect(foreign.noteId).toBeNull();
    const own = await repos.reminders.create(alice, { noteId: mine.id, text: 'y', remindAt: at(0) });
    expect(own.noteId).toBe(mine.id);
  });

  it('takes over a stale claim', async () => {
    await repos.reminders.create(alice, { noteId: null, text: 'call', remindAt: at(0) });
    await repos.reminders.claimDue(at(1), at(-1000), 10);
    expect(await repos.reminders.claimDue(at(5000), at(2), 10)).toHaveLength(1);
  });

  it('cancels only pending reminders of the same user', async () => {
    const reminder = await repos.reminders.create(alice, { noteId: null, text: 'call', remindAt: at(0) });
    expect(await repos.reminders.cancel(bob, reminder.id)).toBe(false);
    expect(await repos.reminders.cancel(alice, reminder.id)).toBe(true);
    expect(await repos.reminders.listPending(alice)).toEqual([]);
  });
});

describe('auth', () => {
  it('allows a login token once and rejects it when expired', async () => {
    const now = new Date();
    await repos.auth.createLoginToken(alice, 'hash', new Date(now.getTime() + 1000));
    expect(await repos.auth.consumeLoginToken('hash', now)).toBe(alice);
    expect(await repos.auth.consumeLoginToken('hash', now)).toBeNull();
    await repos.auth.createLoginToken(alice, 'old', new Date(now.getTime() - 1));
    expect(await repos.auth.consumeLoginToken('old', now)).toBeNull();
  });
});

describe('tag rename race', () => {
  it('reports a name taken after the check as a conflict', async () => {
    const racing = createRepositories({
      ...db,
      query: async <T>(sql: string, params?: unknown[]) => {
        if (sql.includes('UPDATE tags')) throw Object.assign(new Error('duplicate key'), { code: '23505' });
        return db.query<T>(sql, params);
      },
    });
    await repos.notes.create(alice, { text: 'x', source: 'web', tags: ['a'] });
    const [tag] = await repos.tags.list(alice);
    await expect(racing.tags.rename(alice, tag!.id, 'b')).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('api tokens', () => {
  it('revokes only the tokens of the user who owns the name', async () => {
    await repos.auth.createApiToken(alice, 'a1', 'laptop');
    await repos.auth.createApiToken(alice, 'a2', 'laptop');
    await repos.auth.createApiToken(bob, 'b1', 'laptop');
    expect(await repos.auth.deleteApiTokens(alice, 'desktop')).toBe(0);
    expect(await repos.auth.deleteApiTokens(alice, 'laptop')).toBe(2);
    expect(await repos.auth.getUserIdByApiToken('a1')).toBeNull();
    expect(await repos.auth.getUserIdByApiToken('b1')).toBe(bob);
  });
});

describe('sessions', () => {
  it('reports the telegram id, for the allowlist check', async () => {
    const now = new Date();
    await repos.auth.createSession('s', alice, 'csrf', new Date(now.getTime() + 1000));
    expect(await repos.auth.getSession('s', now)).toEqual({ userId: alice, telegramId: '1', csrfToken: 'csrf' });
  });
});

describe('migrate', () => {
  it('leaves the schema as it was when a migration fails, and can run again', async () => {
    const fresh = createPgliteDatabase();
    migrations.push('CREATE TABLE half_done (id int); SELECT * FROM no_such_table');
    try {
      await expect(migrate(fresh)).rejects.toThrow();
      const { rows } = await fresh.query(`SELECT to_regclass('half_done') AS half, to_regclass('users') AS users`);
      expect(rows).toEqual([{ half: null, users: null }]);
    } finally {
      migrations.pop();
    }
    await migrate(fresh);
    const { rows } = await fresh.query<{ version: number }>('SELECT version FROM schema_migrations');
    expect(rows.map((row) => row.version)).toEqual([...migrations.keys()]);
    await fresh.close();
  });

  it('does nothing the second time', async () => {
    await expect(migrate(db)).resolves.toBeUndefined();
  });
});

describe('updates', () => {
  it('reports a redelivered update', async () => {
    expect(await repos.updates.markProcessed('telegram', '1')).toBe(true);
    expect(await repos.updates.markProcessed('telegram', '1')).toBe(false);
  });
});

describe('transaction', () => {
  it('rolls back the mark and the save together, so a retry can succeed', async () => {
    const save = (fail: boolean) =>
      repos.transaction(async (tx) => {
        if (!(await tx.updates.markProcessed('telegram', '9'))) return false;
        await tx.notes.create(alice, { text: 'kept', source: 'telegram' });
        if (fail) throw new Error('boom');
        return true;
      });

    await expect(save(true)).rejects.toThrow('boom');
    expect((await repos.notes.list(alice)).items).toEqual([]);
    expect(await save(false)).toBe(true);
    expect(await save(false)).toBe(false);
    expect((await repos.notes.list(alice)).items).toHaveLength(1);
  });
});
