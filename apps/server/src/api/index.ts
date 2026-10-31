import { getConnInfo } from '@hono/node-server/conninfo';
import type { Api, LinkEnricher, MessageParser, MeResponse, User } from '@notes/core';
import { ConflictError, type Repositories } from '@notes/db';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { generateToken, hashToken, tokensMatch } from '../auth/tokens.ts';
import { MAX_ENRICHED_URLS } from '../enrich/index.ts';
import { createRateLimiter } from './rateLimit.ts';
import {
  ApiError,
  MAX_TAG_LENGTH,
  parseChecked,
  parseListNotesQuery,
  parseTagName,
  parseText,
  parseTimezone,
  parseUuid,
  readBody,
} from './validate.ts';

const SESSION_COOKIE = 'session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_ATTEMPTS_PER_WINDOW = 10;
const LOGIN_WINDOW_MS = 60 * 1000;
/** Fits the longest allowed text with every character escaped as JSON. */
const MAX_BODY_BYTES = 128 * 1024;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ApiDeps {
  repos: Repositories;
  /** Checked on every request, so removing someone also ends their sessions. */
  allowedSenderIds: Set<string>;
  parse: MessageParser;
  secureCookies: boolean;
  /** Fills link previews in the background. Without it, web notes have none. */
  enrich?: LinkEnricher;
  now?: () => Date;
}

interface AppEnv {
  Variables: { session: { userId: string; csrfToken: string; tokenHash: string } };
}

const notFound = () => new ApiError(404, 'Not found');

/**
 * The socket's peer address. X-Forwarded-For is ignored because a client can
 * set it to anything, which would make the limit trivial to dodge.
 */
function clientAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const toMe = (user: User, csrfToken: string): MeResponse => ({
  user: { id: user.id, displayName: user.displayName, timezone: user.timezone },
  csrfToken,
});

export function createApi(deps: ApiDeps): Hono {
  const { repos, allowedSenderIds, parse, secureCookies } = deps;
  const now = deps.now ?? (() => new Date());
  const loginLimiter = createRateLimiter(LOGIN_ATTEMPTS_PER_WINDOW, LOGIN_WINDOW_MS);
  const cookieOptions = { httpOnly: true, sameSite: 'Lax', path: '/', secure: secureCookies } as const;
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.message }, err.status);
    if (err instanceof ConflictError) return c.json({ error: 'That name is already taken' }, 409);
    console.error('Unhandled API error', err);
    return c.json({ error: 'Internal server error' }, 500);
  });
  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  // Notes must not linger in a browser or proxy cache after logout.
  app.use(
    '/api/*',
    createMiddleware<AppEnv>(async (c, next) => {
      await next();
      c.header('Cache-Control', 'no-store');
    }),
  );

  app.use(
    '/api/*',
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'Request body too large' }, 413) }),
  );

  // Registered ahead of the session and CSRF middleware, so it is the only public route.
  app.post('/api/auth/login', async (c) => {
    const retryAfter = loginLimiter.hit(clientAddress(c), now().getTime());
    if (retryAfter !== null) {
      return c.json({ error: 'Too many attempts' }, 429, { 'Retry-After': String(retryAfter) });
    }
    const { token } = await readBody(c);
    if (typeof token !== 'string' || token === '') throw new ApiError(400, 'Invalid token');

    const time = now();
    const userId = await repos.auth.consumeLoginToken(hashToken(token), time);
    if (!userId) throw new ApiError(401, 'This login link is invalid or has expired');

    const sessionToken = generateToken();
    const expiresAt = new Date(time.getTime() + SESSION_TTL_SECONDS * 1000);
    await repos.auth.createSession(hashToken(sessionToken), userId, generateToken(), expiresAt);
    setCookie(c, SESSION_COOKIE, sessionToken, { ...cookieOptions, maxAge: SESSION_TTL_SECONDS });
    return c.json<Api['login']['response']>({ ok: true });
  });

  app.use(
    '/api/*',
    createMiddleware<AppEnv>(async (c, next) => {
      const token = getCookie(c, SESSION_COOKIE);
      if (!token) throw new ApiError(401, 'Not signed in');
      const tokenHash = hashToken(token);
      const session = await repos.auth.getSession(tokenHash, now());
      if (!session || !allowedSenderIds.has(session.telegramId)) throw new ApiError(401, 'Not signed in');
      c.set('session', { ...session, tokenHash });
      await next();
    }),
  );

  app.use(
    '/api/*',
    createMiddleware<AppEnv>(async (c, next) => {
      if (!SAFE_METHODS.has(c.req.method)) {
        const header = c.req.header('X-CSRF-Token') ?? '';
        if (!tokensMatch(header, c.get('session').csrfToken)) throw new ApiError(403, 'Invalid CSRF token');
      }
      await next();
    }),
  );

  /**
   * Never loses a message: if the parser throws, the note keeps its raw text.
   * Parsed tags are checked here because the parser puts no limit on their length.
   */
  function parseNote(input: string): { text: string; tags: string[]; urls: string[] } {
    let parsed: { text: string; tags: string[]; urls: string[] };
    try {
      parsed = parse(input);
    } catch (err) {
      console.error('Message parser failed', err);
      return { text: input, tags: [], urls: [] };
    }
    if (parsed.tags.some((tag) => tag.length > MAX_TAG_LENGTH)) {
      throw new ApiError(400, `Tag names are limited to ${MAX_TAG_LENGTH} characters`);
    }
    return { text: parsed.text || input, tags: parsed.tags, urls: parsed.urls };
  }

  /** Runs after the response. A failure here leaves the saved note untouched. */
  function enrichInBackground(userId: string, noteId: string, urls: string[]): void {
    const { enrich } = deps;
    if (!enrich || urls.length === 0) return;
    void Promise.all(urls.slice(0, MAX_ENRICHED_URLS).map((url) => enrich(url).catch(() => null)))
      .then((links) => {
        const found = links.filter((link) => link !== null);
        return found.length > 0 ? repos.notes.setLinks(userId, noteId, found) : undefined;
      })
      .catch((err: unknown) => console.error('Link enrichment failed', err));
  }

  async function currentMe(userId: string, csrfToken: string): Promise<MeResponse> {
    const user = await repos.users.get(userId);
    if (!user) throw new ApiError(401, 'Not signed in');
    return toMe(user, csrfToken);
  }

  app.post('/api/auth/logout', async (c) => {
    await repos.auth.deleteSession(c.get('session').tokenHash);
    deleteCookie(c, SESSION_COOKIE, cookieOptions);
    return c.json<Api['logout']['response']>({ ok: true });
  });

  app.get('/api/me', async (c) => {
    const { userId, csrfToken } = c.get('session');
    return c.json<Api['me']['response']>(await currentMe(userId, csrfToken));
  });

  app.patch('/api/me', async (c) => {
    const { userId, csrfToken } = c.get('session');
    const timezone = parseTimezone((await readBody(c)).timezone);
    await repos.users.setTimezone(userId, timezone);
    return c.json<Api['updateMe']['response']>(await currentMe(userId, csrfToken));
  });

  app.get('/api/notes', async (c) => {
    const query = parseListNotesQuery(c);
    return c.json<Api['listNotes']['response']>(await repos.notes.list(c.get('session').userId, query));
  });

  app.post('/api/notes', async (c) => {
    const { text, tags, urls } = parseNote(parseText((await readBody(c)).text));
    const { userId } = c.get('session');
    const note = await repos.notes.create(userId, { text, source: 'web', tags });
    enrichInBackground(userId, note.id, urls);
    return c.json<Api['createNote']['response']>(note);
  });

  app.patch('/api/notes/:id', async (c) => {
    const id = parseUuid(c.req.param('id'));
    const parsed = parseNote(parseText((await readBody(c)).text));
    const { userId } = c.get('session');
    const existing = await repos.notes.get(userId, id);
    if (!existing) throw notFound();
    // The parser strips hashtags from stored text, so an edit usually arrives
    // with none. Replacing tags would wipe them, so an edit can only add tags;
    // removing one goes through the tag routes.
    const tags = [...new Set([...existing.tags, ...parsed.tags])];
    const note = await repos.notes.update(userId, id, { text: parsed.text, tags });
    if (!note) throw notFound();
    enrichInBackground(userId, id, parsed.urls);
    return c.json<Api['updateNote']['response']>(note);
  });

  app.delete('/api/notes/:id', async (c) => {
    const id = parseUuid(c.req.param('id'));
    if (!(await repos.notes.delete(c.get('session').userId, id))) throw notFound();
    return c.json<Api['deleteNote']['response']>({ ok: true });
  });

  app.get('/api/tags', async (c) => {
    return c.json<Api['listTags']['response']>({ items: await repos.tags.list(c.get('session').userId) });
  });

  app.patch('/api/tags/:id', async (c) => {
    const id = parseUuid(c.req.param('id'));
    const name = parseTagName((await readBody(c)).name);
    const { userId } = c.get('session');
    // The repository looks for a name collision before ownership, so without
    // this check another user's tag could answer 409 instead of 404.
    const owned = (await repos.tags.list(userId)).some((tag) => tag.id === id);
    if (!owned) throw notFound();
    const tag = await repos.tags.rename(userId, id, name);
    if (!tag) throw notFound();
    return c.json<Api['renameTag']['response']>(tag);
  });

  app.delete('/api/tags/:id', async (c) => {
    const id = parseUuid(c.req.param('id'));
    if (!(await repos.tags.delete(c.get('session').userId, id))) throw notFound();
    return c.json<Api['deleteTag']['response']>({ ok: true });
  });

  app.get('/api/lists', async (c) => {
    return c.json<Api['listLists']['response']>({ items: await repos.lists.all(c.get('session').userId) });
  });

  app.post('/api/lists/:id/items', async (c) => {
    const id = parseUuid(c.req.param('id'));
    const text = parseText((await readBody(c)).text).trim();
    const item = await repos.lists.addItem(c.get('session').userId, id, text);
    if (!item) throw notFound();
    return c.json<Api['addListItem']['response']>(item);
  });

  app.delete('/api/lists/:id', async (c) => {
    const id = parseUuid(c.req.param('id'));
    if (!(await repos.lists.delete(c.get('session').userId, id))) throw notFound();
    return c.json<Api['deleteList']['response']>({ ok: true });
  });

  app.patch('/api/list-items/:id', async (c) => {
    const id = parseUuid(c.req.param('id'));
    const checked = parseChecked((await readBody(c)).checked);
    const item = await repos.lists.setItemChecked(c.get('session').userId, id, checked);
    if (!item) throw notFound();
    return c.json<Api['updateListItem']['response']>(item);
  });

  app.delete('/api/list-items/:id', async (c) => {
    const id = parseUuid(c.req.param('id'));
    if (!(await repos.lists.deleteItem(c.get('session').userId, id))) throw notFound();
    return c.json<Api['deleteListItem']['response']>({ ok: true });
  });

  app.get('/api/reminders', async (c) => {
    return c.json<Api['listReminders']['response']>({ items: await repos.reminders.listPending(c.get('session').userId) });
  });

  app.delete('/api/reminders/:id', async (c) => {
    const id = parseUuid(c.req.param('id'));
    if (!(await repos.reminders.cancel(c.get('session').userId, id))) throw notFound();
    return c.json<Api['cancelReminder']['response']>({ ok: true });
  });

  // A mounted app's notFound handler is not used, and an unknown /api path would
  // otherwise fall through to whatever the parent serves, such as the app shell.
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  // The session variable is internal, so callers see a plain Hono app.
  return app as unknown as Hono;
}
