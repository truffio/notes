import type {
  CommandHandler,
  InboundHandler,
  InboundMessage,
  LinkEnricher,
  LinkPreview,
  MessageParser,
  ParsedMessage,
  ParsedReminder,
  ReminderTimeParser,
  User,
} from '@notes/core';
import type { Repositories } from '@notes/db';

export interface CaptureDeps {
  repos: Repositories;
  allowedSenderIds: Set<string>;
  commands: Record<string, CommandHandler>;
  parse: MessageParser;
  parseTime: ReminderTimeParser;
  enrich: LinkEnricher;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

const COMMAND = /^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/;

function formatTime(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(
      date,
    );
  } catch {
    return date.toISOString();
  }
}

export function createCaptureHandler(deps: CaptureDeps): InboundHandler {
  const { repos, allowedSenderIds, commands, parse, parseTime, enrich } = deps;
  const now = deps.now ?? (() => new Date());
  const onError = deps.onError ?? (() => {});

  /** A parser failure must never lose the message. */
  function safeParse(text: string): ParsedMessage {
    try {
      return parse(text);
    } catch (error) {
      onError(error);
      return { text, tags: [], urls: [], list: null };
    }
  }

  function safeParseTime(text: string, user: User): ParsedReminder | null {
    try {
      return parseTime(text, { now: now(), timezone: user.timezone });
    } catch (error) {
      onError(error);
      return null;
    }
  }

  /** Runs after the reply. A failure here leaves the saved note untouched. */
  function enrichInBackground(userId: string, noteId: string, urls: string[]): void {
    if (urls.length === 0) return;
    void (async () => {
      try {
        const results = await Promise.all(
          urls.map(async (url) => {
            try {
              return await enrich(url);
            } catch (error) {
              onError(error);
              return null;
            }
          }),
        );
        const links = results.filter((link): link is LinkPreview => link !== null);
        if (links.length > 0) await repos.notes.setLinks(userId, noteId, links);
      } catch (error) {
        onError(error);
      }
    })();
  }

  async function runCommand(message: InboundMessage, user: User, name: string, args: string): Promise<string | null> {
    const command = commands[name.toLowerCase()];
    if (!command) return `Unknown command: /${name}`;
    const fresh = await repos.transaction((tx) => tx.updates.markProcessed(message.channel, message.updateId));
    if (!fresh) return null;
    try {
      return await command({ user, args });
    } catch (error) {
      onError(error);
      return 'That command failed. Please try again.';
    }
  }

  return async (message) => {
    if (!allowedSenderIds.has(message.senderId)) return 'Sorry, this bot is private.';

    // Harmless on redelivery: only refreshes the display name.
    const user = await repos.users.upsertByTelegramId(message.senderId, message.senderName);
    const text = message.text.trim();

    const command = COMMAND.exec(text);
    // /remind is message syntax for the time parser, not a registered command.
    if (command && command[1]!.toLowerCase() !== 'remind') return runCommand(message, user, command[1]!, (command[2] ?? '').trim());

    // Parsing happens before the transaction, so a slow or failing parser holds no locks.
    const reminder = safeParseTime(text, user);
    const parsed = safeParse(reminder ? reminder.text : text);

    // The mark and every save share one transaction. A failed save rolls the
    // mark back, so the rethrown error makes the channel fail the update and
    // Telegram redelivers it. A concurrent duplicate waits on the insert, then
    // sees the mark.
    const outcome = await repos.transaction(async (tx) => {
      if (!(await tx.updates.markProcessed(message.channel, message.updateId))) return null;

      if (reminder) {
        const note = await tx.notes.create(user.id, {
          text: parsed.text || reminder.text,
          source: 'telegram',
          tags: parsed.tags,
        });
        await tx.reminders.create(user.id, { noteId: note.id, text: reminder.text, remindAt: reminder.remindAt });
        return { reply: `Reminder set for ${formatTime(reminder.remindAt, user.timezone)}.`, note };
      }

      if (parsed.list) {
        const list = await tx.lists.addItemsByName(user.id, parsed.list.name, parsed.list.items);
        const count = parsed.list.items.length;
        return { reply: `Added ${count} ${count === 1 ? 'item' : 'items'} to ${list.name}.`, note: null };
      }

      const note = await tx.notes.create(user.id, { text: parsed.text || text, source: 'telegram', tags: parsed.tags });
      const tagged = parsed.tags.length > 0 ? ` ${parsed.tags.map((tag) => `#${tag}`).join(' ')}` : '';
      return { reply: `Saved.${tagged}`, note };
    });

    if (!outcome) return null;
    if (outcome.note) enrichInBackground(user.id, outcome.note.id, parsed.urls);
    return outcome.reply;
  };
}
