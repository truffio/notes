import { createHash } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPgliteDatabase, createPostgresDatabase, createRepositories, migrate } from '@notes/db';
import { createMcpServer } from './server.ts';

/** Stdout carries the protocol, so every log goes to stderr. */
const log = (message: string) => process.stderr.write(`[mcp] ${message}\n`);

async function main() {
  const token = process.env.MCP_API_TOKEN;
  if (!token) {
    log('MCP_API_TOKEN is not set');
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  const dataDir = process.env.PGLITE_DATA_DIR;
  if (!databaseUrl && !dataDir) {
    log('Neither DATABASE_URL nor PGLITE_DATA_DIR is set');
    process.exit(1);
  }
  const db = databaseUrl ? createPostgresDatabase(databaseUrl) : createPgliteDatabase(dataDir);
  await migrate(db);

  const repos = createRepositories(db);
  const userId = await repos.auth.getUserIdByApiToken(createHash('sha256').update(token).digest('hex'));
  if (!userId) {
    log('MCP_API_TOKEN is not a valid API token');
    await db.close();
    process.exit(1);
  }

  await createMcpServer({ repos, userId }).connect(new StdioServerTransport());
  log('Ready');
}

main().catch((error: unknown) => {
  log(`Failed to start: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
