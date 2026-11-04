import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createHarness, registerAdmin, registerMember, type Harness, type Session } from './helpers.js';

let h: Harness;
let op: Session;
let ali: Session;
let stranger: Session;

beforeAll(async () => {
  h = await createHarness();
  op = await registerAdmin(h);
  ali = await registerMember(h, op, '+923211111111', 'Ali');
  stranger = (await api(h, 'POST', '/v1/register', null, { phone: '+923009990010', name: 'Sara' })).body;
});
afterAll(async () => {
  await h.close();
});

describe('operator user admin', () => {
  it('flags only the operator in /v1/me', async () => {
    expect((await api(h, 'GET', '/v1/me', op.token)).body.isOperator).toBe(true);
    expect((await api(h, 'GET', '/v1/me', ali.token)).body.isOperator).toBe(false);
    // Admin of their own family, but not the trusted one.
    expect((await api(h, 'GET', '/v1/me', stranger.token)).body.isOperator).toBe(false);
  });

  it('lists every user to the operator only', async () => {
    expect((await api(h, 'GET', '/v1/admin/users', null)).status).toBe(401);
    expect((await api(h, 'GET', '/v1/admin/users', ali.token)).status).toBe(403);
    expect((await api(h, 'GET', '/v1/admin/users', stranger.token)).status).toBe(403);
    const r = await api(h, 'GET', '/v1/admin/users', op.token);
    expect(r.status).toBe(200);
    expect(r.body.users.map((u: { name: string }) => u.name)).toEqual(['Sara', 'Ali', 'Abbu']);
    const sara = r.body.users[0];
    expect(sara).toMatchObject({ phone: '+923009990010', isAdmin: true, trustedFamily: false, familySize: 1 });
  });

  it('reports one user’s usage', async () => {
    await api(h, 'GET', '/v1/lookup/+923331234567', ali.token);
    await api(h, 'POST', '/v1/reports', ali.token, { phone: '+923331234567', category: 'scam' });
    expect((await api(h, 'GET', `/v1/admin/users/${ali.user.id}/usage`, stranger.token)).status).toBe(403);
    expect((await api(h, 'GET', '/v1/admin/users/nope/usage', op.token)).status).toBe(404);
    const r = await api(h, 'GET', `/v1/admin/users/${ali.user.id}/usage`, op.token);
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ name: 'Ali', familySize: 2 });
    expect(r.body.usage.lookups7d).toBe(1);
    expect(r.body.usage.spamReports).toBe(1);
    expect(r.body.lookupsByDay).toHaveLength(14);
    expect(r.body.lookupsByDay.at(-1).lookups).toBe(1);
    expect(r.body.devices).toEqual([]);
  });
});
