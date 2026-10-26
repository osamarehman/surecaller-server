import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { badRequest, forbidden, unauthorized } from './errors.js';
import type { Notifier } from './fcm.js';
import type { GoogleVerifier } from './email.js';
import type { Mailer } from './mail.js';
import { hashToken } from './tokens.js';
import type { UserRow } from './users.js';

export interface Ctx {
  cfg: Config;
  pool: pg.Pool;
  notifier: Notifier;
  mailer: Mailer;
  google: GoogleVerifier | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: Ctx;
  }
  interface FastifyRequest {
    user: UserRow;
  }
}

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
    throw badRequest('invalid_request', `${where}${issue.message}`);
  }
  return r.data;
}

/**
 * Rate-limit key: the authenticated user id (route rate limits run after the
 * v1 `authenticate` hook), so header spelling variants share one bucket.
 * Falls back to the client IP for unauthenticated requests.
 */
export function userKey(req: FastifyRequest): string {
  return req.user ? `u:${req.user.id}` : `ip:${req.ip}`;
}

/** The member whose bearer token is on the request, or null (missing / malformed / unknown). */
export async function userFromToken(req: FastifyRequest): Promise<UserRow | null> {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer\s+([0-9a-fA-F]{64})\s*$/.exec(header);
  if (!m) return null;
  const { rows } = await req.server.ctx.pool.query<UserRow>(
    'SELECT u.*, f.trusted FROM users u JOIN families f ON f.id = u.family_id WHERE u.token_hash = $1',
    [hashToken(m[1].toLowerCase())],
  );
  return rows[0] ?? null;
}

export async function authenticate(req: FastifyRequest): Promise<void> {
  const user = await userFromToken(req);
  if (!user) throw unauthorized();
  req.user = user;
  const { pool } = req.server.ctx;
  const seen = user.last_seen_at;
  if (!seen || Date.now() - seen.getTime() > 60_000) {
    await pool.query('UPDATE users SET last_seen_at = now() WHERE id = $1', [user.id]);
  }
}

/** Admin of their own family. */
export function requireAdmin(req: FastifyRequest): void {
  if (!req.user.is_admin) throw forbidden();
}

/**
 * Server-wide powers (everyone's telemetry). The operator is an admin of a trusted family.
 * ponytail: the only trusted family is the one ADMIN_CODE set up; add an operator flag if
 * other families ever get trusted.
 */
export function requireOperator(req: FastifyRequest): void {
  if (!req.user.is_admin || !req.user.trusted) throw forbidden();
}

/** Parses an optional ISO `since` query value. Empty/absent = null. */
export function parseSince(raw: unknown): Date | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw badRequest('invalid_since', 'since must be an ISO-8601 time');
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw badRequest('invalid_since', 'since must be an ISO-8601 time');
  return d;
}
