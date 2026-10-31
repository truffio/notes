import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const env = {
  TELEGRAM_BOT_TOKEN: 'token',
  TELEGRAM_ALLOWED_USER_IDS: '1, 2',
  BASE_URL: 'https://notes.test/',
};

describe('loadConfig', () => {
  it('reads the required values', () => {
    const config = loadConfig(env);
    expect(config.baseUrl).toBe('https://notes.test');
    expect([...config.allowedSenderIds]).toEqual(['1', '2']);
    expect(config.webhookSecret).toBeUndefined();
  });

  it('accepts a strong webhook secret', () => {
    const secret = 'a1_-'.repeat(8);
    expect(loadConfig({ ...env, TELEGRAM_WEBHOOK_SECRET: secret }).webhookSecret).toBe(secret);
  });

  it.each(['short', 'x'.repeat(31), 'x'.repeat(257), `${'x'.repeat(32)}!`])('refuses the webhook secret %s', (secret) => {
    expect(() => loadConfig({ ...env, TELEGRAM_WEBHOOK_SECRET: secret })).toThrow('TELEGRAM_WEBHOOK_SECRET');
  });

  it('refuses webhook mode without https', () => {
    const insecure = { ...env, BASE_URL: 'http://notes.test', TELEGRAM_WEBHOOK_SECRET: 'x'.repeat(32) };
    expect(() => loadConfig(insecure)).toThrow('https');
  });
});
