/**
 * Read phone telemetry from the database in a terminal.
 *
 *   docker compose exec api node dist/cli/logs.js --installs
 *   docker compose exec api node dist/cli/logs.js --level error --since 2h --details
 *   docker compose exec api node dist/cli/logs.js --follow
 *
 * Run with --help for every flag.
 */
import { parseArgs } from 'node:util';
import { databaseUrlFromEnv } from '../config.js';
import { createPool } from '../db.js';
import { LEVELS, queryInstalls, queryTelemetry, type Level, type TelemetryEvent } from '../routes/telemetry.js';

const HELP = `Usage: node dist/cli/logs.js [options]

  --installs          One line per phone: user, device, app version, last seen, errors in 24h
  --install <id>      Only this install (full id or a unique prefix)
  --user <name|id>    Only this member (name, or id prefix)
  --level <min>       Minimum level: ${LEVELS.join(' | ')}
  --tag <tag>         Only this tag (e.g. startup, api, screening)
  --since <time>      30m, 2h, 3d or an ISO time (default 24h)
  --q <text>          Message contains this text (case-insensitive)
  --limit <n>         Max events (default 100)
  --follow, -f        Keep printing new events every 3 seconds
  --details, -d       Print details (stack traces, context) under each event
  --json              One JSON object per line instead of text
  --help, -h          This help`;

const { values: o } = parseArgs({
  options: {
    installs: { type: 'boolean' },
    install: { type: 'string' },
    user: { type: 'string' },
    level: { type: 'string' },
    tag: { type: 'string' },
    since: { type: 'string', default: '24h' },
    q: { type: 'string' },
    limit: { type: 'string', default: '100' },
    follow: { type: 'boolean', short: 'f' },
    details: { type: 'boolean', short: 'd' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function parseSinceArg(raw: string): Date {
  const m = /^(\d+)\s*([smhd])$/i.exec(raw.trim());
  if (m) {
    const unit = { s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase() as 's' | 'm' | 'h' | 'd'];
    return new Date(Date.now() - Number(m[1]) * unit * 1000);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) fail(`--since: use 30m, 2h, 3d or an ISO time, not "${raw}"`);
  return d;
}

const tty = process.stdout.isTTY;
const COLORS: Record<Level, string> = { debug: '90', info: '0', warn: '33', error: '31', fatal: '1;35' };
const paint = (level: Level, s: string) => (tty ? `\x1b[${COLORS[level]}m${s}\x1b[0m` : s);
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

function timeLabel(d: Date): string {
  const iso = d.toISOString();
  const today = iso.slice(0, 10) === new Date().toISOString().slice(0, 10);
  return today ? iso.slice(11, 19) : `${iso.slice(5, 10)} ${iso.slice(11, 19)}`;
}

/**
 * Phone-supplied text with C0 control characters (except tab) and DEL removed, so a
 * report can't move the cursor, clear the screen or fake other log lines.
 */
const safe = (s: string | null | undefined): string => (s ?? '').replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, ' ');

function print(r: TelemetryEvent) {
  if (o.json) {
    console.log(JSON.stringify(r));
    return;
  }
  const who = [r.userName ?? r.installId.slice(0, 8), r.device, r.appVersion].filter(Boolean).map(safe).join(' / ');
  const head = `${timeLabel(r.at)} ${pad(r.level, 5)} ${pad(r.source, 6)} ${pad(safe(r.tag) || '-', 12)} [${who}]`;
  console.log(paint(r.level, `${head} ${safe(r.message)}`));
  if (o.details && r.details) {
    const { stack, ...rest } = r.details as { stack?: unknown };
    if (Object.keys(rest).length) console.log(`    ${safe(JSON.stringify(rest))}`);
    if (typeof stack === 'string') {
      for (const line of stack.split(/\r?\n/)) console.log(`    ${safe(line)}`);
    }
  }
}

async function main() {
  if (o.help) {
    console.log(HELP);
    return;
  }
  const pool = createPool(databaseUrlFromEnv());
  try {
    if (o.installs) {
      const rows = await queryInstalls(pool);
      if (o.json) {
        for (const r of rows) console.log(JSON.stringify(r));
        return;
      }
      console.log('INSTALL   USER             DEVICE                    VERSION      LAST SEEN (UTC)      ERR24H EV24H');
      for (const r of rows) {
        console.log(
          [
            pad(safe(r.installId.slice(0, 8)), 9),
            pad(safe(r.userName) || '(not signed in)', 16),
            pad(safe(r.device) || '?', 25),
            pad(safe(r.appVersion) || '?', 12),
            pad(r.lastSeenAt.toISOString().slice(0, 19).replace('T', ' '), 20),
            pad(String(r.errors24h), 6),
            String(r.events24h),
          ].join(' '),
        );
      }
      return;
    }

    const level = o.level as Level | undefined;
    if (level && !LEVELS.includes(level)) fail(`--level must be one of ${LEVELS.join(', ')}`);
    const limit = Number.parseInt(o.limit!, 10);
    if (!Number.isInteger(limit) || limit < 1) fail('--limit must be a positive number');

    let installId: string | null = null;
    if (o.install) {
      const { rows } = await pool.query<{ install_id: string }>(
        // left() rather than LIKE: an id containing % or _ is matched literally.
        'SELECT DISTINCT install_id FROM telemetry WHERE left(install_id, length($1)) = $1 LIMIT 2',
        [o.install],
      );
      if (rows.length !== 1) fail(rows.length ? `--install ${o.install} matches several installs` : 'No such install');
      installId = rows[0].install_id;
    }
    let userId: string | null = null;
    if (o.user) {
      const { rows } = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM users WHERE lower(name) = lower($1) OR id::text LIKE lower($1) || '%' LIMIT 2`,
        [o.user],
      );
      if (rows.length !== 1) {
        fail(rows.length ? `--user ${o.user} matches ${rows.map((r) => r.name).join(', ')}` : 'No such member');
      }
      userId = rows[0].id;
    }

    const filter = {
      installId,
      userId,
      minLevel: level ?? null,
      tag: o.tag ?? null,
      since: parseSinceArg(o.since!),
      q: o.q ?? null,
      limit,
    };
    const first = await queryTelemetry(pool, filter);
    first.reverse().forEach(print); // oldest first, like a log file
    if (!o.follow) return;

    // Nothing matched yet: start after the newest row overall, not from the beginning.
    let lastId = first.length
      ? first[first.length - 1].id
      : (await pool.query<{ id: number }>('SELECT coalesce(max(id), 0) AS id FROM telemetry')).rows[0].id;
    const PAGE = 1000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      // Oldest first after lastId; keep paging while full pages come back.
      let fresh: TelemetryEvent[];
      do {
        fresh = await queryTelemetry(pool, { ...filter, since: null, afterId: lastId, limit: PAGE });
        fresh.forEach(print);
        if (fresh.length) lastId = fresh[fresh.length - 1].id;
      } while (fresh.length === PAGE);
    }
  } finally {
    if (!o.follow) await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
