/**
 * How many caller-ID names the server hands each member per UTC day (lookup_usage), to pick
 * LOOKUP_DAILY_LIMIT before setting LOOKUP_DAILY_ENFORCE=true.
 *
 *   docker compose exec api node dist/cli/usage.js        # the last 7 days
 *   docker compose exec api node dist/cli/usage.js 30     # the last 30 days (rows are kept 35)
 *
 * Per day: members who got at least one name, then p50 / p99 / max names per member and how many
 * went past the limit. Members with no names that day are not in the figures.
 */
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';

const days = Number.parseInt(process.argv[2] ?? '7', 10);
if (!Number.isFinite(days) || days < 1) {
  console.error('Usage: usage.js [days]');
  process.exit(2);
}
const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl);

type Stats = { day: string; members: number; p50: number; p99: number; max: number; over: number };

async function main() {
  const since = `(now() AT TIME ZONE 'utc')::date - $1::int + 1`;
  const { rows } = await pool.query<Stats>(
    `SELECT day::text, count(*)::int AS members,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY n) AS p50,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY n) AS p99,
       max(n) AS max, count(*) FILTER (WHERE n > $2)::int AS over
     FROM lookup_usage WHERE day >= ${since} GROUP BY day ORDER BY day`,
    [days, cfg.lookupDailyLimit],
  );
  const { rows: all } = await pool.query<Omit<Stats, 'day'>>(
    `SELECT count(*)::int AS members,
       coalesce(percentile_disc(0.5) WITHIN GROUP (ORDER BY n), 0) AS p50,
       coalesce(percentile_disc(0.99) WITHIN GROUP (ORDER BY n), 0) AS p99,
       coalesce(max(n), 0) AS max, count(*) FILTER (WHERE n > $2)::int AS over
     FROM lookup_usage WHERE day >= ${since}`,
    [days, cfg.lookupDailyLimit],
  );
  const mode = cfg.lookupDailyEnforce ? 'enforced (429 past it)' : 'log only';
  console.log(`LOOKUP_DAILY_LIMIT=${cfg.lookupDailyLimit}, ${mode}. Names per member per UTC day, last ${days} days:`);
  console.log('day          members    p50    p99    max  over');
  const row = (label: string, s: Omit<Stats, 'day'>) =>
    console.log(
      `${label.padEnd(10)} ${String(s.members).padStart(9)} ${String(s.p50).padStart(6)} ${String(s.p99).padStart(6)} ` +
        `${String(s.max).padStart(6)} ${String(s.over).padStart(5)}`,
    );
  for (const r of rows) row(r.day, r);
  row('all days', all[0]);
  console.log(`Suggested limit (max of 3 x p99 and 2000): ${Math.max(3 * all[0].p99, 2000)}.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
