import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importDirectory } from '../src/directory.js';
import { vault } from '../src/vault.js';
import { api, createHarness, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe('business directory', () => {
  it('names unknown numbers, ranks below saved contacts, and honours opt-outs', async () => {
    const me = (await api(h, 'POST', '/v1/register', null, { phone: '+923001240001', name: 'Me' })).body;
    await h.pool.query('INSERT INTO opt_outs (phone_hash) VALUES ($1)', [vault().index('+923001240004')]);

    const n = await importDirectory(
      h.pool,
      [
        { phone: '0321 4327448', name: 'Mehar Baba Restaurant', category: 'restaurant' },
        { phone: '+92 321 4327448', name: 'Second listing, ignored' },
        { phone: '03001240003', name: 'Directory name' },
        { phone: '03001240004', name: 'Opted out' },
        { phone: 'not a phone', name: 'Bad' },
      ],
      'PK',
    );
    expect(n).toBe(2);

    const biz = (await api(h, 'GET', '/v1/lookup/+923214327448', me.token)).body;
    expect(biz).toMatchObject({ name: 'Mehar Baba Restaurant', nameSource: 'directory', category: 'restaurant' });
    expect((await api(h, 'GET', '/v1/lookup/+923001240004', me.token)).body.name).toBeNull();

    // A name someone saved wins over the directory.
    await api(h, 'PATCH', '/v1/me', me.token, { shareContacts: true });
    await api(h, 'POST', '/v1/contacts/sync', me.token, { contacts: [{ phone: '03001240003', name: 'Saved name' }] });
    const saved = (await api(h, 'GET', '/v1/lookup/+923001240003', me.token)).body;
    expect(saved).toMatchObject({ name: 'Saved name', nameSource: 'contacts', category: null });

    // A new import replaces the old one.
    expect(await importDirectory(h.pool, [{ phone: '03001240005', name: 'Only one' }], 'PK')).toBe(1);
    expect((await api(h, 'GET', '/v1/lookup/+923214327448', me.token)).body.name).toBeNull();
  });
});
