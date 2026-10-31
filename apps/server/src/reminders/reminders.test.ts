import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandHandler } from '@notes/core';
import { createPgliteDatabase, createRepositories, migrate, type Database, type Repositories } from '@notes/db';
import { createReminderCommands } from './commands.ts';
import { createReminderWorker } from './worker.ts';

let db: Database;
let repos: Repositories;
let userId: string;
let clock: Date;
let sent: Array<{ to: string; text: string }>;
let failing: Set<string>;

const send = async (to: string, text: string) => {
  await Promise.resolve();
  if (failing.has(text)) throw new Error(`send failed: ${text}`);
  sent.push({ to, text });
};

const minutes = (n: number) => n * 60_000;
const at = (offsetMs: number) => new Date(clock.getTime() + offsetMs);

function makeWorker(options: { maxAttempts?: number; errors?: unknown[] } = {}) {
  return createReminderWorker({
    repos,
    send,
    maxAttempts: options.maxAttempts,
    now: () => clock,
    onError: (error) => options.errors?.push(error),
  });
}

async function statusOf(id: string) {
  const { rows } = await db.query<{ status: string; attempts: number }>(
    'SELECT status, attempts FROM reminders WHERE id = $1',
    [id],
  );
  return rows[0];
}

beforeEach(async () => {
  db = createPgliteDatabase();
  await migrate(db);
  repos = createRepositories(db);
  userId = (await repos.users.upsertByTelegramId('777', 'Alice')).id;
  clock = new Date('2030-01-01T12:00:00Z');
  sent = [];
  failing = new Set();
});

afterEach(() => db.close());

describe('reminder worker', () => {
  it('delivers once even when ticks overlap', async () => {
    await repos.reminders.create(userId, { noteId: null, text: 'call mum', remindAt: at(-1000) });
    const worker = makeWorker();
    await Promise.all([worker.tick(), worker.tick(), worker.tick()]);
    expect(await worker.tick()).toBe(0);
    expect(sent).toEqual([{ to: '777', text: 'call mum' }]);
  });

  it('does not send reminders that are not due yet', async () => {
    await repos.reminders.create(userId, { noteId: null, text: 'later', remindAt: at(minutes(10)) });
    const worker = makeWorker();
    expect(await worker.tick()).toBe(0);
    clock = at(minutes(11));
    expect(await worker.tick()).toBe(1);
  });

  it('sends reminders that came due during downtime, oldest first', async () => {
    await repos.reminders.create(userId, { noteId: null, text: 'second', remindAt: at(-minutes(60)) });
    await repos.reminders.create(userId, { noteId: null, text: 'first', remindAt: at(-minutes(600)) });
    const worker = makeWorker();
    expect(await worker.tick()).toBe(2);
    expect(sent.map((s) => s.text)).toEqual(['first', 'second']);
  });

  it('takes over a claim stranded by a crash after five minutes', async () => {
    const reminder = await repos.reminders.create(userId, { noteId: null, text: 'stranded', remindAt: at(-1000) });
    await repos.reminders.claimDue(clock, at(-minutes(5)), 10); // crash before send
    const worker = makeWorker();
    expect(await worker.tick()).toBe(0);
    clock = at(minutes(6));
    expect(await worker.tick()).toBe(1);
    expect((await statusOf(reminder.id))?.status).toBe('sent');
  });

  it('retries with backoff, then gives up after maxAttempts', async () => {
    const reminder = await repos.reminders.create(userId, { noteId: null, text: 'flaky', remindAt: at(-1000) });
    failing.add('flaky');
    const errors: unknown[] = [];
    const worker = makeWorker({ maxAttempts: 3, errors });

    expect(await worker.tick()).toBe(0);
    expect(await statusOf(reminder.id)).toEqual({ status: 'pending', attempts: 1 });
    expect(await worker.tick()).toBe(0); // backoff not elapsed
    expect((await statusOf(reminder.id))?.attempts).toBe(1);

    clock = at(minutes(1));
    await worker.tick();
    expect(await statusOf(reminder.id)).toEqual({ status: 'pending', attempts: 2 });

    clock = at(minutes(10)); // second backoff is longer than the first
    await worker.tick();
    expect(await statusOf(reminder.id)).toEqual({ status: 'failed', attempts: 3 });

    clock = at(minutes(1000));
    await worker.tick();
    expect((await statusOf(reminder.id))?.attempts).toBe(3);
    expect(errors).toHaveLength(3);
    expect(sent).toEqual([]);
  });

  it('retries successfully once the transport recovers', async () => {
    const reminder = await repos.reminders.create(userId, { noteId: null, text: 'blip', remindAt: at(-1000) });
    failing.add('blip');
    const worker = makeWorker();
    await worker.tick();
    failing.clear();
    clock = at(minutes(1));
    expect(await worker.tick()).toBe(1);
    expect((await statusOf(reminder.id))?.status).toBe('sent');
  });

  it('keeps delivering the rest of a batch when one send fails', async () => {
    await repos.reminders.create(userId, { noteId: null, text: 'a', remindAt: at(-3000) });
    const bad = await repos.reminders.create(userId, { noteId: null, text: 'bad', remindAt: at(-2000) });
    await repos.reminders.create(userId, { noteId: null, text: 'c', remindAt: at(-1000) });
    failing.add('bad');
    const worker = makeWorker();
    expect(await worker.tick()).toBe(2);
    expect(sent.map((s) => s.text)).toEqual(['a', 'c']);
    expect((await statusOf(bad.id))?.status).toBe('pending');
  });

  it('gives up quietly on a user deleted mid-flight', async () => {
    const doomed = (await repos.users.upsertByTelegramId('888', 'Bob')).id;
    await repos.reminders.create(doomed, { noteId: null, text: 'ghost', remindAt: at(-1000) });
    await repos.reminders.create(userId, { noteId: null, text: 'real', remindAt: at(-500) });
    const errors: unknown[] = [];
    const worker = makeWorker({ errors });
    // Delete the user between the claim and the lookup.
    const realGet = repos.users.get;
    repos.users.get = async (id) => {
      if (id === doomed) await db.query('DELETE FROM users WHERE id = $1', [doomed]);
      return realGet(id);
    };
    await expect(worker.tick()).resolves.toBe(1);
    repos.users.get = realGet;
    expect(sent.map((s) => s.text)).toEqual(['real']);
    expect(errors).toEqual([]);
  });

  it('stop waits for the in-flight tick', async () => {
    await repos.reminders.create(userId, { noteId: null, text: 'slow', remindAt: at(-1000) });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const worker = createReminderWorker({
      repos,
      send: async (to, text) => {
        await gate;
        sent.push({ to, text });
      },
      now: () => clock,
    });
    const ticking = worker.tick();
    let stopped = false;
    const stopping = worker.stop().then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(await ticking).toBe(1);
  });

  it('start delivers on a timer and stop ends it', async () => {
    await repos.reminders.create(userId, { noteId: null, text: 'timed', remindAt: at(-1000) });
    const worker = createReminderWorker({ repos, send, intervalMs: 10, now: () => clock });
    worker.start();
    await expect.poll(() => sent.length).toBe(1);
    await worker.stop();
    await repos.reminders.create(userId, { noteId: null, text: 'after stop', remindAt: at(-500) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toHaveLength(1);
  });
});

describe('reminder commands', () => {
  async function user() {
    return (await repos.users.get(userId))!;
  }

  it('lists pending reminders numbered, in the user timezone', async () => {
    const reminders = createReminderCommands({ repos }).reminders!;
    expect(await reminders({ user: await user(), args: '' })).toBe('No pending reminders.');
    await repos.users.setTimezone(userId, 'Asia/Tokyo');
    await repos.reminders.create(userId, { noteId: null, text: 'second', remindAt: new Date('2030-03-02T00:00:00Z') });
    await repos.reminders.create(userId, { noteId: null, text: 'first', remindAt: new Date('2030-03-01T00:00:00Z') });
    const reply = await reminders({ user: await user(), args: '' });
    expect(reply).toContain('1. 1 Mar 2030');
    expect(reply).toContain('09:00 - first');
    expect(reply).toContain('2. 2 Mar 2030');
  });

  it('cancels by the listed number and rejects invalid numbers', async () => {
    const { reminders, cancel } = createReminderCommands({ repos }) as Record<'reminders' | 'cancel', CommandHandler>;
    await repos.reminders.create(userId, { noteId: null, text: 'keep', remindAt: new Date('2030-03-02T00:00:00Z') });
    await repos.reminders.create(userId, { noteId: null, text: 'drop', remindAt: new Date('2030-03-01T00:00:00Z') });
    expect(await cancel({ user: await user(), args: '1' })).toBe('Cancelled: drop');
    expect((await repos.reminders.listPending(userId)).map((r) => r.text)).toEqual(['keep']);
    expect(await reminders({ user: await user(), args: '' })).toContain('1. ');
    for (const args of ['', 'abc', '0', '2', '-1']) {
      const reply = await cancel({ user: await user(), args });
      expect(reply).not.toMatch(/^Cancelled/);
    }
    expect(await repos.reminders.listPending(userId)).toHaveLength(1);
  });

  it('shows, validates and sets the timezone', async () => {
    const timezone = createReminderCommands({ repos }).timezone!;
    expect(await timezone({ user: await user(), args: '' })).toContain('UTC');
    expect(await timezone({ user: await user(), args: 'Mars/Olympus' })).toContain('not a valid');
    expect((await user()).timezone).toBe('UTC');
    expect(await timezone({ user: await user(), args: 'Europe/Paris' })).toBe('Timezone set to Europe/Paris.');
    expect((await user()).timezone).toBe('Europe/Paris');
  });
});
