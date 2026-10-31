import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { migrations } from './schema.ts';

export interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** `exec` runs a script of several statements, which `query` cannot. */
export interface Transaction extends Queryable {
  exec(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  exec(sql: string): Promise<void>;
  /** Commits when `fn` resolves and rolls back when it rejects. */
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
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
    transaction: async <T>(fn: (tx: Transaction) => Promise<T>) => {
      const result = await client.transaction((tx) =>
        fn({
          query: async <R>(sql: string, params: unknown[] = []) => {
            const { rows } = await tx.query<R>(sql, params);
            return { rows };
          },
          exec: async (sql) => {
            await tx.exec(sql);
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
  // An idle connection can drop at any time, such as on a database restart. The
  // pool replaces it, but with no listener this event would crash the process.
  pool.on('error', (error) => console.error('Idle Postgres connection failed:', error.message));
  return {
    query: async <T>(sql: string, params: unknown[] = []) => {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
    exec: async (sql) => {
      await pool.query(sql);
    },
    transaction: async <T>(fn: (tx: Transaction) => Promise<T>) => {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: async <R>(sql: string, params: unknown[] = []) => {
            const { rows } = await client.query(sql, params);
            return { rows: rows as R[] };
          },
          exec: async (sql) => {
            await client.query(sql);
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        // A failed rollback must not hide the real error. The connection may
        // still be inside the transaction, so it is discarded, not reused.
        await client.query('ROLLBACK').catch((rollbackError: Error) => {
          broken = rollbackError;
        });
        throw error;
      } finally {
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
}

/** Arbitrary, and only has to be the same in every process that migrates. */
const MIGRATION_LOCK = 7264301;

/**
 * Runs in one transaction, so a failure leaves the schema as it was. The lock
 * makes a second process, such as the MCP server starting alongside the main
 * one, wait and then find nothing to do.
 */
export async function migrate(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await tx.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY)');
    const { rows } = await tx.query<{ version: number }>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.version));
    for (const [version, sql] of migrations.entries()) {
      if (applied.has(version)) continue;
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    }
  });
}
