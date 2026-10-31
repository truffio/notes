export interface Config {
  telegramToken: string;
  allowedSenderIds: Set<string>;
  baseUrl: string;
  port: number;
  databaseUrl?: string;
  pgliteDataDir: string;
  webRoot?: string;
  webhookSecret?: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

/** Telegram's allowed characters, and long enough that it cannot be guessed. */
const WEBHOOK_SECRET = /^[A-Za-z0-9_-]{32,256}$/;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const allowedSenderIds = new Set(
    required(env, 'TELEGRAM_ALLOWED_USER_IDS')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
  const baseUrl = required(env, 'BASE_URL').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('BASE_URL must start with http:// or https://');
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim() || undefined;
  if (webhookSecret && !WEBHOOK_SECRET.test(webhookSecret)) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET needs 32 to 256 letters, digits, _ or -');
  }
  if (webhookSecret && !baseUrl.startsWith('https:')) throw new Error('Webhook mode needs an https BASE_URL');

  return {
    telegramToken: required(env, 'TELEGRAM_BOT_TOKEN'),
    allowedSenderIds,
    baseUrl,
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    pgliteDataDir: env.PGLITE_DATA_DIR?.trim() || '.data/pglite',
    webRoot: env.WEB_ROOT?.trim() || undefined,
    webhookSecret,
  };
}
