import type pg from 'pg';
import type { CountryCode } from 'libphonenumber-js';
import { withTx } from './db.js';
import { normalizePhone } from './phone.js';
import { vault } from './vault.js';

export interface DirectoryEntry {
  phone: string;
  name: string;
  category?: string | null;
}

/**
 * Replaces the business directory with `entries`. The first entry for a number wins, so pass
 * them best first. Skips unparsable numbers, blank names and opted-out numbers.
 */
export async function importDirectory(pool: pg.Pool, entries: Iterable<DirectoryEntry>, region: CountryCode) {
  const v = vault();
  const seen = new Set<string>();
  const rows: { h: Buffer; e: Buffer; c: string | null }[] = [];
  for (const x of entries) {
    const phone = normalizePhone(x.phone, region);
    const name = x.name?.trim().slice(0, 100);
    if (!phone || !name || seen.has(phone)) continue;
    seen.add(phone);
    rows.push({ h: v.index(phone), e: v.seal(phone, name), c: x.category?.replace(/_/g, ' ').slice(0, 60) || null });
  }
  return withTx(pool, async (c) => {
    await c.query('TRUNCATE directory');
    for (let i = 0; i < rows.length; i += 5000) {
      const b = rows.slice(i, i + 5000);
      await c.query(
        `INSERT INTO directory (phone_hash, name_enc, category)
         SELECT h, e, cat FROM unnest($1::bytea[], $2::bytea[], $3::text[]) AS t(h, e, cat)
         WHERE NOT EXISTS (SELECT 1 FROM opt_outs o WHERE o.phone_hash = t.h)`,
        [b.map((r) => r.h), b.map((r) => r.e), b.map((r) => r.c)],
      );
    }
    return (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM directory')).rows[0].n;
  });
}
