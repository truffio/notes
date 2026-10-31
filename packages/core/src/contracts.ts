import type { LinkPreview, List, ListItem, Note, Reminder, Tag, User } from './types.ts';

/** Result of parsing one inbound message. `text` has hashtags removed. */
export interface ParsedMessage {
  text: string;
  tags: string[];
  urls: string[];
  list: { name: string; items: string[] } | null;
}

export type MessageParser = (input: string) => ParsedMessage;

export interface TimeParseContext {
  now: Date;
  timezone: string;
}

/** `text` is what to remind about, with the time phrase removed. */
export interface ParsedReminder {
  remindAt: Date;
  text: string;
}

/** Returns null unless the message clearly asks for a future reminder. */
export type ReminderTimeParser = (input: string, context: TimeParseContext) => ParsedReminder | null;

export type LinkEnricher = (url: string) => Promise<LinkPreview | null>;

export interface InboundMessage {
  channel: string;
  updateId: string;
  senderId: string;
  senderName: string;
  text: string;
}

/** Returns the reply to send, or null for no reply. */
export type InboundHandler = (message: InboundMessage) => Promise<string | null>;

/** A messaging transport. New channels implement this and touch nothing else. */
export interface Channel {
  readonly name: string;
  start(handler: InboundHandler): Promise<void>;
  stop(): Promise<void>;
  send(recipientId: string, text: string): Promise<void>;
}

export interface CommandContext {
  user: User;
  args: string;
}

/** Slash command, such as `/login`. Registered by name without the slash. */
export type CommandHandler = (context: CommandContext) => Promise<string>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface MeResponse {
  user: Pick<User, 'id' | 'displayName' | 'timezone'>;
  csrfToken: string;
}

/**
 * HTTP API. All routes are under /api, take and return JSON, and require a
 * session cookie unless marked public. State-changing routes require the
 * `X-CSRF-Token` header, whose value comes from GET /api/me.
 * Errors are `{ "error": string }` with 400, 401, 403, 404 or 409.
 */
export interface Api {
  /** POST /api/auth/login, public. Sets the session cookie. */
  login: { body: { token: string }; response: { ok: true } };
  /** POST /api/auth/logout */
  logout: { body: Record<string, never>; response: { ok: true } };
  /** GET /api/me */
  me: { response: MeResponse };
  /** PATCH /api/me */
  updateMe: { body: { timezone: string }; response: MeResponse };
  /** GET /api/notes?cursor=&limit=&tag=&q= */
  listNotes: { query: { cursor?: string; limit?: number; tag?: string; q?: string }; response: Page<Note> };
  /** POST /api/notes. Text runs through the message parser. */
  createNote: { body: { text: string }; response: Note };
  /** PATCH /api/notes/:id. Text runs through the message parser. */
  updateNote: { body: { text: string }; response: Note };
  /** DELETE /api/notes/:id */
  deleteNote: { response: { ok: true } };
  /** GET /api/tags */
  listTags: { response: { items: Tag[] } };
  /** PATCH /api/tags/:id. 409 if the name is taken. */
  renameTag: { body: { name: string }; response: Tag };
  /** DELETE /api/tags/:id */
  deleteTag: { response: { ok: true } };
  /** GET /api/lists */
  listLists: { response: { items: List[] } };
  /** POST /api/lists/:id/items */
  addListItem: { body: { text: string }; response: ListItem };
  /** PATCH /api/list-items/:id */
  updateListItem: { body: { checked: boolean }; response: ListItem };
  /** DELETE /api/list-items/:id */
  deleteListItem: { response: { ok: true } };
  /** DELETE /api/lists/:id */
  deleteList: { response: { ok: true } };
  /** GET /api/reminders. Pending only, soonest first. */
  listReminders: { response: { items: Reminder[] } };
  /** DELETE /api/reminders/:id. Cancels a pending reminder. */
  cancelReminder: { response: { ok: true } };
}
