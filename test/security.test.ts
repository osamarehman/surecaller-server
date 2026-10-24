import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Budget } from '../src/budget.js';
import { buildLookup, buildLookups } from '../src/lookup.js';
import { ADMIN_CODE, api, createHarness, registerAdmin, registerMember, type Harness, type Session } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.pool.query(`TRUNCATE families, users, invites, contacts, reports, name_suggestions, lookups,
    spam_state, blocks, events, url_reports RESTART IDENTITY CASCADE`);
});

async function registerRaw(target: Harness, xff: string) {
  const res = await target.app.inject({
    method: 'POST',
    url: '/v1/register',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
    payload: JSON.stringify({ phone: '+923001234567', name: 'X', code: 'nope' }),
  });
  return res.statusCode;
}

describe('invite takeover protection', () => {
  it('plain invites only register new phones', async () => {
    const admin = await registerAdmin(h);
    const ali = await registerMember(h, admin, '+923211111111', 'Ali');
    const inv = await api(h, 'POST', '/v1/invites', admin.token, {});
    const r = await api(h, 'POST', '/v1/register', null, { phone: '+923211111111', name: 'Evil', code: inv.body.code });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('phone_taken');
    // The admin's phone can't be taken over either.
    const r2 = await api(h, 'POST', '/v1/register', null, { phone: '+923001234567', code: inv.body.code });
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe('phone_taken');
    // Ali's token still works; the invite was not consumed.
    expect((await api(h, 'GET', '/v1/me', ali.token)).status).toBe(200);
    const fresh = await api(h, 'POST', '/v1/register', null, { phone: '+923222222222', name: 'Sara', code: inv.body.code });
    expect(fresh.status).toBe(201);
  });

  it('open sign-up starts its own family as admin; existing needs a reset', async () => {
    const r = await api(h, 'POST', '/v1/register', null, { phone: '+923215550000', name: 'Open' });
    expect(r.status).toBe(201);
    expect(r.body.user.isAdmin).toBe(true); // admin of their own family
    expect(r.body.user.isTrusted).toBe(false); // but doesn't add to the shared caller ID
    const roster = await api(h, 'GET', '/v1/members', r.body.token);
    expect(roster.body.members.map((m: { phone: string }) => m.phone)).toEqual(['+923215550000']);
    expect((await api(h, 'POST', '/v1/events', r.body.token, { type: 'sos' })).status).toBe(201);
    // Shared data stays with trusted families.
    expect((await api(h, 'POST', '/v1/contacts/sync', r.body.token, { contacts: [] })).status).toBe(403);
    expect((await api(h, 'POST', '/v1/reports', r.body.token, { phone: '+923004445566' })).status).toBe(403);
    // Server-wide telemetry is for the operator only.
    expect((await api(h, 'GET', '/v1/telemetry', r.body.token)).status).toBe(403);
    // Their invite joins their family, untrusted too.
    const inv = await api(h, 'POST', '/v1/invites', r.body.token, {});
    const kid = await api(h, 'POST', '/v1/register', null, { phone: '+923215550009', name: 'Kid', code: inv.body.code });
    expect(kid.status).toBe(201);
    expect(kid.body.user.isTrusted).toBe(false);
    expect((await api(h, 'GET', '/v1/members', r.body.token)).body.members).toHaveLength(2);
    // The same number can't be taken over without a code (anti-hijack).
    const again = await api(h, 'POST', '/v1/register', null, { phone: '+923215550000', name: 'Other' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('phone_taken');
  });

  it('families never see or touch each other', async () => {
    const admin = await registerAdmin(h); // admin's phone is +923001234567
    const blk = await api(h, 'POST', '/v1/blocks', admin.token, { type: 'number', value: '+923459990000' });
    expect(blk.body.addedBy).toBe('Abbu');
    await api(h, 'POST', '/v1/events', admin.token, { type: 'sos', message: 'help' });
    const open = await api(h, 'POST', '/v1/register', null, { phone: '+923215550001', name: 'Open' });
    const t = open.body.token;

    // No member badge for another family's number, in lookups or the scam checker.
    expect((await api(h, 'GET', `/v1/lookup/${encodeURIComponent('+923001234567')}`, t)).body.member).toBeNull();
    const chk = await api(h, 'POST', '/v1/check', t, { text: 'call +923001234567 now' });
    expect(chk.body.phones?.every((p: { member: unknown }) => p.member === null)).toBe(true);
    // Separate block lists: the same rule is new in the other family, and sync shows only your own.
    const own = await api(h, 'POST', '/v1/blocks', t, { type: 'number', value: '+923459990000' });
    expect(own.status).toBe(201);
    expect(own.body.id).not.toBe(blk.body.id);
    const sync = await api(h, 'GET', '/v1/sync', t);
    expect(sync.body.blocks.map((b: { id: string }) => b.id)).toEqual([own.body.id]);
    expect((await api(h, 'DELETE', `/v1/blocks/${blk.body.id}`, t)).status).toBe(404);
    const look = await api(h, 'GET', `/v1/lookup/${encodeURIComponent('+923459990000')}`, admin.token);
    expect(look.body.blocked).toEqual({ byCircle: true, addedBy: 'Abbu' });
    // No alerts, roster or stats from the other family.
    expect((await api(h, 'GET', '/v1/events', t)).body.events).toEqual([]);
    expect((await api(h, 'GET', '/v1/stats', t)).body.members).toBe(1);
    const roster = await api(h, 'GET', '/v1/members', admin.token);
    expect(roster.body.members.some((m: { phone: string }) => m.phone === '+923215550001')).toBe(false);
    expect((await api(h, 'GET', `/v1/lookup/${encodeURIComponent('+923215550001')}`, admin.token)).body.member).toBeNull();
    // An admin can't manage, reset or invite their way into another family's member.
    expect((await api(h, 'PATCH', `/v1/members/${admin.user.id}`, t, { watched: true })).status).toBe(404);
    expect((await api(h, 'DELETE', `/v1/members/${admin.user.id}`, t)).status).toBe(404);
    const steal = await api(h, 'POST', '/v1/invites', t, { phone: '+923001234567' });
    expect(steal.status).toBe(409);
    // ADMIN_CODE only works for the operator's family.
    const code = await api(h, 'POST', '/v1/register', null, { phone: '+923215550001', code: ADMIN_CODE });
    expect(code.status).toBe(403);
  });

  it('phone-bound invites work only for that phone and keep admin rights', async () => {
    const admin = await registerAdmin(h);
    const ali = await registerMember(h, admin, '+923211111111', 'Ali');
    const bound = await api(h, 'POST', '/v1/invites', admin.token, { phone: '+923211111111' });
    expect(bound.status).toBe(201);
    expect(bound.body.phone).toBe('+923211111111');
    const wrong = await api(h, 'POST', '/v1/register', null, { phone: '+923222222222', name: 'X', code: bound.body.code });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe('invalid_code');
    const ok = await api(h, 'POST', '/v1/register', null, { phone: '+923211111111', code: bound.body.code });
    expect(ok.status).toBe(201);
    expect(ok.body.user.id).toBe(ali.user.id);
    expect((await api(h, 'GET', '/v1/me', ali.token)).status).toBe(401);
    // Single use.
    const again = await api(h, 'POST', '/v1/register', null, { phone: '+923211111111', code: bound.body.code });
    expect(again.status).toBe(403);

    // Only admins create bound invites.
    expect((await api(h, 'POST', '/v1/invites', ok.body.token, { phone: '+923001234567' })).status).toBe(403);
    // Reset device for an admin keeps isAdmin.
    const ab = await api(h, 'POST', '/v1/invites', admin.token, { phone: '+923001234567' });
    const re = await api(h, 'POST', '/v1/register', null, { phone: '+923001234567', code: ab.body.code });
    expect(re.status).toBe(201);
    expect(re.body.user.isAdmin).toBe(true);
    expect(re.body.user.id).toBe(admin.user.id);

    // A bound invite for a not-yet-member phone registers it as a new member.
    const nb = await api(h, 'POST', '/v1/invites', re.body.token, { phone: '+923339998888' });
    const nm = await api(h, 'POST', '/v1/register', null, { phone: '+923339998888', name: 'New', code: nb.body.code });
    expect(nm.status).toBe(201);
    expect(nm.body.user.isAdmin).toBe(false);

    const badPhone = await api(h, 'POST', '/v1/invites', re.body.token, { phone: 'abc' });
    expect(badPhone.status).toBe(400);
    expect(badPhone.body.error).toBe('invalid_phone');
  });
});

describe('config hardening', () => {
  it('refuses a short or example ADMIN_CODE', () => {
    expect(() => loadConfig({ adminCode: 'short' })).toThrow(/at least 12/);
    expect(() => loadConfig({ adminCode: 'change-me-to-something-long' })).toThrow(/example/);
    expect(loadConfig({ adminCode: null }).adminCode).toBeNull();
    expect(loadConfig({ adminCode: 'a'.repeat(12) }).adminCode).toBe('a'.repeat(12));
  });

  it('ignores X-Forwarded-For by default', async () => {
    expect(loadConfig({ adminCode: null }).trustProxy).toBe(false);
    const limited = await createHarness({ registerRateLimit: 2 });
    try {
      const codes = [await registerRaw(limited, '10.0.0.1'), await registerRaw(limited, '10.0.0.2'), await registerRaw(limited, '10.0.0.3')];
      expect(codes).toEqual([403, 403, 429]);
    } finally {
      await limited.close();
    }
  });

  it('uses X-Forwarded-For with TRUST_PROXY set', async () => {
    const proxied = await createHarness({ registerRateLimit: 1, trustProxy: 1 });
    try {
      const codes = [await registerRaw(proxied, '10.0.0.1'), await registerRaw(proxied, '10.0.0.2'), await registerRaw(proxied, '10.0.0.2')];
      expect(codes).toEqual([403, 403, 429]);
    } finally {
      await proxied.close();
    }
  });
});

describe('rate-limit keys', () => {
  it('counts Authorization header variants against one bucket', async () => {
    const limited = await createHarness({ lookupRateLimit: 3 });
    try {
      const a = await registerAdmin(limited);
      const variants = [
        `Bearer ${a.token}`,
        `Bearer ${a.token.toUpperCase()}`,
        `Bearer   ${a.token}  `,
        `Bearer\t${a.token.toUpperCase()} `,
      ];
      const codes: number[] = [];
      for (const authorization of variants) {
        const res = await limited.app.inject({ method: 'GET', url: '/v1/lookup/+923001112222', headers: { authorization } });
        codes.push(res.statusCode);
      }
      expect(codes).toEqual([200, 200, 200, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe('last admin', () => {
  it('blocks the last admin leaving via DELETE /me while others remain', async () => {
    const admin = await registerAdmin(h);
    const ali = await registerMember(h, admin, '+923211111111', 'Ali');
    const r = await api(h, 'DELETE', '/v1/me', admin.token);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('last_admin');
    // A non-admin can still leave; then the sole remaining admin can leave the empty circle.
    expect((await api(h, 'DELETE', '/v1/me', ali.token)).status).toBe(204);
    expect((await api(h, 'DELETE', '/v1/me', admin.token)).status).toBe(204);
  });

  it('serializes two admins deleting each other', async () => {
    const a = await registerAdmin(h);
    const b = await registerMember(h, a, '+923211111111', 'B');
    await registerMember(h, a, '+923222222222', 'C');
    expect((await api(h, 'PATCH', `/v1/members/${b.user.id}`, a.token, { isAdmin: true })).status).toBe(200);
    const [x, y] = await Promise.all([
      api(h, 'DELETE', `/v1/members/${b.user.id}`, a.token),
      api(h, 'DELETE', `/v1/members/${a.user.id}`, b.token),
    ]);
    const statuses = [x.status, y.status].sort();
    expect(statuses[0]).toBe(204);
    // The loser is blocked by last_admin, or its own account is already gone (401).
    expect([401, 409]).toContain(statuses[1]);
    const { rows } = await h.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE is_admin');
    expect(rows[0].n).toBe(1);
  });

  it('serializes two admins leaving at once', async () => {
    const a = await registerAdmin(h);
    const b = await registerMember(h, a, '+923211111111', 'B');
    await registerMember(h, a, '+923222222222', 'C');
    await api(h, 'PATCH', `/v1/members/${b.user.id}`, a.token, { isAdmin: true });
    const res = await Promise.all([api(h, 'DELETE', '/v1/me', a.token), api(h, 'DELETE', '/v1/me', b.token)]);
    expect(res.map((r) => r.status).sort()).toEqual([204, 409]);
    const { rows } = await h.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE is_admin');
    expect(rows[0].n).toBe(1);
  });
});

describe('batch lookup', () => {
  let admin: Session;
  let ali: Session;
  beforeEach(async () => {
    admin = await registerAdmin(h);
    ali = await registerMember(h, admin, '+923211111111', 'Ali');
  });

  it('matches single lookups exactly', async () => {
    const sara = await registerMember(h, admin, '+923222222222', 'Sara');
    await api(h, 'POST', '/v1/contacts/sync', ali.token, {
      contacts: [
        { phone: '+923215550142', name: 'Ali Raza' },
        { phone: '+923004445566', name: 'Bank?' },
      ],
    });
    await api(h, 'POST', '/v1/contacts/sync', sara.token, { contacts: [{ phone: '+923215550142', name: 'Plumber' }] });
    await api(h, 'POST', '/v1/names', sara.token, { phone: '+923007778899', name: 'Pizza' });
    await api(h, 'POST', '/v1/reports', ali.token, { phone: '+923004445566', category: 'scam', comment: 'PIN' });
    await api(h, 'POST', '/v1/reports', sara.token, { phone: '+923004445566', notSpam: true });
    await api(h, 'POST', '/v1/reports', admin.token, { phone: '+923009990000', category: 'robocall' });
    const blk = await api(h, 'POST', '/v1/blocks', admin.token, { type: 'prefix', value: '+92300999' });
    expect(blk.status).toBeLessThan(300);
    for (let i = 0; i < 2; i++) await api(h, 'GET', '/v1/lookup/+923004445566', ali.token);

    const phones = ['+923215550142', '+923004445566', '+923007778899', '+923009990000', '+923222222222', '+923111111111'];
    const batch = await api(h, 'POST', '/v1/lookup/batch', ali.token, { phones });
    expect(batch.status).toBe(200);
    const singles = [];
    const { family_id: familyId } = (
      await h.pool.query('SELECT family_id FROM users WHERE id = $1', [ali.user.id])
    ).rows[0];
    for (const p of phones) singles.push(await buildLookup(h.pool, p, { threshold: 2, familyId }));
    expect(batch.body.results).toEqual(JSON.parse(JSON.stringify(singles)));
    expect(batch.body.results[0].altNames).toEqual([]);
    expect(batch.body.results[1].spam).toMatchObject({ reports: 1, notSpam: 1, topCategory: 'scam', lastComment: 'PIN' });
    expect(batch.body.results[1].callsToday).toBe(2);
    expect(batch.body.results[2].nameSource).toBe('suggested');
    expect(batch.body.results[3].blocked).toEqual({ byCircle: true, addedBy: 'Abbu' });
    expect(batch.body.results[3].spam.label).toBe('likely_scam');
    expect(batch.body.results[4].member.name).toBe('Sara');
    expect(await buildLookups(h.pool, [], 2, undefined, '00000000-0000-0000-0000-000000000000')).toEqual([]);
  });

  it('caps a batch at 100 numbers', async () => {
    const ok = await api(h, 'POST', '/v1/lookup/batch', ali.token, { phones: Array(100).fill('+923215550142') });
    expect(ok.status).toBe(200);
    const too = await api(h, 'POST', '/v1/lookup/batch', ali.token, { phones: Array(101).fill('+923215550142') });
    expect(too.status).toBe(400);
  });

  it('charges each distinct number to a per-member budget', async () => {
    const limited = await createHarness({ batchLookupRateLimit: 150 });
    try {
      const a = await registerAdmin(limited);
      const nums = (from: number) => Array.from({ length: 100 }, (_, i) => `+9230${10_000_000 + from + i}`);
      expect((await api(limited, 'POST', '/v1/lookup/batch', a.token, { phones: nums(0) })).status).toBe(200);
      const over = await limited.app.inject({
        method: 'POST',
        url: '/v1/lookup/batch',
        headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ phones: nums(100) }),
      });
      expect(over.statusCode).toBe(429);
      expect(over.json().error).toBe('rate_limited');
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
      // The rejected batch charged nothing: 50 units remain.
      expect((await api(limited, 'POST', '/v1/lookup/batch', a.token, { phones: nums(0).slice(0, 50) })).status).toBe(200);
      expect((await api(limited, 'POST', '/v1/lookup/batch', a.token, { phones: ['+923001112222'] })).status).toBe(429);
      // Single lookups have their own budget.
      expect((await api(limited, 'GET', '/v1/lookup/+923001112222', a.token)).status).toBe(200);
    } finally {
      await limited.close();
    }
  });
});

describe('Budget', () => {
  it('charges cost and resets after the window', () => {
    const b = new Budget(3, 1000);
    expect(b.take('k', 2, 0)).toBe(0);
    expect(b.take('k', 2, 10)).toBe(990);
    expect(b.take('other', 3, 10)).toBe(0);
    expect(b.take('k', 1, 20)).toBe(0);
    expect(b.take('k', 3, 1000)).toBe(0);
  });
});
