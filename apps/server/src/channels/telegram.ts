import type { Channel, InboundHandler, InboundMessage } from '@notes/core';
import { Bot, BotError, GrammyError, webhookCallback, type Transformer } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';

/** Telegram rejects messages longer than 4096 characters. */
export const TELEGRAM_LIMIT = 4096;

const POLLING_ATTEMPTS = 3;
const SAVE_FAILED = "Couldn't save that. Please send it again.";

export interface TelegramOptions {
  token: string;
  webhook?: { url: string; secret: string };
  /** Test seam: intercepts every API call, so a fake transport replaces the network. */
  transformer?: Transformer;
  /** Test seam: skips the getMe call. */
  botInfo?: UserFromGetMe;
  /** Test seam: base delay between polling retries. */
  retryDelayMs?: number;
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

/**
 * grammY errors carry the full request payload, which here holds note text,
 * login links and MCP tokens, and may wrap a fetch error whose message has the
 * bot token in its URL. So only the Telegram error text leaves this module.
 */
function toSafeError(error: unknown): Error {
  if (error instanceof GrammyError) return new Error(`Telegram refused the message: ${error.description}`);
  return new Error('Could not reach Telegram');
}

export function createTelegramChannel(options: TelegramOptions): TelegramChannel {
  const bot = new Bot(options.token, { botInfo: options.botInfo });
  if (options.transformer) bot.api.config.use(options.transformer);
  const { webhook } = options;
  const retryDelayMs = options.retryDelayMs ?? 500;
  let handler: InboundHandler | null = null;

  /**
   * Polling has no redelivery, because grammY has already advanced past the
   * update. Retry here, then tell the sender rather than losing it silently.
   * Retrying is safe: a failed save rolled back, so nothing is duplicated.
   */
  async function handleWithRetry(inbound: InboundHandler, message: InboundMessage): Promise<string | null> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await inbound(message);
      } catch (error) {
        if (attempt >= POLLING_ATTEMPTS) {
          console.error('Telegram update failed', error);
          return SAVE_FAILED;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  }

  async function send(recipientId: string, text: string): Promise<void> {
    for (const chunk of splitMessage(text)) {
      await bot.api.sendMessage(recipientId, chunk).catch((error: unknown) => {
        throw toSafeError(error);
      });
    }
  }

  // Replies can hold login links and tokens, and go to the chat the message came
  // from. In a group, everyone there would read them, so only direct chats count.
  const direct = bot.chatType('private');

  direct.on('message:text', async (ctx) => {
    if (!handler) throw new Error('Telegram channel has no handler yet');
    const from = ctx.from;
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id);
    const message: InboundMessage = {
      channel: 'telegram',
      updateId: String(ctx.update.update_id),
      senderId: String(from.id),
      senderName: name,
      text: ctx.message.text,
    };
    const reply = webhook ? await handler(message) : await handleWithRetry(handler, message);
    if (reply) await send(String(ctx.chat.id), reply);
  });

  direct.on('message', async (ctx) => {
    await send(String(ctx.chat.id), 'Text only for now.');
  });

  // Webhook: rethrow so the request fails and Telegram redelivers.
  // Polling: log and keep going, because the bot would stop otherwise. Failed
  // saves never reach here in polling mode; see handleWithRetry.
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
      const callback = webhookCallback(bot, 'std/http', { secretToken: webhook?.secret });
      return async (request) => {
        try {
          return await callback(request);
        } catch (error) {
          // The cause only: a BotError holds the update, with the message text,
          // and the Api object, with the token, and the caller will log this.
          throw error instanceof BotError ? error.error : error;
        }
      };
    },
  };
}
