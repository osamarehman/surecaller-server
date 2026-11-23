import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { badRequest, forbidden, unauthorized } from './errors.js';
import type { Notifier } from './fcm.js';
import type { GoogleVerifier } from './email.js';
import type { Mailer } from './mail.js';
import { hashToken } from './tokens.js';
import { appBuild, type LookupBudget } from './usage.js';
import type { UserRow } from './users.js';

export interface Ctx {
  cfg: Config;
  pool: pg.Pool;
  notifier: Notifier;
  mailer: Mailer;
  google: GoogleVerifier | null;
  /** LOOKUP_DAILY_LIMIT on names from the server (src/usage.ts). */
  budget: LookupBudget;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: Ctx;
  }
  interface FastifyRequest {
    user: UserRow;
  }
}

/** zod 3's name for a value's type ("nan", "array", "null", ...), as its messages printed it. */
function typeName(v: unknown): string {
  if (typeof v === 'number') return Number.isNaN(v) ? 'nan' : 'number';
  if (typeof v !== 'object') return typeof v;
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  return 'object';
}

const quoted = (values: readonly unknown[]) => values.map((v) => (typeof v === 'string' ? `'${v}'` : v)).join(' | ');

/**
 * zod 3's default English messages. The app shows the `invalid_request` message as is, so the
 * text stays what zod 3 sent. Messages set on a schema (`.refine(.., 'area too long')`) win over this.
 */
function v3Message(issue: z.core.$ZodRawIssue): string | undefined {
  const i = issue as z.core.$ZodRawIssue & Record<string, any>;
  const exact = i.exact ? 'exactly' : undefined;
  if ((i.code === 'invalid_type' || i.code === 'invalid_value') && i.input === undefined) return 'Required';
  switch (i.code) {
    case 'invalid_type':
      // zod 4 rejects Infinity as a number; zod 3 failed it at .int() (the only coerced number has one).
      if (i.expected === 'int' || (i.expected === 'number' && typeof i.input === 'number' && !Number.isNaN(i.input)))
        return 'Expected integer, received float';
      return `Expected ${i.expected === 'record' ? 'object' : i.expected}, received ${typeName(i.input)}`;
    case 'invalid_value':
      // zod 3 checked an enum's input is a string first.
      if (typeof i.input !== 'string') return `Expected ${quoted(i.values)}, received ${typeName(i.input)}`;
      return `Invalid enum value. Expected ${quoted(i.values)}, received '${i.input}'`;
    case 'invalid_union':
    case 'custom':
      return 'Invalid input';
    case 'invalid_format':
      if (i.format === 'regex') return 'Invalid';
      return `Invalid ${i.format === 'guid' ? 'uuid' : i.format}`;
    case 'too_small':
      if (i.origin === 'array') return `Array must contain ${exact ?? (i.inclusive ? 'at least' : 'more than')} ${i.minimum} element(s)`;
      if (i.origin === 'string') return `String must contain ${exact ?? (i.inclusive ? 'at least' : 'over')} ${i.minimum} character(s)`;
      if (i.origin === 'number' || i.origin === 'int') return `Number must be ${exact ? 'exactly equal to' : i.inclusive ? 'greater than or equal to' : 'greater than'} ${i.minimum}`;
      return 'Invalid input';
    case 'too_big':
      if (i.origin === 'array') return `Array must contain ${exact ?? (i.inclusive ? 'at most' : 'less than')} ${i.maximum} element(s)`;
      if (i.origin === 'string') return `String must contain ${exact ?? (i.inclusive ? 'at most' : 'under')} ${i.maximum} character(s)`;
      if (i.origin === 'number' || i.origin === 'int') return `Number must be ${exact ?? (i.inclusive ? 'less than or equal to' : 'less than')} ${i.maximum}`;
      return 'Invalid input';
    default:
      return undefined; // zod 4's own message
  }
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {}, { error: v3Message });
  if (!r.success) {
    // zod 4's .int() also rejects unsafe integers before .min()/.max() run; zod 3 reported the
    // .min()/.max() issue at the same path, so skip the safe-range one when another follows it.
    const { issues } = r.error;
    const unsafeInt = (i: z.core.$ZodIssue) =>
      (i.code === 'too_big' && i.maximum === Number.MAX_SAFE_INTEGER) ||
      (i.code === 'too_small' && i.minimum === Number.MIN_SAFE_INTEGER);
    const samePath = (a: z.core.$ZodIssue, b: z.core.$ZodIssue) => a.path.join('.') === b.path.join('.');
    const issue = issues.find((i, n) => !(unsafeInt(i) && issues.slice(n + 1).some((j) => samePath(i, j)))) ?? issues[0];
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
  // X-SureCaller-Build rides on the same throttled write; a new build is written at once.
  const build = appBuild(req);
  if (!seen || Date.now() - seen.getTime() > 60_000 || (build !== null && build !== user.app_build)) {
    await pool.query(
      `UPDATE users SET last_seen_at = now(), app_build = coalesce($2, app_build),
         app_seen_at = CASE WHEN $2::int IS NULL THEN app_seen_at ELSE now() END
       WHERE id = $1`,
      [user.id, build],
    );
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
