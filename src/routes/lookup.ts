import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx } from '../db.js';
import { Budget } from '../budget.js';
import { tooManyRequests } from '../errors.js';
import { parse, userKey } from '../http.js';
import { buildLookup, buildLookups, refreshSpamState } from '../lookup.js';
import { vault } from '../vault.js';
import { normalizePhone, requirePhone } from '../phone.js';

export const CATEGORIES = ['scam', 'telemarketing', 'robocall', 'harassment', 'other'] as const;

export const MAX_BATCH = 100;
const BatchBody = z.object({ phones: z.array(z.string()).max(MAX_BATCH) });

const ReportBody = z.object({
  phone: z.string(),
  category: z.enum(CATEGORIES).nullish(),
  comment: z.string().trim().max(500).nullish(),
  notSpam: z.boolean().optional().default(false),
});

const NameBody = z.object({
  phone: z.string(),
  name: z.string().trim().min(1).max(60),
});

export async function lookupRoutes(app: FastifyInstance) {
  const { cfg, pool } = app.ctx;
  const threshold = cfg.spamThreshold;

  app.get<{ Params: { phone: string } }>(
    '/lookup/:phone',
    { config: { rateLimit: { max: cfg.lookupRateLimit, timeWindow: '1 minute', keyGenerator: userKey } } },
    async (req) => {
      const phone = requirePhone(req.params.phone, cfg.defaultRegion);
      // Don't log untrusted lookups: the call-count feeds shared spam scores, which open
      // sign-ups must not be able to nudge by repeatedly looking a number up.
      return buildLookup(pool, phone, {
        threshold,
        logUserId: req.user.id,
        familyId: req.user.family_id,
      });
    },
  );

  // Labels the Recents list: not logged, so it doesn't inflate callsToday.
  // Unparsable numbers (private, short codes) are skipped. Each distinct number
  // costs one unit of a separate per-member budget (BATCH_LOOKUP_RATE_LIMIT per
  // minute), so Recents labelling can't starve the call-time lookup budget.
  const batchBudget = new Budget(cfg.batchLookupRateLimit);
  app.post('/lookup/batch', async (req, reply) => {
    const b = parse(BatchBody, req.body);
    const phones = [
      ...new Set(b.phones.map((p) => normalizePhone(p, cfg.defaultRegion)).filter((p): p is string => !!p)),
    ];
    const waitMs = batchBudget.take(userKey(req), Math.max(1, phones.length));
    if (waitMs > 0) {
      reply.header('retry-after', String(Math.ceil(waitMs / 1000)));
      throw tooManyRequests(waitMs);
    }
    // A fixed handful of set-based queries, run in parallel.
    return { results: await buildLookups(pool, phones, threshold, undefined, req.user.family_id) };
  });

  // Every user feeds the shared spam list; the per-user limits stop one account flooding it.
  app.post('/reports', { config: { rateLimit: { max: 60, timeWindow: '1 hour', keyGenerator: userKey } } }, async (req) => {
    const b = parse(ReportBody, req.body);
    const phone = requirePhone(b.phone, cfg.defaultRegion);
    const spamRaw = await withTx(pool, async (c) => {
      await c.query(
        `INSERT INTO reports (user_id, phone, category, comment, not_spam, created_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (user_id, phone) DO UPDATE SET category = EXCLUDED.category,
           comment = EXCLUDED.comment, not_spam = EXCLUDED.not_spam, created_at = now()`,
        [req.user.id, phone, b.notSpam ? null : (b.category ?? 'other'), b.comment || null, b.notSpam],
      );
      return refreshSpamState(c, [phone], threshold);
    });
    return buildLookup(pool, phone, { threshold, spamRaw, familyId: req.user.family_id });
  });

  app.delete<{ Params: { phone: string } }>('/reports/:phone', async (req, reply) => {
    const phone = requirePhone(req.params.phone, cfg.defaultRegion);
    await withTx(pool, async (c) => {
      await c.query('DELETE FROM reports WHERE user_id = $1 AND phone = $2', [req.user.id, phone]);
      await refreshSpamState(c, [phone], threshold);
    });
    return reply.status(204).send();
  });

  app.post('/names', { config: { rateLimit: { max: 60, timeWindow: '1 hour', keyGenerator: userKey } } }, async (req) => {
    const b = parse(NameBody, req.body);
    const phone = requirePhone(b.phone, cfg.defaultRegion);
    await pool.query(
      `INSERT INTO name_suggestions (user_id, phone_hash, name_enc)
       SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM opt_outs WHERE phone_hash = $2)
       ON CONFLICT (user_id, phone_hash) DO UPDATE SET name_enc = EXCLUDED.name_enc, created_at = now()`,
      [req.user.id, vault().index(phone), vault().seal(phone, b.name)],
    );
    return buildLookup(pool, phone, { threshold, familyId: req.user.family_id });
  });
}
