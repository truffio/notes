import type { Api } from '@notes/core';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export const MAX_TEXT_LENGTH = 10000;
export const MAX_TAG_LENGTH = 64;
/** Postgres rejects a tsquery word over 2046 bytes, and a character is at most 4. */
const MAX_QUERY_LENGTH = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CURSOR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** An error whose message is safe to show to the client. */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
  ) {
    super(message);
  }
}

const badRequest = (message: string) => new ApiError(400, message);

/** Postgres text cannot hold a NUL, so it must not get as far as a query. */
const isStorable = (value: string) => !value.includes('\0');

export function parseUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw badRequest('Invalid id');
  return value;
}

/**
 * Requiring a JSON content type also protects login, the one route without a
 * CSRF token: a cross-site form cannot send this type without a CORS preflight.
 */
export async function readBody(c: Context): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/iu.test(c.req.header('Content-Type') ?? '')) {
    throw badRequest('Expected a JSON body');
  }
  const body: unknown = await c.req.json().catch(() => {
    throw badRequest('Invalid JSON');
  });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest('Invalid JSON');
  return body as Record<string, unknown>;
}

export function parseText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || !isStorable(value)) throw badRequest('Invalid text');
  if (value.length > MAX_TEXT_LENGTH) throw badRequest(`Text is limited to ${MAX_TEXT_LENGTH} characters`);
  return value;
}

export function parseTagName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name === '' || !isStorable(name)) throw badRequest('Invalid tag name');
  if (name.length > MAX_TAG_LENGTH) throw badRequest(`Tag names are limited to ${MAX_TAG_LENGTH} characters`);
  return name;
}

export function parseTimezone(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw badRequest('Invalid timezone');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    throw badRequest('Invalid timezone');
  }
  return value;
}

export function parseChecked(value: unknown): boolean {
  if (typeof value !== 'boolean') throw badRequest('Invalid checked value');
  return value;
}

/** Stricter than the repository, which would pass some bad cursors to Postgres. */
function parseCursor(value: string): string {
  const [createdAt, id, ...rest] = value.split('|');
  const date = new Date(createdAt ?? '');
  const valid =
    rest.length === 0 &&
    id !== undefined &&
    UUID_PATTERN.test(id) &&
    CURSOR_DATE_PATTERN.test(createdAt ?? '') &&
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() >= 1 &&
    date.toISOString() === createdAt;
  if (!valid) throw badRequest('Invalid cursor');
  return value;
}

export function parseListNotesQuery(c: Context): Api['listNotes']['query'] {
  const { cursor, limit, tag, q } = c.req.query();
  const query: Api['listNotes']['query'] = {};
  if (cursor !== undefined) query.cursor = parseCursor(cursor);
  if (limit !== undefined) {
    if (!/^[1-9]\d*$/u.test(limit)) throw badRequest('Invalid limit');
    query.limit = Number(limit);
  }
  if (tag !== undefined) query.tag = parseTagName(tag);
  if (q !== undefined) {
    if (!isStorable(q) || q.length > MAX_QUERY_LENGTH) throw badRequest('Invalid search');
    query.q = q;
  }
  return query;
}
