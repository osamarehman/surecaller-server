import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_CODE, api, createHarness, registerAdmin, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe('register, admin bootstrap and invites', () => {
  it('health is public', async () => {
    const r = await api(h, 'GET', '/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, version: '1.0.0' });
  });

  it('rejects a wrong code and an unparsable phone', async () => {
    let r = await api(h, 'POST', '/v1/register', null, { phone: '+923001234567', name: 'X', code: 'nope' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('invalid_code');
    r = await api(h, 'POST', '/v1/register', null, { phone: 'abc', name: 'X', code: ADMIN_CODE });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_phone');
  });

  it('bootstraps the first admin with ADMIN_CODE, then runs the invite flow', async () => {
    // Local format is re-normalized with DEFAULT_REGION=PK.
    const reg = await api(h, 'POST', '/v1/register', null, {
      phone: '0300 1234567',
      name: 'Abbu',
      code: ADMIN_CODE.toUpperCase(), // the app uppercases what the user types
      deviceName: 'Pixel 8',
    });
    expect(reg.status).toBe(201);
    expect(reg.body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(reg.body.user).toMatchObject({
      phone: '+923001234567',
      name: 'Abbu',
      isAdmin: true,
      isTrusted: true,
      status: null,
      shareContacts: true,
      sharedContactCount: 0,
      watched: false,
      protection: { screening: false, overlay: false, recording: false, reportedAt: null },
    });
    const admin = reg.body;

    // The token is stored only as a hash.
    const { rows } = await h.pool.query('SELECT token_hash FROM users');
    expect(rows[0].token_hash).not.toBe(admin.token);

    // ADMIN_CODE can't create a second admin.
    const second = await api(h, 'POST', '/v1/register', null, {
      phone: '+923331112222',
      name: 'Stranger',
      code: ADMIN_CODE,
    });
    expect(second.status).toBe(403);
    expect(second.body.error).toBe('invalid_code');

    const inv = await api(h, 'POST', '/v1/invites', admin.token, { expiresInHours: 72 });
    expect(inv.status).toBe(201);
    expect(inv.body.code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(new Date(inv.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 71 * 3600_000);

    // Codes are case/dash-insensitive.
    const lower = inv.body.code.toLowerCase().replace('-', '');
    const m = await api(h, 'POST', '/v1/register', null, { phone: '+923331112222', name: 'Ammi', code: lower });
    expect(m.status).toBe(201);
    expect(m.body.user.isAdmin).toBe(false);

    // Single use.
    const reuse = await api(h, 'POST', '/v1/register', null, {
      phone: '+923339998888',
      name: 'Other',
      code: inv.body.code,
    });
    expect(reuse.status).toBe(403);

    // Members can't create phone-bound (device reset) invites, and get 5 plain ones.
    const forbidden = await api(h, 'POST', '/v1/invites', m.body.token, { phone: '+923331112222' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe('forbidden');
    for (let i = 0; i < 5; i++) {
      const ok = await api(h, 'POST', '/v1/invites', m.body.token, {});
      expect(ok.status).toBe(201);
      expect(ok.body.phone).toBeNull();
    }
    const over = await api(h, 'POST', '/v1/invites', m.body.token, {});
    expect(over.status).toBe(409);
    expect(over.body.error).toBe('invite_limit');

    // A plain invite can't take over an existing member's phone (and isn't consumed).
    const plain = await api(h, 'POST', '/v1/invites', admin.token, {});
    expect(plain.body.phone).toBeNull();
    const takeover = await api(h, 'POST', '/v1/register', null, { phone: '+923331112222', code: plain.body.code });
    expect(takeover.status).toBe(409);
    expect(takeover.body.error).toBe('phone_taken');
    expect((await api(h, 'GET', '/v1/me', m.body.token)).status).toBe(200);

    // Re-registering an existing phone with a phone-bound invite replaces the token, keeps the user.
    const inv2 = await api(h, 'POST', '/v1/invites', admin.token, { phone: '0333 1112222' });
    expect(inv2.status).toBe(201);
    expect(inv2.body.phone).toBe('+923331112222');
    const again = await api(h, 'POST', '/v1/register', null, {
      phone: '+923331112222',
      code: inv2.body.code,
    });
    expect(again.status).toBe(201);
    expect(again.body.user.id).toBe(m.body.user.id);
    expect(again.body.user.name).toBe('Ammi');
    expect((await api(h, 'GET', '/v1/me', m.body.token)).status).toBe(401);
    expect((await api(h, 'GET', '/v1/me', again.body.token)).status).toBe(200);

    // Admin can re-register (reinstall) with ADMIN_CODE.
    const adminAgain = await api(h, 'POST', '/v1/register', null, {
      phone: '+923001234567',
      code: ADMIN_CODE,
    });
    expect(adminAgain.status).toBe(201);
    expect(adminAgain.body.user.id).toBe(admin.user.id);
  });

  it('rejects expired invites', async () => {
    await h.pool.query(
      `WITH f AS (INSERT INTO families DEFAULT VALUES RETURNING id)
       INSERT INTO invites (code, expires_at, family_id) SELECT 'ABCD-EFGH', now() - interval '1 minute', id FROM f`,
    );
    const r = await api(h, 'POST', '/v1/register', null, { phone: '+923451234567', name: 'L', code: 'ABCD-EFGH' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('invalid_code');
  });
});

describe('auth failures', () => {
  it('requires a valid bearer token', async () => {
    for (const [method, url] of [
      ['GET', '/v1/me'],
      ['GET', '/v1/members'],
      ['GET', '/v1/lookup/+923001234567'],
      ['GET', '/v1/sync'],
      ['GET', '/v1/events'],
      ['GET', '/v1/app/latest'],
      ['POST', '/v1/check'],
    ] as const) {
      const none = await api(h, method, url, null, method === 'POST' ? { text: 'x' } : undefined);
      expect(none.status, url).toBe(401);
      expect(none.body.error).toBe('unauthorized');
      const bad = await api(h, method, url, 'f'.repeat(64), method === 'POST' ? { text: 'x' } : undefined);
      expect(bad.status, url).toBe(401);
    }
    const garbage = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Basic abc' } });
    expect(garbage.statusCode).toBe(401);
  });

  it('returns JSON errors for unknown routes and bad JSON', async () => {
    const r = await api(h, 'GET', '/nope');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
    const bad = await h.app.inject({
      method: 'POST',
      url: '/v1/register',
      headers: { 'content-type': 'application/json' },
      payload: '{bad',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_json');
  });
});

describe('me and members', () => {
  it('patches profile, lists and manages members', async () => {
    await h.pool.query('TRUNCATE families, users, invites CASCADE');
    const admin = await registerAdmin(h);
    const inv = await api(h, 'POST', '/v1/invites', admin.token, {});
    const m = (await api(h, 'POST', '/v1/register', null, { phone: '+923211111111', name: 'Ali', code: inv.body.code }))
      .body;

    const p = await api(h, 'PATCH', '/v1/me', m.token, {
      status: 'Driving',
      protection: { screening: true, overlay: true },
      fcmToken: 'fcm-ali',
    });
    expect(p.status).toBe(200);
    expect(p.body.status).toBe('Driving');
    expect(p.body.protection.screening).toBe(true);
    expect(p.body.protection.recording).toBe(false);
    expect(typeof p.body.protection.reportedAt).toBe('string');
    expect(p.body.lastSeenAt).not.toBeNull();

    const bad = await api(h, 'PATCH', '/v1/me', m.token, { name: '' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_request');

    const list = await api(h, 'GET', '/v1/members', m.token);
    expect(list.body.members.map((u: { name: string }) => u.name)).toEqual(['Abbu', 'Ali']);

    expect((await api(h, 'PATCH', `/v1/members/${admin.user.id}`, m.token, { watched: true })).status).toBe(403);
    const w = await api(h, 'PATCH', `/v1/members/${m.user.id}`, admin.token, { watched: true });
    expect(w.body.watched).toBe(true);

    const last = await api(h, 'PATCH', `/v1/members/${admin.user.id}`, admin.token, { isAdmin: false });
    expect(last.status).toBe(409);
    expect(last.body.error).toBe('last_admin');

    expect((await api(h, 'PATCH', '/v1/members/not-a-uuid', admin.token, { watched: true })).status).toBe(404);

    const stats = await api(h, 'GET', '/v1/stats', m.token);
    expect(stats.body).toEqual({ members: 2, knownNumbers: 2, spamBlocked: 0 });

    expect((await api(h, 'DELETE', `/v1/members/${m.user.id}`, admin.token)).status).toBe(204);
    expect((await api(h, 'GET', '/v1/me', m.token)).status).toBe(401);

    // DELETE /me (with an empty JSON body as some HTTP clients send).
    const del = await h.app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
    });
    expect(del.statusCode).toBe(204);
    const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM users');
    expect(rows[0].n).toBe(0);
  });
});
