import { serveStatic } from '@hono/node-server/serve-static';
import {
  parseMessage,
  parseReminderTime,
  type Channel,
  type CommandHandler,
  type LinkEnricher,
} from '@notes/core';
import type { Repositories } from '@notes/db';
import { Hono } from 'hono';
import { createApi } from './api/index.ts';
import { createMcpTokenCommand } from './auth/apiTokens.ts';
import { createLoginCommand } from './auth/login.ts';
import { createCaptureHandler } from './capture/handler.ts';
import { createLinkEnricher } from './enrich/index.ts';
import { createReminderCommands } from './reminders/commands.ts';
import { createReminderWorker } from './reminders/worker.ts';

const HELP = `Send me anything and I'll save it. Use #tags to organize.

list groceries: milk, eggs
remind me tomorrow at 9am to call Sam

/login - open the web dashboard
/reminders - list pending reminders
/cancel <number> - cancel a reminder
/timezone <name> - set your timezone, such as America/Toronto
/mcptoken <name> - create a token for Claude access`;

export interface AppDeps {
  repos: Repositories;
  channel: Channel;
  allowedSenderIds: Set<string>;
  baseUrl: string;
  /** Set when the web app has been built, so this server hosts it. */
  webRoot?: string;
  /** Path of the Telegram webhook, when running in webhook mode. */
  webhook?: { path: string; callback: (request: Request) => Promise<Response> };
  enrich?: LinkEnricher;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export function createApp(deps: AppDeps) {
  const { repos, channel, baseUrl, webRoot, webhook, now } = deps;
  const enrich = deps.enrich ?? createLinkEnricher();

  const help: CommandHandler = async () => HELP;
  const commands: Record<string, CommandHandler> = {
    start: help,
    help,
    login: createLoginCommand({ repos, baseUrl, now }),
    mcptoken: createMcpTokenCommand({ repos }),
    ...createReminderCommands({ repos }),
  };

  const handler = createCaptureHandler({
    repos,
    allowedSenderIds: deps.allowedSenderIds,
    commands,
    parse: parseMessage,
    parseTime: parseReminderTime,
    enrich,
    now,
    onError: deps.onError,
  });

  const worker = createReminderWorker({ repos, send: channel.send, now, onError: deps.onError });

  const app = new Hono();
  app.route('/', createApi({ repos, parse: parseMessage, enrich, secureCookies: baseUrl.startsWith('https:'), now }));
  if (webhook) app.post(webhook.path, (c) => webhook.callback(c.req.raw));
  if (webRoot) {
    app.use('*', serveStatic({ root: webRoot }));
    // Client-side routes such as /login and /tags are served by the app shell.
    app.get('*', serveStatic({ path: `${webRoot}/index.html` }));
  }

  return { app, handler, worker };
}
