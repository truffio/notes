import type { Reminder } from '@notes/core';
import type { Repositories } from '@notes/db';

export interface ReminderWorkerDeps {
  repos: Repositories;
  send: (telegramId: string, text: string) => Promise<void>;
  intervalMs?: number;
  maxAttempts?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export interface ReminderWorker {
  start(): void;
  stop(): Promise<void>;
  /** Delivers what is due and returns how many reminders were sent. */
  tick(): Promise<number>;
}

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const STALE_CLAIM_MS = 5 * 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const BATCH_SIZE = 50;

/** Delay before retry number `attempts + 1`: 30s, 1m, 2m, ... capped at one hour. */
const backoffMs = (attempts: number) => Math.min(BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), BACKOFF_MAX_MS);

export function createReminderWorker(deps: ReminderWorkerDeps): ReminderWorker {
  const { repos, send } = deps;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const now = deps.now ?? (() => new Date());
  const onError = deps.onError ?? (() => {});

  let running: Promise<number> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;

  const report = (error: unknown) => {
    try {
      onError(error);
    } catch {
      // A failing error handler must not break delivery.
    }
  };

  /** Returns true if the reminder was delivered. Never throws. */
  async function deliver(reminder: Reminder): Promise<boolean> {
    try {
      const user = await repos.users.get(reminder.userId);
      if (!user) {
        // The user was deleted mid-flight; there is nobody to remind.
        await repos.reminders.markFailed(reminder.id, null);
        return false;
      }
      try {
        await send(user.telegramId, reminder.text);
      } catch (error) {
        report(error);
        // `attempts` already counts this try, because claimDue increments it.
        const retryAt = reminder.attempts >= maxAttempts ? null : new Date(now().getTime() + backoffMs(reminder.attempts));
        await repos.reminders.markFailed(reminder.id, retryAt);
        return false;
      }
      await repos.reminders.markSent(reminder.id);
      return true;
    } catch (error) {
      report(error);
      return false;
    }
  }

  async function run(): Promise<number> {
    let sent = 0;
    for (;;) {
      const current = now();
      const batch = await repos.reminders.claimDue(current, new Date(current.getTime() - STALE_CLAIM_MS), BATCH_SIZE);
      // UPDATE ... RETURNING has no defined order, so restore oldest first.
      batch.sort((a, b) => a.remindAt.localeCompare(b.remindAt));
      for (const reminder of batch) {
        if (await deliver(reminder)) sent++;
      }
      if (batch.length < BATCH_SIZE) return sent;
    }
  }

  function tick(): Promise<number> {
    // Overlapping callers share one run, so nothing is claimed twice.
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  }

  function schedule() {
    timer = setTimeout(() => {
      timer = null;
      tick()
        .catch(report)
        .finally(() => {
          if (started) schedule();
        });
    }, intervalMs);
  }

  return {
    tick,

    start() {
      if (started) return;
      started = true;
      // Tick right away, so reminders that came due during downtime go out on startup.
      tick()
        .catch(report)
        .finally(() => {
          if (started) schedule();
        });
    },

    async stop() {
      started = false;
      if (timer) clearTimeout(timer);
      timer = null;
      await running?.catch(() => {});
    },
  };
}
