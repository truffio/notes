import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Repositories } from '@notes/db';
import { z } from 'zod';

export interface McpDeps {
  repos: Repositories;
  /** Fixed at startup from the API token. Never taken from tool input. */
  userId: string;
}

/** Same limits as the HTTP API. Postgres rejects a NUL, and a tsquery word over 2046 bytes. */
const MAX_QUERY_LENGTH = 500;
const MAX_TAG_LENGTH = 64;
const noNul = (value: string) => !value.includes('\0');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

const toolError = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
});

/** Resolves a raw API token to its user. Must hash as `/mcptoken` does when it stores one. */
export function authenticate(repos: Repositories, token: string): Promise<string | null> {
  return repos.auth.getUserIdByApiToken(createHash('sha256').update(token).digest('hex'));
}

export function createMcpServer({ repos, userId }: McpDeps): McpServer {
  const server = new McpServer({ name: 'notes', version: '0.0.0' });
  const limit = z.number().int().min(1).max(100).optional();

  server.registerTool(
    'search_notes',
    {
      description: 'Search the notes by text, optionally only those with a tag. Newest first.',
      inputSchema: {
        query: z.string().min(1).max(MAX_QUERY_LENGTH).refine(noNul),
        tag: z.string().max(MAX_TAG_LENGTH).refine(noNul).optional(),
        limit,
      },
      annotations: READ_ONLY,
    },
    async ({ query, tag, limit }) => {
      const page = await repos.notes.list(userId, { q: query, tag, limit });
      return json(page.items);
    },
  );

  server.registerTool(
    'get_note',
    {
      description: 'Get one note by its id.',
      inputSchema: { id: z.string() },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      if (!UUID.test(id)) return toolError('Invalid note id');
      const note = await repos.notes.get(userId, id);
      return note ? json(note) : toolError('Note not found');
    },
  );

  server.registerTool(
    'list_tags',
    {
      description: 'List all tags with the number of notes using each.',
      annotations: READ_ONLY,
    },
    async () => json(await repos.tags.list(userId)),
  );

  server.registerTool(
    'list_recent_notes',
    {
      description: 'List the most recent notes, newest first.',
      inputSchema: { limit },
      annotations: READ_ONLY,
    },
    async ({ limit }) => json((await repos.notes.list(userId, { limit })).items),
  );

  return server;
}
