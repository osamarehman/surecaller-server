import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createHarness, registerAdmin, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const as = (voter: string | null, method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) =>
  h.app
    .inject({
      method,
      url,
      headers: {
        ...(voter ? { 'x-voter-id': voter } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      payload: body ? JSON.stringify(body) : undefined,
    })
    .then((r) => ({ status: r.statusCode, body: r.json() }));

describe('feedback board', () => {
  it('posts, votes once per voter, sorts, and lets only trusted admins triage', async () => {
    const A = 'voter-aaaaaaaa';
    const B = 'voter-bbbbbbbb';
    expect((await as(null, 'POST', '/v1/feedback', { type: 'bug', title: 'No voter' })).status).toBe(400);
    expect((await as(A, 'POST', '/v1/feedback', { type: 'bug', title: 'x' })).status).toBe(400);

    const bug = await as(A, 'POST', '/v1/feedback', { type: 'bug', title: 'Call screen flickers', author: 'Ali' });
    expect(bug.status).toBe(201);
    expect(bug.body.item).toMatchObject({ type: 'bug', status: 'open', votes: 0, voted: false, author: 'Ali' });
    const feat = (await as(A, 'POST', '/v1/feedback', { type: 'feature', title: 'Dark dialer', description: 'pls' }))
      .body.item;

    expect((await as(A, 'POST', `/v1/feedback/${feat.id}/vote`)).body).toEqual({ votes: 1, voted: true });
    expect((await as(A, 'POST', `/v1/feedback/${feat.id}/vote`)).body).toEqual({ votes: 1, voted: true });
    expect((await as(B, 'POST', `/v1/feedback/${feat.id}/vote`)).body).toEqual({ votes: 2, voted: true });
    expect((await as(B, 'DELETE', `/v1/feedback/${feat.id}/vote`)).body).toEqual({ votes: 1, voted: false });
    expect((await as(A, 'POST', '/v1/feedback/nope/vote')).status).toBe(404);

    const top = await as(B, 'GET', '/v1/feedback');
    expect(top.body.items.map((i: { title: string }) => i.title)).toEqual(['Dark dialer', 'Call screen flickers']);
    expect(top.body.items[0].voted).toBe(false);
    const bugs = await as(null, 'GET', '/v1/feedback?type=bug&sort=new');
    expect(bugs.body.items).toHaveLength(1);

    // Triage: a trusted admin only.
    const admin = await registerAdmin(h);
    const stranger = (await api(h, 'POST', '/v1/register', null, { phone: '+923009990010', name: 'S' })).body;
    expect((await api(h, 'PATCH', `/v1/feedback/${bug.body.item.id}`, null, { status: 'planned' })).status).toBe(401);
    expect((await api(h, 'PATCH', `/v1/feedback/${bug.body.item.id}`, stranger.token, { status: 'planned' })).status).toBe(403);
    const rej = await api(h, 'PATCH', `/v1/feedback/${bug.body.item.id}`, admin.token, {
      status: 'rejected',
      rejectReason: 'Android limit',
    });
    expect(rej.body.item).toMatchObject({ status: 'rejected', rejectReason: 'Android limit' });
    const reopen = await api(h, 'PATCH', `/v1/feedback/${bug.body.item.id}`, admin.token, { status: 'open' });
    expect(reopen.body.item.rejectReason).toBeNull();

    expect((await api(h, 'DELETE', `/v1/feedback/${feat.id}`, admin.token)).body).toEqual({ ok: true });
    expect((await as(null, 'GET', '/v1/feedback')).body.items).toHaveLength(1);
    expect((await as(A, 'POST', `/v1/feedback/${feat.id}/vote`)).status).toBe(404);
  });
});
