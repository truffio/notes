import { serve } from '@hono/node-server';
import { createPgliteDatabase, createPostgresDatabase, createRepositories, migrate } from '@notes/db';
import { createApp } from './app.ts';
import { createTelegramChannel } from './channels/telegram.ts';
import { loadConfig } from './config.ts';
import { redactConsole } from './log.ts';

const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const UPDATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const WEBHOOK_PATH = '/telegram/webhook';

// Registered first, so a failure at startup is redacted like any other log. This
// also catches a rejected top-level await and unhandled rejections.
process.on('uncaughtException', (error) => {
  console.error(error);
  process.exit(1);
});

const config = loadConfig(process.env);
redactConsole([config.telegramToken, config.webhookSecret, config.databaseUrl]);

const db = config.databaseUrl ? createPostgresDatabase(config.databaseUrl) : createPgliteDatabase(config.pgliteDataDir);
await migrate(db);
const repos = createRepositories(db);

const channel = createTelegramChannel({
  token: config.telegramToken,
  webhook: config.webhookSecret
    ? { url: `${config.baseUrl}${WEBHOOK_PATH}`, secret: config.webhookSecret }
    : undefined,
});

const { app, handler, worker } = createApp({
  repos,
  channel,
  allowedSenderIds: config.allowedSenderIds,
  baseUrl: config.baseUrl,
  webRoot: config.webRoot,
  webhook: config.webhookSecret ? { path: WEBHOOK_PATH, callback: channel.webhookCallback() } : undefined,
  onError: (error) => console.error(error),
});

const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => console.log(`Listening on port ${port}`));

await channel.start(handler);
worker.start();

const purge = async () => {
  const now = new Date();
  await repos.auth.purgeExpired(now);
  await repos.updates.purgeBefore(new Date(now.getTime() - UPDATE_RETENTION_MS));
};
const purgeTimer = setInterval(() => void purge().catch((error) => console.error(error)), PURGE_INTERVAL_MS);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(purgeTimer);
  await worker.stop();
  await channel.stop();
  server.close();
  await db.close();
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
