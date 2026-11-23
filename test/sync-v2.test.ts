import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refreshSpamDetails } from '../src/lookup.js';
import { initAppKeys, packVault } from '../src/pack.js';
import { syncFormat2 } from '../src/pack-build.js';
import { api, createHarness, registerAdmin, registerMember, type Harness, type Session } from './helpers.js';

const SCAMMER = '+923041112233';

describe('GET /v1/sync additions for lookups on the phone', () => {
  let h: Harness;
  let admin: Session;
  let ali: Session;
  let sara: Session;

  const sync = (token: string, qs = '') => h.app.inject({ method: 'GET', url: `/v1/sync${qs}`, headers: { authorization: `Bearer ${token}` } });

  /** The answer as the code before these additions built it: same keys, same order. */
  const oldShape = (b: { serverTime: string; spam: Record<string, unknown>[]; blocks: unknown[] }) =>
    JSON.stringify({
      serverTime: b.serverTime,
      spam: b.spam.map((r) => ({
        phone: r.phone,
        label: r.label,
        score: r.score,
        reports: r.reports,
        topCategory: r.topCategory,
        deleted: r.deleted,
      })),
      blocks: b.blocks,
    });

  beforeAll(async () => {
    h = await createHarness();
    admin = await registerAdmin(h);
    ali = await registerMember(h, admin, '+923211111111', 'Ali');
    sara = await registerMember(h, admin, '+923222222222', 'Sara');
    await api(h, 'POST', '/v1/reports', ali.token, { phone: SCAMMER, category: 'scam', comment: 'Asks for OTP' });
    await api(h, 'POST', '/v1/blocks', admin.token, { type: 'prefix', value: '+92304111', label: 'Bank scam series' });
  });
  afterAll(async () => {
    initAppKeys([]);
    await h.close();
  });

  it('gives a caller without the new parameters exactly the old answer', async () => {
    const res = await sync(ali.token);
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(Object.keys(b)).toEqual(['serverTime', 'spam', 'blocks']);
    expect(b.spam).toEqual([{ phone: SCAMMER, label: 'suspected', score: 40, reports: 1, topCategory: 'scam', deleted: false }]);
    expect(res.body).toBe(oldShape(b));
    // Unknown values of the new parameters change nothing either.
    const other = await sync(ali.token, '?v=1&members=0');
    expect(other.body).toBe(oldShape(other.json()));
  });

  it('adds notSpam, lastComment and calls with ?v=2; a details change alone reaches only v=2 deltas', async () => {
    const before = (await sync(ali.token)).json().serverTime;
    // Same reporter, new comment: label, score, reports and category stay; only the details change.
    await api(h, 'POST', '/v1/reports', ali.token, { phone: SCAMMER, category: 'scam', comment: 'Asks for card PIN' });
    await api(h, 'POST', '/v1/reports', sara.token, { phone: '+923041112244', category: 'scam' }); // something for old deltas
    const oldDelta = (await sync(ali.token, `?since=${encodeURIComponent(before)}`)).json();
    expect(oldDelta.spam.map((r: { phone: string }) => r.phone)).toEqual(['+923041112244']);
    const v2Delta = (await sync(ali.token, `?v=2&since=${encodeURIComponent(before)}`)).json();
    expect(v2Delta.spam).toEqual([
      {
        phone: SCAMMER,
        label: 'suspected',
        score: 40,
        reports: 1,
        topCategory: 'scam',
        deleted: false,
        notSpam: 0,
        lastComment: 'Asks for card PIN',
        calls: 0,
      },
      expect.objectContaining({ phone: '+923041112244', notSpam: 0, lastComment: null, calls: 0 }),
    ]);
    expect(v2Delta).toMatchObject({ packCursor: null, lookupMode: 'online' });
    expect(v2Delta.members).toBeUndefined();

    // Calls (lookups in 24 h) and not-spam votes come with the hourly refresh / the vote.
    await api(h, 'GET', `/v1/lookup/${SCAMMER}`, sara.token);
    await api(h, 'GET', `/v1/lookup/${SCAMMER}`, sara.token);
    const t = (await sync(ali.token)).json().serverTime;
    expect(await refreshSpamDetails(h.pool)).toBe(1);
    expect(await refreshSpamDetails(h.pool)).toBe(0); // nothing changed since
    expect((await sync(ali.token, `?since=${encodeURIComponent(t)}`)).json().spam).toEqual([]);
    const calls = (await sync(ali.token, `?v=2&since=${encodeURIComponent(t)}`)).json().spam;
    expect(calls).toEqual([expect.objectContaining({ phone: SCAMMER, calls: 2, lastComment: 'Asks for card PIN' })]);
    await api(h, 'POST', '/v1/reports', admin.token, { phone: '+923041112244', notSpam: true });
    const full = (await sync(ali.token, '?v=2')).json().spam;
    expect(full.find((r: { phone: string }) => r.phone === SCAMMER)).toMatchObject({ notSpam: 0, calls: 2 });
  });

  it('adds the family roster with ?members=1', async () => {
    await h.pool.query("UPDATE users SET photo_url = 'https://lh3.googleusercontent.com/a/ali=s256-c', status = 'Driving' WHERE id = $1", [
      ali.user.id,
    ]);
    const b = (await sync(sara.token, '?members=1')).json();
    expect(Object.keys(b)).toEqual(['serverTime', 'spam', 'blocks', 'members']);
    expect(b.members).toEqual([
      { id: admin.user.id, phone: admin.user.phone, name: 'Abbu', status: null, photoUrl: null },
      { id: ali.user.id, phone: '+923211111111', name: 'Ali', status: 'Driving', photoUrl: 'https://lh3.googleusercontent.com/a/ali=s256-c' },
      { id: sara.user.id, phone: '+923222222222', name: 'Sara', status: null, photoUrl: null },
    ]);
    // Another family's sync shows only its own members.
    const other = (await api(h, 'POST', '/v1/register', null, { phone: '+923003333333', name: 'Other' })).body as Session;
    expect((await sync(other.token, '?members=1')).json().members).toEqual([
      { id: other.user.id, phone: '+923003333333', name: 'Other', status: null, photoUrl: null },
    ]);
  });

  it('sends packCursor and lookupMode with ?v=2 once format 2 is built', async () => {
    initAppKeys([{ id: 1, hex: 'f0'.repeat(32) }]);
    await h.pool.query(
      'INSERT INTO pack_meta (salt_id, salt, t, m_kib, p, canary, active_at) VALUES (1, $1, 1, 64, 1, $2, now()) ON CONFLICT DO NOTHING',
      [Buffer.alloc(16, 1), packVault()!.canary()],
    );
    expect((await sync(ali.token, '?v=2')).json()).toMatchObject({ packCursor: null, lookupMode: 'online' }); // not built yet
    const saltId = (await syncFormat2(h.pool, { params: { t: 1, m: 64, p: 1 } }))!.built!.saltId;
    const fam = (await h.pool.query('SELECT family_id FROM users WHERE id = $1', [ali.user.id])).rows[0].family_id;
    const { rows } = await h.pool.query<{ v: number }>(
      'SELECT max(version)::int AS v FROM pack_parts WHERE salt_id = $1 AND (scope IS NULL OR scope = $2)',
      [saltId, fam],
    );
    expect(rows[0].v).toBeGreaterThan(0);
    expect((await sync(ali.token, '?v=2')).json()).toMatchObject({ packCursor: rows[0].v, lookupMode: 'local' });
    h.cfg.lookupMode = 'online';
    expect((await sync(ali.token, '?v=2')).json()).toMatchObject({ packCursor: rows[0].v, lookupMode: 'online' });
    h.cfg.lookupMode = 'local';
    // Still the old answer without the parameters.
    const res = await sync(ali.token);
    expect(res.body).toBe(oldShape(res.json()));
  });
});
