import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { lockCircle, withTx } from '../db.js';
import { parse, userKey } from '../http.js';
import { refreshSpamForUser, spamReporters } from '../lookup.js';
import { emailTaken, EmailProof, proveIdentity, spendEmailCode, verifyGoogle } from '../email.js';
import { AppError, conflict, notFound } from '../errors.js';
import { assertKeepsAnAdmin, getUser, toMe } from '../users.js';
import { packVault } from '../pack.js';

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
  // A Google ID token also links the account to that Google account ("Confirm with Google").
  ...EmailProof,
});

const PhotoBody = z.object({ googleIdToken: z.string().min(1).max(4096) });
/** PUT /v1/me/photo per member per hour (each one checks a Google token; people set a photo once). */
export const PHOTO_RATE_LIMIT = 20;

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

  app.get('/me', async (req) => {
    const me = toMe((await getUser(pool, req.user.id))!);
    // Contacts uploaded before the pack existed lack phone_enc; one full re-upload fixes them.
    const { rows } = await pool.query<{ r: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM contacts WHERE user_id = $1 AND phone_enc IS NULL) AS r',
      [req.user.id],
    );
    return { ...me, contactsResyncNeeded: packVault() !== null && rows[0].r };
  });

  app.patch('/me', async (req) => {
    const b = parse(PatchMe, req.body);
    const proof = await proveIdentity(app.ctx, b);
    const email = proof?.email ?? null;
    const sub = proof?.sub ?? null; // set only for a Google proof
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
      let link = false;
      if (sub) {
        const { rows } = await c.query<{ google_sub: string | null }>(
          'SELECT google_sub FROM users WHERE id = $1 FOR UPDATE',
          [req.user.id],
        );
        const current = rows[0]?.google_sub ?? null;
        if (current === null) link = true;
        else if (current !== sub && cfg.signupProof === 'google') {
          // One Google account per account: switching would free the old one for a second account.
          throw conflict('google_account_set', 'This account is already confirmed with another Google account.');
        }
        // Linked to another Google account while SIGNUP_PROOF is not google: the email changes as
        // before, the link stays.
        if (link || current === sub) {
          set('google_sub', sub);
          sets.push('google_verified_at = now()');
        }
      }
      if (email) {
        // An email code changes only the email; the Google link stays.
        set('email', email);
        await spendEmailCode(c, email);
      }
      if (b.protection !== undefined) {
        vals.push(JSON.stringify({ ...b.protection, reportedAt: new Date().toISOString() }));
        sets.push(`protection = protection || $${vals.length}::jsonb`);
      }
      if (sets.length) await c.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals);
      // With SPAM_REPORTERS=google a newly linked account's reports start counting: relabel them.
      if (link && spamReporters() === 'google') await refreshSpamForUser(c, req.user.id, cfg.spamThreshold);
      // Turning sharing off removes what was shared.
      if (b.shareContacts === false) await c.query('DELETE FROM contacts WHERE user_id = $1', [req.user.id]);
    }).catch(emailTaken);
    return toMe((await getUser(pool, req.user.id))!);
  });

  // The member's photo is their Google profile picture and nothing else: the link comes out of a
  // verified Google ID token, so a client can never point it at an image of its choosing.
  app.put('/me/photo', { config: { rateLimit: { max: PHOTO_RATE_LIMIT, timeWindow: '1 hour', keyGenerator: userKey } } }, async (req) => {
    const b = parse(PhotoBody, req.body);
    const { picture } = await verifyGoogle(app.ctx, b.googleIdToken);
    if (!picture) throw new AppError(422, 'no_photo', 'This Google account has no profile picture');
    await pool.query('UPDATE users SET photo_url = $2 WHERE id = $1', [req.user.id, picture]);
    return toMe((await getUser(pool, req.user.id))!);
  });

  app.delete('/me/photo', async (req) => {
    await pool.query('UPDATE users SET photo_url = NULL WHERE id = $1', [req.user.id]);
    return toMe((await getUser(pool, req.user.id))!);
  });

  app.delete('/me', async (req, reply) => {
    await deleteMember(pool, req.user.id, cfg.spamThreshold);
    return reply.status(204).send();
  });
}
