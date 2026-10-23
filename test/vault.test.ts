import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { createVault, vault } from '../src/vault.js';
import { api, createHarness, registerAdmin, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe('vault', () => {
  it('seals names per number and key; indexes are stable and keyed', () => {
    const a = createVault('11'.repeat(32));
    const b = createVault('22'.repeat(32));
    const blob = a.seal('+923001112233', 'Ali Raza');
    expect(a.open('+923001112233', blob)).toBe('Ali Raza');
    expect(a.open('+923001112234', blob)).toBeNull(); // another number can't open it
    expect(b.open('+923001112233', blob)).toBeNull(); // another server key can't either
    expect(a.seal('+923001112233', 'Ali Raza').equals(blob)).toBe(false); // random IV
    expect(a.index('+923001112233').equals(a.index('+923001112233'))).toBe(true);
    expect(a.index('+923001112233').equals(b.index('+923001112233'))).toBe(false);
    expect(() => createVault('abc')).toThrow(/64 hex/);
  });
});

describe('contacts at rest', () => {
  it('stores no plaintext numbers or names', async () => {
    const admin = await registerAdmin(h);
    await api(h, 'POST', '/v1/contacts/sync', admin.token, {
      contacts: [{ phone: '+923215557788', name: 'Plaintext Canary' }],
    });
    await api(h, 'POST', '/v1/names', admin.token, { phone: '+923215557799', name: 'Suggested Canary' });
    await api(h, 'GET', '/v1/lookup/+923215557788', admin.token);
    const dump = (
      await h.pool.query(`SELECT
        (SELECT coalesce(string_agg(encode(phone_hash, 'escape') || encode(name_enc, 'escape'), ''), '') FROM contacts) ||
        (SELECT coalesce(string_agg(encode(phone_hash, 'escape') || encode(name_enc, 'escape'), ''), '') FROM name_suggestions) ||
        (SELECT coalesce(string_agg(encode(phone_hash, 'escape'), ''), '') FROM lookups) AS all`)
    ).rows[0].all as string;
    expect(dump.length).toBeGreaterThan(0);
    for (const s of ['3215557788', '3215557799', 'Canary']) expect(dump).not.toContain(s);
    // ...yet the lookup still resolves the name.
    expect((await api(h, 'GET', '/v1/lookup/+923215557788', admin.token)).body.name).toBe('Plaintext Canary');
  });

  it('encrypts leftover plaintext tables once, as family-only, and drops them', async () => {
    await h.pool.query('TRUNCATE users, invites, contacts, name_suggestions, lookups CASCADE');
    const admin = await registerAdmin(h);
    await h.pool.query(`CREATE TABLE contacts_plain (user_id uuid, phone text, name text, updated_at timestamptz DEFAULT now());
      INSERT INTO contacts_plain (user_id, phone, name) VALUES ('${admin.user.id}', '+923216660011', 'Old Family Contact')`);
    await migrate(h.pool);
    expect((await h.pool.query("SELECT to_regclass('contacts_plain') AS t")).rows[0].t).toBeNull();
    const { rows } = await h.pool.query('SELECT family_only, name_enc FROM contacts WHERE phone_hash = $1', [
      vault().index('+923216660011'),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].family_only).toBe(true);
    expect(vault().open('+923216660011', rows[0].name_enc)).toBe('Old Family Contact');

    // Family sees it; an open sign-up doesn't. A re-sync keeps the family-only flag.
    const open = await api(h, 'POST', '/v1/register', null, { phone: '+923216660099', name: 'Stranger' });
    expect((await api(h, 'GET', '/v1/lookup/+923216660011', admin.token)).body.name).toBe('Old Family Contact');
    expect((await api(h, 'GET', '/v1/lookup/+923216660011', open.body.token)).body.name).toBeNull();
    await api(h, 'POST', '/v1/contacts/sync', admin.token, {
      contacts: [
        { phone: '+923216660011', name: 'Old Family Contact' },
        { phone: '+923216660022', name: 'New Contact' },
      ],
    });
    expect((await api(h, 'GET', '/v1/lookup/+923216660011', open.body.token)).body.name).toBeNull();
    expect((await api(h, 'GET', '/v1/lookup/+923216660022', open.body.token)).body.name).toBe('New Contact');
  });
});
