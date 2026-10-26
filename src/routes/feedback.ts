import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Client } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { parse, requireOperator } from '../http.js';
import { UUID_RE } from '../users.js';

// Public feedback board, contract in docs/FEEDBACK.md. Anyone can read, post and vote; a browser's
// random X-Voter-Id dedupes votes. Rate limits are per IP: the voter id is the client's to change.

const TYPES = ['bug', 'feature'] as const;
const STATUSES = ['open', 'planned', 'in_progress', 'shipped', 'rejected'] as const;

const ListQuery = z.object({
  type: z.enum(TYPES).optional(),
  status: z.enum(STATUSES).optional(),
  sort: z.enum(['top', 'new']).optional().default('top'),
});
const NewItem = z.object({
  type: z.enum(TYPES),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(2000).optional().default(''),
  author: z.string().trim().max(60).optional(),
});
const PatchItem = z.object({
  type: z.enum(TYPES).optional(),
  title: z.string().trim().min(3).max(120).optional(),
  status: z.enum(STATUSES).optional(),
  rejectReason: z.string().trim().max(500).nullable().optional(),
});

const voterId = (req: FastifyRequest): string | null => {
  const v = req.headers['x-voter-id'];
  return typeof v === 'string' && /^[\w-]{8,100}$/.test(v) ? v : null;
};
const requireVoter = (req: FastifyRequest) => {
  const v = voterId(req);
  if (!v) throw badRequest('invalid_request', 'X-Voter-Id header required');
  return v;
};

interface Row {
  id: string;
  type: string;
  title: string;
  description: string;
  status: string;
  reject_reason: string | null;
  author: string | null;
  votes: number;
  voted: boolean;
  created_at: Date;
  updated_at: Date;
}

// ponytail: vote counts are counted per read, add a votes column if the board grows past thousands
const SELECT = `SELECT f.*,
  (SELECT count(*)::int FROM feedback_votes v WHERE v.feedback_id = f.id) AS votes,
  EXISTS (SELECT 1 FROM feedback_votes v WHERE v.feedback_id = f.id AND v.voter_id = $1) AS voted
  FROM feedback f WHERE f.deleted_at IS NULL`;

const toItem = (r: Row) => ({
  id: r.id,
  type: r.type,
  title: r.title,
  description: r.description,
  status: r.status,
  rejectReason: r.status === 'rejected' ? r.reject_reason : null,
  votes: r.votes,
  voted: r.voted,
  author: r.author,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

async function getItem(db: Client, id: string, voter: string | null) {
  if (!UUID_RE.test(id)) throw notFound('Feedback not found');
  const { rows } = await db.query<Row>(`${SELECT} AND f.id = $2`, [voter, id]);
  if (!rows[0]) throw notFound('Feedback not found');
  return toItem(rows[0]);
}

export async function feedbackPublicRoutes(app: FastifyInstance) {
  const { pool } = app.ctx;

  app.get('/v1/feedback', async (req) => {
    const q = parse(ListQuery, req.query);
    const { rows } = await pool.query<Row>(
      `${SELECT} AND ($2::text IS NULL OR f.type = $2) AND ($3::text IS NULL OR f.status = $3)
       ORDER BY ${q.sort === 'new' ? 'f.created_at DESC' : 'votes DESC, f.created_at DESC'} LIMIT 500`,
      [voterId(req), q.type ?? null, q.status ?? null],
    );
    return { items: rows.map(toItem) };
  });

  app.post(
    '/v1/feedback',
    { bodyLimit: 8192, config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const voter = requireVoter(req);
      const b = parse(NewItem, req.body);
      const { rows } = await pool.query<{ id: string }>(
        'INSERT INTO feedback (type, title, description, author) VALUES ($1, $2, $3, $4) RETURNING id',
        [b.type, b.title, b.description, b.author || null],
      );
      return reply.status(201).send({ item: await getItem(pool, rows[0].id, voter) });
    },
  );

  const vote = (add: boolean) => async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const voter = requireVoter(req);
    await getItem(pool, req.params.id, voter); // 404 for unknown or deleted items
    await pool.query(
      add
        ? 'INSERT INTO feedback_votes (feedback_id, voter_id) VALUES ($1, $2) ON CONFLICT DO NOTHING'
        : 'DELETE FROM feedback_votes WHERE feedback_id = $1 AND voter_id = $2',
      [req.params.id, voter],
    );
    const item = await getItem(pool, req.params.id, voter);
    return { votes: item.votes, voted: item.voted };
  };
  const voteLimit = { config: { rateLimit: { max: 60, timeWindow: '1 hour' } } };
  app.post('/v1/feedback/:id/vote', voteLimit, vote(true));
  app.delete('/v1/feedback/:id/vote', voteLimit, vote(false));
}

/** Triage, for admins of the trusted family. Registered under the authenticated /v1 scope. */
export async function feedbackAdminRoutes(app: FastifyInstance) {
  const { pool } = app.ctx;

  app.patch<{ Params: { id: string } }>('/feedback/:id', async (req) => {
    requireOperator(req);
    const b = parse(PatchItem, req.body);
    await getItem(pool, req.params.id, null);
    await pool.query(
      `UPDATE feedback SET type = coalesce($2, type), title = coalesce($3, title),
         status = coalesce($4, status),
         reject_reason = CASE WHEN coalesce($4, status) = 'rejected' THEN coalesce($5, reject_reason) END,
         updated_at = now()
       WHERE id = $1`,
      [req.params.id, b.type ?? null, b.title ?? null, b.status ?? null, b.rejectReason ?? null],
    );
    return { item: await getItem(pool, req.params.id, null) };
  });

  app.delete<{ Params: { id: string } }>('/feedback/:id', async (req) => {
    requireOperator(req);
    await getItem(pool, req.params.id, null);
    await pool.query('UPDATE feedback SET deleted_at = now() WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}
