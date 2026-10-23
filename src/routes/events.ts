import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, parseSince, requireTrusted } from '../http.js';
import { requirePhone } from '../phone.js';

const EventBody = z.object({
  type: z.enum(['spam_call', 'sos', 'scam_sms']),
  phone: z.string().nullish(),
  message: z.string().trim().max(1000).nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
});

interface EventRow {
  id: string;
  type: string;
  from_user: string;
  from_name: string;
  phone: string | null;
  message: string | null;
  lat: number | null;
  lng: number | null;
  created_at: Date;
}

function toEvent(r: EventRow) {
  return {
    id: r.id,
    type: r.type,
    fromUser: { id: r.from_user, name: r.from_name },
    phone: r.phone,
    message: r.message,
    lat: r.lat,
    lng: r.lng,
    createdAt: r.created_at.toISOString(),
  };
}

export async function eventRoutes(app: FastifyInstance) {
  const { cfg, pool, notifier } = app.ctx;

  app.post('/events', async (req, reply) => {
    requireTrusted(req); // only family can raise SOS / spam alerts
    const b = parse(EventBody, req.body);
    const phone = b.phone ? requirePhone(b.phone, cfg.defaultRegion) : null;
    const { rows } = await pool.query<EventRow>(
      `INSERT INTO events (type, from_user, phone, message, lat, lng)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *, (SELECT name FROM users WHERE id = $2) AS from_name`,
      [b.type, req.user.id, phone, b.message || null, b.lat ?? null, b.lng ?? null],
    );
    const event = toEvent(rows[0]);

    // sos -> every other member; spam_call / scam_sms -> admins, only for watched members.
    if (notifier.enabled && (b.type === 'sos' || req.user.watched)) {
      const { rows: targets } = await pool.query<{ fcm_token: string }>(
        `SELECT fcm_token FROM users WHERE id <> $1 AND fcm_token IS NOT NULL
         AND trusted AND ($2 OR is_admin)`,
        [req.user.id, b.type === 'sos'],
      );
      // The push goes through Google, so it carries no event content (phone, message, SOS
      // position, member name): only the id. The app fetches the row with GET /v1/events?since.
      // The DB row itself stays complete; it never leaves the circle.
      const data: Record<string, string> = { kind: 'event', id: event.id };
      // Fire and forget: the client still gets 201 if FCM is slow or down.
      void notifier.send(
        targets.map((t) => t.fcm_token),
        data,
      ).catch((err) => req.log.warn({ err }, 'event push failed'));
    }

    return reply.status(201).send(event);
  });

  app.get<{ Querystring: { since?: string } }>('/events', async (req) => {
    // Untrusted (open sign-up) users get no alerts feed — SOS locations stay within the family.
    // Returned empty (not 403) so their background event poll doesn't error.
    if (!req.user.trusted) return { events: [] };
    const since = parseSince(req.query.since);
    // Visible: all sos; my own events; as admin, spam/scam events from watched members.
    const { rows } = await pool.query<EventRow>(
      `SELECT e.*, u.name AS from_name FROM events e JOIN users u ON u.id = e.from_user
       WHERE e.created_at > now() - interval '7 days'
         AND ($2::timestamptz IS NULL OR date_trunc('milliseconds', e.created_at) > $2)
         AND (e.type = 'sos' OR e.from_user = $1 OR ($3 AND u.watched))
       ORDER BY e.created_at DESC LIMIT 500`,
      [req.user.id, since, req.user.is_admin],
    );
    return { events: rows.map(toEvent) };
  });
}
