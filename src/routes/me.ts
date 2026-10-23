import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { lockCircle, withTx } from '../db.js';
import { notFound } from '../errors.js';
import { parse } from '../http.js';
import { refreshSpamForUser } from '../lookup.js';
import { assertKeepsAnAdmin, getUser, toUser } from '../users.js';

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
    const { rowCount } = await c.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (!rowCount) throw notFound('Member not found');
    await assertKeepsAnAdmin(c, { removing: userId });
    await refreshSpamForUser(c, userId, threshold, async () => {
      // Keep the adder's name on circle blocks they created.
      await c.query(
        `UPDATE blocks b SET added_by_name = u.name FROM users u WHERE b.added_by = u.id AND u.id = $1`,
        [userId],
      );
      await c.query('DELETE FROM users WHERE id = $1', [userId]);
    });
  });
}

export async function meRoutes(app: FastifyInstance) {
  const { cfg, pool } = app.ctx;

  app.get('/me', async (req) => toUser((await getUser(pool, req.user.id))!));

  app.patch('/me', async (req) => {
    const b = parse(PatchMe, req.body);
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
      if (b.protection !== undefined) {
        vals.push(JSON.stringify({ ...b.protection, reportedAt: new Date().toISOString() }));
        sets.push(`protection = protection || $${vals.length}::jsonb`);
      }
      if (sets.length) await c.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals);
      // Turning sharing off removes what was shared.
      if (b.shareContacts === false) await c.query('DELETE FROM contacts WHERE user_id = $1', [req.user.id]);
    });
    return toUser((await getUser(pool, req.user.id))!);
  });

  app.delete('/me', async (req, reply) => {
    await deleteMember(pool, req.user.id, cfg.spamThreshold);
    return reply.status(204).send();
  });
}
