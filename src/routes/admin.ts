import type { FastifyInstance } from 'fastify';
import { notFound } from '../errors.js';
import { requireOperator } from '../http.js';
import { UUID_RE } from '../users.js';

/**
 * Server-wide user list and per-user usage, for the operator only (admin of the trusted family).
 * Registered inside the authenticated /v1 block.
 */
export async function adminRoutes(app: FastifyInstance) {
  const { pool } = app.ctx;

  // Everyone signed up on this server, newest first, with their latest app version.
  app.get('/admin/users', async (req) => {
    requireOperator(req);
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.phone, u.email, u.is_admin AS "isAdmin", u.family_id AS "familyId",
              f.trusted AS "trustedFamily",
              (SELECT count(*)::int FROM users m WHERE m.family_id = u.family_id) AS "familySize",
              u.created_at AS "createdAt", u.last_seen_at AS "lastSeenAt",
              t.app_version AS "appVersion", t.device
       FROM users u
       JOIN families f ON f.id = u.family_id
       LEFT JOIN LATERAL (
         SELECT app_version, device FROM telemetry WHERE user_id = u.id ORDER BY id DESC LIMIT 1
       ) t ON true
       ORDER BY u.created_at DESC`,
    );
    return { users: rows };
  });

  // One user's usage: activity counts, lookups per day (last 14 days) and devices.
  app.get<{ Params: { id: string } }>('/admin/users/:id/usage', async (req) => {
    requireOperator(req);
    const id = req.params.id;
    if (!UUID_RE.test(id)) throw notFound('User not found');
    const user = (
      await pool.query(
        `SELECT u.id, u.name, u.phone, u.email, u.is_admin AS "isAdmin", u.family_id AS "familyId",
                f.trusted AS "trustedFamily", u.status, u.share_contacts AS "shareContacts",
                u.protection, u.created_at AS "createdAt", u.last_seen_at AS "lastSeenAt",
                (u.fcm_token IS NOT NULL) AS "pushEnabled",
                (SELECT count(*)::int FROM users m WHERE m.family_id = u.family_id) AS "familySize"
         FROM users u JOIN families f ON f.id = u.family_id WHERE u.id = $1`,
        [id],
      )
    ).rows[0];
    if (!user) throw notFound('User not found');

    const [counts, daily, devices] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM lookups WHERE user_id = $1 AND created_at > now() - interval '7 days') AS "lookups7d",
           (SELECT count(*)::int FROM lookups WHERE user_id = $1 AND created_at > now() - interval '30 days') AS "lookups30d",
           (SELECT count(*)::int FROM contacts WHERE user_id = $1) AS "sharedContacts",
           (SELECT count(*)::int FROM reports WHERE user_id = $1 AND NOT not_spam) AS "spamReports",
           (SELECT count(*)::int FROM reports WHERE user_id = $1 AND not_spam) AS "notSpamVotes",
           (SELECT count(*)::int FROM name_suggestions WHERE user_id = $1) AS "namesSuggested",
           (SELECT count(*)::int FROM url_reports WHERE user_id = $1) AS "linksReported",
           (SELECT count(*)::int FROM events WHERE from_user = $1 AND type = 'spam_call') AS "spamCallAlerts",
           (SELECT count(*)::int FROM events WHERE from_user = $1 AND type = 'scam_sms') AS "scamSmsAlerts",
           (SELECT count(*)::int FROM events WHERE from_user = $1 AND type = 'sos') AS "sosSent",
           (SELECT count(*)::int FROM handymen WHERE added_by = $1) AS "handymenAdded",
           (SELECT count(*)::int FROM handyman_reviews WHERE user_id = $1) AS "handymanReviews",
           (SELECT coalesce(sum(rows), 0)::int FROM pack_usage WHERE user_id = $1 AND day > current_date - 30) AS "packRows30d",
           (SELECT count(*)::int FROM telemetry WHERE user_id = $1 AND level IN ('error', 'fatal')
              AND received_at > now() - interval '7 days') AS "errors7d"`,
        [id],
      ),
      pool.query(
        `SELECT to_char(d, 'YYYY-MM-DD') AS day, count(l.id)::int AS lookups
         FROM generate_series(current_date - 13, current_date, interval '1 day') d
         LEFT JOIN lookups l ON l.user_id = $1 AND l.created_at >= d AND l.created_at < d + interval '1 day'
         GROUP BY d ORDER BY d`,
        [id],
      ),
      pool.query(
        `SELECT * FROM (
           SELECT DISTINCT ON (install_id) install_id AS "installId", app_version AS "appVersion", device, os,
                  received_at AS "lastSeenAt"
           FROM telemetry WHERE user_id = $1 ORDER BY install_id, id DESC
         ) d ORDER BY "lastSeenAt" DESC`,
        [id],
      ),
    ]);

    return {
      user,
      usage: counts.rows[0],
      lookupsByDay: daily.rows,
      devices: devices.rows,
    };
  });
}
