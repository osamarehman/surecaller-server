import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { lockCircle, withTx } from '../db.js';
import { parse } from '../http.js';
import { refreshSpamForUser } from '../lookup.js';
import { EmailProof, isEmailTaken, proveEmail, spendEmailCode } from '../email.js';
import { conflict, notFound } from '../errors.js';
import { assertKeepsAnAdmin, getUser, toMe } from '../users.js';

const PatchMe = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  status: z.string().trim().max(100).nullable().optional(),
  shareContacts: z.boolean().optional(),
  protection: z
    .object({
      screening: z.boolean().optional(),
      overlay: z.boolean().optional(),
      recording: z.boolean().optional(),
    })
    .optional(),
  fcmToken: z.string().max(4096).nullable().optional(),
  // Adds or changes the account's email: a Google ID token, or email + a code from POST /v1/email-codes.
  ...EmailProof,
});

/**
 * Deletes a member with their contacts, reports, names and token, and refreshes
 * affected spam rows. Runs under the circle lock so two concurrent deletions
 * can't remove the last admin. The last admin can only go when nobody else is
 * left (`409 last_admin`).
 */
export async function deleteMember(pool: pg.Pool, userId: string, threshold: number): Promise<void> {
  await withTx(pool, async (c) => {
    await lockCircle(c);
    const { rows } = await c.query<{ family_id: string }>('SELECT family_id FROM users WHERE id = $1', [userId]);
    if (!rows[0]) throw notFound('Member not found');
    await assertKeepsAnAdmin(c, { removing: userId });
    await refreshSpamForUser(c, userId, threshold, async () => {
      // Keep the adder's name on circle blocks they created.
      await c.query(
        `UPDATE blocks b SET added_by_name = u.name FROM users u WHERE b.added_by = u.id AND u.id = $1`,
        [userId],
      );
      await c.query('DELETE FROM users WHERE id = $1', [userId]);
    });
    // The last member out takes the family (and its invites and block list) with them.
    await c.query('DELETE FROM families f WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM users WHERE family_id = f.id)', [
      rows[0].family_id,
    ]);
  });
}

export async function meRoutes(app: FastifyInstance) {
  const { cfg, pool } = app.ctx;

  app.get('/me', async (req) => toMe((await getUser(pool, req.user.id))!));

  app.patch('/me', async (req) => {
    const b = parse(PatchMe, req.body);
    const email = await proveEmail(app.ctx, b);
    await withTx(pool, async (c) => {
      const sets: string[] = [];
      const vals: unknown[] = [req.user.id];
      const set = (col: string, v: unknown) => {
        vals.push(v);
        sets.push(`${col} = $${vals.length}`);
      };
      if (b.name !== undefined) set('name', b.name);
      if (b.status !== undefined) set('status', b.status || null);
      if (b.shareContacts !== undefined) set('share_contacts', b.shareContacts);
      if (b.fcmToken !== undefined) set('fcm_token', b.fcmToken || null);
      if (email) {
        set('email', email);
        await spendEmailCode(c, email);
      }
      if (b.protection !== undefined) {
        vals.push(JSON.stringify({ ...b.protection, reportedAt: new Date().toISOString() }));
        sets.push(`protection = protection || $${vals.length}::jsonb`);
      }
      if (sets.length) await c.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals);
      // Turning sharing off removes what was shared.
      if (b.shareContacts === false) await c.query('DELETE FROM contacts WHERE user_id = $1', [req.user.id]);
    }).catch((e) => {
      throw isEmailTaken(e) ? conflict('email_taken', 'This email is already used by another account') : e;
    });
    return toMe((await getUser(pool, req.user.id))!);
  });

  app.delete('/me', async (req, reply) => {
    await deleteMember(pool, req.user.id, cfg.spamThreshold);
    return reply.status(204).send();
  });
}
