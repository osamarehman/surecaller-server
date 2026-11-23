import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { UserRow } from '../users.js';
import { AppError, badRequest, tooManyRequests } from '../errors.js';
import { parse } from '../http.js';
import { appKeys, packVault } from '../pack.js';
import { format2Serving, PackAppKeyMismatch, PackKeyMismatch, type PackMeta } from '../pack-build.js';
import { secondsToUtcMidnight } from '../usage.js';

/**
 * The offline name pack, format 2: keyed with the pack key (PACK_APP_KEYS) and split into parts
 * (docs/API.md, "Offline name pack, format 2"). Binary formats are documented there and parsed
 * by test/pack-v2-decoder.ts.
 */

/** Page sizes (tests lower them). A page stops after the section that takes it past its size. */
export const pack2Limits = {
  /** GET /v1/pack/changes */
  changesPageBytes: 2 * 1024 * 1024,
  /** POST /v1/pack/parts */
  partsPageBytes: 4 * 1024 * 1024,
};
/** Parts one `parts` request may ask for. */
export const PARTS_MAX = 64;
/** POST /v1/pack/key handouts per account per UTC day. */
export const KEY_DAILY_LIMIT = 10;
/** Bytes per member per UTC day (manifest, changes, parts): this many full packs, at least the floor. */
export const BYTE_QUOTA_FACTOR = 3;
export const BYTE_QUOTA_FLOOR = 64 * 1024 * 1024;
/** Full global sections kept in memory for download waves (same bytes for every key holder). */
const CACHE_BYTES = 64 * 1024 * 1024;

const MANIFEST_HEAD = 55;
const MANIFEST_PART = 35;
const PAGE_HEAD = 25;
const SECTION_HEAD = 28;
const MODE_FULL = 0;
const MODE_DELTA = 1;
const MODE_RESYNC = 2;
const KIND_UPSERT = 0;
const KIND_DELETE = 2;

interface PartRow {
  scope: string | null;
  part: number;
  version: number;
  floor: number;
  live: number;
  bytes: number;
  digest: Buffer;
  removal: number;
}

const EMPTY_DIGEST = Buffer.alloc(8);

/**
 * Why this account gets no pack key and no format-2 pack (PACK_KEY_HOLDERS, revocation), or
 * null when it may have them. Under `google`: Google-linked accounts and the operator's admins.
 */
export function packDenial(cfg: Config, u: UserRow): 'google_required' | 'revoked' | null {
  if (u.pack_revoked_at) return 'revoked';
  if (cfg.packKeyHolders === 'google' && !(u.google_sub || (u.is_admin && u.trusted))) return 'google_required';
  return null;
}

const denied = (reason: 'google_required' | 'revoked') =>
  new AppError(
    403,
    'pack_key_denied',
    reason === 'revoked'
      ? 'The offline name pack is turned off for this account'
      : 'Link your Google account to get offline caller ID',
    { reason },
  );

/** An LRU of encoded full global sections, keyed by generation, part_bits, part and version. */
class SectionCache {
  private map = new Map<string, Buffer>();
  private size = 0;
  get(k: string): Buffer | undefined {
    const v = this.map.get(k);
    if (v) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: Buffer) {
    if (v.length > CACHE_BYTES / 4) return;
    this.map.set(k, v);
    this.size += v.length;
    for (const [old, b] of this.map) {
      if (this.size <= CACHE_BYTES) break;
      this.map.delete(old);
      this.size -= b.length;
    }
  }
}

/** One section: u8 scope | u16 id | u8 mode | u64 version | u32 live | 8B digest | u32 rows | rows. */
function section(p: PartRow, mode: number, rows: Buffer[], count: number): Buffer {
  const head = Buffer.alloc(SECTION_HEAD);
  let o = head.writeUInt8(p.scope ? 1 : 0, 0);
  o = head.writeUInt16BE(p.part, o);
  o = head.writeUInt8(mode, o);
  o = head.writeBigUInt64BE(BigInt(p.version), o);
  o = head.writeUInt32BE(p.live, o);
  o += p.digest.copy(head, o, 0, 8);
  head.writeUInt32BE(count, o);
  return Buffer.concat([head, ...rows]);
}

/** A row: u8 kind | 8B tag | upsert: u16 blobLen | blob. */
function row(tag: Buffer, blob: Buffer | null): Buffer {
  const r = Buffer.alloc(9 + (blob ? 2 + blob.length : 0));
  r.writeUInt8(blob ? KIND_UPSERT : KIND_DELETE, 0);
  tag.copy(r, 1, 0, 8);
  if (blob) {
    r.writeUInt16BE(blob.length, 9);
    blob.copy(r, 11);
  }
  return r;
}

/** Page header: "SCPS" | u8 1 | u8 flags | u32 saltId | u16 keyId | u8 partBits | u64 cursor | u16 next | u16 count. */
function page(g: PackMeta, more: boolean, cursor: number, next: number, sections: Buffer[]): Buffer {
  const head = Buffer.alloc(PAGE_HEAD);
  let o = head.write('SCPS', 0, 'ascii');
  o = head.writeUInt8(1, o);
  o = head.writeUInt8(more ? 1 : 0, o);
  o = head.writeUInt32BE(g.saltId, o);
  o = head.writeUInt16BE(g.appKeyId!, o);
  o = head.writeUInt8(g.partBits, o);
  o = head.writeBigUInt64BE(BigInt(cursor), o);
  o = head.writeUInt16BE(next, o);
  head.writeUInt16BE(sections.length, o);
  return Buffer.concat([head, ...sections]);
}

/** Tag range [lo, hi) of a global part. */
const tagRange = (part: number, bits: number) => [part << (16 - bits), (part + 1) << (16 - bits)] as const;

function intQuery(raw: string | undefined, name: string, max: number): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d{1,15}$/.test(raw) || Number(raw) > max) throw badRequest(`invalid_${name}`, `${name} must be a whole number up to ${max}`);
  return Number(raw);
}

const PartsBody = z.object({
  saltId: z.number().int().min(1).optional(),
  parts: z
    .array(z.object({ s: z.enum(['g', 'f']), id: z.number().int().min(0).max(65535) }))
    .min(1)
    .max(PARTS_MAX),
});

export async function pack2Routes(app: FastifyInstance) {
  const { cfg, pool } = app.ctx;
  const cache = new SectionCache();

  /** Off (404), denied for this account (403), not usable (503) or not built yet (503). */
  async function served(req: FastifyRequest, reply: FastifyReply, db: pg.PoolClient | pg.Pool) {
    if (!appKeys().length || !packVault()) {
      throw new AppError(404, 'pack_disabled', 'The offline name pack (format 2) is not enabled on this server');
    }
    const no = packDenial(cfg, req.user);
    if (no) throw denied(no);
    let s;
    try {
      s = await format2Serving(db);
    } catch (err) {
      if (!(err instanceof PackKeyMismatch || err instanceof PackAppKeyMismatch)) throw err;
      req.log.error(err.message);
      throw new AppError(503, 'pack_key_mismatch', 'The offline name pack is unavailable');
    }
    if (!s.active) {
      reply.header('retry-after', '600');
      throw new AppError(503, 'pack_not_ready', 'The offline name pack is being built; try again later');
    }
    return { active: s.active, retiring: s.retiring };
  }

  /** The generation a request names (`saltId`), the active one by default. */
  function pick(s: { active: PackMeta; retiring: PackMeta | null }, saltId: number | undefined): PackMeta {
    if (saltId === undefined || saltId === s.active.saltId) return s.active;
    if (s.retiring && saltId === s.retiring.saltId) return s.retiring;
    throw new AppError(409, 'pack_generation', 'That name pack generation is no longer served; start over with GET /v1/pack/head');
  }

  /** Runs fn in one read-only snapshot. */
  async function snapshot<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return await fn(c);
    } finally {
      await c.query('COMMIT').catch(() => {});
      c.release();
    }
  }

  /** The member's parts of a generation: the global ones and their family's, global first by id. */
  async function partsOf(c: pg.PoolClient, saltId: number, family: string): Promise<PartRow[]> {
    const { rows } = await c.query<PartRow>(
      `SELECT scope, part, version, floor, live, bytes, digest, removal FROM pack_parts
       WHERE salt_id = $1 AND (scope IS NULL OR scope = $2) ORDER BY scope NULLS FIRST, part`,
      [saltId, family],
    );
    return rows;
  }

  /** Before serving: 429 pack_quota once today's bytes reach max(3 × the full pack, 64 MB). */
  async function checkQuota(c: pg.PoolClient, req: FastifyRequest, active: PackMeta) {
    const { rows } = await c.query<{ used: number; full: number }>(
      `SELECT
         coalesce((SELECT bytes FROM pack_usage WHERE user_id = $1 AND day = (now() AT TIME ZONE 'utc')::date), 0) AS used,
         coalesce((SELECT sum(bytes + ${SECTION_HEAD}) FROM pack_parts WHERE salt_id = $2 AND (scope IS NULL OR scope = $3)), 0)::bigint AS full`,
      [req.user.id, active.saltId, req.user.family_id],
    );
    const limit = Math.max(BYTE_QUOTA_FLOOR, BYTE_QUOTA_FACTOR * (rows[0].full + MANIFEST_HEAD + PAGE_HEAD));
    if (rows[0].used >= limit) {
      throw new AppError(429, 'pack_quota', 'Daily name pack download limit reached; try again tomorrow');
    }
  }

  /** Counts what was served, and remembers the family part the member was sent. */
  async function charge(req: FastifyRequest, bytes: number, sentFamily: boolean) {
    await pool.query(
      `INSERT INTO pack_usage (user_id, day, bytes) VALUES ($1, (now() AT TIME ZONE 'utc')::date, $2)
       ON CONFLICT (user_id, day) DO UPDATE SET bytes = pack_usage.bytes + EXCLUDED.bytes`,
      [req.user.id, bytes],
    );
    if (sentFamily && req.user.pack2_family_id !== req.user.family_id) {
      await pool.query('UPDATE users SET pack2_family_id = $2 WHERE id = $1', [req.user.id, req.user.family_id]);
    }
  }

  /** Every live row of a part, by tag (a full section's rows). */
  async function liveRows(c: pg.PoolClient, g: PackMeta, p: PartRow, family: string): Promise<Buffer[]> {
    const q = p.scope
      ? await c.query<{ tag: Buffer; blob: Buffer }>(
          `SELECT tag, blob FROM pack_entries WHERE salt_id = $1 AND scope = $2 AND tag16 IS NOT NULL AND NOT deleted ORDER BY tag`,
          [g.saltId, family],
        )
      : await c.query<{ tag: Buffer; blob: Buffer }>(
          `SELECT tag, blob FROM pack_entries WHERE salt_id = $1 AND scope IS NULL AND tag16 IS NOT NULL
             AND tag16 >= $2 AND tag16 < $3 AND NOT deleted ORDER BY tag`,
          [g.saltId, ...tagRange(p.part, g.partBits)],
        );
    return q.rows.map((r) => row(r.tag, r.blob));
  }

  /** A full section (mode 0) of a part; global ones come from the cache when unchanged. */
  async function fullSection(c: pg.PoolClient, g: PackMeta, p: PartRow, family: string): Promise<Buffer> {
    const k = `${g.saltId}:${g.partBits}:${p.part}:${p.version}`;
    if (!p.scope) {
      const hit = cache.get(k);
      if (hit) return hit;
    }
    const rows = await liveRows(c, g, p, family);
    const s = section(p, MODE_FULL, rows, rows.length);
    if (!p.scope) cache.set(k, s);
    return s;
  }

  /** The rows of a part changed after `since`, in seq order; deletes only for a retiring generation. */
  async function deltaSection(c: pg.PoolClient, g: PackMeta, p: PartRow, family: string, since: number): Promise<Buffer> {
    const deletesOnly = g.retireAfter !== null;
    const q = p.scope
      ? await c.query<{ tag: Buffer; blob: Buffer | null }>(
          `SELECT tag, blob FROM pack_entries WHERE salt_id = $1 AND scope = $2 AND tag16 IS NOT NULL AND seq > $3
             AND ($4 = false OR deleted) ORDER BY seq`,
          [g.saltId, family, since, deletesOnly],
        )
      : await c.query<{ tag: Buffer; blob: Buffer | null }>(
          `SELECT tag, blob FROM pack_entries WHERE salt_id = $1 AND scope IS NULL AND tag16 IS NOT NULL
             AND tag16 >= $2 AND tag16 < $3 AND seq > $4 AND ($5 = false OR deleted) ORDER BY seq`,
          [g.saltId, ...tagRange(p.part, g.partBits), since, deletesOnly],
        );
    const rows = q.rows.map((r) => row(r.tag, r.blob));
    return section(p, MODE_DELTA, rows, rows.length);
  }

  /** Cursor (highest part version) and removalSeq (highest delete) of the member's parts. */
  const cursorOf = (parts: PartRow[]) => ({
    cursor: parts.reduce((m, p) => Math.max(m, p.version), 0),
    removal: parts.reduce((m, p) => Math.max(m, p.removal), 0),
  });

  // The pack key, to native code only. Never logged (requests are not logged with bodies).
  app.post('/pack/key', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    // {} today; room for an integrity token later.
    const body = req.body as unknown;
    if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body))) {
      throw badRequest('invalid_request', 'Send a JSON object');
    }
    const s = await served(req, reply, pool);
    const gens = [s.active, ...(s.retiring ? [s.retiring] : [])];
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      // One handout at a time per account, so the daily limit holds.
      await c.query("SELECT pg_advisory_xact_lock(hashtext('pack_key:' || $1))", [req.user.id]);
      const { rows } = await c.query<{ n: number }>(
        `SELECT count(DISTINCT at)::int AS n FROM pack_key_grants
         WHERE user_id = $1 AND at >= (now() AT TIME ZONE 'utc')::date AT TIME ZONE 'utc'`,
        [req.user.id],
      );
      if (rows[0].n >= KEY_DAILY_LIMIT) {
        const wait = secondsToUtcMidnight();
        reply.header('retry-after', String(wait));
        throw tooManyRequests(wait * 1000);
      }
      await c.query(
        'INSERT INTO pack_key_grants (user_id, key_id, ip) SELECT $1, k, $3::inet FROM unnest($2::int[]) AS t(k)',
        [req.user.id, gens.map((g) => g.appKeyId), req.ip || null],
      );
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
    return {
      keys: gens.map((g) => ({
        id: g.appKeyId,
        key: g.appKey!.key.toString('base64'),
        saltId: g.saltId,
        ...(g.retireAfter ? { until: g.retireAfter.toISOString() } : {}),
      })),
    };
  });

  app.get('/pack/head', async (req, reply) => {
    const body = await snapshot(async (c) => {
      const s = await served(req, reply, c);
      const a = s.active;
      const r = s.retiring;
      const { cursor, removal } = cursorOf(await partsOf(c, a.saltId, req.user.family_id));
      return {
        saltId: a.saltId,
        keyId: a.appKeyId,
        keyIds: [...new Set([a.appKeyId, ...(r ? [r.appKeyId] : [])])],
        partBits: a.partBits,
        cursor,
        removalSeq: removal,
        // The member moved family since their family part was last sent: call `changes`.
        familyChanged: req.user.pack2_family_id !== req.user.family_id,
        retiring: r ? { saltId: r.saltId, keyId: r.appKeyId, until: r.retireAfter!.toISOString() } : null,
      };
    });
    const etag = `"${crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32)}"`;
    reply.header('etag', etag).header('cache-control', 'no-cache');
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    return body;
  });

  app.get<{ Querystring: { saltId?: string } }>('/pack/manifest', async (req, reply) => {
    const saltId = intQuery(req.query.saltId, 'saltId', 0xffffffff);
    const buf = await snapshot(async (c) => {
      const s = await served(req, reply, c);
      const g = pick(s, saltId);
      await checkQuota(c, req, s.active);
      const parts = await partsOf(c, g.saltId, req.user.family_id);
      const { cursor, removal } = cursorOf(parts);
      const out = Buffer.alloc(MANIFEST_HEAD + MANIFEST_PART * parts.length);
      let o = out.write('SCPM', 0, 'ascii');
      o = out.writeUInt8(1, o);
      o = out.writeUInt8(g.retireAfter ? 1 : 0, o);
      o = out.writeUInt32BE(g.saltId, o);
      o = out.writeUInt16BE(g.appKeyId!, o);
      o += g.salt.copy(out, o, 0, 16);
      o = out.writeUInt8(g.t, o);
      o = out.writeUInt32BE(g.m, o);
      o = out.writeUInt8(g.p, o);
      o = out.writeUInt8(g.partBits, o);
      o = out.writeBigUInt64BE(BigInt(cursor), o);
      o = out.writeBigUInt64BE(BigInt(removal), o);
      o = out.writeUInt32BE(parts.length, o);
      for (const p of parts) {
        o = out.writeUInt8(p.scope ? 1 : 0, o);
        o = out.writeUInt16BE(p.part, o);
        o = out.writeBigUInt64BE(BigInt(p.version), o);
        o = out.writeBigUInt64BE(BigInt(p.floor), o);
        o = out.writeUInt32BE(p.live, o);
        o = out.writeUInt32BE(Math.min(p.bytes, 0xffffffff), o);
        o += p.digest.copy(out, o, 0, 8);
      }
      return out;
    });
    await charge(req, buf.length, false);
    return reply.header('content-type', 'application/octet-stream').header('cache-control', 'no-store').send(buf);
  });

  app.get<{ Querystring: { since?: string; after?: string; saltId?: string } }>('/pack/changes', async (req, reply) => {
    const since = intQuery(req.query.since, 'since', Number.MAX_SAFE_INTEGER) ?? 0;
    const after = intQuery(req.query.after, 'after', 65535);
    const saltId = intQuery(req.query.saltId, 'saltId', 0xffffffff);
    const family = req.user.family_id;
    const res = await snapshot(async (c) => {
      const s = await served(req, reply, c);
      const g = pick(s, saltId);
      await checkQuota(c, req, s.active);
      const retiring = g.retireAfter !== null;
      const parts = await partsOf(c, g.saltId, family);
      const { cursor } = cursorOf(parts);
      // The member's family part on the first page: whole after a family move (a retiring
      // generation, which sends deletes only, says "fetch it whole" instead).
      const moved = req.user.pack2_family_id !== family;
      const sections: Buffer[] = [];
      let size = PAGE_HEAD;
      let sentFamily = false;
      const mode = (p: PartRow) => (p.floor > since ? MODE_RESYNC : MODE_DELTA);
      if (after === undefined) {
        const fam = parts.find((p) => p.scope) ?? null;
        let sec: Buffer | null = null;
        if (moved) {
          const p = fam ?? { scope: family, part: 0, version: 0, floor: 0, live: 0, bytes: 0, digest: EMPTY_DIGEST, removal: 0 };
          sec = retiring ? section(p, MODE_RESYNC, [], 0) : await fullSection(c, g, p, family);
          sentFamily = !retiring;
        } else if (fam && fam.version > since) {
          sec = mode(fam) === MODE_RESYNC ? section(fam, MODE_RESYNC, [], 0) : await deltaSection(c, g, fam, family, since);
        }
        if (sec) {
          sections.push(sec);
          size += sec.length;
        }
      }
      const todo = parts.filter((p) => !p.scope && p.version > since && (after === undefined || p.part > after));
      let next = 0;
      let more = false;
      let globals = 0;
      for (const p of todo) {
        // A page holds at least one global part before it can be cut: `next` names the last
        // global part on it, so a page cut after the family section alone would say `next` 0
        // and the follow-up (`after=0`) would skip global part 0.
        if (size > pack2Limits.changesPageBytes && globals > 0) {
          more = true;
          break;
        }
        const sec = mode(p) === MODE_RESYNC ? section(p, MODE_RESYNC, [], 0) : await deltaSection(c, g, p, family, since);
        sections.push(sec);
        size += sec.length;
        next = p.part;
        globals++;
      }
      return { buf: page(g, more, cursor, next, sections), sentFamily };
    });
    await charge(req, res.buf.length, res.sentFamily);
    return reply.header('content-type', 'application/octet-stream').header('cache-control', 'no-store').send(res.buf);
  });

  app.post('/pack/parts', async (req, reply) => {
    const body = parse(PartsBody, req.body);
    const family = req.user.family_id;
    const res = await snapshot(async (c) => {
      const s = await served(req, reply, c);
      const g = pick(s, body.saltId);
      for (const r of body.parts) {
        if (r.s === 'f' ? r.id !== 0 : r.id >= 1 << g.partBits) {
          throw badRequest('invalid_part', `No such part: ${r.s} ${r.id} (partBits ${g.partBits})`);
        }
      }
      await checkQuota(c, req, s.active);
      const parts = await partsOf(c, g.saltId, family);
      const find = (scope: 'g' | 'f', id: number) =>
        parts.find((p) => (scope === 'f' ? p.scope !== null : p.scope === null && p.part === id)) ?? {
          scope: scope === 'f' ? family : null,
          part: id,
          version: 0,
          floor: 0,
          live: 0,
          bytes: 0,
          digest: EMPTY_DIGEST,
          removal: 0,
        };
      const sections: Buffer[] = [];
      let size = PAGE_HEAD;
      let sentFamily = false;
      for (const r of body.parts) {
        if (size > pack2Limits.partsPageBytes && sections.length) break;
        const sec = await fullSection(c, g, find(r.s, r.id), family);
        sections.push(sec);
        size += sec.length;
        if (r.s === 'f' && !g.retireAfter) sentFamily = true;
      }
      const { cursor } = cursorOf(parts);
      const more = sections.length < body.parts.length;
      return { buf: page(g, more, cursor, sections.length, sections), sentFamily };
    });
    await charge(req, res.buf.length, res.sentFamily);
    return reply.header('content-type', 'application/octet-stream').header('cache-control', 'no-store').send(res.buf);
  });
}
