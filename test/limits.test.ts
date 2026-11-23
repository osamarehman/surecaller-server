import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, noStatementTimeout } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { optOutNumber } from '../src/privacy.js';
import { CHECK_RATE_LIMIT } from '../src/routes/check.js';
import { INVITE_RATE_LIMIT, STATS_RATE_LIMIT } from '../src/routes/circle.js';
import { EVENT_RATE_LIMIT } from '../src/routes/events.js';
import { PHOTO_RATE_LIMIT } from '../src/routes/me.js';
import { BLOCK_RATE_LIMIT } from '../src/routes/sync.js';
import { api, createHarness, registerAdmin, type Harness, type Session } from './helpers.js';

let h: Harness;
let a: Session;
beforeAll(async () => {
  h = await createHarness();
  a = await registerAdmin(h);
});
afterAll(async () => {
  await h.close();
});

/** Status codes of n calls in a row. */
async function statuses(n: number, call: (i: number) => Promise<{ status: number }>) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await call(i)).status);
  return out;
}

describe('database pool', () => {
  it('sets a statement timeout that migrations and pack builds lift, and puts it back', async () => {
    const pool = createPool(h.cfg.databaseUrl, { max: 1, statementTimeoutMs: 500 });
    try {
      const show = async () => (await pool.query<{ statement_timeout: string }>('SHOW statement_timeout')).rows[0].statement_timeout;
      expect(await show()).toBe('500ms');
      await expect(pool.query('SELECT pg_sleep(1)')).rejects.toThrow(/statement timeout/);
      // One connection: migrate runs on it and hands it back with the timeout restored.
      await migrate(pool);
      expect(await show()).toBe('500ms');
      const c = await pool.connect();
      try {
        await noStatementTimeout(c, () => c.query('SELECT pg_sleep(0.7)'));
      } finally {
        c.release();
      }
      expect(await show()).toBe('500ms');
    } finally {
      await pool.end();
    }
  });

  it('has the per-user indexes on telemetry and lookups', async () => {
    const { rows } = await h.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname IN ('telemetry_user_id_idx', 'lookups_user_time_idx') ORDER BY 1`,
    );
    expect(rows.map((r) => r.indexname)).toEqual(['lookups_user_time_idx', 'telemetry_user_id_idx']);
  });
});

describe('removal request', () => {
  it('deletes handyman listings for the number, with their reviews', async () => {
    const phone = '+923215557777';
    const add = await api(h, 'POST', '/v1/handymen', a.token, { name: 'Bilal', phone, city: 'Lahore', category: 'Plumber' });
    expect(add.status).toBe(201);
    await api(h, 'POST', '/v1/handymen', a.token, { name: 'Bilal', phone, city: 'Karachi', category: 'Plumber' });
    const keep = await api(h, 'POST', '/v1/handymen', a.token, { name: 'Other', phone: '+923215558888', city: 'Lahore', category: 'Plumber' });
    expect((await api(h, 'PUT', `/v1/handymen/${add.body.id}/review`, a.token, { rating: 5 })).status).toBe(200);

    const r = await optOutNumber(h.pool, phone);
    expect(r.handymen).toBe(2);
    expect((await h.pool.query('SELECT 1 FROM handymen WHERE phone = $1', [phone])).rowCount).toBe(0);
    expect((await h.pool.query('SELECT 1 FROM handyman_reviews WHERE handyman_id = $1', [add.body.id])).rowCount).toBe(0);
    expect((await api(h, 'GET', `/v1/handymen/${keep.body.id}`, a.token)).status).toBe(200);
    // And it can't be listed again.
    const again = await api(h, 'POST', '/v1/handymen', a.token, { name: 'Bilal', phone, city: 'Lahore', category: 'Plumber' });
    expect(again.status).toBe(409);
  });
});

describe('GET /v1/stats', () => {
  it('reuses the shared known-numbers count for a few minutes', async () => {
    const first = (await api(h, 'GET', '/v1/stats', a.token)).body;
    await api(h, 'PATCH', '/v1/me', a.token, { shareContacts: true });
    await api(h, 'POST', '/v1/contacts/sync', a.token, { contacts: [{ phone: '+923215550199', name: 'New' }] });
    const second = (await api(h, 'GET', '/v1/stats', a.token)).body;
    expect(second.knownNumbers).toBe(first.knownNumbers);
    expect(second).toMatchObject({ members: 1, spamBlocked: 0 });
  });

  it('is rate limited per member', async () => {
    const used = 2; // the test above
    const codes = await statuses(STATS_RATE_LIMIT - used + 1, () => api(h, 'GET', '/v1/stats', a.token));
    expect(codes.slice(0, -1).every((c) => c === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});

describe('per-member limits on writes', () => {
  it('limits spam alerts but never an SOS', async () => {
    const codes = await statuses(EVENT_RATE_LIMIT + 1, () =>
      api(h, 'POST', '/v1/events', a.token, { type: 'spam_call', phone: '+923215550123' }),
    );
    expect(codes.slice(0, -1).every((c) => c === 201)).toBe(true);
    expect(codes.at(-1)).toBe(429);
    expect((await api(h, 'POST', '/v1/events', a.token, { type: 'sos', message: 'help' })).status).toBe(201);
  });

  it('limits block rules, checks, invites and photo changes', async () => {
    const blocks = await statuses(BLOCK_RATE_LIMIT + 1, (i) =>
      api(h, 'POST', '/v1/blocks', a.token, { type: 'number', value: `+9232155${String(i).padStart(5, '0')}` }),
    );
    expect(blocks.at(-2)).toBe(201);
    expect(blocks.at(-1)).toBe(429);

    const checks = await statuses(CHECK_RATE_LIMIT + 1, () => api(h, 'POST', '/v1/check', a.token, { text: 'hello' }));
    expect(checks.at(-2)).toBe(200);
    expect(checks.at(-1)).toBe(429);

    const invites = await statuses(INVITE_RATE_LIMIT + 1, () => api(h, 'POST', '/v1/invites', a.token, {}));
    expect(invites.at(-2)).toBe(201);
    expect(invites.at(-1)).toBe(429);

    const photos = await statuses(PHOTO_RATE_LIMIT + 1, () =>
      api(h, 'PUT', '/v1/me/photo', a.token, { googleIdToken: 'google:face@gmail.com' }),
    );
    expect(photos.at(-2)).toBe(200);
    expect(photos.at(-1)).toBe(429);

    // Per member: someone else still gets through.
    const b = (await api(h, 'POST', '/v1/register', null, { phone: '+923002222299', name: 'B' })).body as Session;
    expect((await api(h, 'POST', '/v1/check', b.token, { text: 'hello' })).status).toBe(200);
  });
});
