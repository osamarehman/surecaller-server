import type { FastifyInstance } from 'fastify';
import { AppError, badRequest } from '../errors.js';
import { packMeta, PackKeyMismatch, servingMeta } from '../pack-build.js';
import { packVault } from '../pack.js';

export const PACK_MAX_LIMIT = 20_000;
/** Rows a member may download per UTC day: this many times the pack they can see, at least the floor. */
export const PACK_QUOTA_FACTOR = 5;
export const PACK_QUOTA_FLOOR = 50_000;
const MAGIC = Buffer.from('SCNP', 'ascii');
const FLAG_RESET = 1;
const FLAG_MORE = 2;

function intParam(raw: string | undefined, name: string, def: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return def;
  if (!/^\d{1,15}$/.test(raw)) throw badRequest(`invalid_${name}`, `${name} must be a whole number`);
  return Math.min(max, Math.max(min, Number(raw)));
}

interface EntryRow {
  id: number;
  seq: number;
  scope: string | null;
  tag: Buffer | null;
  blob: Buffer | null;
  deleted: boolean;
}

/** GET /v1/pack: the offline name pack, binary (format in docs/API.md). */
export async function packRoutes(app: FastifyInstance) {
  const { pool } = app.ctx;

  app.get<{ Querystring: { since?: string; limit?: string } }>('/pack', async (req, reply) => {
    if (!packVault()) throw new AppError(404, 'pack_disabled', 'The offline name pack is not enabled on this server');
    const since = intParam(req.query.since, 'since', 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(req.query.limit, 'limit', PACK_MAX_LIMIT, 1, PACK_MAX_LIMIT);
    const family = req.user.family_id;
    try {
      await packMeta(pool); // creates the first generation; checks PACK_KEY
    } catch (err) {
      if (!(err instanceof PackKeyMismatch)) throw err;
      req.log.error(err.message);
      throw new AppError(503, 'pack_key_mismatch', 'The offline name pack is unavailable');
    }

    // One snapshot for the generation, the quota count and the rows.
    const c = await pool.connect();
    let meta, reset, page: EntryRow[], more: boolean, nextSince: number;
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      meta = (await servingMeta(c))!;
      // Starting over: asked to, behind purged tombstones or a new generation, or the member
      // changed family since their last download (the old family's entries must go).
      reset = since === 0 || since < meta.purgeSeq || req.user.pack_family_id !== family;
      const { rows: q } = await c.query<{ used: number; live: number }>(
        `SELECT
           coalesce((SELECT rows FROM pack_usage WHERE user_id = $1 AND day = (now() AT TIME ZONE 'utc')::date), 0) AS used,
           (SELECT count(*) FROM pack_entries
            WHERE salt_id = $2 AND NOT deleted AND (scope IS NULL OR scope = $3)) AS live`,
        [req.user.id, meta.saltId, family],
      );
      const left = Math.max(PACK_QUOTA_FLOOR, PACK_QUOTA_FACTOR * q[0].live) - q[0].used;
      if (left <= 0) throw new AppError(429, 'pack_quota', 'Daily name pack download limit reached; try again tomorrow');
      const n = Math.min(limit, left);
      const { rows } = await c.query<EntryRow>(
        `SELECT id, seq, scope, tag, blob, deleted FROM pack_entries
         WHERE salt_id = $1 AND seq > $2 AND (scope IS NULL OR scope = $3) AND ($2 > 0 OR NOT deleted)
         ORDER BY seq LIMIT $4`,
        [meta.saltId, reset ? 0 : since, family, n + 1],
      );
      more = rows.length > n;
      page = more ? rows.slice(0, n) : rows;
      nextSince = page.length ? page[page.length - 1].seq : reset ? 0 : since;
      if (reset && !more) {
        // A full download skips tombstones; move past any trailing ones too.
        const { rows: m } = await c.query<{ s: number }>(
          `SELECT coalesce(max(seq), 0) AS s FROM pack_entries WHERE salt_id = $1 AND (scope IS NULL OR scope = $2)`,
          [meta.saltId, family],
        );
        nextSince = Math.max(nextSince, m[0].s);
      }
    } finally {
      await c.query('COMMIT').catch(() => {});
      c.release();
    }

    // Every row served counts against the daily quota, deltas included.
    await pool.query(
      `INSERT INTO pack_usage (user_id, day, rows) VALUES ($1, (now() AT TIME ZONE 'utc')::date, $2)
       ON CONFLICT (user_id, day) DO UPDATE SET rows = pack_usage.rows + EXCLUDED.rows`,
      [req.user.id, page.length],
    );
    if (req.user.pack_family_id !== family) {
      await pool.query('UPDATE users SET pack_family_id = $2 WHERE id = $1', [req.user.id, family]);
    }

    const head = Buffer.alloc(44);
    let o = MAGIC.copy(head, 0);
    o = head.writeUInt8(1, o);
    o = head.writeUInt8((reset ? FLAG_RESET : 0) | (more ? FLAG_MORE : 0), o);
    o = head.writeUInt32BE(meta.saltId, o);
    o += meta.salt.copy(head, o, 0, 16);
    o = head.writeUInt8(meta.t, o);
    o = head.writeUInt32BE(meta.m, o);
    o = head.writeUInt8(meta.p, o);
    o = head.writeBigUInt64BE(BigInt(nextSince), o);
    head.writeUInt32BE(page.length, o);

    const parts: Buffer[] = [head];
    for (const r of page) {
      const upsert = !r.deleted && r.tag && r.blob;
      const e = Buffer.alloc(17 + (upsert ? 10 : 0));
      let p = e.writeBigUInt64BE(BigInt(r.id), 0);
      p = e.writeBigUInt64BE(BigInt(r.seq), p);
      p = e.writeUInt8(upsert ? (r.scope ? 1 : 0) : 2, p);
      if (upsert) {
        p += r.tag!.copy(e, p, 0, 8);
        e.writeUInt16BE(r.blob!.length, p);
        parts.push(e, r.blob!);
      } else parts.push(e);
    }
    return reply
      .header('content-type', 'application/octet-stream')
      .header('cache-control', 'no-store')
      .send(Buffer.concat(parts));
  });
}
