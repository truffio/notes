import type { CommandHandler } from '@notes/core';
import type { Repositories } from '@notes/db';
import { generateToken, hashToken } from './tokens.ts';

export const LOGIN_TOKEN_TTL_MS = 10 * 60 * 1000;

export interface LoginCommandDeps {
  repos: Repositories;
  baseUrl: string;
  now?: () => Date;
}

/** `/login`. The token sits in the URL fragment, which never reaches server logs. */
export function createLoginCommand(deps: LoginCommandDeps): CommandHandler {
  const now = deps.now ?? (() => new Date());
  const baseUrl = deps.baseUrl.replace(/\/+$/u, '');
  return async ({ user }) => {
    const token = generateToken();
    const expiresAt = new Date(now().getTime() + LOGIN_TOKEN_TTL_MS);
    await deps.repos.auth.createLoginToken(user.id, hashToken(token), expiresAt);
    return `Open this link to sign in. It works once and expires in 10 minutes.\n${baseUrl}/login#token=${token}`;
  };
}
