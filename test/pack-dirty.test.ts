import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { importDirectory } from '../src/directory.js';
import { packVault } from '../src/pack.js';
import { drainDirty, fullRequested, reconcilePack } from '../src/pack-build.js';
import { optOutNumber } from '../src/privacy.js';
import { vault } from '../src/vault.js';
import { api, createHarness, registerAdmin, registerMember, type Harness, type Session } from './helpers.js';

const X = '+923006660001';
const Y = '+923006660002';
const D = '+923006660003';
const S = '+923006660004';

const hex = (phone: string) => vault().index(phone).toString('hex');

describe('pack_dirty triggers', () => {
  let h: Harness;
  let a: Session;
  let m: Session;
  let b: Session;

  /** Queued numbers as { hash hex: priority }. */
  const queue = async () =>
    Object.fromEntries(
      (await h.pool.query<{ h: string; p: number }>("SELECT encode(phone_hash, 'hex') AS h, priority AS p FROM pack_dirty")).rows.map(
        (r) => [r.h, r.p],
      ),
    );
  const clear = () => h.pool.query('DELETE FROM pack_dirty');

  beforeAll(async () => {
    h = await createHarness();
    // Cheap Argon2 for the test.
    await h.pool.query(
      'INSERT INTO pack_meta (salt_id, salt, t, m_kib, p, canary, active_at) VALUES (1, $1, 1, 64, 1, $2, now())',
      [Buffer.alloc(16, 2), packVault()!.canary()],
    );
    a = await registerAdmin(h, '+923001230001', 'Abbu');
    m = await registerMember(h, a, '+923001230002', 'Ammi');
    b = (await api(h, 'POST', '/v1/register', null, { phone: '+923001230003', name: 'Other' })).body;
    await api(h, 'PATCH', '/v1/me', a.token, { shareContacts: true });
    await api(h, 'PATCH', '/v1/me', m.token, { shareContacts: true });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(clear);

  it('queues a registered member, with users.phone_hash written on register', async () => {
    await clear();
    const c = (await api(h, 'POST', '/v1/register', null, { phone: '+923001230004', name: 'New' })).body as Session;
    expect(await queue()).toEqual({ [hex(c.user.phone)]: 1 });
    const { rows } = await h.pool.query<{ phone_hash: Buffer }>('SELECT phone_hash FROM users WHERE id = $1', [c.user.id]);
    expect(rows[0].phone_hash.equals(vault().index(c.user.phone))).toBe(true);
  });

  it('queues contact inserts, updates and deletes', async () => {
    await api(h, 'POST', '/v1/contacts/sync', a.token, { contacts: [{ phone: X, name: 'Ali' }, { phone: Y, name: 'Bilal' }] });
    expect(await queue()).toEqual({ [hex(X)]: 1, [hex(Y)]: 1 });
    await clear();
    // Y dropped (delete), X kept (update).
    await api(h, 'POST', '/v1/contacts/sync', a.token, { contacts: [{ phone: X, name: 'Ali Raza' }] });
    expect(await queue()).toEqual({ [hex(X)]: 1, [hex(Y)]: 1 });
    await clear();
    await api(h, 'DELETE', '/v1/contacts', a.token);
    expect(await queue()).toEqual({ [hex(X)]: 1 });
  });

  it('lets members sync overlapping address books at the same time, while a drain runs', async () => {
    const sync = (who: Session, phones: string[]) =>
      api(h, 'POST', '/v1/contacts/sync', who.token, { contacts: phones.map((phone) => ({ phone, name: 'Shared Person' })) });
    // The same numbers in opposite orders: queue rows must be locked in one order.
    const list = Array.from({ length: 1500 }, (_, i) => `+92311${String(i).padStart(7, '0')}`);
    for (let round = 0; round < 2; round++) {
      const r = await Promise.all([sync(a, list), sync(m, [...list].reverse())]);
      expect(r.map((x) => x.status)).toEqual([200, 200]);
      await h.pool.query('DELETE FROM contacts');
    }
    // Each sync drops some numbers (one statement) and adds others (the next), and the two
    // members' sets cross; a drain deletes queue rows meanwhile.
    const pool80 = list.slice(0, 80);
    const pick = (seed: number) => pool80.filter((_, i) => (i * 7 + seed * 13) % 5 < 3);
    let stop = false;
    const drainer = (async () => {
      while (!stop) await drainDirty(h.pool);
    })();
    try {
      for (let round = 0; round < 12; round++) {
        const r = await Promise.all([sync(a, pick(round)), sync(m, pick(round + 2).reverse()), sync(b, pick(round + 4))]);
        expect(r.map((x) => x.status)).toEqual([200, 200, 200]);
      }
    } finally {
      stop = true;
      await drainer;
    }
    await h.pool.query('DELETE FROM contacts');
    await drainDirty(h.pool);
  });

  it('queues suggestions, directory rows and opt-outs (removals at priority 0)', async () => {
    expect((await api(h, 'POST', '/v1/names', b.token, { phone: S, name: 'Plumber' })).status).toBe(200);
    expect(await queue()).toEqual({ [hex(S)]: 1 });
    await clear();
    await importDirectory(h.pool, [{ phone: D, name: 'Shop' }], 'PK');
    expect(await queue()).toEqual({ [hex(D)]: 1 });
    await clear();
    await h.pool.query('INSERT INTO opt_outs (phone_hash) VALUES ($1)', [vault().index(S)]);
    expect(await queue()).toEqual({ [hex(S)]: 0 });
    // A later normal change keeps the removal's priority.
    await h.pool.query('UPDATE name_suggestions SET created_at = now() WHERE phone_hash = $1', [vault().index(S)]);
    expect(await queue()).toEqual({ [hex(S)]: 0 });
    await clear();
    await h.pool.query('DELETE FROM opt_outs WHERE phone_hash = $1', [vault().index(S)]);
    expect(await queue()).toEqual({ [hex(S)]: 0 });
  });

  it('asks for a full pass when the directory is truncated (import)', async () => {
    await h.pool.query('UPDATE pack_meta SET full_requested_at = NULL');
    expect(await fullRequested(h.pool)).toBeNull();
    await importDirectory(h.pool, [], 'PK');
    expect(await fullRequested(h.pool)).not.toBeNull();
    // D left the directory without a row trigger: only the full pass notices.
    expect(await queue()).toEqual({});
    await h.pool.query('UPDATE pack_meta SET full_requested_at = NULL');
  });

  it('queues member name, photo and family changes, but not a last-seen write', async () => {
    await api(h, 'PATCH', '/v1/me', m.token, { name: 'Ammi Jan' });
    expect(await queue()).toEqual({ [hex(m.user.phone)]: 1 });
    await clear();
    await api(h, 'PATCH', '/v1/me', m.token, { name: 'Ammi Jan' }); // unchanged
    await h.pool.query('UPDATE users SET last_seen_at = now(), app_build = 47 WHERE id = $1', [m.user.id]);
    expect(await queue()).toEqual({});
    await h.pool.query("UPDATE users SET photo_url = 'https://example.com/p.png' WHERE id = $1", [m.user.id]);
    expect(await queue()).toEqual({ [hex(m.user.phone)]: 1 });
    await clear();

    // A family move queues the member and the family_only contacts they uploaded (scoped by family).
    await api(h, 'POST', '/v1/contacts/sync', m.token, { contacts: [{ phone: X, name: 'Ali' }, { phone: Y, name: 'Bilal' }] });
    await h.pool.query('UPDATE contacts SET family_only = true WHERE phone_hash = $1', [vault().index(Y)]);
    await clear();
    expect((await api(h, 'POST', '/v1/family/leave', m.token)).status).toBe(200);
    expect(await queue()).toEqual({ [hex(m.user.phone)]: 1, [hex(Y)]: 1 });
  });

  it('queues the cascade when a member is deleted', async () => {
    await api(h, 'PATCH', '/v1/me', b.token, { shareContacts: true });
    await api(h, 'POST', '/v1/contacts/sync', b.token, { contacts: [{ phone: D, name: 'Dee' }] });
    await clear();
    expect((await api(h, 'DELETE', '/v1/me', b.token)).status).toBe(204);
    // The member's number, the contact (ON DELETE CASCADE) and the suggestion they made.
    expect(await queue()).toEqual({ [hex(b.user.phone)]: 1, [hex(D)]: 1, [hex(S)]: 1 });
  });

  it('keeps a number queued again during a drain', async () => {
    await api(h, 'POST', '/v1/contacts/sync', a.token, { contacts: [{ phone: X, name: 'Ali' }] });
    expect(await queue()).toEqual({ [hex(X)]: 1 });
    // Another transaction queues X again (a change the drain's snapshot can't see) and holds the
    // row until it commits, after the drain read the queue.
    const other = new pg.Client({ connectionString: h.cfg.databaseUrl });
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT pack_queue($1, 1::smallint)', [vault().index(X)]);
      // The drain rebuilds X from what it can see, but doesn't wait for the row the writer holds
      // (that could deadlock) and leaves it queued.
      expect((await drainDirty(h.pool))!.numbers).toBe(0);
      await other.query('COMMIT');
      expect(await queue()).toEqual({ [hex(X)]: 1 });
    } finally {
      await other.end();
    }
    // A change committed after the drain read the queue has a newer queued_at: its row stays too.
    await h.pool.query('SELECT pack_queue($1, 1::smallint)', [vault().index(Y)]);
    const seen = (await h.pool.query<{ q: string }>('SELECT queued_at::text AS q FROM pack_dirty WHERE phone_hash = $1', [vault().index(Y)])).rows[0].q;
    await h.pool.query('SELECT pack_queue($1, 1::smallint)', [vault().index(Y)]);
    expect((await h.pool.query('DELETE FROM pack_dirty WHERE phone_hash = $1 AND queued_at <= $2::timestamptz', [vault().index(Y), seen])).rowCount).toBe(0);
    expect((await drainDirty(h.pool))!.numbers).toBe(2);
    expect(await queue()).toEqual({});
  });

  it('drains removals first, and an opt-out leaves the pack within one drain', async () => {
    await reconcilePack(h.pool);
    await clear();
    const many = Array.from({ length: 12 }, (_, i) => ({ phone: `+9230077700${String(i).padStart(2, '0')}`, name: `Person ${'abcdefghijkl'[i]}` }));
    await api(h, 'POST', '/v1/contacts/sync', a.token, { contacts: [{ phone: X, name: 'Ali' }, ...many] });
    await drainDirty(h.pool);
    const xEntry = async () =>
      (await h.pool.query<{ seq: number; deleted: boolean }>('SELECT seq::int, deleted FROM pack_entries WHERE phone_hash = $1 AND scope IS NULL', [
        vault().index(X),
      ])).rows[0];
    expect(await xEntry()).toMatchObject({ deleted: false });

    // Normal work queued first, then the removal; batches of 3.
    await api(h, 'POST', '/v1/contacts/sync', a.token, {
      contacts: [{ phone: X, name: 'Ali' }, ...many.map((c, i) => ({ ...c, name: `Changed ${'abcdefghijkl'[i]}` }))],
    });
    await h.pool.query('INSERT INTO opt_outs (phone_hash) VALUES ($1)', [vault().index(X)]);
    const r = (await drainDirty(h.pool, { batch: 3 }))!;
    expect(r.numbers).toBe(13);
    const x = await xEntry();
    expect(x.deleted).toBe(true);
    const { rows } = await h.pool.query<{ s: number }>(
      'SELECT min(seq)::int AS s FROM pack_entries WHERE phone_hash = ANY($1::bytea[])',
      [many.map((c) => vault().index(c.phone))],
    );
    expect(x.seq).toBeLessThan(rows[0].s); // the tombstone was written before every other change
    await h.pool.query('DELETE FROM opt_outs WHERE phone_hash = $1', [vault().index(X)]);
  });

  it('takes removals between the batches of a full pass', async () => {
    // Twelve numbers, and the one whose hash sorts last: a full pass reaches it at the very end.
    const all = Array.from({ length: 13 }, (_, i) => `+9230066611${String(i).padStart(2, '0')}`);
    all.sort((p, q) => Buffer.compare(vault().index(p), vault().index(q)));
    const last = all.pop()!;
    const name = (i: number, v: string) => `${v} ${'abcdefghijklm'[i]}`;
    await api(h, 'POST', '/v1/contacts/sync', a.token, {
      contacts: [...all, last].map((phone, i) => ({ phone, name: name(i, 'Person') })),
    });
    await drainDirty(h.pool);
    await clear(); // the full pass alone sees the renames; only the removal is queued
    await api(h, 'POST', '/v1/contacts/sync', a.token, {
      contacts: [...all, last].map((phone, i) => ({ phone, name: name(i, 'Renamed') })),
    });
    await clear();
    await h.pool.query('INSERT INTO opt_outs (phone_hash) VALUES ($1)', [vault().index(last)]);
    const r = (await reconcilePack(h.pool, { batch: 2 }))!;
    expect(r.deleted).toBe(1);
    const seq = async (phones: string[]) =>
      (await h.pool.query<{ s: number }>(
        'SELECT max(seq)::int AS s FROM pack_entries WHERE scope IS NULL AND phone_hash = ANY($1::bytea[])',
        [phones.map((p) => vault().index(p))],
      )).rows[0].s;
    expect(await seq([last])).toBeLessThan(await seq(all));
    expect(await queue()).toEqual({});
  });

  it('waits for the worker to remove an opted-out number while it holds the lock', async () => {
    await api(h, 'POST', '/v1/contacts/sync', a.token, { contacts: [{ phone: Y, name: 'Bilal' }] });
    await drainDirty(h.pool);
    const holder = new pg.Client({ connectionString: h.cfg.databaseUrl });
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(737373, 1)');
      setTimeout(() => void holder.query('SELECT pg_advisory_unlock(737373, 1)'), 1500);
      const r = await optOutNumber(h.pool, Y, 10_000);
      // Y's global entry and the family entry of the family-only contact Ammi uploaded.
      expect(r.pack).toMatchObject({ queued: true, done: true, deleted: 2 });
      expect(r.pack!.doneMs).toBeGreaterThanOrEqual(1000);
    } finally {
      await holder.end();
    }
    // Gives up after the wait when nobody drains, and says so.
    await api(h, 'POST', '/v1/contacts/sync', a.token, { contacts: [{ phone: X, name: 'Ali' }] });
    await drainDirty(h.pool);
    const blocker = new pg.Client({ connectionString: h.cfg.databaseUrl });
    await blocker.connect();
    try {
      await blocker.query('SELECT pg_advisory_lock(737373, 1)');
      const r = await optOutNumber(h.pool, X, 1200);
      expect(r.pack).toMatchObject({ queued: true, done: false, deleted: 0 });
    } finally {
      await blocker.end();
    }
    expect((await drainDirty(h.pool))!.deleted).toBeGreaterThanOrEqual(1);
    expect(await queue()).toEqual({});
  });
});
