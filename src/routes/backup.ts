import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { parse, userKey } from '../http.js';
import { vault } from '../vault.js';

// The app's local data (docs/API.md -> Backup). Opaque to the server: stored sealed, returned as sent.
const MAX_BYTES = 1_048_576;
const Body = z.object({ data: z.record(z.unknown()) });
// ponytail: reuses the vault's per-"phone" key with a prefix, so no new key to manage
const keyFor = (userId: string) => `backup:${userId}`;

export async function backupRoutes(app: FastifyInstance) {
  const { pool } = app.ctx;

  app.put(
    '/backup',
    { bodyLimit: MAX_BYTES + 1024, config: { rateLimit: { max: 60, timeWindow: '1 hour', keyGenerator: userKey } } },
    async (req) => {
      const { data } = parse(Body, req.body);
      const json = JSON.stringify(data);
      if (Buffer.byteLength(json) > MAX_BYTES) throw new AppError(413, 'too_large', 'Backup is over 1 MB');
      const { rows } = await pool.query<{ updated_at: Date }>(
        `INSERT INTO backups (user_id, data_enc) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET data_enc = EXCLUDED.data_enc, updated_at = now()
         RETURNING updated_at`,
        [req.user.id, vault().seal(keyFor(req.user.id), json)],
      );
      return { updatedAt: rows[0].updated_at.toISOString() };
    },
  );

  app.get('/backup', async (req) => {
    const { rows } = await pool.query<{ data_enc: Buffer; updated_at: Date }>(
      'SELECT data_enc, updated_at FROM backups WHERE user_id = $1',
      [req.user.id],
    );
    const json = rows[0] && vault().open(keyFor(req.user.id), rows[0].data_enc);
    if (!json) throw new AppError(404, 'no_backup', 'No backup for this account');
    return { data: JSON.parse(json), updatedAt: rows[0].updated_at.toISOString() };
  });

  app.delete('/backup', async (req, reply) => {
    await pool.query('DELETE FROM backups WHERE user_id = $1', [req.user.id]);
    return reply.status(204).send();
  });
}
