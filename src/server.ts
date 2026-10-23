import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';

const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;

async function waitForDb(pool: ReturnType<typeof createPool>, log: (m: string) => void) {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (attempt >= 30) throw err;
      log(`database not ready (${(err as Error).message}), retrying...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  const cfg = loadConfig();
  const pool = createPool(cfg.databaseUrl);
  const app = await buildApp(cfg, pool);
  const log = (m: string) => app.log.info(m);

  await waitForDb(pool, log);
  await migrate(pool, log);
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

  await app.listen({ port: cfg.port, host: cfg.host });

  const shutdown = async (sig: string) => {
    log(`${sig} received, shutting down`);
    clearInterval(timer);
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
