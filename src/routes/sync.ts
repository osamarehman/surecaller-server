import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../errors.js';
import { parse, parseSince, userKey } from '../http.js';
import { format2Cursor } from '../pack-build.js';
import { requirePhone } from '../phone.js';
import { packDenial } from './pack2.js';
import { UUID_RE } from '../users.js';

/** POST /v1/blocks per member per hour (block rules are added one at a time, by hand). */
export const BLOCK_RATE_LIMIT = 120;

interface BlockRow {
  id: string;
  type: 'number' | 'prefix' | 'country';
  value: string;
  label: string | null;
  added_by: string | null;
  added_by_display: string | null;
  deleted_at: Date | null;
}

const BLOCK_SELECT = `SELECT b.*, coalesce(u.name, b.added_by_name) AS added_by_display
  FROM blocks b LEFT JOIN users u ON u.id = b.added_by`;

function toBlock(r: BlockRow) {
  return {
    id: r.id,
    type: r.type,
    value: r.value,
    label: r.label,
    addedBy: r.added_by_display,
    deleted: r.deleted_at !== null,
  };
}

const BlockBody = z.object({
  type: z.enum(['number', 'prefix', 'country']),
  value: z.string().trim().min(1).max(40),
  label: z.string().trim().max(100).nullish(),
});

export async function syncRoutes(app: FastifyInstance) {
  const { cfg, pool } = app.ctx;

  app.get<{ Querystring: { since?: string; v?: string; members?: string } }>('/sync', async (req) => {
    const since = parseSince(req.query.since);
    // ?v=2: what lookups on the phone need (spam details, packCursor, lookupMode); ?members=1:
    // the family roster. Without them the answer is exactly what it was before.
    const v2 = req.query.v === '2';
    const withMembers = req.query.members === '1';
    // serverTime = start of the oldest open transaction, so rows committed by a
    // concurrent writer after we read are still >= the next `since`.
    const { rows: t } = await pool.query<{ t: Date }>(
      `SELECT least(now(), coalesce(min(xact_start), now())) AS t FROM pg_stat_activity
       WHERE datname = current_database() AND backend_type = 'client backend'
         AND xact_start IS NOT NULL`,
    );
    const serverTime = t[0].t;

    // With `since`: every change in [since, serverTime), tombstones included.
    // Without: a snapshot of the live rows.
    const [spam, blocks] = await Promise.all([
      pool.query(
        v2
          ? // A change to the details alone (detail_updated_at) also sends the row.
            `SELECT phone, label, score, reports, top_category, not_spam, last_comment, calls FROM spam_state
             WHERE (($1::timestamptz IS NULL AND label <> 'none') OR greatest(updated_at, detail_updated_at) >= $1)
               AND greatest(updated_at, detail_updated_at) < $2
             ORDER BY phone`
          : `SELECT phone, label, score, reports, top_category FROM spam_state
         WHERE (($1::timestamptz IS NULL AND label <> 'none') OR updated_at >= $1) AND updated_at < $2
         ORDER BY phone`,
        [since, serverTime],
      ),
      pool.query<BlockRow>(
        `${BLOCK_SELECT}
         WHERE b.family_id = $3
           AND (($1::timestamptz IS NULL AND b.deleted_at IS NULL) OR b.updated_at >= $1) AND b.updated_at < $2
         ORDER BY b.created_at`,
        [since, serverTime, req.user.family_id],
      ),
    ]);

    const out = {
      serverTime: serverTime.toISOString(),
      spam: spam.rows.map((r) => ({
        phone: r.phone,
        label: r.label,
        score: r.score,
        reports: r.reports,
        topCategory: r.top_category,
        deleted: r.label === 'none',
        ...(v2 ? { notSpam: r.not_spam, lastComment: r.last_comment, calls: r.calls } : {}),
      })),
      blocks: blocks.rows.map(toBlock),
    };
    if (!v2 && !withMembers) return out;
    const extra: Record<string, unknown> = {};
    if (withMembers) {
      const { rows } = await pool.query<{ id: string; phone: string; name: string; status: string | null; photo_url: string | null }>(
        'SELECT id, phone, name, status, photo_url FROM users WHERE family_id = $1 ORDER BY created_at, id',
        [req.user.family_id],
      );
      extra.members = rows.map((r) => ({ id: r.id, phone: r.phone, name: r.name, status: r.status, photoUrl: r.photo_url }));
    }
    if (v2) {
      // The format-2 pack's cursor for this member (call GET /v1/pack/changes when it moved), and
      // whether new apps answer caller ID from the pack (LOOKUP_MODE; online while format 2 is off).
      const cursor = packDenial(cfg, req.user) ? null : await format2Cursor(pool, req.user.family_id);
      extra.packCursor = cursor;
      extra.lookupMode = cursor !== null ? cfg.lookupMode : 'online';
    }
    return { ...out, ...extra };
  });

  app.post('/blocks', { config: { rateLimit: { max: BLOCK_RATE_LIMIT, timeWindow: '1 hour', keyGenerator: userKey } } }, async (req, reply) => {
    // Each family has its own block list.
    const b = parse(BlockBody, req.body);
    let value: string;
    if (b.type === 'number') {
      value = requirePhone(b.value, cfg.defaultRegion);
    } else {
      value = b.value.replace(/[\s\-()]/g, '');
      if (!value.startsWith('+') && value.startsWith('00')) value = `+${value.slice(2)}`;
      const ok = b.type === 'country' ? /^\+[1-9]\d{0,2}$/.test(value) : /^\+[1-9]\d{1,14}$/.test(value);
      if (!ok) {
        throw badRequest(
          'invalid_block',
          b.type === 'country' ? 'country must look like +234' : 'prefix must look like +92304111',
        );
      }
    }
    // The adder is the caller, so added_by_name is the display name.
    const { rows } = await pool.query<BlockRow>(
      `INSERT INTO blocks (type, value, label, added_by, added_by_name, family_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (family_id, type, value) WHERE deleted_at IS NULL DO NOTHING
       RETURNING *, added_by_name AS added_by_display`,
      [b.type, value, b.label || null, req.user.id, req.user.name, req.user.family_id],
    );
    if (rows[0]) return reply.status(201).send(toBlock(rows[0]));
    const existing = await pool.query<BlockRow>(
      `${BLOCK_SELECT} WHERE b.family_id = $3 AND b.type = $1 AND b.value = $2 AND b.deleted_at IS NULL`,
      [b.type, value, req.user.family_id],
    );
    return reply.status(200).send(toBlock(existing.rows[0]));
  });

  app.delete<{ Params: { id: string } }>('/blocks/:id', async (req, reply) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) throw notFound('Block not found');
    const { rows } = await pool.query<BlockRow>(
      'SELECT * FROM blocks WHERE id = $1 AND family_id = $2 AND deleted_at IS NULL',
      [id, req.user.family_id],
    );
    const block = rows[0];
    if (!block) throw notFound('Block not found');
    if (block.added_by !== req.user.id && !req.user.is_admin) {
      throw forbidden('Only the member who added it or an admin can remove a block');
    }
    await pool.query('UPDATE blocks SET deleted_at = now(), updated_at = now() WHERE id = $1', [id]);
    return reply.status(204).send();
  });
}
