import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPostgresDatabase, migrate } from './client.ts';

/** Stands in for a Postgres pool, recording what reaches the single connection. */
const fake = vi.hoisted(() => ({
  pool: null as unknown as EventEmitter,
  sql: [] as string[],
  released: [] as unknown[],
  failOn: null as RegExp | null,
  failRollback: false,
}));

vi.mock('pg', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  const query = async (sql: string) => {
    fake.sql.push(sql);
    if (fake.failRollback && sql === 'ROLLBACK') throw new Error('connection lost');
    if (fake.failOn?.test(sql)) throw new Error('statement failed');
    return { rows: [] };
  };
  class Pool extends Emitter {
    constructor() {
      super();
      fake.pool = this;
    }
    query = query;
    connect = async () => ({ query, release: (error?: unknown) => fake.released.push(error) });
    end = async () => {};
  }
  return { default: { Pool } };
});

beforeEach(() => {
  fake.sql = [];
  fake.released = [];
  fake.failOn = null;
  fake.failRollback = false;
});

afterEach(() => vi.restoreAllMocks());

describe('createPostgresDatabase', () => {
  it('survives an idle connection dropping', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    createPostgresDatabase('postgres://test');
    // EventEmitter throws on an 'error' event with no listener, which ends the process.
    expect(() => fake.pool.emit('error', new Error('terminating connection'))).not.toThrow();
    expect(log).toHaveBeenCalled();
  });

  it('commits on one connection and releases it for reuse', async () => {
    const db = createPostgresDatabase('postgres://test');
    await db.transaction((tx) => tx.exec('SELECT 1; SELECT 2'));
    expect(fake.sql).toEqual(['BEGIN', 'SELECT 1; SELECT 2', 'COMMIT']);
    expect(fake.released).toEqual([undefined]);
  });

  it('keeps the original error and discards the connection when rollback fails', async () => {
    fake.failRollback = true;
    const db = createPostgresDatabase('postgres://test');
    await expect(db.transaction(() => Promise.reject(new Error('original')))).rejects.toThrow('original');
    expect(fake.released).toEqual([expect.any(Error)]);
  });
});

describe('migrate on Postgres', () => {
  it('runs inside a real transaction, under a lock, with no BEGIN in a script', async () => {
    await migrate(createPostgresDatabase('postgres://test'));
    expect(fake.sql[0]).toBe('BEGIN');
    expect(fake.sql[1]).toContain('pg_advisory_xact_lock');
    expect(fake.sql.at(-1)).toBe('COMMIT');
    expect(fake.sql.slice(1, -1).filter((sql) => /\b(?:BEGIN|COMMIT)\b/u.test(sql))).toEqual([]);
  });

  it('rolls back and returns the connection clean when a migration fails', async () => {
    fake.failOn = /CREATE TABLE users/u;
    await expect(migrate(createPostgresDatabase('postgres://test'))).rejects.toThrow('statement failed');
    expect(fake.sql.at(-1)).toBe('ROLLBACK');
    expect(fake.released).toEqual([undefined]);
  });
});
