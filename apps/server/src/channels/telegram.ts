import type { Channel, InboundHandler } from '@notes/core';
import { Bot, webhookCallback, type Transformer } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';

/** Telegram rejects messages longer than 4096 characters. */
export const TELEGRAM_LIMIT = 4096;

export interface TelegramOptions {
  token: string;
  webhook?: { url: string; secret: string };
  /** Test seam: intercepts every API call, so a fake transport replaces the network. */
  transformer?: Transformer;
  /** Test seam: skips the getMe call. */
  botInfo?: UserFromGetMe;
}

export type TelegramChannel = Channel & { webhookCallback(): (request: Request) => Promise<Response> };

/** Splits at newlines or spaces where possible, so no chunk exceeds the limit. */
export function splitMessage(text: string, limit = TELEGRAM_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut <= 0) cut = rest.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[\n ]/, '');
  }
  chunks.push(rest);
  return chunks;
}

export function createTelegramChannel(options: TelegramOptions): TelegramChannel {
  const bot = new Bot(options.token, { botInfo: options.botInfo });
  if (options.transformer) bot.api.config.use(options.transformer);
  const { webhook } = options;
  let handler: InboundHandler | null = null;

  async function send(recipientId: string, text: string): Promise<void> {
    for (const chunk of splitMessage(text)) await bot.api.sendMessage(recipientId, chunk);
  }

  bot.on('message:text', async (ctx) => {
    if (!handler) throw new Error('Telegram channel has no handler yet');
    const from = ctx.from;
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id);
    const reply = await handler({
      channel: 'telegram',
      updateId: String(ctx.update.update_id),
      senderId: String(from.id),
      senderName: name,
      text: ctx.message.text,
    });
    if (reply) await send(String(ctx.chat.id), reply);
  });

  bot.on('message', async (ctx) => {
    await send(String(ctx.chat.id), 'Text only for now.');
  });

  // Webhook: rethrow so the request fails and Telegram redelivers.
  // Polling: log and keep going, because the bot would stop otherwise.
  bot.catch((error) => {
    if (webhook) throw error;
    console.error('Telegram update failed', error.error);
  });

  return {
    name: 'telegram',

    async start(inbound) {
      handler = inbound;
      if (webhook) {
        await bot.init();
        await bot.api.setWebhook(webhook.url, { secret_token: webhook.secret });
        return;
      }
      await bot.api.deleteWebhook();
      await bot.init();
      // start() resolves only when polling stops, so do not await it.
      void bot.start().catch((error) => console.error('Telegram polling stopped', error));
    },

    async stop() {
      handler = null;
      if (bot.isRunning()) await bot.stop();
    },

    send,

    webhookCallback() {
      return webhookCallback(bot, 'std/http', { secretToken: webhook?.secret });
    },
  };
}
