import type { LinkPreview, List, ListItem, Note, Page, Reminder, ReminderStatus, Source, Tag, User } from '@notes/core';
import type { Database, Queryable } from './client.ts';

/** Raised when a rename collides with an existing name. */
export class ConflictError extends Error {}

const MAX_PAGE = 100;

const iso = (value: Date | string) => new Date(value).toISOString();

interface UserRow {
  id: string;
  telegram_id: string;
  display_name: string;
  timezone: string;
  created_at: Date | string;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  telegramId: row.telegram_id,
  displayName: row.display_name,
  timezone: row.timezone,
  createdAt: iso(row.created_at),
});

interface NoteRow {
  id: string;
  text: string;
  source: Source;
  links: LinkPreview[] | string;
  tags: string[] | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const toNote = (row: NoteRow): Note => ({
  id: row.id,
  text: row.text,
  source: row.source,
  tags: row.tags ?? [],
  links: typeof row.links === 'string' ? (JSON.parse(row.links) as LinkPreview[]) : row.links,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const NOTE_COLUMNS = `n.id, n.text, n.source, n.links, n.created_at, n.updated_at,
  (SELECT array_agg(t.name ORDER BY t.name) FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id) AS tags`;

interface ReminderRow {
  id: string;
  user_id: string;
  note_id: string | null;
  text: string;
  remind_at: Date | string;
  status: ReminderStatus;
  attempts: number;
}

const toReminder = (row: ReminderRow): Reminder => ({
  id: row.id,
  userId: row.user_id,
  noteId: row.note_id,
  text: row.text,
  remindAt: iso(row.remind_at),
  status: row.status,
  attempts: row.attempts,
});

interface ItemRow {
  id: string;
  text: string;
  checked: boolean;
}

const toItem = (row: ItemRow): ListItem => ({ id: row.id, text: row.text, checked: row.checked });

/** Turns user input into a prefix query, so results appear while typing. */
function toPrefixQuery(q: string): string | null {
  const words = q.match(/[\p{L}\p{N}_]+/gu);
  return words ? words.map((word) => `${word}:*`).join(' & ') : null;
}

export function encodeCursor(note: Pick<Note, 'createdAt' | 'id'>): string {
  return `${note.createdAt}|${note.id}`;
}

function decodeCursor(cursor: string): [string, string] | null {
  const [createdAt, id] = cursor.split('|');
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) return null;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return [createdAt, id];
}

export interface ListNotesOptions {
  cursor?: string;
  limit?: number;
  tag?: string;
  q?: string;
}

function createStores(db: Queryable) {
  async function setNoteTags(userId: string, noteId: string, tags: string[]) {
    await db.query('DELETE FROM note_tags WHERE note_id = $1', [noteId]);
    for (const name of new Set(tags)) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO tags (user_id, name) VALUES ($1, $2)
         ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [userId, name],
      );
      await db.query('INSERT INTO note_tags (note_id, tag_id) VALUES ($1, $2)', [noteId, rows[0]!.id]);
    }
  }

  const notes = {
    async get(userId: string, id: string): Promise<Note | null> {
      const { rows } = await db.query<NoteRow>(
        `SELECT ${NOTE_COLUMNS} FROM notes n WHERE n.user_id = $1 AND n.id = $2`,
        [userId, id],
      );
      return rows[0] ? toNote(rows[0]) : null;
    },

    async create(
      userId: string,
      input: { text: string; source: Source; tags?: string[]; links?: LinkPreview[] },
    ): Promise<Note> {
      const { rows } = await db.query<{ id: string }>(
        'INSERT INTO notes (user_id, text, source, links) VALUES ($1, $2, $3, $4) RETURNING id',
        [userId, input.text, input.source, JSON.stringify(input.links ?? [])],
      );
      const id = rows[0]!.id;
      await setNoteTags(userId, id, input.tags ?? []);
      return (await notes.get(userId, id))!;
    },

    async list(userId: string, options: ListNotesOptions = {}): Promise<Page<Note>> {
      const limit = Math.min(Math.max(options.limit ?? 30, 1), MAX_PAGE);
      const params: unknown[] = [userId];
      const where = ['n.user_id = $1'];
      if (options.tag) {
        params.push(options.tag);
        where.push(`EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
          WHERE nt.note_id = n.id AND t.name = $${params.length})`);
      }
      if (options.q !== undefined) {
        const query = toPrefixQuery(options.q);
        if (!query) return { items: [], nextCursor: null };
        params.push(query);
        where.push(`n.search @@ to_tsquery('simple', $${params.length})`);
      }
      if (options.cursor) {
        const cursor = decodeCursor(options.cursor);
        if (!cursor) return { items: [], nextCursor: null };
        params.push(cursor[0], cursor[1]);
        where.push(`(n.created_at, n.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }
      params.push(limit + 1);
      const { rows } = await db.query<NoteRow>(
        `SELECT ${NOTE_COLUMNS} FROM notes n WHERE ${where.join(' AND ')}
         ORDER BY n.created_at DESC, n.id DESC LIMIT $${params.length}`,
        params,
      );
      const items = rows.slice(0, limit).map(toNote);
      const last = items.at(-1);
      return { items, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
    },

    async update(userId: string, id: string, input: { text: string; tags: string[] }): Promise<Note | null> {
      const { rows } = await db.query<{ id: string }>(
        `UPDATE notes SET text = $3, updated_at = date_trunc('milliseconds', now())
         WHERE user_id = $1 AND id = $2 RETURNING id`,
        [userId, id, input.text],
      );
      if (!rows[0]) return null;
      await setNoteTags(userId, id, input.tags);
      return notes.get(userId, id);
    },

    async setLinks(userId: string, id: string, links: LinkPreview[]): Promise<void> {
      await db.query('UPDATE notes SET links = $3 WHERE user_id = $1 AND id = $2', [
        userId,
        id,
        JSON.stringify(links),
      ]);
    },

    async delete(userId: string, id: string): Promise<boolean> {
      const { rows } = await db.query('DELETE FROM notes WHERE user_id = $1 AND id = $2 RETURNING id', [userId, id]);
      return rows.length > 0;
    },
  };

  const TAG_COUNT = '(SELECT count(*)::int FROM note_tags nt WHERE nt.tag_id = t.id)';

  const tags = {
    async list(userId: string): Promise<Tag[]> {
      const { rows } = await db.query<{ id: string; name: string; note_count: number }>(
        `SELECT t.id, t.name, ${TAG_COUNT} AS note_count FROM tags t WHERE t.user_id = $1 ORDER BY t.name`,
        [userId],
      );
      return rows.map((row) => ({ id: row.id, name: row.name, noteCount: row.note_count }));
    },

    async rename(userId: string, id: string, name: string): Promise<Tag | null> {
      const { rows: taken } = await db.query(
        'SELECT 1 FROM tags WHERE user_id = $1 AND name = $2 AND id <> $3',
        [userId, name, id],
      );
      if (taken.length > 0) throw new ConflictError(`Tag "${name}" already exists`);
      const { rows } = await db.query<{ id: string; name: string; note_count: number }>(
        `UPDATE tags t SET name = $3 WHERE t.user_id = $1 AND t.id = $2
         RETURNING t.id, t.name, ${TAG_COUNT} AS note_count`,
        [userId, id, name],
      );
      return rows[0] ? { id: rows[0].id, name: rows[0].name, noteCount: rows[0].note_count } : null;
    },

    async delete(userId: string, id: string): Promise<boolean> {
      const { rows } = await db.query('DELETE FROM tags WHERE user_id = $1 AND id = $2 RETURNING id', [userId, id]);
      return rows.length > 0;
    },
  };

  const lists = {
    async all(userId: string): Promise<List[]> {
      const { rows: listRows } = await db.query<{ id: string; name: string }>(
        'SELECT id, name FROM lists WHERE user_id = $1 ORDER BY name',
        [userId],
      );
      const { rows: itemRows } = await db.query<ItemRow & { list_id: string }>(
        `SELECT i.id, i.list_id, i.text, i.checked FROM list_items i
         JOIN lists l ON l.id = i.list_id WHERE l.user_id = $1 ORDER BY i.position`,
        [userId],
      );
      return listRows.map((list) => ({
        id: list.id,
        name: list.name,
        items: itemRows.filter((item) => item.list_id === list.id).map(toItem),
      }));
    },

    /** Creates the list if needed. Names compare in lower case. */
    async addItemsByName(userId: string, name: string, items: string[]): Promise<List> {
      const normalized = name.trim().toLowerCase();
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO lists (user_id, name) VALUES ($1, $2)
         ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [userId, normalized],
      );
      const id = rows[0]!.id;
      for (const text of items) {
        await db.query('INSERT INTO list_items (list_id, text) VALUES ($1, $2)', [id, text]);
      }
      return (await lists.all(userId)).find((list) => list.id === id)!;
    },

    async addItem(userId: string, listId: string, text: string): Promise<ListItem | null> {
      const { rows } = await db.query<ItemRow>(
        `INSERT INTO list_items (list_id, text)
         SELECT id, $3 FROM lists WHERE user_id = $1 AND id = $2 RETURNING id, text, checked`,
        [userId, listId, text],
      );
      return rows[0] ? toItem(rows[0]) : null;
    },

    async setItemChecked(userId: string, itemId: string, checked: boolean): Promise<ListItem | null> {
      const { rows } = await db.query<ItemRow>(
        `UPDATE list_items i SET checked = $3 FROM lists l
         WHERE l.id = i.list_id AND l.user_id = $1 AND i.id = $2 RETURNING i.id, i.text, i.checked`,
        [userId, itemId, checked],
      );
      return rows[0] ? toItem(rows[0]) : null;
    },

    async deleteItem(userId: string, itemId: string): Promise<boolean> {
      const { rows } = await db.query(
        `DELETE FROM list_items i USING lists l
         WHERE l.id = i.list_id AND l.user_id = $1 AND i.id = $2 RETURNING i.id`,
        [userId, itemId],
      );
      return rows.length > 0;
    },

    async delete(userId: string, id: string): Promise<boolean> {
      const { rows } = await db.query('DELETE FROM lists WHERE user_id = $1 AND id = $2 RETURNING id', [userId, id]);
      return rows.length > 0;
    },
  };

  const reminders = {
    async create(userId: string, input: { noteId: string | null; text: string; remindAt: Date }): Promise<Reminder> {
      const { rows } = await db.query<ReminderRow>(
        `INSERT INTO reminders (user_id, note_id, text, remind_at, next_attempt_at)
         VALUES ($1, $2, $3, $4, $4) RETURNING *`,
        [userId, input.noteId, input.text, input.remindAt.toISOString()],
      );
      return toReminder(rows[0]!);
    },

    async listPending(userId: string): Promise<Reminder[]> {
      const { rows } = await db.query<ReminderRow>(
        `SELECT * FROM reminders WHERE user_id = $1 AND status = 'pending' ORDER BY remind_at`,
        [userId],
      );
      return rows.map(toReminder);
    },

    async cancel(userId: string, id: string): Promise<boolean> {
      const { rows } = await db.query(
        `UPDATE reminders SET status = 'cancelled'
         WHERE user_id = $1 AND id = $2 AND status = 'pending' RETURNING id`,
        [userId, id],
      );
      return rows.length > 0;
    },

    /**
     * Atomically claims due reminders. A claim older than `staleBefore` is taken
     * over, so a crash mid-send cannot strand a reminder.
     */
    async claimDue(now: Date, staleBefore: Date, limit: number): Promise<Reminder[]> {
      const { rows } = await db.query<ReminderRow>(
        `UPDATE reminders SET status = 'sending', claimed_at = $1, attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM reminders
           WHERE (status = 'pending' AND next_attempt_at <= $1)
              OR (status = 'sending' AND claimed_at < $2)
           ORDER BY next_attempt_at LIMIT $3 FOR UPDATE SKIP LOCKED
         ) RETURNING *`,
        [now.toISOString(), staleBefore.toISOString(), limit],
      );
      return rows.map(toReminder);
    },

    async markSent(id: string): Promise<void> {
      await db.query(`UPDATE reminders SET status = 'sent' WHERE id = $1`, [id]);
    },

    /** Pass `nextAttemptAt` to retry, or null to give up. */
    async markFailed(id: string, nextAttemptAt: Date | null): Promise<void> {
      if (nextAttemptAt) {
        await db.query(`UPDATE reminders SET status = 'pending', next_attempt_at = $2 WHERE id = $1`, [
          id,
          nextAttemptAt.toISOString(),
        ]);
      } else {
        await db.query(`UPDATE reminders SET status = 'failed' WHERE id = $1`, [id]);
      }
    },
  };

  const users = {
    async upsertByTelegramId(telegramId: string, displayName: string): Promise<User> {
      const { rows } = await db.query<UserRow>(
        `INSERT INTO users (telegram_id, display_name) VALUES ($1, $2)
         ON CONFLICT (telegram_id) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING *`,
        [telegramId, displayName],
      );
      return toUser(rows[0]!);
    },

    async get(id: string): Promise<User | null> {
      const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
      return rows[0] ? toUser(rows[0]) : null;
    },

    async setTimezone(id: string, timezone: string): Promise<void> {
      await db.query('UPDATE users SET timezone = $2 WHERE id = $1', [id, timezone]);
    },
  };

  /** Callers pass SHA-256 hashes. Raw tokens are never stored. */
  const auth = {
    async createLoginToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
      await db.query('INSERT INTO login_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
        tokenHash,
        userId,
        expiresAt.toISOString(),
      ]);
    },

    /** Single use: a second call with the same token returns null. */
    async consumeLoginToken(tokenHash: string, now: Date): Promise<string | null> {
      const { rows } = await db.query<{ user_id: string }>(
        `UPDATE login_tokens SET used_at = $2
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING user_id`,
        [tokenHash, now.toISOString()],
      );
      return rows[0]?.user_id ?? null;
    },

    async createSession(tokenHash: string, userId: string, csrfToken: string, expiresAt: Date): Promise<void> {
      await db.query('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, $4)', [
        tokenHash,
        userId,
        csrfToken,
        expiresAt.toISOString(),
      ]);
    },

    async getSession(tokenHash: string, now: Date): Promise<{ userId: string; csrfToken: string } | null> {
      const { rows } = await db.query<{ user_id: string; csrf_token: string }>(
        'SELECT user_id, csrf_token FROM sessions WHERE token_hash = $1 AND expires_at > $2',
        [tokenHash, now.toISOString()],
      );
      return rows[0] ? { userId: rows[0].user_id, csrfToken: rows[0].csrf_token } : null;
    },

    async deleteSession(tokenHash: string): Promise<void> {
      await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    },

    async createApiToken(userId: string, tokenHash: string, name: string): Promise<void> {
      await db.query('INSERT INTO api_tokens (token_hash, user_id, name) VALUES ($1, $2, $3)', [
        tokenHash,
        userId,
        name,
      ]);
    },

    async getUserIdByApiToken(tokenHash: string): Promise<string | null> {
      const { rows } = await db.query<{ user_id: string }>(
        'UPDATE api_tokens SET last_used_at = now() WHERE token_hash = $1 RETURNING user_id',
        [tokenHash],
      );
      return rows[0]?.user_id ?? null;
    },
  };

  const updates = {
    /** Returns false if this update was already handled. */
    async markProcessed(channel: string, updateId: string): Promise<boolean> {
      const { rows } = await db.query(
        `INSERT INTO processed_updates (channel, update_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING update_id`,
        [channel, updateId],
      );
      return rows.length > 0;
    },
  };

  return { users, notes, tags, lists, reminders, auth, updates };
}

export type Stores = ReturnType<typeof createStores>;

export function createRepositories(db: Database) {
  return {
    ...createStores(db),
    /** Runs `fn` atomically. Inside it, use only the stores it receives. */
    transaction: <T>(fn: (stores: Stores) => Promise<T>) => db.transaction((tx) => fn(createStores(tx))),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
