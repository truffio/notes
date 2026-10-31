import { format } from 'node:util';

const REPLACEMENT = '[REDACTED]';
/** Any Telegram bot token, in case one reaches a log that is not the configured one. */
const BOT_TOKEN = /\d{5,}:[A-Za-z0-9_-]{30,}/g;
const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

export function createRedactor(secrets: Array<string | undefined>): (text: string) => string {
  const needles = secrets
    .filter((secret): secret is string => Boolean(secret))
    // URLs hold the encoded form, in which a bot token's colon becomes %3A.
    .flatMap((secret) => [secret, encodeURIComponent(secret)]);
  return (text) => {
    let result = text;
    for (const needle of needles) result = result.replaceAll(needle, REPLACEMENT);
    return result.replace(BOT_TOKEN, REPLACEMENT);
  };
}

/**
 * Redacts everything written through `target`. Done here, not at each call site,
 * because the leaks come from objects other code logs: a grammY BotError holds
 * the Api object with its `token`, and a wrapped fetch error has the token in
 * its URL, and both print when passed to console.error.
 */
export function redactConsole(secrets: Array<string | undefined>, target: Console = console): void {
  const redact = createRedactor(secrets);
  for (const method of METHODS) {
    const write = target[method].bind(target);
    target[method] = (...args: unknown[]) => write(redact(format(...args)));
  }
}
