import type pg from 'pg';
import { packVault } from './pack.js';
import { removeFromPack } from './pack-build.js';
import { vault } from './vault.js';

/**
 * Leaves a number out of caller ID: adds it to opt_outs, deletes every shared, suggested and
 * directory name for it and its handyman listings (their reviews go with them), and (with
 * PACK_KEY) takes it out of the offline name pack right away so the name leaves phones on their
 * next sync: the triggers queue the number as a removal, drained here or by the pack worker,
 * waiting up to `packWaitMs`.
 * `phone` is E.164, as stored.
 */
export async function optOutNumber(pool: pg.Pool, phone: string, packWaitMs = 60_000) {
  const h = vault().index(phone);
  await pool.query('INSERT INTO opt_outs (phone_hash) VALUES ($1) ON CONFLICT DO NOTHING', [h]);
  const c = await pool.query('DELETE FROM contacts WHERE phone_hash = $1', [h]);
  const n = await pool.query('DELETE FROM name_suggestions WHERE phone_hash = $1', [h]);
  const d = await pool.query('DELETE FROM directory WHERE phone_hash = $1', [h]);
  // Listings keep the number in the clear; reviews cascade (ON DELETE CASCADE).
  const hm = await pool.query('DELETE FROM handymen WHERE phone = $1', [phone]);
  // null: pack off. done false: still queued after packWaitMs (the pack worker removes it later).
  const pack = packVault() ? await removeFromPack(pool, h, packWaitMs) : null;
  return {
    contacts: c.rowCount ?? 0,
    suggestions: n.rowCount ?? 0,
    directory: d.rowCount ?? 0,
    handymen: hm.rowCount ?? 0,
    pack,
  };
}
