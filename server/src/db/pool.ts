import pg from 'pg';
import { config } from '../config.js';

// Return dates/timestamps as JS values but keep DATE columns as 'YYYY-MM-DD' strings so they
// are never shifted by a timezone conversion.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => Number(v));

let pool: pg.Pool | null = null;

export function getPool() {
  if (!pool) pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 20 });
  return pool;
}

export async function closePool() {
  if (pool) await pool.end();
  pool = null;
}

export type Db = pg.PoolClient;

export interface TxScope {
  orgId?: string | null;
  userId?: string | null;
}

/**
 * Runs fn in a transaction with the tenant context set for row-level security.
 * Without an orgId, no tenant-owned rows are visible.
 */
export async function withTx<T>(scope: TxScope, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [
      scope.orgId ?? '',
      scope.userId ?? '',
    ]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await db.query(sql, params);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query(sql, params);
  return r.rows as T[];
}
