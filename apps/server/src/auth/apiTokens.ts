import type { CommandHandler } from '@notes/core';
import type { Repositories } from '@notes/db';
import { generateToken, hashToken } from './tokens.ts';

const MAX_NAME_LENGTH = 64;

export interface McpTokenCommandDeps {
  repos: Repositories;
}

/** `/mcptoken <name>`. The token is shown once here and cannot be recovered. */
export function createMcpTokenCommand(deps: McpTokenCommandDeps): CommandHandler {
  return async ({ user, args }) => {
    const name = args.trim();
    if (name === '' || name.length > MAX_NAME_LENGTH || name.includes('\0')) {
      return `Usage: /mcptoken <name>, with a name of up to ${MAX_NAME_LENGTH} characters.`;
    }
    const token = generateToken();
    await deps.repos.auth.createApiToken(user.id, hashToken(token), name);
    return `MCP token "${name}". Copy it now, it will not be shown again.\n${token}`;
  };
}
