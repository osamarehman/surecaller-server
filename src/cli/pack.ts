/**
 * The offline name pack (needs PACK_KEY).
 *
 *   docker compose exec api node dist/cli/pack.js reconcile  # rebuild changed entries now
 *   docker compose exec api node dist/cli/pack.js rotate     # new salt: every phone refetches
 *
 * The server already reconciles every 15 minutes. `rotate` re-hashes every number (Argon2,
 * about 20 ms each per worker, PACK_WORKERS): hours of CPU for a large directory. The old
 * generation keeps serving meanwhile; an interrupted rotate resumes when run again.
 */
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { initPack } from '../pack.js';
import { reconcilePack, rotatePack, type ReconcileResult } from '../pack-build.js';
import { initVault } from '../vault.js';

const cmd = process.argv[2];
if (cmd !== 'reconcile' && cmd !== 'rotate') {
  console.error('Usage: pack.js reconcile | rotate');
  process.exit(2);
}
const cfg = loadConfig();
if (!cfg.packKey) {
  console.error('PACK_KEY is not set: the name pack is off.');
  process.exit(1);
}
initVault(cfg.contactsKey);
initPack(cfg.packKey);
const pool = createPool(cfg.databaseUrl);

const report = (r: ReconcileResult | null) =>
  console.log(
    r
      ? `Salt ${r.saltId}: ${r.entries} entries, ${r.upserted} updated, ${r.deleted} deleted, ` +
          `${r.hashed} hashed, ${r.purged} purged in ${(r.ms / 1000).toFixed(1)} s.`
      : 'Another rebuild is running; try again when it finishes.',
  );

async function main() {
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
