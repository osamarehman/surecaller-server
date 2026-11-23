import pg from 'pg';

// bigint (e.g. count(*)) as JS number; counts here never approach 2^53.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export type Pool = pg.Pool;
export type Client = pg.Pool | pg.PoolClient;

/**
 * Transaction-scoped advisory lock serializing membership changes (register,
 * admin role changes, deletions) so the last-admin and first-admin checks
 * can't race.
 */
export async function lockCircle(c: pg.PoolClient): Promise<void> {
  await c.query('SELECT pg_advisory_xact_lock(424242)');
}

export interface PoolOptions {
  /** Connections in the pool (buildLookups alone runs 8 queries in parallel per lookup). */
  max?: number;
  /** Server-side statement_timeout per connection; 0 = none. Long jobs lift it with noStatementTimeout. */
  statementTimeoutMs?: number;
}

/** How long a query waits for a free pool connection (or a new one to open) before it fails. */
export const CONNECT_TIMEOUT_MS = 5_000;

export function createPool(databaseUrl: string, opts: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: opts.max ?? 25,
    // A request fails fast instead of queueing forever when the pool is used up.
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    ...(opts.statementTimeoutMs ? { statement_timeout: opts.statementTimeoutMs } : {}),
  });
  // An idle client dying (db restart, OOM) emits 'error'; unhandled, it crashes the process.
  pool.on('error', (err) => console.error('idle pg client error:', err.message));
  return pool;
}

/**
 * Runs fn on a dedicated client with no statement_timeout (migrations, name pack builds), and
 * puts the pool's timeout back before the client goes back to the pool.
 */
export async function noStatementTimeout<T>(c: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  await c.query('SET statement_timeout = 0');
  try {
    return await fn();
  } finally {
    // RESET returns to the value the connection started with (the pool's statement_timeout).
    await c.query('RESET statement_timeout').catch(() => {});
  }
}

/** Waits (up to about a minute) until Postgres answers, logging each failed try. */
export async function waitForDb(pool: pg.Pool, log: (m: string) => void): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (attempt >= 30) throw err;
      log(`database not ready (${(err as Error).message}), retrying...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
