import type { InboundMessage } from '@notes/core';
import type { Transformer } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createTelegramChannel, splitMessage } from './telegram.ts';

const botInfo = {
  id: 42,
  is_bot: true as const,
  first_name: 'Notes',
  username: 'notes_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
} as UserFromGetMe;

function fakeTransport(updates: unknown[] = []) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  let pending = [...updates];
  const transformer: Transformer = async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === 'getUpdates') {
      const batch = pending;
      pending = [];
      if (batch.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: true, result: batch } as never;
    }
    return { ok: true, result: true } as never;
  };
  const sent = () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload);
  return { calls, transformer, sent };
}

const textUpdate = (id: number, text: string) => ({
  update_id: id,
  message: {
    message_id: id,
    date: 0,
    chat: { id: 7, type: 'private', first_name: 'Ann' },
    from: { id: 7, is_bot: false, first_name: 'Ann', last_name: 'Lee' },
    text,
  },
});

const photoUpdate = (id: number) => ({
  update_id: id,
  message: {
    message_id: id,
    date: 0,
    chat: { id: 7, type: 'private', first_name: 'Ann' },
    from: { id: 7, is_bot: false, first_name: 'Ann' },
    photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }],
  },
});

const post = (body: unknown, secret?: string) =>
  new Request('https://example.com/telegram', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) },
    body: JSON.stringify(body),
  });

const webhook = { url: 'https://example.com/telegram', secret: 's3cret' };

describe('splitMessage', () => {
  it('keeps short text whole and splits long text under the limit', () => {
    expect(splitMessage('short')).toEqual(['short']);
    const long = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n');
    const chunks = splitMessage(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4096);
    expect(chunks.join('\n')).toBe(long);
    expect(splitMessage('x'.repeat(10000)).every((c) => c.length <= 4096)).toBe(true);
  });
});

describe('telegram channel (webhook)', () => {
  async function setup(handler: (m: InboundMessage) => Promise<string | null>) {
    const transport = fakeTransport();
    const channel = createTelegramChannel({ token: 't', webhook, transformer: transport.transformer, botInfo });
    await channel.start(handler);
    return { channel, transport, call: channel.webhookCallback() };
  }

  it('registers the webhook with its secret', async () => {
    const { transport } = await setup(async () => null);
    const call = transport.calls.find((c) => c.method === 'setWebhook');
    expect(call?.payload).toMatchObject({ url: webhook.url, secret_token: webhook.secret });
  });

  it('passes text to the handler and sends the reply', async () => {
    const handler = vi.fn(async () => 'Saved.');
    const { transport, call } = await setup(handler);
    const response = await call(post(textUpdate(10, 'hello'), webhook.secret));
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith({
      channel: 'telegram',
      updateId: '10',
      senderId: '7',
      senderName: 'Ann Lee',
      text: 'hello',
    });
    expect(transport.sent()).toEqual([{ chat_id: '7', text: 'Saved.' }]);
  });

  it('sends nothing when the handler returns null', async () => {
    const { transport, call } = await setup(async () => null);
    await call(post(textUpdate(11, 'dup'), webhook.secret));
    expect(transport.sent()).toEqual([]);
  });

  it('answers non-text messages without calling the handler', async () => {
    const handler = vi.fn(async () => 'x');
    const { transport, call } = await setup(handler);
    await call(post(photoUpdate(12), webhook.secret));
    expect(handler).not.toHaveBeenCalled();
    expect(transport.sent()).toEqual([{ chat_id: '7', text: 'Text only for now.' }]);
  });

  it('splits long replies under the Telegram limit', async () => {
    const { transport, call } = await setup(async () => 'word '.repeat(2000));
    await call(post(textUpdate(13, 'long'), webhook.secret));
    const texts = transport.sent().map((p) => p.text as string);
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(4096);
  });

  it('rejects requests with a wrong secret', async () => {
    const handler = vi.fn(async () => 'x');
    const { call } = await setup(handler);
    const response = await call(post(textUpdate(14, 'hi'), 'wrong'));
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails the request when the handler throws, so Telegram redelivers', async () => {
    const { call } = await setup(async () => {
      throw new Error('db down');
    });
    const outcome = await call(post(textUpdate(15, 'hi'), webhook.secret)).then(
      (response) => response.status,
      () => 'threw',
    );
    expect(outcome === 'threw' || Number(outcome) >= 500).toBe(true);
  });

  it('send() delivers to a recipient', async () => {
    const { channel, transport } = await setup(async () => null);
    await channel.send('99', 'ping');
    expect(transport.sent()).toEqual([{ chat_id: '99', text: 'ping' }]);
  });
});

describe('telegram channel (polling)', () => {
  it('polls updates, replies, and stops', async () => {
    const transport = fakeTransport([textUpdate(20, 'hi'), photoUpdate(21)]);
    const channel = createTelegramChannel({ token: 't', transformer: transport.transformer, botInfo });
    const handler = vi.fn(async () => 'ok');
    await channel.start(handler);
    await vi.waitFor(() => expect(transport.sent()).toHaveLength(2));
    expect(transport.sent().map((p) => p.text)).toEqual(['ok', 'Text only for now.']);
    expect(transport.calls.some((c) => c.method === 'setWebhook')).toBe(false);
    await channel.stop();
  });

  it('retries a failed save, then tells the sender and keeps polling', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const transport = fakeTransport([textUpdate(30, 'bad'), textUpdate(31, 'good')]);
    const channel = createTelegramChannel({ token: 't', transformer: transport.transformer, botInfo, retryDelayMs: 1 });
    const seen: string[] = [];
    await channel.start(async (m) => {
      seen.push(m.text);
      if (m.text === 'bad') throw new Error('boom');
      return 'ok';
    });
    await vi.waitFor(() => expect(transport.sent()).toHaveLength(2));
    expect(transport.sent().map((p) => p.text)).toEqual(["Couldn't save that. Please send it again.", 'ok']);
    expect(seen).toEqual(['bad', 'bad', 'bad', 'good']);
    await channel.stop();
    error.mockRestore();
  });

  it('recovers when a retry succeeds', async () => {
    const transport = fakeTransport([textUpdate(40, 'flaky')]);
    const channel = createTelegramChannel({ token: 't', transformer: transport.transformer, botInfo, retryDelayMs: 1 });
    let calls = 0;
    await channel.start(async () => {
      if (++calls === 1) throw new Error('boom');
      return 'saved';
    });
    await vi.waitFor(() => expect(transport.sent().map((p) => p.text)).toEqual(['saved']));
    await channel.stop();
  });
});

describe('telegram channel (hardening)', () => {
  const groupUpdate = (id: number, text: string, type: 'group' | 'supergroup') => ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: -100, type, title: 'Friends' },
      from: { id: 7, is_bot: false, first_name: 'Ann' },
      text,
    },
  });

  it.each(['group', 'supergroup'] as const)('ignores messages in a %s, so tokens never reach it', async (type) => {
    const transport = fakeTransport();
    const channel = createTelegramChannel({ token: 't', webhook, transformer: transport.transformer, botInfo });
    const handler = vi.fn(async () => 'login link');
    await channel.start(handler);
    const response = await channel.webhookCallback()(post(groupUpdate(70, '/login', type), webhook.secret));
    expect(response.status).toBe(200);
    expect(handler).not.toHaveBeenCalled();
    expect(transport.sent()).toEqual([]);
  });

  it('does not put message text or the payload in a send error', async () => {
    const transformer: Transformer = async () =>
      ({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }) as never;
    const channel = createTelegramChannel({ token: 't', transformer, botInfo });
    const error = await channel.send('7', 'login token abc123').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('chat not found');
    expect(inspect(error, { depth: 5 })).not.toContain('abc123');
  });

  it('does not expose a transport failure, which can hold the token in a URL', async () => {
    const transformer: Transformer = async () => {
      throw new Error('request to https://api.telegram.org/botSECRET/sendMessage failed');
    };
    const channel = createTelegramChannel({ token: 'SECRET', transformer, botInfo });
    const error = await channel.send('7', 'hello').catch((e: unknown) => e);
    expect(inspect(error, { depth: 5 })).not.toContain('SECRET');
  });

  it('rethrows only the cause from a webhook update', async () => {
    const transport = fakeTransport();
    const channel = createTelegramChannel({ token: 'SECRET', webhook, transformer: transport.transformer, botInfo });
    await channel.start(async () => {
      throw new Error('save failed');
    });
    const error = await channel
      .webhookCallback()(post(textUpdate(71, 'private note'), webhook.secret))
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe('save failed');
    const printed = inspect(error, { depth: 5 });
    expect(printed).not.toContain('SECRET');
    expect(printed).not.toContain('private note');
  });
});
