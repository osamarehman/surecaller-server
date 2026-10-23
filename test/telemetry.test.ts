import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { api, createHarness, registerAdmin, registerMember, type Harness, type Session } from './helpers.js';

let h: Harness;
let admin: Session;
let ali: Session;

const INSTALL_A = '11111111-aaaa-4aaa-8aaa-111111111111';
const INSTALL_B = '22222222-bbbb-4bbb-8bbb-222222222222';

const report = (installId: string, events: unknown[], extra: Record<string, unknown> = {}) => ({
  installId,
  appVersion: '1.0.3+4',
  device: 'Google Pixel 9a',
  os: 'Android 16 (SDK 36)',
  events,
  ...extra,
});

const ev = (level: string, message: string, extra: Record<string, unknown> = {}) => ({
  at: '2026-10-21T09:50:15.917Z',
  level,
  source: 'dart',
  tag: 'startup',
  message,
  ...extra,
});

/** Another app on the same database with different settings (createHarness would wipe the data). */
async function withApp(overrides: Partial<Config>, fn: (h2: Harness) => Promise<void>) {
  const app = await buildApp({ ...h.cfg, ...overrides }, h.pool, { enabled: false, send: async () => {} });
  await app.ready();
  try {
    await fn({ ...h, app });
  } finally {
    await app.close();
  }
}

beforeAll(async () => {
  h = await createHarness({ telemetryDebugInstalls: new Set([INSTALL_B]) });
  admin = await registerAdmin(h);
  ali = await registerMember(h, admin, '+923211111111', 'Ali');
});
afterAll(async () => {
  await h.close();
});

describe('POST /v1/telemetry', () => {
  it('stores reports without a token (user null) and with a bad token', async () => {
    let r = await api(h, 'POST', '/v1/telemetry', null, report(INSTALL_A, [ev('fatal', 'boom', { details: { stack: 'at main' } })]));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ stored: 1, debug: false });

    r = await api(h, 'POST', '/v1/telemetry', 'f'.repeat(64), report(INSTALL_A, [ev('info', 'bad token still ok')]));
    expect(r.status).toBe(200);

    const { rows } = await h.pool.query('SELECT * FROM telemetry WHERE install_id = $1 ORDER BY id', [INSTALL_A]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      user_id: null,
      level: 'fatal',
      source: 'dart',
      tag: 'startup',
      message: 'boom',
      details: { stack: 'at main' },
      app_version: '1.0.3+4',
      device: 'Google Pixel 9a',
    });
    expect(rows[0].at.toISOString()).toBe('2026-10-21T09:50:15.917Z');
  });

  it('links events to the signed-in member', async () => {
    const r = await api(h, 'POST', '/v1/telemetry', ali.token, report(INSTALL_A, [ev('warn', 'api 500', { tag: 'api' })]));
    expect(r.status).toBe(200);
    const { rows } = await h.pool.query("SELECT user_id FROM telemetry WHERE message = 'api 500'");
    expect(rows[0].user_id).toBe(ali.user.id);
  });

  it('truncates long fields and oversized details instead of rejecting', async () => {
    const big = { stack: 'x'.repeat(20_000) };
    const r = await api(
      h,
      'POST',
      '/v1/telemetry',
      null,
      report(INSTALL_A, [ev('error', 'm'.repeat(5000), { tag: 't'.repeat(100), details: big, at: 'not a date' })]),
    );
    expect(r.status).toBe(200);
    const { rows } = await h.pool.query(
      "SELECT * FROM telemetry WHERE tag LIKE 'ttt%' ORDER BY id DESC LIMIT 1",
    );
    expect(rows[0].tag).toHaveLength(64);
    // No token: the small limits (1000 chars / 4 KB).
    expect(rows[0].message).toHaveLength(1000);
    expect(rows[0].details.truncated).toBe(true);
    expect(rows[0].details.preview).toHaveLength(2000);
    // Bad `at` falls back to the server time.
    expect(Math.abs(rows[0].at.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('gives signed-in members the larger limits', async () => {
    const details = { stack: 'y'.repeat(6000) }; // over 4 KB, under 16 KB
    const r = await api(
      h,
      'POST',
      '/v1/telemetry',
      ali.token,
      report(INSTALL_A, [ev('error', 'm'.repeat(5000), { tag: 'limits-authed', details })]),
    );
    expect(r.status).toBe(200);
    const { rows } = await h.pool.query("SELECT * FROM telemetry WHERE tag = 'limits-authed'");
    expect(rows[0].message).toHaveLength(4000);
    expect(rows[0].details).toEqual(details);
    await h.pool.query("DELETE FROM telemetry WHERE tag = 'limits-authed'");
  });

  it('keeps at most 50 events per request without a token, 200 with one', async () => {
    const many = Array.from({ length: 120 }, () => ev('info', 'bulk'));
    let r = await api(h, 'POST', '/v1/telemetry', null, report('bulk-install', many));
    expect(r.body.stored).toBe(50);
    r = await api(h, 'POST', '/v1/telemetry', ali.token, report('bulk-install', many));
    expect(r.body.stored).toBe(120);
    const { rows } = await h.pool.query("SELECT count(*)::int AS n FROM telemetry WHERE install_id = 'bulk-install'");
    expect(rows[0].n).toBe(170);
    await h.pool.query("DELETE FROM telemetry WHERE install_id = 'bulk-install'");
  });

  it('masks phone numbers in message and nested details, whatever the app sent', async () => {
    const r = await api(
      h,
      'POST',
      '/v1/telemetry',
      ali.token,
      report(INSTALL_A, [
        ev('warn', 'lookup +92 300 1234567 failed, then 0300-7654321 and %2B923001234567', {
          tag: 'redact',
          details: {
            phone: '+923001234567',
            url: '/v1/lookup/%2B92300%201234567?x=1',
            nested: { list: ['03001234567', 'short 123456', 42, null], note: 'ok' },
            code: 'K7Q2-9XPM', // not a phone: fewer than 7 digits
          },
        }),
      ]),
    );
    expect(r.status).toBe(200);
    expect(r.body.stored).toBe(1);
    const { rows } = await h.pool.query("SELECT message, details FROM telemetry WHERE tag = 'redact'");
    expect(rows[0].message).toBe('lookup …4567 failed, then …4321 and …4567');
    expect(rows[0].details).toEqual({
      phone: '…4567',
      url: '/v1/lookup/…4567?x=1',
      nested: { list: ['…4567', 'short 123456', 42, null], note: 'ok' },
      code: 'K7Q2-9XPM',
    });
    // The admin read shows the masked copy too (nothing else is stored).
    const list = await api(h, 'GET', '/v1/telemetry?tag=redact', admin.token);
    expect(list.body.events[0].message).toBe('lookup …4567 failed, then …4321 and …4567');
    await h.pool.query("DELETE FROM telemetry WHERE tag = 'redact'");
  });

  it('strips NUL bytes that Postgres would reject', async () => {
    const r = await api(
      h,
      'POST',
      '/v1/telemetry',
      null,
      report(INSTALL_A, [ev('info', 'nul\u0000here', { tag: 'nul\u0000tag', details: { k: 'a\u0000b', n: [1, 'x\u0000'] } })]),
    );
    expect(r.status).toBe(200);
    expect(r.body.stored).toBe(1);
    const { rows } = await h.pool.query("SELECT * FROM telemetry WHERE message = 'nulhere'");
    expect(rows[0].tag).toBe('nultag');
    expect(rows[0].details).toEqual({ k: 'ab', n: [1, 'x'] });
    await h.pool.query("DELETE FROM telemetry WHERE message = 'nulhere'");
  });

  it('replaces implausible phone times with server time', async () => {
    const r = await api(
      h,
      'POST',
      '/v1/telemetry',
      null,
      report('clock-install', [
        ev('info', 'year 1970', { at: '1970-01-01T00:00:00Z' }),
        ev('info', 'year 3000', { at: '3000-01-01T00:00:00Z' }),
      ]),
    );
    expect(r.status).toBe(200);
    const { rows } = await h.pool.query("SELECT at FROM telemetry WHERE install_id = 'clock-install'");
    for (const row of rows) expect(Math.abs(row.at.getTime() - Date.now())).toBeLessThan(60_000);
    await h.pool.query("DELETE FROM telemetry WHERE install_id = 'clock-install'");
  });

  it('drops events over the per-install daily cap without rejecting', async () => {
    await withApp({ telemetryMaxEventsPerInstallDay: 3 }, async (h2) => {
      const two = [ev('info', 'cap'), ev('info', 'cap')];
      expect((await api(h2, 'POST', '/v1/telemetry', null, report('cap-install', two))).body.stored).toBe(2);
      let r = await api(h2, 'POST', '/v1/telemetry', null, report('cap-install', two));
      expect(r.status).toBe(200);
      expect(r.body.stored).toBe(1);
      r = await api(h2, 'POST', '/v1/telemetry', null, report('cap-install', two));
      expect(r.body.stored).toBe(0);
      // Other installs are not affected.
      expect((await api(h2, 'POST', '/v1/telemetry', null, report('cap-other', two))).body.stored).toBe(2);
    });
    const { rows } = await h.pool.query("SELECT count(*)::int AS n FROM telemetry WHERE install_id = 'cap-install'");
    expect(rows[0].n).toBe(3);
    await h.pool.query("DELETE FROM telemetry WHERE install_id IN ('cap-install', 'cap-other')");
  });

  it('stores nothing once the table is over the global row cap', async () => {
    await h.pool.query('ANALYZE telemetry'); // refresh the row estimate the cap reads
    await withApp({ telemetryMaxRows: 1 }, async (h2) => {
      const r = await api(h2, 'POST', '/v1/telemetry', null, report('full-install', [ev('error', 'x')]));
      expect(r.status).toBe(200);
      expect(r.body.stored).toBe(0);
    });
    const { rows } = await h.pool.query("SELECT count(*)::int AS n FROM telemetry WHERE install_id = 'full-install'");
    expect(rows[0].n).toBe(0);
  });

  it('stores nothing once the table is over the size cap (needs no ANALYZE)', async () => {
    // The table already holds rows, so its on-disk size is at least one 8 KB page.
    await withApp({ telemetryMaxBytes: 8 * 1024 }, async (h2) => {
      const r = await api(h2, 'POST', '/v1/telemetry', ali.token, report('full-install', [ev('error', 'x')]));
      expect(r.status).toBe(200);
      expect(r.body.stored).toBe(0);
    });
    const { rows } = await h.pool.query("SELECT count(*)::int AS n FROM telemetry WHERE install_id = 'full-install'");
    expect(rows[0].n).toBe(0);
  });

  it('rejects bad batches', async () => {
    const tooMany = Array.from({ length: 201 }, () => ev('info', 'x'));
    expect((await api(h, 'POST', '/v1/telemetry', null, report(INSTALL_A, tooMany))).status).toBe(400);
    expect((await api(h, 'POST', '/v1/telemetry', null, report(INSTALL_A, []))).status).toBe(400);
    expect((await api(h, 'POST', '/v1/telemetry', null, report(INSTALL_A, [ev('loud', 'x')]))).status).toBe(400);
    expect((await api(h, 'POST', '/v1/telemetry', null, report('', [ev('info', 'x')]))).status).toBe(400);
  });

  it('asks listed installs for debug events', async () => {
    const r = await api(h, 'POST', '/v1/telemetry', null, report(INSTALL_B, [ev('debug', 'verbose')]));
    expect(r.body).toEqual({ stored: 1, debug: true });
  });

  it("'all' turns debug on for every install", async () => {
    await withApp({ telemetryDebugInstalls: 'all' }, async (h2) => {
      const r = await api(h2, 'POST', '/v1/telemetry', null, report('any-install', [ev('info', 'x')]));
      expect(r.body.debug).toBe(true);
    });
  });

  it('rate limits per IP', async () => {
    await withApp({ telemetryRateLimit: 2 }, async (h2) => {
      const body = report('rl-install', [ev('info', 'x')]);
      expect((await api(h2, 'POST', '/v1/telemetry', null, body)).status).toBe(200);
      expect((await api(h2, 'POST', '/v1/telemetry', null, body)).status).toBe(200);
      const r = await api(h2, 'POST', '/v1/telemetry', null, body);
      expect(r.status).toBe(429);
      expect(r.body.error).toBe('rate_limited');
    });
  });
});

describe('GET /v1/telemetry (admin)', () => {
  it('is admin only', async () => {
    expect((await api(h, 'GET', '/v1/telemetry', ali.token)).status).toBe(403);
    expect((await api(h, 'GET', '/v1/telemetry/installs', ali.token)).status).toBe(403);
    expect((await api(h, 'GET', '/v1/telemetry', null)).status).toBe(401);
  });

  it('filters by minimum level, install, text and time, newest first', async () => {
    let r = await api(h, 'GET', '/v1/telemetry?level=error', admin.token);
    expect(r.status).toBe(200);
    expect(r.body.events.map((e: { level: string }) => e.level).sort()).toEqual(['error', 'fatal']);
    // Newest first.
    expect(r.body.events[0].level).toBe('error');
    expect(r.body.events[1]).toMatchObject({
      installId: INSTALL_A,
      userId: null,
      userName: null,
      message: 'boom',
      details: { stack: 'at main' },
      at: '2026-10-21T09:50:15.917Z',
    });

    r = await api(h, 'GET', `/v1/telemetry?installId=${INSTALL_B}`, admin.token);
    expect(r.body.events).toHaveLength(1);
    expect(r.body.events[0].message).toBe('verbose');

    r = await api(h, 'GET', '/v1/telemetry?q=API%20500', admin.token);
    expect(r.body.events).toHaveLength(1);
    expect(r.body.events[0]).toMatchObject({ userId: ali.user.id, userName: 'Ali', tag: 'api' });

    r = await api(h, 'GET', `/v1/telemetry?userId=${ali.user.id}`, admin.token);
    expect(r.body.events).toHaveLength(1);

    r = await api(h, 'GET', '/v1/telemetry?tag=api', admin.token);
    expect(r.body.events).toHaveLength(1);

    const future = new Date(Date.now() + 60_000).toISOString();
    r = await api(h, 'GET', `/v1/telemetry?since=${encodeURIComponent(future)}`, admin.token);
    expect(r.body.events).toHaveLength(0);

    r = await api(h, 'GET', '/v1/telemetry?limit=2', admin.token);
    expect(r.body.events).toHaveLength(2);

    expect((await api(h, 'GET', '/v1/telemetry?level=loud', admin.token)).status).toBe(400);
    expect((await api(h, 'GET', '/v1/telemetry?userId=nope', admin.token)).status).toBe(400);
  });

  it('summarizes installs', async () => {
    const r = await api(h, 'GET', '/v1/telemetry/installs', admin.token);
    expect(r.status).toBe(200);
    const a = r.body.installs.find((i: { installId: string }) => i.installId === INSTALL_A);
    expect(a).toMatchObject({
      userId: ali.user.id, // the latest signed-in member on that install
      userName: 'Ali',
      appVersion: '1.0.3+4',
      device: 'Google Pixel 9a',
      os: 'Android 16 (SDK 36)',
      errors24h: 2,
      events24h: 4,
    });
    const b = r.body.installs.find((i: { installId: string }) => i.installId === INSTALL_B);
    expect(b).toMatchObject({ userId: null, userName: null, errors24h: 0, events24h: 1 });
    // Most recently heard from first.
    const seen = r.body.installs.map((i: { lastSeenAt: string }) => i.lastSeenAt);
    expect(seen).toEqual([...seen].sort().reverse());
    expect(r.body.installs.indexOf(b)).toBeLessThan(r.body.installs.indexOf(a));
  });
});
