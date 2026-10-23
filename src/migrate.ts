import fs from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { ROOT_DIR } from './config.js';
import { vault } from './vault.js';

const MIGRATIONS_DIR = path.join(ROOT_DIR, 'migrations');
const LOCK_ID = 727272;

/** Applies every migrations/*.sql file not yet recorded, in file-name order. */
export async function migrate(pool: pg.Pool, log: (msg: string) => void = () => {}): Promise<void> {
  const client = await pool.connect();
  try {
    // Serialize concurrent starters.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`applied migration ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    await encryptPlainTables(client, log);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

/**
 * Finishes 006_encrypt_contacts.sql: encrypts the rows left in contacts_plain /
 * name_suggestions_plain and drops those tables, in one transaction. Contacts that existed
 * before this (shared under the old family-only terms) are marked family_only.
 */
async function encryptPlainTables(client: pg.PoolClient, log: (msg: string) => void): Promise<void> {
  const { rows: plain } = await client.query<{ t: string | null; s: string | null }>(
    "SELECT to_regclass('contacts_plain') AS t, to_regclass('name_suggestions_plain') AS s",
  );
  if (!plain[0].t && !plain[0].s) return;
  await client.query('BEGIN');
  try {
    let n = 0;
    if (plain[0].t) {
      const { rows } = await client.query<{ user_id: string; phone: string; name: string; updated_at: Date }>(
        'SELECT user_id, phone, name, updated_at FROM contacts_plain',
      );
      if (rows.length) {
        const v = vault();
        await client.query(
          `INSERT INTO contacts (user_id, phone_hash, name_enc, family_only, updated_at)
           SELECT u, h, e, true, t FROM unnest($1::uuid[], $2::bytea[], $3::bytea[], $4::timestamptz[]) AS x(u, h, e, t)`,
          [rows.map((r) => r.user_id), rows.map((r) => v.index(r.phone)),
           rows.map((r) => v.seal(r.phone, r.name)), rows.map((r) => r.updated_at)],
        );
      }
      n += rows.length;
      await client.query('DROP TABLE contacts_plain');
    }
    if (plain[0].s) {
      const { rows } = await client.query<{ user_id: string; phone: string; name: string; created_at: Date }>(
        'SELECT user_id, phone, name, created_at FROM name_suggestions_plain',
      );
      if (rows.length) {
        const v = vault();
        await client.query(
          `INSERT INTO name_suggestions (user_id, phone_hash, name_enc, created_at)
           SELECT u, h, e, t FROM unnest($1::uuid[], $2::bytea[], $3::bytea[], $4::timestamptz[]) AS x(u, h, e, t)`,
          [rows.map((r) => r.user_id), rows.map((r) => v.index(r.phone)),
           rows.map((r) => v.seal(r.phone, r.name)), rows.map((r) => r.created_at)],
        );
      }
      n += rows.length;
      await client.query('DROP TABLE name_suggestions_plain');
    }
    await client.query('COMMIT');
    log(`encrypted ${n} plaintext contact / suggestion rows and dropped the plaintext tables`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`encrypting plaintext contacts failed: ${(err as Error).message}`);
  }
}
