/**
 * Handle deletion and removal requests sent from the website.
 *
 *   docker compose exec api node dist/cli/privacy.js            # list pending requests
 *   docker compose exec api node dist/cli/privacy.js apply <id> # after checking the number is theirs
 *   docker compose exec api node dist/cli/privacy.js reject <id>
 *
 * apply, kind "account": deletes that member (same as Delete account in the app).
 * apply, kind "remove":  adds the number to opt_outs and deletes every shared and directory name for it.
 * Either way the request row is deleted afterwards, so the phone and email don't linger.
 */
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { deleteMember } from '../routes/me.js';
import { initPack } from '../pack.js';
import { optOutNumber } from '../privacy.js';
import { initVault } from '../vault.js';

const [cmd = 'list', idArg] = process.argv.slice(2);
const cfg = loadConfig();
initVault(cfg.contactsKey);
initPack(cfg.packKey);
const pool = createPool(cfg.databaseUrl);

type Req = { id: string; kind: 'account' | 'remove'; phone: string; email: string; created_at: Date };

async function main() {
  if (cmd === 'list') {
    const { rows } = await pool.query<Req>('SELECT * FROM privacy_requests ORDER BY created_at');
    if (!rows.length) return console.log('No pending requests.');
    for (const r of rows) {
      const days = Math.floor((Date.now() - r.created_at.getTime()) / 86_400_000);
      console.log(`#${r.id}  ${r.kind.padEnd(7)}  ${r.phone}  ${r.email}  ${days}d old (30d limit)`);
    }
    return;
  }
  if ((cmd !== 'apply' && cmd !== 'reject') || !/^\d+$/.test(idArg ?? '')) {
    console.error('Usage: privacy.js [list | apply <id> | reject <id>]');
    process.exit(2);
  }
  const r = (await pool.query<Req>('SELECT * FROM privacy_requests WHERE id = $1', [idArg])).rows[0];
  if (!r) throw new Error(`No request #${idArg}`);

  if (cmd === 'apply' && r.kind === 'account') {
    const user = (await pool.query<{ id: string }>('SELECT id FROM users WHERE phone = $1', [r.phone])).rows[0];
    if (user) await deleteMember(pool, user.id, cfg.spamThreshold);
    console.log(user ? `Deleted the account for ${r.phone}.` : `No account for ${r.phone}; nothing to delete.`);
  } else if (cmd === 'apply') {
    const x = await optOutNumber(pool, r.phone);
    console.log(
      `Opted out ${r.phone}: removed ${x.contacts} shared contacts, ${x.suggestions} name suggestions and ${x.directory} directory entries.`,
    );
    if (cfg.packKey) {
      console.log(
        x.pack
          ? `Name pack updated: ${x.pack.deleted} entries deleted.`
          : 'Name pack: a rebuild is already running; the next one (within 15 minutes) removes the name.',
      );
    }
  }
  await pool.query('DELETE FROM privacy_requests WHERE id = $1', [r.id]);
  console.log(`Request #${r.id} closed. Email ${r.email} to confirm.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
