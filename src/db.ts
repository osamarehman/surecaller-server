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

export function createPool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  // An idle client dying (db restart, OOM) emits 'error'; unhandled, it crashes the process.
  pool.on('error', (err) => console.error('idle pg client error:', err.message));
  return pool;
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
