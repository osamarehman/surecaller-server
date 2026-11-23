import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { tooManyRequests } from './errors.js';

/**
 * Per-member daily budget on caller-ID names from the server (docs/API.md, "Online answer
 * budget"): every Lookup with a name returned by GET /v1/lookup/:phone, POST /v1/lookup/batch,
 * POST /v1/check, POST /v1/reports and POST /v1/names adds 1 to lookup_usage for the UTC day.
 * Past LOOKUP_DAILY_LIMIT it only logs, unless LOOKUP_DAILY_ENFORCE: then 429 rate_limited with
 * Retry-After to the next UTC midnight.
 */

const TODAY = "(now() AT TIME ZONE 'utc')::date";

/** Seconds from `now` to the next UTC midnight (at least 1). */
export function secondsToUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000));
}

export class LookupBudget {
  /** Members already logged as over the limit today ("user|day"), so each is logged once a day. */
  private logged = new Set<string>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly limit: number,
    private readonly enforce: boolean,
    private readonly log: FastifyBaseLogger,
  ) {}

  private refuse(req: FastifyRequest, reply: FastifyReply): never {
    this.note(req.user.id, 'refused');
    const s = secondsToUtcMidnight();
    reply.header('retry-after', String(s));
    throw tooManyRequests(s * 1000);
  }

  private note(userId: string, what: 'passed' | 'refused') {
    const key = `${userId}|${new Date().toISOString().slice(0, 10)}`;
    if (this.logged.has(key)) return;
    if (this.logged.size > 50_000) this.logged.clear();
    this.logged.add(key);
    this.log.warn(
      { userId, limit: this.limit },
      what === 'refused'
        ? 'lookup budget: member reached LOOKUP_DAILY_LIMIT today; refusing names until UTC midnight'
        : 'lookup budget: member passed LOOKUP_DAILY_LIMIT today (LOOKUP_DAILY_ENFORCE=false: logged only)',
    );
  }

  /** Before the work: when enforcing, refuses a member who has no names left today. */
  async check(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!this.enforce) return;
    const { rows } = await this.pool.query<{ n: number }>(`SELECT n FROM lookup_usage WHERE user_id = $1 AND day = ${TODAY}`, [
      req.user.id,
    ]);
    if ((rows[0]?.n ?? 0) >= this.limit) this.refuse(req, reply);
  }

  /**
   * After the work: counts `names` answers. When enforcing and `mayRefuse`, an answer that would
   * take the member past the limit is refused whole (429) and nothing is counted; otherwise it is
   * counted (a write already done, such as a report, is never undone).
   */
  async charge(req: FastifyRequest, reply: FastifyReply, names: number, mayRefuse = true): Promise<void> {
    if (names <= 0) return;
    const capped = this.enforce && mayRefuse;
    const { rows } = await this.pool.query<{ n: number }>(
      `INSERT INTO lookup_usage AS u (user_id, day, n) SELECT $1::uuid, ${TODAY}, $2::int WHERE NOT $3::boolean OR $2::int <= $4::int
       ON CONFLICT (user_id, day) DO UPDATE SET n = u.n + EXCLUDED.n WHERE NOT $3::boolean OR u.n + EXCLUDED.n <= $4::int
       RETURNING n`,
      [req.user.id, names, capped, this.limit],
    );
    if (!rows[0]) return this.refuse(req, reply);
    const n = rows[0].n;
    if (n > this.limit && n - names <= this.limit && !this.enforce) this.note(req.user.id, 'passed');
  }
}

/** Routes that only old builds should need, counted per member per day in legacy_usage. */
const LEGACY_ROUTES = new Set(['/v1/pack', '/v1/lookup/batch', '/v1/lookup/:phone']);
const LEGACY_FLUSH_MS = 60_000;

/**
 * Counts calls to LEGACY_ROUTES in memory and writes them every minute in one statement, so a
 * request costs no write.
 */
export function legacyUsage(pool: pg.Pool, log: FastifyBaseLogger) {
  let counts = new Map<string, number>();
  const flush = async () => {
    if (!counts.size) return;
    const batch = counts;
    counts = new Map();
    const keys = [...batch.keys()].map((k) => k.split('|'));
    try {
      await pool.query(
        `INSERT INTO legacy_usage AS l (day, route, user_id, calls)
         SELECT ${TODAY}, r, u, c FROM unnest($1::text[], $2::uuid[], $3::int[]) AS t(r, u, c)
         WHERE EXISTS (SELECT 1 FROM users WHERE id = t.u)
         ON CONFLICT (day, route, user_id) DO UPDATE SET calls = l.calls + EXCLUDED.calls`,
        [keys.map((k) => k[0]), keys.map((k) => k[1]), [...batch.values()]],
      );
    } catch (err) {
      log.warn({ err }, 'legacy_usage write failed');
    }
  };
  const timer = setInterval(() => void flush(), LEGACY_FLUSH_MS);
  timer.unref();
  return {
    /** onRequest hook, after authenticate. */
    record: async (req: FastifyRequest) => {
      const route = req.routeOptions.url;
      if (!route || !LEGACY_ROUTES.has(route) || !req.user) return;
      const key = `${route}|${req.user.id}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
    async close() {
      clearInterval(timer);
      await flush();
    },
    flush,
  };
}

/** X-SureCaller-Build as a version code, or null when absent or not a plain positive integer. */
export function appBuild(req: FastifyRequest): number | null {
  const raw = req.headers['x-surecaller-build'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || !/^\d{1,9}$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n > 0 ? n : null;
}
