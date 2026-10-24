import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { badRequest } from '../errors.js';
import { parse, parseSince, requireOperator, userFromToken } from '../http.js';
import { redactPhones } from '../phone.js';

export const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
export type Level = (typeof LEVELS)[number];

/** `level` and every level above it, e.g. warn -> [warn, error, fatal]. */
export function levelsFrom(min: Level): Level[] {
  return LEVELS.slice(LEVELS.indexOf(min));
}

const MAX_EVENTS = 200;
const MAX_TAG = 64;
const DETAILS_PREVIEW = 2000;
/** Per-request sizes; a request with no valid token gets the small ones (anyone can send those). */
interface Limits {
  events: number;
  message: number;
  detailsBytes: number;
}
const AUTHED_LIMITS: Limits = { events: MAX_EVENTS, message: 4000, detailsBytes: 16 * 1024 };
const ANON_LIMITS: Limits = { events: 50, message: 1000, detailsBytes: 4 * 1024 };
const MAX_META = 120;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Phone clocks outside [now - 30 days, now + 1 day] are not trusted. */
const MAX_PAST_MS = 30 * DAY_MS;
const MAX_FUTURE_MS = DAY_MS;

const TelemetryBody = z.object({
  installId: z.string().trim().min(1).max(100),
  appVersion: z.string().nullish(),
  device: z.string().nullish(),
  os: z.string().nullish(),
  events: z
    .array(
      z.object({
        at: z.string().nullish(),
        level: z.enum(LEVELS),
        source: z.enum(['dart', 'native']),
        tag: z.string().nullish(),
        message: z.string().nullish(),
        details: z.record(z.unknown()).nullish(),
      }),
    )
    .min(1)
    .max(MAX_EVENTS),
});

const ListQuery = z.object({
  installId: z.string().trim().min(1).max(100).optional(),
  userId: z.string().uuid().optional(),
  level: z.enum(LEVELS).optional(),
  tag: z.string().trim().min(1).max(MAX_TAG).optional(),
  since: z.string().optional(),
  q: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

/** Postgres rejects NUL in text and jsonb. */
const noNul = (s: string): string => s.replace(/\u0000/g, '');
const clip = (s: string | null | undefined, max: number): string => noNul(s ?? '').slice(0, max);
const clipMeta = (s: string | null | undefined): string | null => (s ? clip(s, MAX_META) : null);
/**
 * The app masks phone numbers before sending, but the server does not rely on that: a stale
 * app, a bug or anyone else posting to this open endpoint gets the same treatment here.
 */
const scrub = (s: string): string => redactPhones(noNul(s));
const clipMessage = (s: string | null | undefined, max: number): string => scrub(s ?? '').slice(0, max);

/** JSON text for `details` (NUL removed, phones masked in every nested string), or a short preview when too big. */
function detailsJson(d: Record<string, unknown> | null | undefined, maxBytes: number): string | null {
  if (!d) return null;
  // JSON.stringify's replacer visits every nested value, so this recurses through objects and arrays.
  const json = JSON.stringify(d, (_k, v) => (typeof v === 'string' ? scrub(v) : v));
  if (Buffer.byteLength(json, 'utf8') <= maxBytes) return json;
  return JSON.stringify({ truncated: true, preview: json.slice(0, DETAILS_PREVIEW) });
}

/** The phone's event time, or server time when missing, unparsable or implausible. */
function eventTime(raw: string | null | undefined, now: Date): Date {
  if (!raw) return now;
  const t = new Date(raw).getTime();
  if (Number.isNaN(t) || t < now.getTime() - MAX_PAST_MS || t > now.getTime() + MAX_FUTURE_MS) return now;
  return new Date(t);
}

/** API shape (camelCase); also what the logs CLI prints. */
export interface TelemetryEvent {
  /** bigserial, parsed as a JS number (see db.ts). */
  id: number;
  receivedAt: Date;
  at: Date;
  installId: string;
  userId: string | null;
  userName: string | null;
  appVersion: string | null;
  device: string | null;
  os: string | null;
  level: Level;
  source: string;
  tag: string;
  message: string;
  details: Record<string, unknown> | null;
}

export interface TelemetryFilter {
  installId?: string | null;
  userId?: string | null;
  minLevel?: Level | null;
  tag?: string | null;
  since?: Date | null;
  q?: string | null;
  /** Only rows with id greater than this, oldest first (the CLI's --follow). */
  afterId?: number | null;
  limit: number;
}

/** Newest first, or oldest first after `afterId`. Shared by GET /v1/telemetry and the logs CLI. */
export async function queryTelemetry(pool: pg.Pool, f: TelemetryFilter): Promise<TelemetryEvent[]> {
  const order = f.afterId == null ? 'DESC' : 'ASC';
  const { rows } = await pool.query<TelemetryEvent>(
    `SELECT t.id, t.received_at AS "receivedAt", t.at, t.install_id AS "installId", t.user_id AS "userId",
            u.name AS "userName", t.app_version AS "appVersion", t.device, t.os, t.level, t.source,
            t.tag, t.message, t.details
     FROM telemetry t LEFT JOIN users u ON u.id = t.user_id
     WHERE ($1::text IS NULL OR t.install_id = $1)
       AND ($2::uuid IS NULL OR t.user_id = $2)
       AND ($3::text[] IS NULL OR t.level = ANY($3))
       AND ($4::text IS NULL OR t.tag = $4)
       AND ($5::timestamptz IS NULL OR t.received_at > $5)
       AND ($6::text IS NULL OR position(lower($6) in lower(t.message)) > 0)
       AND ($7::bigint IS NULL OR t.id > $7)
     ORDER BY t.id ${order} LIMIT $8`,
    [
      f.installId ?? null,
      f.userId ?? null,
      f.minLevel ? levelsFrom(f.minLevel) : null,
      f.tag ?? null,
      f.since ?? null,
      f.q ?? null,
      f.afterId ?? null,
      f.limit,
    ],
  );
  return rows;
}

export interface InstallSummary {
  installId: string;
  userId: string | null;
  userName: string | null;
  appVersion: string | null;
  device: string | null;
  os: string | null;
  lastSeenAt: Date;
  errors24h: number;
  events24h: number;
}

/** One row per install, most recently heard from first. */
export async function queryInstalls(pool: pg.Pool): Promise<InstallSummary[]> {
  // Latest row and latest signed-in user per install come from the (install_id, id) index;
  // the 24h counts only touch the last day via the received_at index.
  const { rows } = await pool.query<InstallSummary>(
    `WITH latest AS (
       SELECT DISTINCT ON (install_id) install_id, app_version, device, os, received_at
       FROM telemetry ORDER BY install_id, id DESC
     ), day AS (
       SELECT install_id, count(*)::int AS events,
              count(*) FILTER (WHERE level IN ('error', 'fatal'))::int AS errors
       FROM telemetry WHERE received_at > now() - interval '24 hours' GROUP BY install_id
     )
     SELECT l.install_id AS "installId", s.user_id AS "userId", u.name AS "userName",
            l.app_version AS "appVersion", l.device, l.os, l.received_at AS "lastSeenAt",
            coalesce(d.errors, 0) AS "errors24h", coalesce(d.events, 0) AS "events24h"
     FROM latest l
     LEFT JOIN LATERAL (
       SELECT user_id FROM telemetry
       WHERE install_id = l.install_id AND user_id IS NOT NULL ORDER BY id DESC LIMIT 1
     ) s ON true
     LEFT JOIN users u ON u.id = s.user_id
     LEFT JOIN day d ON d.install_id = l.install_id
     ORDER BY l.received_at DESC`,
  );
  return rows;
}

interface Caps {
  perDay: number;
  maxRows: number;
  maxBytes: number;
}

/** How many of `wanted` events this install may still store (per-day and table caps). */
async function allowance(pool: pg.Pool, installId: string, wanted: number, caps: Caps) {
  // Two table-wide caps. pg_total_relation_size (heap + indexes + toast) is exact and cheap
  // (reads the relation's file sizes, no scan), and is what actually protects the disk: the
  // per-install daily cap is easy to dodge with random install ids, this one is not.
  // reltuples is only the planner's row estimate (lags until ANALYZE), kept as a second guard.
  const { rows } = await pool.query<{ bytes: number; total: number; today: number }>(
    `SELECT pg_total_relation_size('telemetry')::float8 AS bytes,
            (SELECT greatest(reltuples, 0)::float8 FROM pg_class WHERE oid = 'telemetry'::regclass) AS total,
            (SELECT count(*)::int FROM telemetry
             WHERE install_id = $1 AND received_at > now() - interval '24 hours') AS today`,
    [installId],
  );
  if (rows[0].bytes >= caps.maxBytes || rows[0].total >= caps.maxRows) return 0;
  return Math.max(0, Math.min(wanted, caps.perDay - rows[0].today));
}

/** POST /v1/telemetry: no auth required (a crash before sign-up still gets reported). */
export async function telemetryIngestRoutes(app: FastifyInstance) {
  const { cfg, pool } = app.ctx;
  const debugInstalls = cfg.telemetryDebugInstalls;
  const wantsDebug = (id: string) => debugInstalls === 'all' || debugInstalls.has(id);

  app.post(
    '/v1/telemetry',
    {
      bodyLimit: 512 * 1024,
      config: { rateLimit: { max: cfg.telemetryRateLimit, timeWindow: '1 minute' } },
    },
    async (req) => {
      const b = parse(TelemetryBody, req.body);
      const installId = noNul(b.installId);
      const debug = wantsDebug(installId);
      // A bad or stale token never rejects the report; it is just stored unlinked, with the
      // smaller per-request limits (the excess is dropped, like the caps below).
      const user = await userFromToken(req);
      const limits = user ? AUTHED_LIMITS : ANON_LIMITS;
      const room = await allowance(pool, installId, Math.min(b.events.length, limits.events), {
        perDay: cfg.telemetryMaxEventsPerInstallDay,
        maxRows: cfg.telemetryMaxRows,
        maxBytes: cfg.telemetryMaxBytes,
      });
      // Over a cap: drop the excess silently so the phone doesn't retry it.
      if (room === 0) return { stored: 0, debug };
      const ev = b.events.slice(0, room);
      const now = new Date();
      try {
        await pool.query(
          `INSERT INTO telemetry (install_id, user_id, app_version, device, os,
                                  at, level, source, tag, message, details)
           SELECT $1, $2, $3, $4, $5, e.at, e.level, e.source, e.tag, e.message, e.details::jsonb
           FROM unnest($6::timestamptz[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[])
             AS e(at, level, source, tag, message, details)`,
          [
            installId,
            user?.id ?? null,
            clipMeta(b.appVersion),
            clipMeta(b.device),
            clipMeta(b.os),
            ev.map((e) => eventTime(e.at, now)),
            ev.map((e) => e.level),
            ev.map((e) => e.source),
            ev.map((e) => clip(e.tag, MAX_TAG)),
            ev.map((e) => clipMessage(e.message, limits.message)),
            ev.map((e) => detailsJson(e.details, limits.detailsBytes)),
          ],
        );
      } catch (err) {
        // Class 22 = data exception (bad encoding, invalid JSON text...): the batch itself is
        // bad, so answer 400 and the phone drops it instead of retrying forever.
        if (/^22/.test((err as { code?: string }).code ?? '')) {
          throw badRequest('invalid_data', 'Telemetry batch contains data the database rejects');
        }
        throw err;
      }
      return { stored: ev.length, debug };
    },
  );
}

/** Admin-only reads; registered inside the authenticated /v1 block. */
export async function telemetryAdminRoutes(app: FastifyInstance) {
  const { pool } = app.ctx;

  app.get('/telemetry', async (req) => {
    requireOperator(req);
    const q = parse(ListQuery, req.query);
    const events = await queryTelemetry(pool, {
      installId: q.installId,
      userId: q.userId,
      minLevel: q.level,
      tag: q.tag,
      since: parseSince(q.since),
      q: q.q,
      limit: q.limit,
    });
    return { events };
  });

  app.get('/telemetry/installs', async (req) => {
    requireOperator(req);
    return { installs: await queryInstalls(pool) };
  });
}
