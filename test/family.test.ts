import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createHarness, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const signUp = async (phone: string, name: string) =>
  (await api(h, 'POST', '/v1/register', null, { phone, name })).body;
const names = async (token: string) =>
  (await api(h, 'GET', '/v1/members', token)).body.members.map((m: { name: string }) => m.name).sort();

describe('join and leave a family when signed in', () => {
  it('moves a signed-up user into another family with its invite, and out again', async () => {
    const ali = await signUp('+923001230001', 'Ali');
    const sara = await signUp('+923001230002', 'Sara');
    await api(h, 'POST', '/v1/events', sara.token, { type: 'sos' });

    const inv = await api(h, 'POST', '/v1/invites', ali.token, {});
    expect((await api(h, 'POST', '/v1/family/join', sara.token, { code: 'NOPE-NOPE' })).status).toBe(403);
    // /v1/join is the same route as /v1/family/join.
    const join = await api(h, 'POST', '/v1/join', sara.token, { code: inv.body.code.toLowerCase() });
    expect(join.status).toBe(200);
    expect(join.body.isAdmin).toBe(false);
    expect(await names(ali.token)).toEqual(['Ali', 'Sara']);
    // Her SOS from the old family doesn't follow her, and her empty family is gone.
    expect((await api(h, 'GET', '/v1/events', ali.token)).body.events).toHaveLength(0);
    const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM families');
    expect(rows[0].n).toBe(1);
    // The code is used up, and joining your own family is refused.
    expect((await api(h, 'POST', '/v1/family/join', sara.token, { code: inv.body.code })).status).toBe(403);
    const inv2 = await api(h, 'POST', '/v1/invites', ali.token, {});
    expect((await api(h, 'POST', '/v1/family/join', sara.token, { code: inv2.body.code })).body.error).toBe(
      'already_member',
    );

    // The only admin can't leave others without an admin.
    const stuck = await api(h, 'POST', '/v1/family/leave', ali.token);
    expect(stuck.body.error).toBe('last_admin');

    const leave = await api(h, 'POST', '/v1/family/leave', sara.token);
    expect(leave.status).toBe(200);
    expect(leave.body.isAdmin).toBe(true);
    expect(await names(sara.token)).toEqual(['Sara']);
    expect(await names(ali.token)).toEqual(['Ali']);
    expect((await api(h, 'POST', '/v1/family/leave', sara.token)).body.error).toBe('alone');
  });
});
