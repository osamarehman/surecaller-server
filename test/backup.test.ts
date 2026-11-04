import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createHarness, registerAdmin, registerMember, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe('backup', () => {
  it('stores one sealed backup per member and returns it only to them', async () => {
    const a = await registerAdmin(h, '+923001230001', 'Ali Khan');
    const b = await registerMember(h, a, '+923001230002', 'Sara Khan');
    expect((await api(h, 'GET', '/v1/backup', a.token)).body.error).toBe('no_backup');

    const data = { v: 1, notes: [{ phone: '+923001112223', note: 'Plumber' }], settings: { themeMode: 'dark' } };
    expect((await api(h, 'PUT', '/v1/backup', a.token, { data })).status).toBe(200);
    expect((await api(h, 'GET', '/v1/backup', a.token)).body.data).toEqual(data);
    expect((await api(h, 'GET', '/v1/backup', b.token)).status).toBe(404);

    const raw = (await h.pool.query('SELECT data_enc FROM backups')).rows[0].data_enc as Buffer;
    expect(raw.toString('latin1')).not.toContain('Plumber');

    await api(h, 'PUT', '/v1/backup', a.token, { data: { v: 2 } });
    expect((await api(h, 'GET', '/v1/backup', a.token)).body.data).toEqual({ v: 2 });
    expect((await api(h, 'PUT', '/v1/backup', a.token, { data: [1] })).status).toBe(400);
    const big = { blob: 'x'.repeat(1_048_600) };
    expect((await api(h, 'PUT', '/v1/backup', a.token, { data: big })).status).toBe(413);

    expect((await api(h, 'DELETE', '/v1/backup', a.token)).status).toBe(204);
    expect((await api(h, 'GET', '/v1/backup', a.token)).status).toBe(404);

    await api(h, 'PUT', '/v1/backup', b.token, { data: { v: 1 } });
    expect((await api(h, 'DELETE', '/v1/me', b.token)).status).toBe(204);
    expect((await h.pool.query('SELECT count(*)::int AS n FROM backups')).rows[0].n).toBe(0);
  });
});
