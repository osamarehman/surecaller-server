import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vault } from '../src/vault.js';
import { api, createHarness, registerAdmin, registerMember, type Harness, type Session } from './helpers.js';

let h: Harness;
let admin: Session;
let ali: Session;
let sara: Session;

beforeAll(async () => {
  h = await createHarness();
  admin = await registerAdmin(h);
  ali = await registerMember(h, admin, '+923211111111', 'Ali');
  sara = await registerMember(h, admin, '+923222222222', 'Sara');
});
afterAll(async () => {
  await h.close();
});

describe('contacts sync and lookup', () => {
  it('stores contacts, normalizing and deduping', async () => {
    const r = await api(h, 'POST', '/v1/contacts/sync', ali.token, {
      contacts: [
        { phone: '+923215550142', name: 'Ali Raza' },
        { phone: '0321 5550143', name: 'Plumber' },
        { phone: 'garbage', name: 'Nope' },
        { phone: '+923215550144', name: '   ' },
        { phone: '+923215550143', name: 'Plumber Bhai' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ stored: 2 });
    const me = await api(h, 'GET', '/v1/me', ali.token);
    expect(me.body.sharedContactCount).toBe(2);
  });

  it('picks the most common shared name and lists alternatives', async () => {
    await api(h, 'POST', '/v1/contacts/sync', sara.token, {
      contacts: [{ phone: '+923215550142', name: 'Ali Plumber' }],
    });
    await api(h, 'POST', '/v1/contacts/sync', admin.token, {
      contacts: [{ phone: '+923215550142', name: 'Ali Raza' }],
    });
    const r = await api(h, 'GET', '/v1/lookup/+923215550142', sara.token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      phone: '+923215550142',
      name: 'Ali Raza',
      nameSource: 'contacts',
      altNames: [],
      savedByCount: 3,
      member: null,
      blocked: null,
      spam: { label: 'none', score: 0, reports: 0, notSpam: 0, topCategory: null, lastComment: null },
      callsToday: 1,
    });
  });

  it('breaks name ties by most recent', async () => {
    await api(h, 'POST', '/v1/contacts/sync', ali.token, { contacts: [{ phone: '+923007770001', name: 'Old Name' }] });
    await new Promise((r) => setTimeout(r, 20));
    await api(h, 'POST', '/v1/contacts/sync', sara.token, { contacts: [{ phone: '+923007770001', name: 'New Name' }] });
    const r = await api(h, 'GET', '/v1/lookup/+923007770001', admin.token);
    expect(r.body.name).toBe('New Name');
  });

  it('member profile beats contacts; suggested names are the last resort', async () => {
    await api(h, 'POST', '/v1/contacts/sync', admin.token, {
      contacts: [{ phone: '+923222222222', name: 'Sara Office' }],
    });
    await api(h, 'PATCH', '/v1/me', sara.token, { status: 'At work' });
    const m = await api(h, 'GET', '/v1/lookup/+923222222222', ali.token);
    expect(m.body.name).toBe('Sara');
    expect(m.body.nameSource).toBe('member');
    expect(m.body.member).toEqual({ id: sara.user.id, name: 'Sara', status: 'At work' });
    expect(m.body.altNames).toEqual([]);

    const s = await api(h, 'POST', '/v1/names', ali.token, { phone: '+923459990000', name: 'Courier' });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ name: 'Courier', nameSource: 'suggested', savedByCount: 0 });
    // One suggestion per user per phone: posting again replaces it.
    const s2 = await api(h, 'POST', '/v1/names', ali.token, { phone: '+923459990000', name: 'TCS Courier' });
    expect(s2.body.name).toBe('TCS Courier');
    expect(s2.body.altNames).toEqual([]);

    const unknown = await api(h, 'GET', '/v1/lookup/+923451112233', ali.token);
    expect(unknown.body).toMatchObject({ name: null, nameSource: null, savedByCount: 0 });
  });

  it('counts lookups in the last 24h as callsToday', async () => {
    for (let i = 0; i < 3; i++) await api(h, 'GET', '/v1/lookup/+923004445566', ali.token);
    const r = await api(h, 'GET', '/v1/lookup/%2B923004445566', sara.token);
    expect(r.body.callsToday).toBe(4);
    await h.pool.query("UPDATE lookups SET created_at = now() - interval '25 hours' WHERE phone_hash = $1", [
      vault().index('+923004445566'),
    ]);
    const later = await api(h, 'GET', '/v1/lookup/+923004445566', sara.token);
    expect(later.body.callsToday).toBe(1);
  });

  it('batch lookup skips junk and does not log', async () => {
    const r = await api(h, 'POST', '/v1/lookup/batch', ali.token, {
      phones: ['+923215550142', 'private', '+923215550142', '+923222222222'],
    });
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: { phone: string }) => x.phone)).toEqual(['+923215550142', '+923222222222']);
    const too = await api(h, 'POST', '/v1/lookup/batch', ali.token, { phones: Array(201).fill('+923215550142') });
    expect(too.status).toBe(400);
  });

  it('rejects invalid phones', async () => {
    const r = await api(h, 'GET', '/v1/lookup/12', ali.token);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_phone');
  });

  it('refuses sync when sharing is off and removes shared contacts', async () => {
    const off = await api(h, 'PATCH', '/v1/me', sara.token, { shareContacts: false });
    expect(off.body.shareContacts).toBe(false);
    expect(off.body.sharedContactCount).toBe(0);
    const r = await api(h, 'POST', '/v1/contacts/sync', sara.token, { contacts: [] });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('sharing_off');

    expect((await api(h, 'DELETE', '/v1/contacts', ali.token)).status).toBe(204);
    expect((await api(h, 'GET', '/v1/me', ali.token)).body.sharedContactCount).toBe(0);
  });

  it('accepts 20 000 contacts and rejects more', async () => {
    const contacts = Array.from({ length: 20_000 }, (_, i) => ({
      phone: `+9230${String(10_000_000 + i)}`,
      name: `Contact ${i}`,
    }));
    const r = await api(h, 'POST', '/v1/contacts/sync', admin.token, { contacts });
    expect(r.status).toBe(200);
    expect(r.body.stored).toBe(20_000);
    const over = await api(h, 'POST', '/v1/contacts/sync', admin.token, {
      contacts: [...contacts, { phone: '+923001112222', name: 'x' }],
    });
    expect(over.status).toBe(400);
    expect(over.body.error).toBe('too_many_contacts');
  });

  it('rate-limits lookups per token', async () => {
    const limited = await createHarness({ lookupRateLimit: 3 });
    try {
      const a = await registerAdmin(limited);
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await api(limited, 'GET', '/v1/lookup/+923001112222', a.token)).status);
      expect(codes).toEqual([200, 200, 200, 429]);
      const r = await api(limited, 'GET', '/v1/lookup/+923001112222', a.token);
      expect(r.body.error).toBe('rate_limited');
    } finally {
      await limited.close();
    }
  });
});
