import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importDirectory } from '../src/directory.js';
import { answerJson, argon2, argon2Many, entryKeys, openEntry, packVault, sealEntry, type PackParams } from '../src/pack.js';
import { PackKeyMismatch, reconcilePack, rotatePack } from '../src/pack-build.js';
import { optOutNumber } from '../src/privacy.js';
import { vault } from '../src/vault.js';
import { api, createHarness, registerAdmin, registerMember, type Harness, type Session } from './helpers.js';

describe('pack crypto', () => {
  it('reproduces the docs/NAME_PACK.md test vector', async () => {
    const prm: PackParams = { salt: Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'), t: 2, m: 16384, p: 1 };
    const h = await argon2('+923001234567', prm);
    expect(h.toString('hex')).toBe('8dc734366b90dac0e73145a24d33d04fba93929d0de84fc8798b7291dd71f1ae');
    const { tag, key } = entryKeys(h);
    expect(tag.toString('hex')).toBe('1d5ee36909813de6');
    expect(key.toString('hex')).toBe('3d1197c6e03c6aaa36ff6a5707c6742033d6c5ae4ecd0c1c7754d334ac44dea0');
    const plaintext = '{"n":"Ali Raza","s":"contacts","c":null,"k":3,"m":false}';
    const blob = sealEntry(key, tag, plaintext, Buffer.from('0c0b0a090807060504030201', 'hex'));
    expect(blob.toString('hex')).toBe(
      '0c0b0a0908070605040302015d6992671da274398158839dd76cf70316579bc17ce660b32352906b287d363391a0b38e565421348b32040a9e69a09cf338255f6e182ff1a0f33e06d4d4aeb4bdb4a1347a897381',
    );
    expect(openEntry(key, tag, blob)).toBe(plaintext);
    expect(openEntry(key, Buffer.alloc(8), blob)).toBeNull();
  });

  it('pads entry plaintexts to 32 bytes and they still parse', async () => {
    const { tag, key } = entryKeys(Buffer.alloc(32, 9));
    for (const n of ['A', 'Ali Raza', 'محمد علی', 'x'.repeat(100)]) {
      const pt = answerJson({ n, s: 'contacts', c: null, k: 1, m: false });
      expect(Buffer.byteLength(pt) % 32).toBe(0);
      expect(pt.trimEnd()).toBe(JSON.stringify({ n, s: 'contacts', c: null, k: 1, m: false }));
      const opened = openEntry(key, tag, sealEntry(key, tag, pt))!;
      expect(JSON.parse(opened)).toEqual({ n, s: 'contacts', c: null, k: 1, m: false });
    }
    // Names of nearby lengths seal to the same blob length.
    const len = (n: string) => sealEntry(key, tag, answerJson({ n, s: 'contacts', c: null, k: 1, m: false })).length;
    expect(len('Al')).toBe(len('Ali Raza'));
  });

  it('hashes the same in worker threads as inline', async () => {
    const prm: PackParams = { salt: Buffer.alloc(16, 7), t: 1, m: 64, p: 1 };
    const phones = Array.from({ length: 40 }, (_, i) => `+9230000000${String(i).padStart(2, '0')}`);
    const viaWorkers = await argon2Many(phones, prm, 2);
    const inline = await argon2Many(phones, prm, 0);
    expect(viaWorkers.map((b) => b.toString('hex'))).toEqual(inline.map((b) => b.toString('hex')));
  });
});

interface Entry {
  id: number;
  seq: number;
  kind: number;
  tag?: Buffer;
  blob?: Buffer;
}
interface Pack {
  reset: boolean;
  more: boolean;
  saltId: number;
  prm: PackParams;
  nextSince: number;
  entries: Entry[];
}

function parsePack(buf: Buffer): Pack {
  expect(buf.subarray(0, 4).toString('ascii')).toBe('SCNP');
  expect(buf[4]).toBe(1);
  const flags = buf[5];
  let o = 6;
  const saltId = buf.readUInt32BE(o);
  o += 4;
  const salt = Buffer.from(buf.subarray(o, o + 16));
  o += 16;
  const t = buf.readUInt8(o++);
  const m = buf.readUInt32BE(o);
  o += 4;
  const p = buf.readUInt8(o++);
  const nextSince = Number(buf.readBigUInt64BE(o));
  o += 8;
  const count = buf.readUInt32BE(o);
  o += 4;
  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    const e: Entry = { id: Number(buf.readBigUInt64BE(o)), seq: Number(buf.readBigUInt64BE(o + 8)), kind: buf[o + 16] };
    o += 17;
    if (e.kind !== 2) {
      e.tag = Buffer.from(buf.subarray(o, o + 8));
      const len = buf.readUInt16BE(o + 8);
      e.blob = Buffer.from(buf.subarray(o + 10, o + 10 + len));
      o += 10 + len;
    }
    entries.push(e);
  }
  expect(o).toBe(buf.length);
  return { reset: (flags & 1) !== 0, more: (flags & 2) !== 0, saltId, prm: { salt, t, m, p }, nextSince, entries };
}

/** What a phone would find for `phone`: decrypted answers, by kind. */
async function find(pack: Pack, phone: string) {
  const { tag, key } = entryKeys(await argon2(phone, pack.prm));
  return pack.entries
    .filter((e) => e.tag?.equals(tag))
    .map((e) => ({ id: e.id, kind: e.kind, answer: JSON.parse(openEntry(key, tag, e.blob!)!) }));
}

const X = '+923005550001'; // open contact
const Y = '+923005550002'; // family_only contact
const Z = '+923005550003'; // opted out
const D = '+923005550004'; // directory
const S = '+923005550005'; // name suggestion


describe('GET /v1/pack', () => {
  let h: Harness;
  let a: Session; // family A admin
  let mem: Session; // family A member
  let b: Session; // family B
  const get = (token: string, qs = '') =>
    h.app.inject({ method: 'GET', url: `/v1/pack${qs}`, headers: { authorization: `Bearer ${token}` } });
  const pack = async (token: string, qs = '') => {
    const res = await get(token, qs);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    return parsePack(res.rawPayload);
  };
  const maxSeq = async () =>
    (await h.pool.query<{ s: number }>('SELECT coalesce(max(seq), 0)::int AS s FROM pack_entries')).rows[0].s;

  beforeAll(async () => {
    h = await createHarness();
    // Cheap Argon2 for the test (the real cost is checked by the vector test).
    await h.pool.query(
      'INSERT INTO pack_meta (salt_id, salt, t, m_kib, p, canary, active_at) VALUES (1, $1, 1, 64, 1, $2, now())',
      [Buffer.alloc(16, 1), packVault()!.canary()],
    );
    a = await registerAdmin(h, '+923001234567', 'Abbu');
    mem = await registerMember(h, a, '+923001111111', 'Ammi');
    b = (await api(h, 'POST', '/v1/register', null, { phone: '+923002222222', name: 'Other' })).body;
    await api(h, 'PATCH', '/v1/me', a.token, { shareContacts: true });
    const sync = await api(h, 'POST', '/v1/contacts/sync', a.token, {
      contacts: [
        { phone: X, name: 'Ali Raza' },
        { phone: Y, name: 'Bilal' },
        { phone: Z, name: 'Zed' },
      ],
    });
    expect(sync.body.stored).toBe(3);
    await h.pool.query('UPDATE contacts SET family_only = true WHERE phone_hash = $1', [vault().index(Y)]);
    await h.pool.query('INSERT INTO opt_outs (phone_hash) VALUES ($1)', [vault().index(Z)]);
    await importDirectory(h.pool, [{ phone: D, name: 'Mehar Baba', category: 'restaurant' }], 'PK');
    expect((await api(h, 'POST', '/v1/names', b.token, { phone: S, name: 'Plumber' })).status).toBe(200);
  });
  afterAll(async () => {
    await h.close();
  });

  it('stores numbers sealed under PACK_KEY', async () => {
    const { rows } = await h.pool.query<{ phone_enc: Buffer }>('SELECT phone_enc FROM contacts WHERE phone_hash = $1', [
      vault().index(X),
    ]);
    expect(packVault()!.openPhone(rows[0].phone_enc)).toBe(X);
  });

  it('builds entries and serves them per family', async () => {
    const r = (await reconcilePack(h.pool))!;
    // global: X, D, S; family A: Y, Abbu, Ammi; family B: its own member.
    expect(r).toMatchObject({ entries: 7, upserted: 7, deleted: 0 });

    const pa = await pack(a.token);
    expect(pa).toMatchObject({ reset: true, more: false, saltId: 1, prm: { t: 1, m: 64, p: 1 } });
    expect(pa.entries).toHaveLength(6);
    expect(pa.entries.every((e) => (e.blob!.length - 28) % 32 === 0)).toBe(true); // padded
    expect((await find(pa, S))[0]).toMatchObject({ kind: 0, answer: { n: 'Plumber', s: 'suggested', c: null, k: 0 } });
    expect(await find(pa, X)).toEqual([
      { id: expect.any(Number), kind: 0, answer: { n: 'Ali Raza', s: 'contacts', c: null, k: 1, m: false } },
    ]);
    expect((await find(pa, Y))[0]).toMatchObject({ kind: 1, answer: { n: 'Bilal', s: 'contacts', k: 1, m: false } });
    expect((await find(pa, mem.user.phone))[0]).toMatchObject({ kind: 1, answer: { n: 'Ammi', s: 'member', m: true } });
    expect((await find(pa, D))[0]).toMatchObject({
      kind: 0,
      answer: { n: 'Mehar Baba', s: 'directory', c: 'restaurant', k: 0 },
    });
    expect(await find(pa, Z)).toEqual([]);

    // Family B sees only the global answers and its own member.
    const pb = await pack(b.token);
    expect(pb.entries).toHaveLength(4);
    expect(await find(pb, X)).toHaveLength(1);
    expect(await find(pb, Y)).toEqual([]);
    expect(await find(pb, mem.user.phone)).toEqual([]);
    expect((await find(pb, '+923002222222'))[0]).toMatchObject({ kind: 1, answer: { n: 'Other', s: 'member' } });

    // Nothing changed: nothing rewritten, in big or tiny batches.
    expect(await reconcilePack(h.pool)).toMatchObject({ entries: 7, upserted: 0, deleted: 0, hashed: 0 });
    expect(await reconcilePack(h.pool, { batch: 2 })).toMatchObject({ entries: 7, upserted: 0, deleted: 0, hashed: 0 });
    expect((await pack(a.token, `?since=${pa.nextSince}`)).entries).toEqual([]);
  });

  it('pages, and sends deletes as a delta', async () => {
    const first = await pack(a.token, '?limit=2');
    expect(first).toMatchObject({ more: true, reset: true });
    expect(first.entries).toHaveLength(2);
    const rest = await pack(a.token, `?since=${first.nextSince}`);
    expect(rest).toMatchObject({ more: false, reset: false });
    expect(rest.entries).toHaveLength(4);

    const full = await pack(a.token);
    const xId = (await find(full, X))[0].id;
    await api(h, 'POST', '/v1/contacts/sync', a.token, { contacts: [{ phone: Y, name: 'Bilal' }] });
    // Batches of one number: the tombstone still comes from the number's own batch.
    expect(await reconcilePack(h.pool, { batch: 1 })).toMatchObject({ upserted: 0, deleted: 1 });

    for (const s of [a, b]) {
      const delta = await pack(s.token, `?since=${full.nextSince}`);
      expect(delta.reset).toBe(false);
      expect(delta.entries).toEqual([{ id: xId, seq: delta.nextSince, kind: 2 }]);
    }
    // A full download leaves tombstones out.
    const again = await pack(a.token);
    expect(await find(again, X)).toEqual([]);
    expect(again.entries.some((e) => e.kind === 2)).toBe(false);

    // Saved again: the same id comes back as an upsert.
    await api(h, 'POST', '/v1/contacts/sync', a.token, {
      contacts: [
        { phone: Y, name: 'Bilal' },
        { phone: X, name: 'Ali' },
      ],
    });
    expect(await reconcilePack(h.pool)).toMatchObject({ upserted: 1, hashed: 0 });
    expect(await find(await pack(a.token), X)).toMatchObject([{ id: xId, kind: 0, answer: { n: 'Ali' } }]);
  });

  it('tells clients behind the purge horizon to start over', async () => {
    const full = await pack(b.token);
    await h.pool.query('UPDATE pack_meta SET purge_seq = $1', [full.nextSince + 1]);
    const p = await pack(b.token, `?since=${full.nextSince}`);
    expect(p.reset).toBe(true);
    expect(p.entries.length).toBe(full.entries.length);
    await h.pool.query('UPDATE pack_meta SET purge_seq = 0');
  });

  it('starts over when the member changed family', async () => {
    const full = await pack(mem.token);
    expect((await find(full, Y))[0]).toMatchObject({ kind: 1 });
    expect((await pack(mem.token, `?since=${full.nextSince}`)).reset).toBe(false);
    expect((await api(h, 'POST', '/v1/family/leave', mem.token)).status).toBe(200);
    const moved = await pack(mem.token, `?since=${full.nextSince}`);
    expect(moved.reset).toBe(true);
    expect(await find(moved, Y)).toEqual([]); // family A's family-only contact is not served
    expect((await pack(mem.token, `?since=${moved.nextSince}`)).reset).toBe(false);
  });

  it('counts every row served against a daily quota', async () => {
    expect((await get(a.token, '?since=abc')).statusCode).toBe(400);
    expect((await get(a.token, '?since=1&limit=-1')).statusCode).toBe(400);
    const c = (await api(h, 'POST', '/v1/register', null, { phone: '+923003333333', name: 'C' })).body as Session;
    const used = async () =>
      (await h.pool.query<{ rows: number }>('SELECT rows::int FROM pack_usage WHERE user_id = $1', [c.user.id])).rows[0]
        .rows;
    const full = await pack(c.token);
    expect(await used()).toBe(full.entries.length);
    const delta = await pack(c.token, `?since=${full.entries[0].seq}`); // deltas count too
    expect(await used()).toBe(full.entries.length + delta.entries.length);

    // 2 rows left: the page is cut to 2 and says more.
    await h.pool.query('UPDATE pack_usage SET rows = 50000 - 2 WHERE user_id = $1', [c.user.id]);
    expect(await pack(c.token, '?since=1')).toMatchObject({ more: true, entries: { length: 2 } });
    for (const qs of ['', '?since=1']) {
      const res = await get(c.token, qs);
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ error: 'pack_quota' });
    }
  });

  it('keeps an opted-out member for their own family only', async () => {
    // Family B saves Abbu's number: a global answer.
    await api(h, 'PATCH', '/v1/me', b.token, { shareContacts: true });
    await api(h, 'POST', '/v1/contacts/sync', b.token, { contacts: [{ phone: a.user.phone, name: 'Boss' }] });
    await reconcilePack(h.pool);
    expect((await find(await pack(b.token), a.user.phone))[0]).toMatchObject({ kind: 0, answer: { n: 'Boss' } });

    await h.pool.query('INSERT INTO opt_outs (phone_hash) VALUES ($1)', [vault().index(a.user.phone)]);
    expect(await reconcilePack(h.pool)).toMatchObject({ deleted: 1 });
    expect(await find(await pack(b.token), a.user.phone)).toEqual([]);
    expect(await find(await pack(a.token), a.user.phone)).toMatchObject([{ kind: 1, answer: { n: 'Abbu', s: 'member' } }]);
  });

  it('removes an opted-out name from the pack straight away', async () => {
    const before = await pack(b.token);
    expect(await find(before, D)).toHaveLength(1);
    const r = await optOutNumber(h.pool, D);
    expect(r).toMatchObject({ directory: 1, pack: { deleted: 1 } });
    const delta = await pack(b.token, `?since=${before.nextSince}`);
    expect(delta.entries).toMatchObject([{ kind: 2 }]);
  });

  it('refuses a changed PACK_KEY and unreadable sealed numbers', async () => {
    const { rows } = await h.pool.query<{ canary: Buffer }>('SELECT canary FROM pack_meta');
    await h.pool.query('UPDATE pack_meta SET canary = $1', [Buffer.from('not the canary')]);
    await expect(reconcilePack(h.pool)).rejects.toBeInstanceOf(PackKeyMismatch);
    const res = await get(b.token, '?since=1');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'pack_key_mismatch' });
    await h.pool.query('UPDATE pack_meta SET canary = $1', [rows[0].canary]);

    // One of the few sealed numbers no longer opens: over 2%, so nothing is written.
    const seq = await maxSeq();
    await h.pool.query('UPDATE contacts SET phone_enc = $1 WHERE phone_hash = $2', [Buffer.from('garbage'), vault().index(X)]);
    await expect(reconcilePack(h.pool)).rejects.toThrow(/do not open/);
    expect(await maxSeq()).toBe(seq);
    await api(h, 'POST', '/v1/contacts/sync', a.token, {
      contacts: [
        { phone: Y, name: 'Bilal' },
        { phone: X, name: 'Ali' },
      ],
    });
    expect(await reconcilePack(h.pool)).toMatchObject({ upserted: 0, deleted: 0 });
  });

  it('rotates to a new salt without an empty pack', async () => {
    const old = await pack(a.token);
    const r = await rotatePack(h.pool);
    expect(r).toMatchObject({ saltId: 2 });
    expect((await h.pool.query('SELECT salt_id FROM pack_meta')).rows).toEqual([{ salt_id: 2 }]);
    const p = await pack(a.token, `?since=${old.nextSince}`);
    expect(p).toMatchObject({ reset: true, saltId: 2, prm: { t: 2, m: 16384, p: 1 } });
    expect(p.entries).toHaveLength(old.entries.length);
    expect(p.prm.salt.equals(old.prm.salt)).toBe(false);
    expect((await find(p, Y))[0]).toMatchObject({ kind: 1, answer: { n: 'Bilal' } });
    expect(await reconcilePack(h.pool)).toMatchObject({ saltId: 2, upserted: 0, hashed: 0 });
  });
});

describe('without PACK_KEY', () => {
  it('stores no sealed numbers and answers 404 pack_disabled', async () => {
    const h = await createHarness({ packKey: null });
    try {
      const me = (await api(h, 'POST', '/v1/register', null, { phone: '+923004444444', name: 'Me' })).body;
      await api(h, 'PATCH', '/v1/me', me.token, { shareContacts: true });
      await api(h, 'POST', '/v1/contacts/sync', me.token, { contacts: [{ phone: X, name: 'Ali' }] });
      const { rows } = await h.pool.query('SELECT phone_enc FROM contacts');
      expect(rows).toEqual([{ phone_enc: null }]);
      expect(await reconcilePack(h.pool)).toBeNull();
      const r = await api(h, 'GET', '/v1/pack', me.token);
      expect(r).toMatchObject({ status: 404, body: { error: 'pack_disabled' } });
    } finally {
      await h.close();
    }
  });
});
