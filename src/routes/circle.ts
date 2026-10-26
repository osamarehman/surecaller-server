import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { lockCircle, withTx } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { parse, requireAdmin, userKey } from '../http.js';
import { refreshSpamForUser } from '../lookup.js';
import { normalizePhone, requirePhone } from '../phone.js';
import { vault } from '../vault.js';
import { canonicalInviteCode, newInviteCode } from '../tokens.js';
import type { PoolClient } from 'pg';
import { assertKeepsAnAdmin, getUser, toMe, toUser, USER_SELECT, UUID_RE, type UserRow } from '../users.js';
import { deleteMember } from './me.js';

const PatchMember = z.object({
  watched: z.boolean().optional(),
  isAdmin: z.boolean().optional(),
});

const JoinBody = z.object({ code: z.string().trim().min(1).max(200) });

/**
 * Moves a member out of their family (under lockCircle). The family must keep an admin if others
 * stay, and an emptied family is deleted. Their recent alerts and SOS go too: those belong to the
 * family they were sent in.
 */
async function moveMember(c: PoolClient, user: UserRow, to: { familyId: string; admin: boolean }) {
  await assertKeepsAnAdmin(c, { removing: user.id });
  await c.query('DELETE FROM events WHERE from_user = $1', [user.id]);
  await c.query('UPDATE users SET family_id = $2, is_admin = $3, watched = false WHERE id = $1', [
    user.id,
    to.familyId,
    to.admin,
  ]);
  await c.query('DELETE FROM families f WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM users WHERE family_id = f.id)', [
    user.family_id,
  ]);
}

const InviteBody = z.object({
  expiresInHours: z.number().int().min(1).max(24 * 30).optional().default(72),
  // Binds the code to this phone; required to re-register an existing member.
  phone: z.string().nullish(),
});

const MAX_CONTACTS = 20_000;
const ContactsBody = z.object({
  contacts: z.array(z.object({ phone: z.string(), name: z.string() })),
});

export async function circleRoutes(app: FastifyInstance) {
  const { cfg, pool } = app.ctx;

  // Members, invites and stats are per family: nobody sees another family.
  app.get('/members', async (req) => {
    const { rows } = await pool.query<UserRow>(
      `${USER_SELECT} WHERE u.family_id = $1 ORDER BY u.is_admin DESC, lower(u.name)`,
      [req.user.family_id],
    );
    return { members: rows.map(toUser) };
  });

  app.patch<{ Params: { id: string } }>('/members/:id', async (req) => {
    requireAdmin(req);
    const b = parse(PatchMember, req.body);
    const id = req.params.id;
    if (!UUID_RE.test(id)) throw notFound('Member not found');
    await withTx(pool, async (c) => {
      await lockCircle(c);
      const target = (
        await c.query<UserRow>('SELECT * FROM users WHERE id = $1 AND family_id = $2', [id, req.user.family_id])
      ).rows[0];
      if (!target) throw notFound('Member not found');
      if (b.isAdmin === false) await assertKeepsAnAdmin(c, { demoting: id });
      await c.query(
        'UPDATE users SET watched = coalesce($2, watched), is_admin = coalesce($3, is_admin) WHERE id = $1',
        [id, b.watched ?? null, b.isAdmin ?? null],
      );
      // Admin reports count as likely_scam, so a role change can flip labels.
      if (b.isAdmin !== undefined && b.isAdmin !== target.is_admin) {
        await refreshSpamForUser(c, id, cfg.spamThreshold);
      }
    });
    return toUser((await getUser(pool, id))!);
  });

  app.delete<{ Params: { id: string } }>('/members/:id', async (req, reply) => {
    requireAdmin(req);
    const id = req.params.id;
    if (!UUID_RE.test(id)) throw notFound('Member not found');
    const { rowCount } = await pool.query('SELECT 1 FROM users WHERE id = $1 AND family_id = $2', [
      id,
      req.user.family_id,
    ]);
    if (!rowCount) throw notFound('Member not found');
    await deleteMember(pool, id, cfg.spamThreshold);
    return reply.status(204).send();
  });

  // A signed-in user joins another family with its invite code, as a member.
  app.post('/family/join', async (req) => {
    const { code } = parse(JoinBody, req.body);
    await withTx(pool, async (c) => {
      await lockCircle(c);
      const invite = (
        await c.query<{ code: string; phone: string | null; family_id: string }>(
          `SELECT code, phone, family_id FROM invites
           WHERE code = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
          [canonicalInviteCode(code)],
        )
      ).rows[0];
      if (!invite || (invite.phone !== null && invite.phone !== req.user.phone)) {
        throw new AppError(403, 'invalid_code', 'Invite code is not valid');
      }
      if (invite.family_id === req.user.family_id) throw conflict('already_member', "You're already in this family");
      await moveMember(c, req.user, { familyId: invite.family_id, admin: false });
      await c.query('UPDATE invites SET used_at = now(), used_by = $2 WHERE code = $1', [invite.code, req.user.id]);
    });
    return toMe((await getUser(pool, req.user.id))!);
  });

  // Leaves the family and starts a new one with this user as its admin.
  app.post('/family/leave', async (req) => {
    await withTx(pool, async (c) => {
      await lockCircle(c);
      const { rows } = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE family_id = $1', [
        req.user.family_id,
      ]);
      if (rows[0].n === 1) throw conflict('alone', "You're the only member already");
      const fam = await c.query<{ id: string }>('INSERT INTO families DEFAULT VALUES RETURNING id');
      await moveMember(c, req.user, { familyId: fam.rows[0].id, admin: true });
    });
    return toMe((await getUser(pool, req.user.id))!);
  });

  // Non-admins may send up to this many plain invites (outstanding + already used).
  const MEMBER_INVITE_LIMIT = 5;

  app.post('/invites', async (req, reply) => {
    const b = parse(InviteBody, req.body);
    const phone = b.phone ? requirePhone(b.phone, cfg.defaultRegion) : null;
    // Phone-bound (device-reset) codes are admin-only.
    if (!req.user.is_admin && phone) throw forbidden();
    const result = await withTx(pool, async (c) => {
      // An admin can only reset devices in their own family, never take over someone else's number.
      if (phone) {
        const { rows } = await c.query<{ family_id: string }>('SELECT family_id FROM users WHERE phone = $1', [phone]);
        if (rows[0] && rows[0].family_id !== req.user.family_id) {
          throw conflict('phone_taken', 'This number belongs to another family');
        }
      }
      if (!req.user.is_admin) {
        // Lock so concurrent invites can't each read < limit and all insert.
        await lockCircle(c);
        const { rows } = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM invites
           WHERE created_by = $1 AND phone IS NULL AND (used_by IS NOT NULL OR expires_at > now())`,
          [req.user.id],
        );
        if (Number(rows[0].n) >= MEMBER_INVITE_LIMIT) {
          throw conflict('invite_limit', `You can invite up to ${MEMBER_INVITE_LIMIT} people. Ask an admin to add more.`);
        }
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newInviteCode();
        const { rows } = await c.query<{ expires_at: Date }>(
          `INSERT INTO invites (code, created_by, expires_at, phone, family_id)
           VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)
           ON CONFLICT (code) DO NOTHING RETURNING expires_at`,
          [code, req.user.id, b.expiresInHours, phone, req.user.family_id],
        );
        if (rows[0]) return { code, expiresAt: rows[0].expires_at.toISOString(), phone };
      }
      throw new Error('could not generate a unique invite code');
    });
    return reply.status(201).send(result);
  });

  // members and blocked are this family's; knownNumbers is the shared caller-ID database.
  app.get('/stats', async (req) => {
    const userPhones = (await pool.query<{ phone: string }>('SELECT phone FROM users')).rows;
    const { rows } = await pool.query<{ members: number; known: number; blocked: number }>(
      `SELECT
         (SELECT count(*) FROM users WHERE family_id = $2) AS members,
         (SELECT count(*) FROM (SELECT phone_hash FROM contacts UNION SELECT phone_hash FROM name_suggestions
                                UNION SELECT unnest($1::bytea[])) k) AS known,
         (SELECT count(*) FROM events e JOIN users u ON u.id = e.from_user
          WHERE e.type = 'spam_call' AND u.family_id = $2) AS blocked`,
      [userPhones.map((u) => vault().index(u.phone)), req.user.family_id],
    );
    return { members: rows[0].members, knownNumbers: rows[0].known, spamBlocked: rows[0].blocked };
  });

  app.post('/contacts/sync', { config: { rateLimit: { max: 30, timeWindow: '1 hour', keyGenerator: userKey } } }, async (req) => {
    const raw = req.body as { contacts?: unknown } | undefined;
    if (Array.isArray(raw?.contacts) && raw.contacts.length > MAX_CONTACTS) {
      throw badRequest('too_many_contacts', `At most ${MAX_CONTACTS} contacts per request`);
    }
    const b = parse(ContactsBody, req.body);
    if (!req.user.share_contacts) throw conflict('sharing_off', 'Contact sharing is turned off');

    // Dedupe by normalized phone (last entry wins); skip unparsable numbers and blank names.
    const byPhone = new Map<string, string>();
    for (const ct of b.contacts) {
      const name = ct.name.trim().slice(0, 100);
      const phone = normalizePhone(ct.phone, cfg.defaultRegion);
      if (phone && name) byPhone.set(phone, name);
    }
    const phones = [...byPhone.keys()];
    const v = vault();
    const hashes = phones.map((p) => v.index(p));
    const sealed = phones.map((p) => v.seal(p, byPhone.get(p)!));
    // Replace the stored set in place: drop numbers no longer sent, upsert the
    // rest (each stamped with this sync's time, as a full rewrite would).
    await withTx(pool, async (c) => {
      await c.query('DELETE FROM contacts WHERE user_id = $1 AND NOT (phone_hash = ANY($2::bytea[]))', [
        req.user.id,
        hashes,
      ]);
      if (phones.length) {
        // A number that stays in the address book keeps its family_only flag.
        await c.query(
          `INSERT INTO contacts (user_id, phone_hash, name_enc)
           SELECT $1, h, e FROM unnest($2::bytea[], $3::bytea[]) AS t(h, e)
           WHERE NOT EXISTS (SELECT 1 FROM opt_outs o WHERE o.phone_hash = t.h)
           ON CONFLICT (user_id, phone_hash) DO UPDATE SET name_enc = EXCLUDED.name_enc, updated_at = now()`,
          [req.user.id, hashes, sealed],
        );
      }
    });
    return { stored: phones.length };
  });

  app.delete('/contacts', async (req, reply) => {
    await pool.query('DELETE FROM contacts WHERE user_id = $1', [req.user.id]);
    return reply.status(204).send();
  });
}
