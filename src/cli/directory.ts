/**
 * Loads the business directory from newline-delimited JSON on stdin, one
 * {"phone","name","category"} per line, best first. Replaces what was there.
 *
 *   docker compose exec -T api node dist/cli/directory.js import < directory.ndjson
 *
 * Build the file from Overture Maps with scripts/overture-directory.sql (see README).
 */
import readline from 'node:readline';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { importDirectory, type DirectoryEntry } from '../directory.js';
import { initVault } from '../vault.js';
import { initPack } from '../pack.js';
import { reconcilePack } from '../pack-build.js';

if (process.argv[2] !== 'import') {
  console.error('Usage: directory.js import < file.ndjson');
  process.exit(2);
}
const cfg = loadConfig();
initVault(cfg.contactsKey);
initPack(cfg.packKey);
const pool = createPool(cfg.databaseUrl);

async function main() {
  const entries: DirectoryEntry[] = [];
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (line.trim()) entries.push(JSON.parse(line));
  }
  const n = await importDirectory(pool, entries, cfg.defaultRegion);
  console.log(`Read ${entries.length} entries; the directory now has ${n} numbers.`);
  if (cfg.packKey) {
    console.log('Updating the offline name pack (new numbers need an Argon2 hash each; this can take a while)...');
    const r = await reconcilePack(pool);
    console.log(
      r
        ? `Name pack: ${r.entries} entries, ${r.upserted} updated, ${r.deleted} deleted, ${r.hashed} hashed in ${r.ms} ms.`
        : 'Name pack: another rebuild is running; it picks up the new directory on its next pass.',
    );
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
