import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vault } from '../src/vault.js';
import { api, createHarness, registerAdmin, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.pool.query('TRUNCATE users, privacy_requests, opt_outs CASCADE');
});
afterAll(async () => {
  await h.close();
});

describe('privacy requests', () => {
  it('stores one pending request per number and kind', async () => {
    const send = (email: string) =>
      api(h, 'POST', '/v1/privacy-requests', null, { kind: 'remove', phone: '0321 5550000', email });
    expect((await send('a@example.com')).status).toBe(202);
    expect((await send('b@example.com')).status).toBe(202);
    const { rows } = await h.pool.query('SELECT phone, email FROM privacy_requests');
    expect(rows).toEqual([{ phone: '+923215550000', email: 'b@example.com' }]);
    expect((await send('not-an-email')).status).toBe(400);
  });

  it('ignores uploads of an opted-out number', async () => {
    const admin = await registerAdmin(h);
    const phone = '+923215551111';
    await h.pool.query('INSERT INTO opt_outs (phone_hash) VALUES ($1)', [vault().index(phone)]);
    await api(h, 'POST', '/v1/contacts/sync', admin.token, { contacts: [{ phone, name: 'Opted Out' }] });
    await api(h, 'POST', '/v1/names', admin.token, { phone, name: 'Still Out' });
    const r = await api(h, 'GET', `/v1/lookup/${phone}`, admin.token);
    expect(r.body.name ?? null).toBeNull();
  });
});
