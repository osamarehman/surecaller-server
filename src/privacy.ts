import type pg from 'pg';
import { packVault } from './pack.js';
import { reconcilePack } from './pack-build.js';
import { vault } from './vault.js';

/**
 * Leaves a number out of caller ID: adds it to opt_outs, deletes every shared, suggested and
 * directory name for it, and (with PACK_KEY) updates the offline name pack right away so the
 * name leaves phones on their next sync.
 */
export async function optOutNumber(pool: pg.Pool, phone: string) {
  const h = vault().index(phone);
  await pool.query('INSERT INTO opt_outs (phone_hash) VALUES ($1) ON CONFLICT DO NOTHING', [h]);
  const c = await pool.query('DELETE FROM contacts WHERE phone_hash = $1', [h]);
  const n = await pool.query('DELETE FROM name_suggestions WHERE phone_hash = $1', [h]);
  const d = await pool.query('DELETE FROM directory WHERE phone_hash = $1', [h]);
  // null: pack off, or a rebuild already running (the next 15-minute pass picks it up).
  const pack = packVault() ? await reconcilePack(pool) : null;
  return { contacts: c.rowCount ?? 0, suggestions: n.rowCount ?? 0, directory: d.rowCount ?? 0, pack };
}
