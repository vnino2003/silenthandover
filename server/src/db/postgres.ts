import pg from 'pg';
import type { Db, Queryable } from './types';
import { userClaims } from './types';

// DATE as plain 'YYYY-MM-DD' strings, not local-midnight Date objects.
pg.types.setTypeParser(1082, (v) => v);

/**
 * Production database: Supabase PostgreSQL through its connection pooler.
 * DATABASE_URL must use the `postgres` role so that `set local role authenticated` is allowed.
 */
export function createPostgresDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10, ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false } });

  async function tx<T>(prepare: (q: Queryable) => Promise<void>, fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    const q: Queryable = {
      query: async <R>(sql: string, params?: unknown[]) => (await client.query(sql, params as unknown[])).rows as R[],
    };
    try {
      await client.query('begin');
      await client.query(`set local timezone = 'UTC'`);
      await prepare(q);
      const result = await fn(q);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    kind: 'postgres',
    asUser: (userId, fn) =>
      tx(async (q) => {
        await q.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [
          userClaims(userId),
          userId,
        ]);
        await q.query('set local role authenticated');
      }, fn),
    asService: (fn) => tx(async () => {}, fn),
    exec: async (sql) => {
      await pool.query(sql);
    },
    close: () => pool.end(),
  };
}
