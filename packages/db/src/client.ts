import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { migrations } from './schema.ts';

export interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Database extends Queryable {
  exec(sql: string): Promise<void>;
  /** Commits when `fn` resolves and rolls back when it rejects. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
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
    transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
      const result = await client.transaction((tx) =>
        fn({
          query: async <R>(sql: string, params: unknown[] = []) => {
            const { rows } = await tx.query<R>(sql, params);
            return { rows };
          },
        }),
      );
      return result as T;
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
    transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: async <R>(sql: string, params: unknown[] = []) => {
            const { rows } = await client.query(sql, params);
            return { rows: rows as R[] };
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
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
