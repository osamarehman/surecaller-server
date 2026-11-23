/**
 * The offline name pack (needs PACK_KEY).
 *
 *   docker compose exec pack-worker node dist/cli/pack.js reconcile  # full pass now
 *   docker compose exec pack-worker node dist/cli/pack.js rotate     # new salt: every phone refetches
 *   docker compose exec pack-worker node dist/cli/pack.js revoke <phone or user id>    # format 2: no key, no pack
 *   docker compose exec pack-worker node dist/cli/pack.js unrevoke <phone or user id>
 *
 * The pack worker (src/pack-runner.ts) already rebuilds queued numbers within seconds and runs a
 * full pass nightly; `reconcile` waits for nobody and says so when the worker holds the lock.
 * `rotate` re-hashes every number (Argon2,
 * about 20 ms each per worker, PACK_WORKERS): hours of CPU for a large directory. The old
 * generation keeps serving meanwhile; an interrupted rotate resumes when run again. It rotates the
 * format-1 salt only: format 2 rotates when a new key goes to the front of PACK_APP_KEYS.
 * `revoke` makes POST /v1/pack/key and the format-2 pack routes answer 403 pack_key_denied
 * (reason revoked) for that account; it can't take back a key the account already has (only a
 * key rotation does).
 */
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { initAppKeys, initPack } from '../pack.js';
import { reconcilePack, rotatePack, type ReconcileResult } from '../pack-build.js';
import { normalizePhone } from '../phone.js';
import { UUID_RE } from '../users.js';
import { initVault } from '../vault.js';

const cmd = process.argv[2];
if (cmd !== 'reconcile' && cmd !== 'rotate' && cmd !== 'revoke' && cmd !== 'unrevoke') {
  console.error('Usage: pack.js reconcile | rotate | revoke <phone or user id> | unrevoke <phone or user id>');
  process.exit(2);
}
const cfg = loadConfig();
if (!cfg.packKey && (cmd === 'reconcile' || cmd === 'rotate')) {
  console.error('PACK_KEY is not set: the name pack is off.');
  process.exit(1);
}
initVault(cfg.contactsKey);
initPack(cfg.packKey);
initAppKeys(cfg.packAppKeys);
const pool = createPool(cfg.databaseUrl);

const report = (r: ReconcileResult | null) =>
  console.log(
    r
      ? `Salt ${r.saltId}: ${r.entries} entries, ${r.upserted} updated, ${r.deleted} deleted, ` +
          `${r.hashed} hashed, ${r.purged} purged in ${(r.ms / 1000).toFixed(1)} s.` +
          (r.format2 ?? []).map((f) => ` Format 2 (salt ${f.saltId}): ${f.entries} entries, ${f.upserted} updated.`).join('')
      : 'Another rebuild is running; try again when it finishes.',
  );

async function revoke(who: string | undefined, on: boolean) {
  const phone = who && !UUID_RE.test(who) ? normalizePhone(who, cfg.defaultRegion) : null;
  if (!who || (!UUID_RE.test(who) && !phone)) {
    console.error(`Usage: pack.js ${cmd} <phone or user id>`);
    process.exitCode = 2;
    return;
  }
  const { rows } = await pool.query<{ id: string; name: string }>(
    `UPDATE users SET pack_revoked_at = CASE WHEN $2 THEN coalesce(pack_revoked_at, now()) END
     WHERE ${phone ? 'phone = $1' : 'id = $1::uuid'} RETURNING id, name`,
    [phone ?? who, on],
  );
  if (!rows[0]) {
    console.error('No such account.');
    process.exitCode = 1;
    return;
  }
  console.log(
    on
      ? `Revoked: ${rows[0].name} (${rows[0].id}) gets no pack key and no format-2 pack from now on. ` +
          'A key already handed out stays usable until the next key rotation.'
      : `Allowed again: ${rows[0].name} (${rows[0].id}).`,
  );
}

async function main() {
  if (cmd === 'revoke' || cmd === 'unrevoke') return revoke(process.argv[3], cmd === 'revoke');
  if (cmd === 'rotate') {
    console.log('Building a new salt generation; the current one keeps serving until it is ready...');
    report(await rotatePack(pool));
    console.log('Swapped in: every phone will refetch the pack. Catching up on changes made meanwhile...');
  }
  report(await reconcilePack(pool));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
