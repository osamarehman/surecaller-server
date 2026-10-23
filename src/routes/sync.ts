import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../errors.js';
import { parse, parseSince, requireTrusted } from '../http.js';
import { requirePhone } from '../phone.js';
import { UUID_RE } from '../users.js';

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

function toBlock(r: BlockRow, trusted = true) {
  return {
    id: r.id,
    type: r.type,
    value: r.value,
    label: r.label,
    // The adder's name is family info; untrusted sign-ups still get the rule, without the name.
    addedBy: trusted ? r.added_by_display : null,
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

  app.get<{ Querystring: { since?: string } }>('/sync', async (req) => {
    const since = parseSince(req.query.since);
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
        `SELECT phone, label, score, reports, top_category FROM spam_state
         WHERE (($1::timestamptz IS NULL AND label <> 'none') OR updated_at >= $1) AND updated_at < $2
         ORDER BY phone`,
        [since, serverTime],
      ),
      pool.query<BlockRow>(
        `${BLOCK_SELECT}
         WHERE (($1::timestamptz IS NULL AND b.deleted_at IS NULL) OR b.updated_at >= $1) AND b.updated_at < $2
         ORDER BY b.created_at`,
        [since, serverTime],
      ),
    ]);

    return {
      serverTime: serverTime.toISOString(),
      spam: spam.rows.map((r) => ({
        phone: r.phone,
        label: r.label,
        score: r.score,
        reports: r.reports,
        topCategory: r.top_category,
        deleted: r.label === 'none',
      })),
      blocks: blocks.rows.map((r) => toBlock(r, req.user.trusted)),
    };
  });

  app.post('/blocks', async (req, reply) => {
    requireTrusted(req); // only family edits the shared block list
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
      `INSERT INTO blocks (type, value, label, added_by, added_by_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (type, value) WHERE deleted_at IS NULL DO NOTHING
       RETURNING *, added_by_name AS added_by_display`,
      [b.type, value, b.label || null, req.user.id, req.user.name],
    );
    if (rows[0]) return reply.status(201).send(toBlock(rows[0], req.user.trusted));
    const existing = await pool.query<BlockRow>(
      `${BLOCK_SELECT} WHERE b.type = $1 AND b.value = $2 AND b.deleted_at IS NULL`,
      [b.type, value],
    );
    return reply.status(200).send(toBlock(existing.rows[0], req.user.trusted));
  });

  app.delete<{ Params: { id: string } }>('/blocks/:id', async (req, reply) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) throw notFound('Block not found');
    const { rows } = await pool.query<BlockRow>(
      'SELECT * FROM blocks WHERE id = $1 AND deleted_at IS NULL',
      [id],
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
