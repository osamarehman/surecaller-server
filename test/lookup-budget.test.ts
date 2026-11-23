import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { legacyUsage, secondsToUtcMidnight } from '../src/usage.js';
import { api, createHarness, registerAdmin, type Harness, type Session } from './helpers.js';

const LIMIT = 5;
/** Saved with a name by the admin: every lookup of these returns a name. */
const NAMED = Array.from({ length: 8 }, (_, i) => `+92300555${String(i).padStart(4, '0')}`);
const UNKNOWN = '+923009990000';

async function setup(h: Harness) {
  const a = await registerAdmin(h);
  await api(h, 'PATCH', '/v1/me', a.token, { shareContacts: true });
  const names = ['Ali', 'Bilal', 'Sana', 'Zara', 'Omar', 'Hina', 'Asad', 'Nida'];
  await api(h, 'POST', '/v1/contacts/sync', a.token, { contacts: NAMED.map((phone, i) => ({ phone, name: names[i] })) });
}

let n = 0;
const newMember = async (h: Harness): Promise<Session> =>
  (await api(h, 'POST', '/v1/register', null, { phone: `+92301444${String(n++).padStart(4, '0')}`, name: 'Member' })).body;

const used = async (h: Harness, s: Session) =>
  (await h.pool.query<{ n: number }>('SELECT n FROM lookup_usage WHERE user_id = $1', [s.user.id])).rows[0]?.n ?? 0;

const raw = (h: Harness, s: Session, method: 'GET' | 'POST', url: string, body?: unknown, headers: Record<string, string> = {}) =>
  h.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${s.token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });

describe('daily name budget, enforced', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ lookupDailyLimit: LIMIT, lookupDailyEnforce: true });
    await setup(h);
  });
  afterAll(async () => {
    await h.close();
  });

  it('shares one counter across the five routes and counts only answers with a name', async () => {
    const s = await newMember(h);
    expect((await api(h, 'GET', `/v1/lookup/${encodeURIComponent(NAMED[0])}`, s.token)).status).toBe(200);
    expect((await api(h, 'GET', `/v1/lookup/${encodeURIComponent(UNKNOWN)}`, s.token)).status).toBe(200); // no name
    expect(await used(h, s)).toBe(1);
    const batch = await api(h, 'POST', '/v1/lookup/batch', s.token, { phones: [NAMED[1], UNKNOWN] });
    expect(batch.body.results).toHaveLength(2);
    expect(await used(h, s)).toBe(2);
    const check = await api(h, 'POST', '/v1/check', s.token, { text: `call ${NAMED[2]} now` });
    expect(check.body.phones[0].name).toBe('Sana');
    expect(await used(h, s)).toBe(3);
    expect((await api(h, 'POST', '/v1/reports', s.token, { phone: NAMED[3], category: 'scam' })).body.name).toBe('Zara');
    expect((await api(h, 'POST', '/v1/names', s.token, { phone: NAMED[4], name: 'Omar Khan' })).body.name).toBe('Omar');
    expect(await used(h, s)).toBe(5);

    // At the limit: refused, with Retry-After to the next UTC midnight.
    const res = await raw(h, s, 'GET', `/v1/lookup/${encodeURIComponent(NAMED[5])}`);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: 'rate_limited' });
    const retry = Number(res.headers['retry-after']);
    expect(Math.abs(retry - secondsToUtcMidnight())).toBeLessThanOrEqual(5);
    for (const [method, url, body] of [
      ['POST', '/v1/lookup/batch', { phones: [NAMED[5]] }],
      ['POST', '/v1/check', { text: NAMED[5] }],
      ['POST', '/v1/reports', { phone: NAMED[6], category: 'scam' }],
      ['POST', '/v1/names', { phone: NAMED[6], name: 'Someone' }],
    ] as const) {
      const r = await raw(h, s, method, url, body);
      expect(r.statusCode, url).toBe(429);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    }
    // A refused report or suggestion stored nothing; a refused lookup was not logged.
    const { rows } = await h.pool.query(
      `SELECT (SELECT count(*)::int FROM reports WHERE user_id = $1 AND phone = $2) AS reports,
              (SELECT count(*)::int FROM name_suggestions WHERE user_id = $1) AS suggestions,
              (SELECT count(*)::int FROM lookups WHERE user_id = $1) AS lookups`,
      [s.user.id, NAMED[6]],
    );
    expect(rows[0]).toEqual({ reports: 0, suggestions: 1, lookups: 2 });
    expect(await used(h, s)).toBe(LIMIT);

    // Someone else still gets names.
    const other = await newMember(h);
    expect((await api(h, 'GET', `/v1/lookup/${encodeURIComponent(NAMED[5])}`, other.token)).body.name).toBe('Hina');
  });

  it('refuses a batch that would cross the limit whole', async () => {
    const s = await newMember(h);
    await h.pool.query("INSERT INTO lookup_usage (user_id, day, n) VALUES ($1, (now() AT TIME ZONE 'utc')::date, $2)", [
      s.user.id,
      LIMIT - 2,
    ]);
    const r = await raw(h, s, 'POST', '/v1/lookup/batch', { phones: NAMED.slice(0, 3) });
    expect(r.statusCode).toBe(429);
    expect(await used(h, s)).toBe(LIMIT - 2);
    // Two fit.
    const ok = await api(h, 'POST', '/v1/lookup/batch', s.token, { phones: NAMED.slice(0, 2) });
    expect(ok.body.results.map((l: { name: string }) => l.name)).toEqual(['Ali', 'Bilal']);
    expect(await used(h, s)).toBe(LIMIT);
  });

  it('answers the opt-out views without counting them, also past the limit', async () => {
    const s = await newMember(h);
    await h.pool.query("INSERT INTO lookup_usage (user_id, day, n) VALUES ($1, (now() AT TIME ZONE 'utc')::date, $2)", [
      s.user.id,
      LIMIT,
    ]);
    const rep = await api(h, 'POST', '/v1/reports?view=spam', s.token, { phone: NAMED[7], category: 'scam' });
    expect(rep.status).toBe(200);
    expect(rep.body).toEqual({ spam: expect.objectContaining({ label: 'suspected', reports: 1 }) });
    const sug = await raw(h, s, 'POST', '/v1/names?view=none', { phone: NAMED[7], name: 'Nida B' });
    expect(sug.statusCode).toBe(204);
    expect(sug.body).toBe('');
    const chk = await api(h, 'POST', '/v1/check?names=0', s.token, { text: `${NAMED[7]} and ${UNKNOWN}` });
    expect(chk.status).toBe(200);
    expect(chk.body.phones).toEqual([
      { phone: NAMED[7], spam: expect.objectContaining({ reports: 1 }) },
      { phone: UNKNOWN, spam: expect.objectContaining({ reports: 0 }) },
    ]);
    expect(await used(h, s)).toBe(LIMIT);
  });
});

describe('daily name budget, log only (the default)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ lookupDailyLimit: LIMIT });
    await setup(h);
  });
  afterAll(async () => {
    await h.close();
  });

  it('defaults to 2000 names a day, log only', () => {
    expect(loadConfig()).toMatchObject({ lookupDailyLimit: 2000, lookupDailyEnforce: false, packInline: false });
  });

  it('counts past the limit and refuses nothing', async () => {
    const s = await newMember(h);
    for (const phone of NAMED) {
      expect((await api(h, 'GET', `/v1/lookup/${encodeURIComponent(phone)}`, s.token)).status).toBe(200);
    }
    expect((await api(h, 'POST', '/v1/lookup/batch', s.token, { phones: NAMED })).body.results).toHaveLength(NAMED.length);
    expect((await api(h, 'POST', '/v1/reports', s.token, { phone: NAMED[0], category: 'scam' })).status).toBe(200);
    expect(await used(h, s)).toBe(2 * NAMED.length + 1);
  });

  it('records X-SureCaller-Build without a write on every request', async () => {
    const s = await newMember(h);
    const me = (headers: Record<string, string> = {}) => raw(h, s, 'GET', '/v1/me', undefined, headers);
    const row = async () =>
      (await h.pool.query<{ app_build: number | null; app_seen_at: Date | null; last_seen_at: Date }>(
        'SELECT app_build, app_seen_at, last_seen_at FROM users WHERE id = $1',
        [s.user.id],
      )).rows[0];
    await me();
    expect(await row()).toMatchObject({ app_build: null, app_seen_at: null });
    await me({ 'x-surecaller-build': '48' });
    const first = await row();
    expect(first.app_build).toBe(48);
    expect(first.app_seen_at).not.toBeNull();
    // Same build within the minute: no write.
    await h.pool.query("UPDATE users SET last_seen_at = now() - interval '10 seconds' WHERE id = $1", [s.user.id]);
    const before = (await row()).last_seen_at.getTime();
    await me({ 'x-surecaller-build': '48' });
    expect((await row()).last_seen_at.getTime()).toBe(before);
    // A new build is written at once; junk is ignored.
    await me({ 'x-surecaller-build': '49' });
    expect((await row()).app_build).toBe(49);
    await h.pool.query("UPDATE users SET last_seen_at = now() - interval '2 minutes' WHERE id = $1", [s.user.id]);
    await me({ 'x-surecaller-build': 'abc' });
    expect((await row()).app_build).toBe(49);
  });

  it('counts calls to the old routes per member and day', async () => {
    const s = await newMember(h);
    const legacy = legacyUsage(h.pool, h.app.log);
    try {
      const req = (url: string) => ({ routeOptions: { url }, user: { id: s.user.id } }) as never;
      await legacy.record(req('/v1/lookup/batch'));
      await legacy.record(req('/v1/lookup/batch'));
      await legacy.record(req('/v1/pack'));
      await legacy.record(req('/v1/me')); // not an old route
      await legacy.flush();
      await legacy.record(req('/v1/pack'));
    } finally {
      await legacy.close();
    }
    const { rows } = await h.pool.query<{ route: string; calls: number }>(
      'SELECT route, calls FROM legacy_usage WHERE user_id = $1 ORDER BY route',
      [s.user.id],
    );
    expect(rows).toEqual([
      { route: '/v1/lookup/batch', calls: 2 },
      { route: '/v1/pack', calls: 2 },
    ]);
  });
});

describe('old-route counting in the app', () => {
  it('records real requests by route pattern, written when the app closes', async () => {
    const h = await createHarness();
    try {
      const s = await newMember(h);
      await api(h, 'GET', `/v1/lookup/${encodeURIComponent(UNKNOWN)}`, s.token);
      await api(h, 'POST', '/v1/lookup/batch', s.token, { phones: [UNKNOWN] });
      await api(h, 'GET', '/v1/me', s.token);
      await h.app.close(); // flushes
      const { rows } = await h.pool.query<{ route: string; calls: number }>(
        'SELECT route, calls FROM legacy_usage WHERE user_id = $1 ORDER BY route COLLATE "C"',
        [s.user.id],
      );
      expect(rows).toEqual([
        { route: '/v1/lookup/:phone', calls: 1 },
        { route: '/v1/lookup/batch', calls: 1 },
      ]);
    } finally {
      await h.close();
    }
  });
});
