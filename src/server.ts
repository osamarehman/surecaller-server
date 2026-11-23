import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool, waitForDb } from './db.js';
import { refreshSpamDetails, syncSpamRules } from './lookup.js';
import { migrate } from './migrate.js';
import { startPackRunner, type PackRunner } from './pack-runner.js';

const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;
/** How often /v1/sync?v=2's spam details (calls in the last 24 h) are recomputed. */
const SPAM_DETAILS_EVERY_MS = 60 * 60 * 1000;
/** How often the API checks that something drains the name pack queue (pack-worker or PACK_INLINE). */
const PACK_WATCH_EVERY_MS = 60 * 60 * 1000;
/** A queued number older than this (seconds) means nothing is draining. */
const PACK_STALE_S = 10 * 60;

async function main() {
  const cfg = loadConfig();
  const pool = createPool(cfg.databaseUrl, { max: cfg.dbPoolMax, statementTimeoutMs: cfg.dbStatementTimeoutMs });
  const app = await buildApp(cfg, pool);
  const log = (m: string) => app.log.info(m);

  await waitForDb(pool, log);
  await migrate(pool, log);
  // 019_google_identity.sql makes the one-account-per-email index unique only when no two
  // accounts share an address; until the duplicates are merged it stays a plain index.
  const { rows: canonicalIndex } = await pool.query("SELECT to_regclass('users_email_canonical_unique') AS i");
  if (!canonicalIndex[0].i) {
    app.log.warn(
      'users_email_canonical_unique is missing: some accounts share an email address (email_canonical), so ' +
        'one account per email is not enforced for them. Merge or change those emails, then create the index ' +
        '(see migrations/019_google_identity.sql).',
    );
  }
  // SPAM_REPORTERS changed since the last start: relabel every reported number so /v1/sync sends it.
  const relabelled = await syncSpamRules(pool, cfg.spamThreshold);
  if (relabelled !== null) log(`SPAM_REPORTERS=${cfg.spamReporters}: recomputed spam state for ${relabelled} numbers`);
  // /v1/sync?v=2 spam details (not-spam votes, last comment, calls in 24 h): now, then hourly.
  const spamDetails = async () => {
    try {
      const n = await refreshSpamDetails(pool);
      if (n) log(`spam details: refreshed ${n} labelled numbers for /v1/sync?v=2`);
    } catch (err) {
      app.log.warn({ err }, 'spam details refresh failed');
    }
  };
  await spamDetails();
  setInterval(spamDetails, SPAM_DETAILS_EVERY_MS).unref();
  // Key ids only: a key value never goes to a log.
  log(
    cfg.packAppKeys.length
      ? `name pack format 2: on, PACK_APP_KEYS ids ${cfg.packAppKeys.map((k) => k.id).join(', ')}, ` +
          `PACK_KEY_HOLDERS=${cfg.packKeyHolders}, LOOKUP_MODE=${cfg.lookupMode}`
      : 'name pack format 2: off (no PACK_APP_KEYS); /v1/pack/key, head, manifest, changes and parts answer 404',
  );
  // Per-IP rate limits key on req.ip, which this setting decides (see README, "Client IP behind a proxy").
  log(
    `TRUST_PROXY=${cfg.trustProxy === false ? 'off' : String(cfg.trustProxy)}: ` +
      (cfg.trustProxy === false
        ? 'client IP is the socket address (X-Forwarded-For ignored)'
        : typeof cfg.trustProxy === 'number'
          ? `client IP is taken ${cfg.trustProxy} hop(s) back in X-Forwarded-For`
          : 'client IP is taken from X-Forwarded-For'),
  );
  if (cfg.trustProxy === true) {
    app.log.warn(
      'TRUST_PROXY=true trusts every X-Forwarded-For hop, so clients can forge their IP and dodge per-IP ' +
        'rate limits. Set the proxy hop count instead (e.g. 2 for Cloudflare + Caddy).',
    );
  }
  if (!cfg.adminCode) {
    app.log.warn('ADMIN_CODE is not set: nobody can become the first admin until you set it.');
  }
  if (!cfg.publicUrl) {
    app.log.warn(
      'PUBLIC_URL is not set: GET /v1/app/latest answers 503 for a relative apkUrl in downloads/latest.json ' +
        '(phones refuse a Host-derived http:// link). Set it to the https:// address the phones use.',
    );
  }

  const prune = async () => {
    try {
      const l = await pool.query("DELETE FROM lookups WHERE created_at < now() - interval '2 days'");
      const e = await pool.query("DELETE FROM events WHERE created_at < now() - interval '8 days'");
      const i = await pool.query(
        "DELETE FROM invites WHERE expires_at < now() - interval '30 days'",
      );
      const t = await pool.query(
        "DELETE FROM telemetry WHERE received_at < now() - make_interval(days => $1)",
        [cfg.telemetryRetentionDays],
      );
      await pool.query('DELETE FROM email_codes WHERE expires_at < now()');
      await pool.query("DELETE FROM email_code_limits WHERE day < (now() AT TIME ZONE 'utc')::date - 1");
      // Long enough to read a few weeks of the daily name budget (cli/usage.js) and of old-route use.
      await pool.query("DELETE FROM lookup_usage WHERE day < (now() AT TIME ZONE 'utc')::date - 35");
      await pool.query("DELETE FROM legacy_usage WHERE day < (now() AT TIME ZONE 'utc')::date - 120");
      if (l.rowCount || e.rowCount || i.rowCount || t.rowCount) {
        log(
          `pruned ${l.rowCount} lookups, ${e.rowCount} events, ${i.rowCount} invites, ${t.rowCount} telemetry rows`,
        );
      }
    } catch (err) {
      app.log.warn({ err }, 'prune failed');
    }
  };
  await prune();
  const timer = setInterval(prune, PRUNE_EVERY_MS);
  timer.unref();

  // Offline name pack (only with PACK_KEY): the pack-worker service builds it (src/pack-runner.ts).
  // PACK_INLINE=true runs that loop in this process instead, for a deployment without the service.
  let packRunner: PackRunner | null = null;
  let packTimer: NodeJS.Timeout | undefined;
  if (cfg.packKey && cfg.packInline) {
    packRunner = startPackRunner(pool, cfg.databaseUrl, { info: log, error: (m) => app.log.error(m) });
    log('name pack: PACK_INLINE=true, so this API process builds the pack (no pack-worker needed)');
  } else if (cfg.packKey) {
    log('name pack: built by the pack-worker service (PACK_INLINE=false)');
    const watch = async () => {
      try {
        const { rows } = await pool.query<{ age: number | null }>(
          'SELECT extract(epoch FROM now() - min(queued_at))::int AS age FROM pack_dirty',
        );
        const age = rows[0].age;
        if (age !== null && age > PACK_STALE_S) {
          app.log.warn(
            `name pack: numbers have waited ${Math.round(age / 60)} min in pack_dirty: the pack-worker is not running, ` +
              'or is busy with a long full pass (docker compose logs pack-worker). Start it ' +
              '(docker compose up -d pack-worker), or set PACK_INLINE=true.',
          );
        }
      } catch (err) {
        app.log.warn({ err }, 'name pack queue check failed');
      }
    };
    setTimeout(watch, 15 * 60_000).unref();
    packTimer = setInterval(watch, PACK_WATCH_EVERY_MS);
    packTimer.unref();
  }

  await app.listen({ port: cfg.port, host: cfg.host });

  const shutdown = async (sig: string) => {
    log(`${sig} received, shutting down`);
    clearInterval(timer);
    clearInterval(packTimer);
    await packRunner?.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
