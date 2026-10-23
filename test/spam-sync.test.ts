import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createHarness, registerAdmin, registerMember, type Harness, type Session } from './helpers.js';
import { refreshSpamState } from '../src/lookup.js';
import { vault } from '../src/vault.js';
import { assertKeepsAnAdmin } from '../src/users.js';

let h: Harness;
let admin: Session;
let ali: Session;
let sara: Session;
let zain: Session;

const SCAMMER = '+923041112233';

beforeAll(async () => {
  h = await createHarness();
  admin = await registerAdmin(h);
  ali = await registerMember(h, admin, '+923211111111', 'Ali');
  sara = await registerMember(h, admin, '+923222222222', 'Sara');
  zain = await registerMember(h, admin, '+923233333333', 'Zain');
});
afterAll(async () => {
  await h.close();
});

describe('reports and spam labels', () => {
  it('moves from none to suspected to likely_scam, with not-spam votes subtracting', async () => {
    let r = await api(h, 'POST', '/v1/reports', ali.token, { phone: SCAMMER, category: 'scam', comment: 'Asks for OTP' });
    expect(r.status).toBe(200);
    expect(r.body.spam).toMatchObject({
      label: 'suspected',
      score: 40,
      reports: 1,
      notSpam: 0,
      topCategory: 'scam',
      lastComment: 'Asks for OTP',
    });

    // Posting again replaces my report (still one reporter).
    r = await api(h, 'POST', '/v1/reports', ali.token, { phone: SCAMMER, category: 'scam', comment: 'Asks for card PIN' });
    expect(r.body.spam.reports).toBe(1);
    expect(r.body.spam.lastComment).toBe('Asks for card PIN');

    r = await api(h, 'POST', '/v1/reports', sara.token, { phone: SCAMMER, category: 'telemarketing' });
    expect(r.body.spam).toMatchObject({ label: 'likely_scam', reports: 2, score: 80 });

    // Score adds 2 per lookup today.
    await api(h, 'GET', `/v1/lookup/${SCAMMER}`, zain.token);
    r = await api(h, 'GET', `/v1/lookup/${SCAMMER}`, zain.token);
    expect(r.body.spam.score).toBe(84);

    r = await api(h, 'POST', '/v1/reports', zain.token, { phone: SCAMMER, notSpam: true });
    expect(r.body.spam).toMatchObject({ label: 'suspected', reports: 2, notSpam: 1, score: 44 });

    // Withdrawing a report.
    expect((await api(h, 'DELETE', `/v1/reports/${SCAMMER}`, sara.token)).status).toBe(204);
    r = await api(h, 'GET', `/v1/lookup/${SCAMMER}`, zain.token);
    expect(r.body.spam).toMatchObject({ label: 'none', score: 0, reports: 1, notSpam: 1 });
  });

  it('a single admin report is enough for likely_scam', async () => {
    const r = await api(h, 'POST', '/v1/reports', admin.token, { phone: '+923045556677', category: 'robocall' });
    expect(r.body.spam).toMatchObject({ label: 'likely_scam', reports: 1, topCategory: 'robocall' });
  });

  it('validates categories', async () => {
    const r = await api(h, 'POST', '/v1/reports', ali.token, { phone: SCAMMER, category: 'evil' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_request');
  });
});

describe('sync deltas and blocks', () => {
  it('returns a full snapshot, then deltas with tombstones', async () => {
    await h.pool.query('TRUNCATE reports, spam_state, blocks');
    await api(h, 'POST', '/v1/reports', ali.token, { phone: '+923041000001', category: 'scam' });
    await api(h, 'POST', '/v1/reports', sara.token, { phone: '+923041000001', category: 'scam' });
    await api(h, 'POST', '/v1/reports', ali.token, { phone: '+923041000002', category: 'other' });

    const full = await api(h, 'GET', '/v1/sync', zain.token);
    expect(full.status).toBe(200);
    expect(full.body.spam).toEqual([
      { phone: '+923041000001', label: 'likely_scam', score: 80, reports: 2, topCategory: 'scam', deleted: false },
      { phone: '+923041000002', label: 'suspected', score: 40, reports: 1, topCategory: 'other', deleted: false },
    ]);
    expect(full.body.blocks).toEqual([]);
    const t1 = full.body.serverTime;
    expect(new Date(t1).toISOString()).toBe(t1);

    // Nothing changed -> empty delta.
    const same = await api(h, 'GET', `/v1/sync?since=${encodeURIComponent(t1)}`, zain.token);
    expect(same.body.spam).toEqual([]);
    expect(same.body.blocks).toEqual([]);

    // Withdraw the only report on ...002 -> tombstone; add a block.
    await api(h, 'DELETE', '/v1/reports/+923041000002', ali.token);
    const blk = await api(h, 'POST', '/v1/blocks', ali.token, { type: 'prefix', value: '+92304111', label: 'Bank scam series' });
    expect(blk.status).toBe(201);
    expect(blk.body).toEqual({
      id: expect.any(String),
      type: 'prefix',
      value: '+92304111',
      label: 'Bank scam series',
      addedBy: 'Ali',
      deleted: false,
    });

    const d1 = await api(h, 'GET', `/v1/sync?since=${encodeURIComponent(t1)}`, zain.token);
    expect(d1.body.spam).toEqual([
      { phone: '+923041000002', label: 'none', score: 0, reports: 0, topCategory: null, deleted: true },
    ]);
    expect(d1.body.blocks).toHaveLength(1);
    const t2 = d1.body.serverTime;

    // Deleting a block: only the adder or an admin.
    expect((await api(h, 'DELETE', `/v1/blocks/${blk.body.id}`, zain.token)).status).toBe(403);
    expect((await api(h, 'DELETE', `/v1/blocks/${blk.body.id}`, admin.token)).status).toBe(204);
    expect((await api(h, 'DELETE', `/v1/blocks/${blk.body.id}`, admin.token)).status).toBe(404);

    const d2 = await api(h, 'GET', `/v1/sync?since=${encodeURIComponent(t2)}`, zain.token);
    expect(d2.body.spam).toEqual([]);
    expect(d2.body.blocks).toEqual([{ ...blk.body, deleted: true }]);

    // Full snapshot omits tombstones.
    const full2 = await api(h, 'GET', '/v1/sync?since=', zain.token);
    expect(full2.body.spam.map((s: { phone: string }) => s.phone)).toEqual(['+923041000001']);
    expect(full2.body.blocks).toEqual([]);

    const bad = await api(h, 'GET', '/v1/sync?since=yesterday', zain.token);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_since');
  });

  it('deleting a member withdraws their reports from the labels', async () => {
    await api(h, 'POST', '/v1/reports', zain.token, { phone: '+923041000009', category: 'scam' });
    const before = await api(h, 'GET', '/v1/sync', ali.token);
    expect(before.body.spam.some((s: { phone: string }) => s.phone === '+923041000009')).toBe(true);
    const t = before.body.serverTime;
    expect((await api(h, 'DELETE', `/v1/members/${zain.user.id}`, admin.token)).status).toBe(204);
    const d = await api(h, 'GET', `/v1/sync?since=${encodeURIComponent(t)}`, ali.token);
    expect(d.body.spam).toContainEqual(expect.objectContaining({ phone: '+923041000009', deleted: true }));
  });

  it('validates block values and shows blocks in lookups', async () => {
    let r = await api(h, 'POST', '/v1/blocks', ali.token, { type: 'country', value: '+234' });
    expect(r.status).toBe(201);
    r = await api(h, 'POST', '/v1/blocks', ali.token, { type: 'country', value: '+234' });
    expect(r.status).toBe(200); // already blocked: same row back
    r = await api(h, 'POST', '/v1/blocks', ali.token, { type: 'country', value: '234567' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_block');
    r = await api(h, 'POST', '/v1/blocks', ali.token, { type: 'number', value: 'nope' });
    expect(r.body.error).toBe('invalid_phone');
    r = await api(h, 'POST', '/v1/blocks', sara.token, { type: 'number', value: '0300 9998887', label: 'Pest' });
    expect(r.status).toBe(201);
    expect(r.body.value).toBe('+923009998887');

    const l = await api(h, 'GET', '/v1/lookup/+2348031234567', sara.token);
    expect(l.body.blocked).toEqual({ byCircle: true, addedBy: 'Ali' });
    const n = await api(h, 'GET', '/v1/lookup/+923009998887', ali.token);
    expect(n.body.blocked).toEqual({ byCircle: true, addedBy: 'Sara' });
  });
});

describe('shared helpers', () => {
  it('refreshSpamState updates many phones in one pass and only bumps changed rows', async () => {
    const [a, b, c] = ['+923048880001', '+923048880002', '+923048880003'];
    const reporter = await registerMember(h, admin, '+923248880000', 'Reporter');
    await h.pool.query(
      `INSERT INTO reports (user_id, phone, category) VALUES ($1, $2, 'scam'), ($1, $3, 'scam')`,
      [reporter.user.id, a, b],
    );
    const raw = await refreshSpamState(h.pool, [a, b, c, a], 2);
    expect([...raw.keys()].sort()).toEqual([a, b]);
    const state = async () =>
      (await h.pool.query('SELECT phone, label, updated_at FROM spam_state WHERE phone = ANY($1) ORDER BY phone', [[a, b, c]]))
        .rows;
    const s1 = await state();
    expect(s1.map((r) => [r.phone, r.label])).toEqual([[a, 'suspected'], [b, 'suspected']]); // no row for c

    await refreshSpamState(h.pool, [a, b, c], 2); // nothing changed
    expect(await state()).toEqual(s1);

    await h.pool.query('DELETE FROM reports WHERE phone = $1', [a]);
    await refreshSpamState(h.pool, [a, b, c], 2);
    const s2 = await state();
    expect(s2.map((r) => [r.phone, r.label])).toEqual([[a, 'none'], [b, 'suspected']]);
    expect(s2[0].updated_at.getTime()).toBeGreaterThan(s1[0].updated_at.getTime());
    expect(s2[1]).toEqual(s1[1]);

    await refreshSpamState(h.pool, [a], 2); // already none: untouched
    expect((await state())[0]).toEqual(s2[0]);
  });

  it('assertKeepsAnAdmin enforces the last-admin rules', async () => {
    const { rows } = await h.pool.query<{ id: string }>('SELECT id FROM users WHERE is_admin');
    expect(rows).toHaveLength(1);
    const only = rows[0].id;
    await expect(assertKeepsAnAdmin(h.pool, { demoting: only })).rejects.toMatchObject({ code: 'last_admin' });
    await expect(assertKeepsAnAdmin(h.pool, { removing: only })).rejects.toMatchObject({ code: 'last_admin' });
    await expect(assertKeepsAnAdmin(h.pool, { demoting: ali.user.id })).resolves.toBeUndefined();
    await expect(assertKeepsAnAdmin(h.pool, { removing: ali.user.id })).resolves.toBeUndefined();
  });

  it('contacts sync replaces the stored set', async () => {
    const m = await registerMember(h, admin, '+923248880009', 'Syncer');
    await api(h, 'POST', '/v1/contacts/sync', m.token, {
      contacts: [
        { phone: '+923218880001', name: 'One' },
        { phone: '+923218880002', name: 'Two' },
      ],
    });
    const r = await api(h, 'POST', '/v1/contacts/sync', m.token, {
      contacts: [
        { phone: '+923218880002', name: 'Two Renamed' },
        { phone: '+923218880003', name: 'Three' },
      ],
    });
    expect(r.body).toEqual({ stored: 2 });
    const { rows } = await h.pool.query<{ phone_hash: Buffer; name_enc: Buffer }>(
      'SELECT phone_hash, name_enc FROM contacts WHERE user_id = $1',
      [m.user.id],
    );
    const v = vault();
    const stored = ['+923218880002', '+923218880003'].map((p) => {
      const row = rows.find((r) => r.phone_hash.equals(v.index(p)));
      return row && v.open(p, row.name_enc);
    });
    expect(rows).toHaveLength(2);
    expect(stored).toEqual(['Two Renamed', 'Three']);
    await api(h, 'POST', '/v1/contacts/sync', m.token, { contacts: [] });
    expect((await h.pool.query('SELECT 1 FROM contacts WHERE user_id = $1', [m.user.id])).rowCount).toBe(0);
  });
});
