import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { migrations } from './schema.ts';

export interface Database {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** In-memory when `dataDir` is omitted. Used for tests and local development. */
export function createPgliteDatabase(dataDir?: string): Database {
  const client = new PGlite(dataDir);
  return {
    query: async <T>(sql: string, params: unknown[] = []) => {
      const result = await client.query<T>(sql, params);
      return { rows: result.rows };
    },
    exec: async (sql) => {
      await client.exec(sql);
    },
    close: () => client.close(),
  };
}

export function createPostgresDatabase(connectionString: string): Database {
  const pool = new pg.Pool({ connectionString });
  return {
    query: async <T>(sql: string, params: unknown[] = []) => {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
    exec: async (sql) => {
      await pool.query(sql);
    },
    close: () => pool.end(),
  };
}

export async function migrate(db: Database): Promise<void> {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY)');
  const { rows } = await db.query<{ version: number }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.version));
  for (const [version, sql] of migrations.entries()) {
    if (applied.has(version)) continue;
    await db.exec(`BEGIN; ${sql}; INSERT INTO schema_migrations (version) VALUES (${version}); COMMIT;`);
  }
}
