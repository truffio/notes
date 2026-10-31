import type { CommandHandler } from '@notes/core';
import type { Repositories } from '@notes/db';

function isValidTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

function formatTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(
    new Date(iso),
  );
}

export function createReminderCommands(deps: { repos: Repositories }): Record<string, CommandHandler> {
  const { repos } = deps;

  const reminders: CommandHandler = async ({ user }) => {
    const pending = await repos.reminders.listPending(user.id);
    if (pending.length === 0) return 'No pending reminders.';
    const lines = pending.map((r, i) => `${i + 1}. ${formatTime(r.remindAt, user.timezone)} - ${r.text}`);
    return `Pending reminders (${user.timezone}):\n${lines.join('\n')}`;
  };

  const cancel: CommandHandler = async ({ user, args }) => {
    const input = args.trim();
    if (!/^\d+$/.test(input)) return 'Usage: /cancel <number>. Use /reminders to see the numbers.';
    const pending = await repos.reminders.listPending(user.id);
    const target = pending[Number(input) - 1];
    if (!target) return `There is no reminder number ${input}. Use /reminders to see the list.`;
    if (!(await repos.reminders.cancel(user.id, target.id))) return 'That reminder is no longer pending.';
    return `Cancelled: ${target.text}`;
  };

  const timezone: CommandHandler = async ({ user, args }) => {
    const name = args.trim();
    if (!name) return `Your timezone is ${user.timezone}. Change it with /timezone <IANA name>, such as Europe/Paris.`;
    if (!isValidTimezone(name)) return `"${name}" is not a valid IANA timezone. Try something like Europe/Paris.`;
    await repos.users.setTimezone(user.id, name);
    return `Timezone set to ${name}.`;
  };

  return { reminders, cancel, timezone };
}
