/**
 * Lists one member's own contacts whose names carry a trade ("Ali Plumber", "Bilal AC wala")
 * as handymen in a city. Dry run by default; --apply inserts. Contract: docs/HANDYMAN.md.
 *
 *   docker compose exec api node dist/cli/handymen-seed.js --user <id|phone> --city Hyderabad [--apply]
 */
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { initVault, vault } from '../vault.js';
import { initPack, packVault } from '../pack.js';
import { maskPhone, normalizePhone } from '../phone.js';
import { classifyTrade, tidy } from '../routes/handymen.js';

const { values: a } = parseArgs({
  options: { user: { type: 'string' }, city: { type: 'string' }, apply: { type: 'boolean', default: false } },
});
if (!a.user || !a.city) {
  console.error('Usage: handymen-seed.js --user <id|phone> --city <city> [--apply]');
  process.exit(2);
}
const cfg = loadConfig();
initVault(cfg.contactsKey);
initPack(cfg.packKey);
const pool = createPool(cfg.databaseUrl);


async function main() {
  const pv = packVault();
  if (!pv) throw new Error('PACK_KEY is not set: contact numbers can only be read through the name pack key');
  const city = tidy(a.city!);
  const user = (
    await pool.query<{ id: string; name: string }>('SELECT id, name FROM users WHERE id::text = $1 OR phone = $1', [
      a.user!.trim(),
    ])
  ).rows[0];
  if (!user) throw new Error(`No user ${a.user}`);

  const { rows } = await pool.query<{ name_enc: Buffer; phone_enc: Buffer | null }>(
    'SELECT name_enc, phone_enc FROM contacts WHERE user_id = $1',
    [user.id],
  );
  const listed = new Set(
    (await pool.query<{ phone: string }>('SELECT phone FROM handymen')).rows.map((r) => r.phone),
  );
  const found = new Map<string, { name: string; phone: string; category: string; keyword: string }>();
  let noPhone = 0;
  let skipped = 0;
  for (const r of rows) {
    const phone = r.phone_enc && pv.openPhone(r.phone_enc);
    if (!phone) {
      noPhone++;
      continue;
    }
    const contactName = vault().open(phone, r.name_enc);
    const t = contactName && classifyTrade(contactName);
    if (!t) continue;
    const p = normalizePhone(phone, cfg.defaultRegion);
    const out = p && (await pool.query('SELECT 1 FROM opt_outs WHERE phone_hash = $1', [vault().index(p)])).rowCount;
    if (!p || out || listed.has(p) || found.has(p)) {
      skipped++;
      continue;
    }
    found.set(p, { name: t.name.slice(0, 60), phone: p, category: t.category, keyword: t.keyword });
  }

  console.log(`${user.name}: ${rows.length} contacts, ${noPhone} without a readable number (not re-uploaded yet).`);
  console.log(`Trade contacts for ${city}: ${found.size} (skipped ${skipped}: opted out, already listed or bad number).\n`);
  const list = [...found.values()].sort((x, y) => x.category.localeCompare(y.category) || x.name.localeCompare(y.name));
  for (const h of list) console.log([h.category.padEnd(14), maskPhone(h.phone), h.name.padEnd(30), `(${h.keyword})`].join('  '));
  const counts = new Map<string, number>();
  for (const h of list) counts.set(h.category, (counts.get(h.category) ?? 0) + 1);
  console.log('\nPer category:', Object.fromEntries(counts));

  if (!a.apply) return console.log('\nDry run. Add --apply to list them.');
  let added = 0;
  for (const h of list) {
    const r = await pool.query(
      `INSERT INTO handymen (name, phone, city, category, area, added_by) VALUES ($1, $2, $3, $4, '', $5)
       ON CONFLICT (phone, city, category) DO NOTHING`,
      [h.name, h.phone, city, h.category, user.id],
    );
    added += r.rowCount ?? 0;
  }
  console.log(`\nListed ${added} handymen in ${city}.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
