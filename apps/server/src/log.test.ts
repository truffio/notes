import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createRedactor, redactConsole } from './log.ts';

const TOKEN = '123456789:AAFakeFakeFakeFakeFakeFakeFakeFakeFak';

function fakeConsole() {
  const lines: string[] = [];
  const target = { ...console, error: (line: string) => lines.push(line), log: (line: string) => lines.push(line) };
  return { lines, target: target as Console };
}

describe('createRedactor', () => {
  it('removes configured secrets, plain and URL-encoded, and any bot token', () => {
    const redact = createRedactor(['sEcReT', undefined, '']);
    expect(redact('a sEcReT b')).toBe('a [REDACTED] b');
    expect(createRedactor(['p@ss word'])('x p%40ss%20word')).toBe('x [REDACTED]');
    expect(redact(`https://api.telegram.org/bot${TOKEN}/getMe`)).toBe('https://api.telegram.org/bot[REDACTED]/getMe');
  });
});

describe('redactConsole', () => {
  it('redacts a token inside a nested fetch error', () => {
    const { lines, target } = fakeConsole();
    redactConsole([TOKEN], target);
    const cause = new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`);
    target.error('Telegram update failed', Object.assign(new Error('Network request failed'), { error: cause }));
    expect(lines.join('\n')).toContain('Network request failed');
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('redacts the token grammY keeps on its Api object', () => {
    const botError = Object.assign(new Error('update failed'), { ctx: { api: { token: TOKEN } } });
    // The hazard this guards against: plain inspection does print it.
    expect(inspect(botError)).toContain(TOKEN);

    const { lines, target } = fakeConsole();
    redactConsole([TOKEN], target);
    target.error(botError);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('leaves ordinary output alone', () => {
    const { lines, target } = fakeConsole();
    redactConsole([TOKEN], target);
    target.log('Listening on port %d', 3000);
    expect(lines).toEqual(['Listening on port 3000']);
  });
});
