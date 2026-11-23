import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { importDirectory } from '../src/directory.js';
import { argon2, entryKeysV2, initAppKeys, openEntry, packVault, v2Password } from '../src/pack.js';
import {
  drainDirty,
  fullRequested,
  PackAppKeyMismatch,
  packTuning,
  reconcilePack,
  syncFormat2,
} from '../src/pack-build.js';
import { startPackRunner } from '../src/pack-runner.js';
import { optOutNumber } from '../src/privacy.js';
import { pack2Limits } from '../src/routes/pack2.js';
import { vault } from '../src/vault.js';
import { api, createHarness, registerAdmin, registerMember, type Harness, type Session } from './helpers.js';
import { parseManifest, parsePage, PhonePack, type Page } from './pack-v2-decoder.js';
import { checkParts, openV2 } from './pack-v2-helpers.js';

// Test keys only.
const K1 = 'a1'.repeat(32);
const K2 = 'b2'.repeat(32);
const K3 = 'd4'.repeat(32);
const K_BAD = 'c3'.repeat(32);
const key = (hex: string) => Buffer.from(hex, 'hex');
const CHEAP = { t: 1, m: 64, p: 1 };

const X = '+923005550001'; // open contact
const Y = '+923005550002'; // family_only contact
const D = '+923005550004'; // directory
const S = '+923005550005'; // name suggestion
const PHOTO = 'https://lh3.googleusercontent.com/a/abbu=s256-c';

describe('name pack format 2', () => {
  let h: Harness;
  let a: Session; // family A admin (has a photo)
  let mem: Session; // family A member
  let b: Session; // family B
  let gen = 0; // the active format-2 generation

  const req = async (token: string, method: 'GET' | 'POST', url: string, body?: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const bin = async (token: string, method: 'GET' | 'POST', url: string, body?: unknown) => {
    const res = await req(token, method, url, body);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    return res.rawPayload;
  };
  const changes = async (token: string, qs: string) => parsePage(await bin(token, 'GET', `/v1/pack/changes?${qs}`));
  const parts = async (token: string, list: { s: 'g' | 'f'; id: number }[], saltId?: number) =>
    parsePage(await bin(token, 'POST', '/v1/pack/parts', { ...(saltId ? { saltId } : {}), parts: list }));

  /** A fresh phone: manifest, then every part with POST /v1/pack/parts. */
  async function download(token: string) {
    const man = parseManifest(await bin(token, 'GET', '/v1/pack/manifest'));
    const phone = new PhonePack();
    phone.split(man.partBits);
    let want = man.parts.map((p) => ({ s: p.scope ? ('f' as const) : ('g' as const), id: p.id }));
    while (want.length) {
      const page = await parts(token, want.slice(0, 64));
      phone.apply(page);
      want = want.slice(page.next);
    }
    return { phone, cursor: man.cursor };
  }

  /**
   * Catches a phone up from `since` with GET /v1/pack/changes (and parts for resync sections).
   * Returns the cursor to store (the first page's) and the pages.
   */
  async function catchUp(phone: PhonePack, token: string, since: number, pages: Page[] = []): Promise<number> {
    let cursor: number | null = null;
    let after: number | undefined;
    for (;;) {
      const page = await changes(token, `since=${since}${after !== undefined ? `&after=${after}` : ''}`);
      pages.push(page);
      cursor ??= page.cursor; // the first page's cursor: later pages may already hold newer rows
      phone.apply(page);
      if (!page.more) break;
      after = page.next;
    }
    while (phone.resync.length) phone.apply(await parts(token, phone.resync.splice(0, 64)));
    return cursor!;
  }

  /** What the server holds for this member in the active generation: `${scope}|${tag}` -> blob. */
  async function serverView(s: Session) {
    const { rows } = await h.pool.query<{ scope: string | null; tag: Buffer; blob: Buffer }>(
      `SELECT scope, tag, blob FROM pack_entries WHERE salt_id = $1 AND NOT deleted
         AND (scope IS NULL OR scope = (SELECT family_id FROM users WHERE id = $2))`,
      [gen, s.user.id],
    );
    return new Map(rows.map((r) => [`${r.scope ? 1 : 0}|${r.tag.toString('hex')}`, r.blob]));
  }

  beforeAll(async () => {
    h = await createHarness({ packAppKeys: [{ id: 1, hex: K1 }] });
    await h.pool.query(
      'INSERT INTO pack_meta (salt_id, salt, t, m_kib, p, canary, active_at) VALUES (1, $1, 1, 64, 1, $2, now())',
      [Buffer.alloc(16, 1), packVault()!.canary()],
    );
    a = await registerAdmin(h, '+923001234567', 'Abbu');
    mem = await registerMember(h, a, '+923001111111', 'Ammi');
    b = (await api(h, 'POST', '/v1/register', null, { phone: '+923002222222', name: 'Other' })).body;
    await api(h, 'PATCH', '/v1/me', a.token, { shareContacts: true });
    await api(h, 'POST', '/v1/contacts/sync', a.token, {
      contacts: [
        { phone: X, name: 'Ali Raza' },
        { phone: Y, name: 'Bilal' },
      ],
    });
    await h.pool.query('UPDATE contacts SET family_only = true WHERE phone_hash = $1', [vault().index(Y)]);
    await importDirectory(h.pool, [{ phone: D, name: 'Mehar Baba', category: 'restaurant' }], 'PK');
    await api(h, 'POST', '/v1/names', b.token, { phone: S, name: 'Plumber' });
    await h.pool.query('UPDATE users SET photo_url = $2 WHERE id = $1', [a.user.id, PHOTO]);
  });
  afterEach(() => {
    pack2Limits.changesPageBytes = 2 * 1024 * 1024;
    pack2Limits.partsPageBytes = 4 * 1024 * 1024;
    packTuning.splitAvg = 3000;
  });
  afterAll(async () => {
    initAppKeys([]);
    await h.close();
  });

  it('answers 503 pack_not_ready until the first format-2 build is done', async () => {
    await drainDirty(h.pool);
    for (const [method, url, body] of [
      ['POST', '/v1/pack/key', {}],
      ['GET', '/v1/pack/head'],
      ['GET', '/v1/pack/manifest'],
      ['GET', '/v1/pack/changes?since=0'],
      ['POST', '/v1/pack/parts', { parts: [{ s: 'g', id: 0 }] }],
    ] as const) {
      const res = await req(a.token, method, url, body);
      expect(res.statusCode, url).toBe(503);
      expect(res.json()).toMatchObject({ error: 'pack_not_ready' });
    }
  });

  it('builds format 2 beside format 1 under the pack key', async () => {
    const r = (await syncFormat2(h.pool, { params: CHEAP }))!;
    expect(r.built).toMatchObject({ keyId: 1, replaced: null });
    gen = r.built!.saltId;
    expect(gen).toBe(2);
    const { rows } = await h.pool.query('SELECT salt_id, format, app_key_id, active_at IS NOT NULL AS active FROM pack_meta ORDER BY 1');
    expect(rows).toEqual([
      { salt_id: 1, format: 1, app_key_id: null, active: true },
      { salt_id: 2, format: 2, app_key_id: 1, active: true },
    ]);
    // Nothing more to do while the active generation is under the current key.
    expect(await syncFormat2(h.pool, { params: CHEAP })).toEqual({ dropped: [], busy: false, built: null });
    await checkParts(h.pool, gen);

    expect(await openV2(h.pool, gen, K1, X)).toEqual([
      { scope: null, answer: { n: 'Ali Raza', s: 'contacts', c: null, k: 1, m: false } },
    ]);
    expect(await openV2(h.pool, gen, K1, D)).toMatchObject([{ answer: { n: 'Mehar Baba', s: 'directory', c: 'restaurant' } }]);
    expect(await openV2(h.pool, gen, K1, Y)).toMatchObject([{ scope: a.user.id ? expect.any(String) : null, answer: { n: 'Bilal' } }]);
    // The photo: on every answer for the number, and alone (no name) for everyone else.
    expect(await openV2(h.pool, gen, K1, a.user.phone)).toEqual([
      { scope: null, answer: { n: null, s: null, c: null, k: 0, m: false, p: PHOTO } },
      { scope: expect.any(String), answer: { n: 'Abbu', s: 'member', c: null, k: 0, m: true, p: PHOTO } },
    ]);
    // Without the key (another key) nothing is found.
    expect(await openV2(h.pool, gen, K2, X)).toEqual([]);
  });

  it('keeps both formats current from the same queue', async () => {
    await api(h, 'POST', '/v1/contacts/sync', a.token, {
      contacts: [
        { phone: X, name: 'Ali Raza' },
        { phone: Y, name: 'Bilal' },
        { phone: '+923005550009', name: 'Nadia' },
      ],
    });
    const r = (await drainDirty(h.pool))!;
    expect(r).toMatchObject({ upserted: 2 }); // one new entry per generation
    expect((await h.pool.query('SELECT 1 FROM pack_dirty')).rowCount).toBe(0);
    expect(await openV2(h.pool, gen, K1, '+923005550009')).toMatchObject([{ answer: { n: 'Nadia', s: 'contacts' } }]);
    await checkParts(h.pool, gen);
    // A full pass over both finds nothing the drain missed.
    const full = (await reconcilePack(h.pool))!;
    expect(full).toMatchObject({ upserted: 0, deleted: 0, format2: [{ saltId: gen, upserted: 0, deleted: 0, drift: 0 }] });
  });

  it('hands out the key to native code: once logged, no-store, 10 a day', async () => {
    const res = await req(mem.token, 'POST', '/v1/pack/key', {});
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ keys: [{ id: 1, key: key(K1).toString('base64'), saltId: gen }] });
    const { rows } = await h.pool.query('SELECT key_id, host(ip) AS ip FROM pack_key_grants WHERE user_id = $1', [mem.user.id]);
    expect(rows).toEqual([{ key_id: 1, ip: '127.0.0.1' }]);
    expect((await req(mem.token, 'POST', '/v1/pack/key')).statusCode).toBe(200); // no body is fine
    expect((await req(mem.token, 'POST', '/v1/pack/key', [1])).statusCode).toBe(400);
    for (let i = 2; i < 10; i++) expect((await req(mem.token, 'POST', '/v1/pack/key', {})).statusCode).toBe(200);
    const over = await req(mem.token, 'POST', '/v1/pack/key', {});
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ error: 'rate_limited' });
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect((await h.pool.query('SELECT 1 FROM pack_key_grants WHERE user_id = $1', [mem.user.id])).rowCount).toBe(10);
  });

  it('gives the key to Google-linked accounts only under PACK_KEY_HOLDERS=google', async () => {
    expect(loadConfig({ packKeyHolders: 'all' }).packKeyHolders).toBe('all');
    expect(loadConfig({ packKeyHolders: 'all', signupProof: 'google', googleClientIds: ['x'] }).packKeyHolders).toBe('google');
    h.cfg.packKeyHolders = 'google';
    try {
      const denied = await req(b.token, 'POST', '/v1/pack/key', {});
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ error: 'pack_key_denied', reason: 'google_required' });
      for (const url of ['/v1/pack/head', '/v1/pack/manifest', '/v1/pack/changes?since=0']) {
        expect((await req(b.token, 'GET', url)).json()).toMatchObject({ error: 'pack_key_denied', reason: 'google_required' });
      }
      // The operator's admin, and a Google-linked account, get it.
      expect((await req(a.token, 'POST', '/v1/pack/key', {})).statusCode).toBe(200);
      await h.pool.query("UPDATE users SET google_sub = 'sub:other' WHERE id = $1", [b.user.id]);
      expect((await req(b.token, 'POST', '/v1/pack/key', {})).statusCode).toBe(200);
      await h.pool.query('UPDATE users SET google_sub = NULL WHERE id = $1', [b.user.id]);
    } finally {
      h.cfg.packKeyHolders = 'all';
    }
  });

  it('serves head with an ETag (304 when unchanged)', async () => {
    const res = await req(b.token, 'GET', '/v1/pack/head');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const { rows } = await h.pool.query<{ v: number }>(
      'SELECT max(version)::int AS v FROM pack_parts WHERE salt_id = $1 AND (scope IS NULL OR scope = $2)',
      [gen, (await h.pool.query('SELECT family_id FROM users WHERE id = $1', [b.user.id])).rows[0].family_id],
    );
    expect(body).toMatchObject({ saltId: gen, keyId: 1, keyIds: [1], partBits: 6, cursor: rows[0].v, familyChanged: true, retiring: null });
    expect(body.removalSeq).toEqual(expect.any(Number));
    const etag = res.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await req(b.token, 'GET', '/v1/pack/head', undefined, { 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    // A change moves the cursor and the ETag.
    await api(h, 'POST', '/v1/names', b.token, { phone: '+923005550010', name: 'Courier' });
    await drainDirty(h.pool);
    const moved = await req(b.token, 'GET', '/v1/pack/head', undefined, { 'if-none-match': etag });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().cursor).toBeGreaterThan(body.cursor);
  });

  it('serves a manifest that matches pack_parts byte for byte', async () => {
    const man = parseManifest(await bin(a.token, 'GET', '/v1/pack/manifest'));
    const { rows: m } = await h.pool.query('SELECT salt, t, m_kib, p, part_bits FROM pack_meta WHERE salt_id = $1', [gen]);
    expect(man).toMatchObject({ retiring: false, saltId: gen, keyId: 1, t: 1, m: 64, p: 1, partBits: m[0].part_bits });
    expect(man.salt.equals(m[0].salt)).toBe(true);
    const fam = (await h.pool.query('SELECT family_id FROM users WHERE id = $1', [a.user.id])).rows[0].family_id;
    const { rows } = await h.pool.query(
      `SELECT CASE WHEN scope IS NULL THEN 0 ELSE 1 END AS scope, part AS id, version, floor, live, bytes, digest
       FROM pack_parts WHERE salt_id = $1 AND (scope IS NULL OR scope = $2) ORDER BY scope NULLS FIRST, part`,
      [gen, fam],
    );
    expect(man.parts).toEqual(rows);
    expect(man.parts.filter((p) => p.scope === 1)).toHaveLength(1);
    expect(man.cursor).toBe(Math.max(...rows.map((r) => r.version)));
  });

  it('lets a phone download every part, then follow changes, with matching digests', async () => {
    const { phone, cursor } = await download(a.token);
    expect(phone.entries).toEqual(await serverView(a));
    // Find a name the way the phone does.
    const man = parseManifest(await bin(a.token, 'GET', '/v1/pack/manifest'));
    const { tag, key: k } = entryKeysV2(await argon2(v2Password(key(K1), X), { salt: man.salt, t: man.t, m: man.m, p: man.p }));
    expect(JSON.parse(openEntry(k, tag, phone.entries.get(`0|${tag.toString('hex')}`)!)!)).toMatchObject({ n: 'Ali Raza' });

    // Nothing changed: no sections. Then a rename, a new name and a removal arrive as deltas.
    expect((await changes(a.token, `since=${cursor}`)).sections).toEqual([]);
    await api(h, 'POST', '/v1/contacts/sync', a.token, {
      contacts: [
        { phone: X, name: 'Ali Khan' },
        { phone: Y, name: 'Bilal' },
        { phone: '+923005550011', name: 'Saima' },
      ],
    });
    await drainDirty(h.pool);
    await checkParts(h.pool, gen);
    const page = await changes(a.token, `since=${cursor}`);
    expect(page.sections.every((s) => s.mode === 1)).toBe(true);
    expect(page.sections.flatMap((s) => s.rows.map((r) => r.kind)).sort()).toEqual([0, 0, 2]); // X, 5550011; 5550009 gone
    const next = await catchUp(phone, a.token, cursor);
    expect(next).toBe(page.cursor);
    expect(phone.entries).toEqual(await serverView(a));
  });

  it('pages changes by part (after, next, more) and cuts them by size', async () => {
    // More global numbers, spread over many parts.
    await api(h, 'POST', '/v1/contacts/sync', b.token, { contacts: [] });
    await api(h, 'PATCH', '/v1/me', b.token, { shareContacts: true });
    await api(h, 'POST', '/v1/contacts/sync', b.token, {
      contacts: Array.from({ length: 40 }, (_, i) => ({ phone: `+92300777${String(i).padStart(4, '0')}`, name: `Shop ${i}` })),
    });
    await drainDirty(h.pool);
    await checkParts(h.pool, gen);
    pack2Limits.changesPageBytes = 600;
    const { phone } = await download(b.token);
    const first = await changes(b.token, 'since=0');
    expect(first.more).toBe(true);
    expect(first.sections[0].scope).toBe(1); // the family part comes first, on the first page only
    const second = await changes(b.token, `since=0&after=${first.next}`);
    expect(second.sections.every((s) => s.scope === 0 && s.id > first.next)).toBe(true);
    // Following every page from 0 gives the same pack as the full download.
    const fresh = new PhonePack();
    await catchUp(fresh, b.token, 0);
    expect(fresh.entries).toEqual(phone.entries);
    expect(fresh.entries).toEqual(await serverView(b));
    expect((await req(b.token, 'GET', '/v1/pack/changes?after=70000')).statusCode).toBe(400);
  });

  it('never ends a changes page on the family part alone (next would skip global part 0)', async () => {
    // A page size smaller than the family section: the first page must still carry a global
    // part, and `next` must name it.
    pack2Limits.changesPageBytes = 1;
    const first = await changes(b.token, 'since=0');
    expect(first.sections[0].scope).toBe(1);
    expect(first.more).toBe(true);
    const globals = first.sections.filter((s) => s.scope === 0);
    expect(globals.length).toBeGreaterThan(0);
    expect(first.next).toBe(globals[globals.length - 1].id);
    // Paging the whole way with one global part per page still gives every entry.
    const fresh = new PhonePack();
    await catchUp(fresh, b.token, 0);
    expect(fresh.entries).toEqual(await serverView(b));
  });

  it('serves parts in request order, at most 64, cut by size with more', async () => {
    const man = parseManifest(await bin(b.token, 'GET', '/v1/pack/manifest'));
    const ids = man.parts.filter((p) => p.scope === 0).map((p) => p.id);
    const reply = await parts(b.token, [{ s: 'f', id: 0 }, ...ids.map((id) => ({ s: 'g' as const, id }))]);
    expect(reply.more).toBe(false);
    expect(reply.sections.map((s) => `${s.scope}/${s.id}`)).toEqual(['1/0', ...ids.map((id) => `0/${id}`)]);
    expect(reply.sections.every((s) => s.mode === 0)).toBe(true);
    pack2Limits.partsPageBytes = 300;
    const cut = await parts(b.token, ids.map((id) => ({ s: 'g' as const, id })));
    expect(cut.more).toBe(true);
    expect(cut.next).toBe(cut.sections.length);
    expect(cut.sections.length).toBeLessThan(ids.length);
    // An empty part comes back empty; bad requests are refused.
    const empty = Array.from({ length: 64 }, (_, i) => i).find((i) => !ids.includes(i))!;
    expect((await parts(b.token, [{ s: 'g', id: empty }])).sections[0]).toMatchObject({ live: 0, version: 0, rows: [] });
    const many = Array.from({ length: 65 }, (_, i) => ({ s: 'g', id: i % 64 }));
    expect((await req(b.token, 'POST', '/v1/pack/parts', { parts: many })).statusCode).toBe(400);
    expect((await req(b.token, 'POST', '/v1/pack/parts', { parts: [{ s: 'g', id: 64 }] })).json()).toMatchObject({
      error: 'invalid_part',
    });
    expect((await req(b.token, 'POST', '/v1/pack/parts', { parts: [{ s: 'f', id: 1 }] })).statusCode).toBe(400);
    expect((await req(b.token, 'POST', '/v1/pack/parts', { saltId: 999, parts: [{ s: 'g', id: 0 }] })).json()).toMatchObject({
      error: 'pack_generation',
    });
  });

  it('splits parts when they fill up, and phones split theirs locally', async () => {
    const { phone, cursor } = await download(b.token);
    packTuning.splitAvg = 0.2;
    const r = (await reconcilePack(h.pool))!;
    const bits = r.format2![0].partBits;
    expect(bits).toBeGreaterThan(6);
    expect((await h.pool.query('SELECT part_bits FROM pack_meta WHERE salt_id = $1', [gen])).rows[0].part_bits).toBe(bits);
    await checkParts(h.pool, gen);
    // The phone's next delta carries the new partBits; nothing changed, so it only splits.
    const page = await changes(b.token, `since=${cursor}`);
    expect(page.partBits).toBe(bits);
    phone.apply(page);
    expect(phone.entries).toEqual(await serverView(b));
    // And a change after the split still applies with matching digests.
    await api(h, 'POST', '/v1/names', b.token, { phone: '+923005550012', name: 'Tailor' });
    await drainDirty(h.pool);
    await checkParts(h.pool, gen);
    await catchUp(phone, b.token, page.cursor);
    expect(phone.entries).toEqual(await serverView(b));
  });

  it('raises a part floor on purge: a phone behind it refetches that part', async () => {
    const { phone, cursor } = await download(b.token);
    await api(h, 'POST', '/v1/contacts/sync', b.token, { contacts: [{ phone: '+923007770000', name: 'Shop 0' }] });
    await drainDirty(h.pool);
    await h.pool.query("UPDATE pack_entries SET updated_at = now() - interval '61 days' WHERE salt_id = $1 AND deleted", [gen]);
    const r = (await reconcilePack(h.pool))!;
    expect(r.format2![0].purged).toBeGreaterThan(0);
    await checkParts(h.pool, gen);
    const { rows } = await h.pool.query<{ floor: number }>('SELECT floor FROM pack_parts WHERE salt_id = $1 AND floor > $2', [gen, cursor]);
    expect(rows.length).toBeGreaterThan(0);
    const page = await changes(b.token, `since=${cursor}`);
    expect(page.sections.filter((s) => s.mode === 2).length).toBe(rows.length);
    expect(page.sections.filter((s) => s.mode === 2).every((s) => s.rows.length === 0)).toBe(true);
    await catchUp(phone, b.token, cursor);
    expect(phone.entries).toEqual(await serverView(b));
  });

  it('sends the new family part whole after a family move', async () => {
    const { phone, cursor } = await download(mem.token);
    expect([...phone.entries.keys()].filter((k) => k.startsWith('1|')).length).toBeGreaterThan(1); // family A: Y, Abbu, Ammi
    expect((await req(mem.token, 'GET', '/v1/pack/head')).json().familyChanged).toBe(false);
    expect((await api(h, 'POST', '/v1/family/leave', mem.token)).status).toBe(200);
    await drainDirty(h.pool);
    await checkParts(h.pool, gen);
    expect((await req(mem.token, 'GET', '/v1/pack/head')).json().familyChanged).toBe(true);
    const pages: Page[] = [];
    await catchUp(phone, mem.token, cursor, pages);
    expect(pages[0].sections[0]).toMatchObject({ scope: 1, id: 0, mode: 0 });
    expect(phone.entries).toEqual(await serverView(mem));
    expect([...phone.entries.keys()].filter((k) => k.startsWith('1|'))).toHaveLength(1); // only Ammi now
    expect((await req(mem.token, 'GET', '/v1/pack/head')).json().familyChanged).toBe(false);
  });

  it('shows an opt-out as a delete in changes of both formats within one drain', async () => {
    const v1 = await h.app.inject({ method: 'GET', url: '/v1/pack', headers: { authorization: `Bearer ${b.token}` } });
    const v1Since = Number(v1.rawPayload.readBigUInt64BE(32));
    const head = (await req(b.token, 'GET', '/v1/pack/head')).json();
    const r = await optOutNumber(h.pool, D);
    expect(r.pack).toMatchObject({ done: true, deleted: 2 }); // one tombstone per generation
    const page = await changes(b.token, `since=${head.cursor}`);
    const rows = page.sections.flatMap((s) => s.rows);
    expect(rows.map((x) => x.kind)).toEqual([2]);
    expect(page.cursor).toBeGreaterThan(head.cursor);
    expect((await req(b.token, 'GET', '/v1/pack/head')).json().removalSeq).toBe(page.cursor);
    const delta = await h.app.inject({ method: 'GET', url: `/v1/pack?since=${v1Since}`, headers: { authorization: `Bearer ${b.token}` } });
    expect(delta.rawPayload.readUInt32BE(40)).toBe(1);
    expect(delta.rawPayload[44 + 16]).toBe(2); // kind delete
    await checkParts(h.pool, gen);
  });

  it('counts bytes against a daily quota', async () => {
    const used = async () =>
      (await h.pool.query<{ bytes: number }>('SELECT bytes FROM pack_usage WHERE user_id = $1', [b.user.id])).rows[0].bytes;
    const before = await used();
    const buf = await bin(b.token, 'GET', '/v1/pack/manifest');
    expect(await used()).toBe(before + buf.length);
    await h.pool.query('UPDATE pack_usage SET bytes = $2 WHERE user_id = $1', [b.user.id, 64 * 1024 * 1024]);
    for (const [method, url, body] of [
      ['GET', '/v1/pack/manifest'],
      ['GET', '/v1/pack/changes?since=0'],
      ['POST', '/v1/pack/parts', { parts: [{ s: 'g', id: 0 }] }],
    ] as const) {
      const res = await req(b.token, method, url, body);
      expect(res.statusCode, url).toBe(429);
      expect(res.json()).toMatchObject({ error: 'pack_quota' });
    }
    expect((await req(b.token, 'GET', '/v1/pack/head')).statusCode).toBe(200);
    await h.pool.query('UPDATE pack_usage SET bytes = 0 WHERE user_id = $1', [b.user.id]);
  });

  it('refuses every format-2 route to a revoked account', async () => {
    await h.pool.query('UPDATE users SET pack_revoked_at = now() WHERE id = $1', [b.user.id]);
    for (const [method, url, body] of [
      ['POST', '/v1/pack/key', {}],
      ['GET', '/v1/pack/head'],
      ['GET', '/v1/pack/manifest'],
      ['GET', '/v1/pack/changes?since=0'],
      ['POST', '/v1/pack/parts', { parts: [{ s: 'g', id: 0 }] }],
    ] as const) {
      const res = await req(b.token, method, url, body);
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ error: 'pack_key_denied', reason: 'revoked' });
    }
    // Format 1 is not touched.
    expect((await h.app.inject({ method: 'GET', url: '/v1/pack', headers: { authorization: `Bearer ${b.token}` } })).statusCode).toBe(200);
    expect((await api(h, 'GET', '/v1/sync?v=2', b.token)).body.packCursor).toBeNull();
    await h.pool.query('UPDATE users SET pack_revoked_at = NULL WHERE id = $1', [b.user.id]);
  });

  it('catches a changed key value instead of building under it', async () => {
    await h.pool.query('UPDATE pack_meta SET full_requested_at = NULL'); // the directory import's, from beforeAll
    const metaBefore = (await h.pool.query('SELECT salt_id FROM pack_meta ORDER BY 1')).rows;
    initAppKeys([{ id: 1, hex: K_BAD }]);
    try {
      await expect(syncFormat2(h.pool, { params: CHEAP })).rejects.toBeInstanceOf(PackAppKeyMismatch);
      expect((await h.pool.query('SELECT salt_id FROM pack_meta ORDER BY 1')).rows).toEqual(metaBefore);
      const res = await req(a.token, 'GET', '/v1/pack/head');
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: 'pack_key_mismatch' });
      expect((await req(a.token, 'POST', '/v1/pack/key', {})).statusCode).toBe(503);
      // Format 1 keeps going; format 2 is marked for a full pass.
      await api(h, 'POST', '/v1/names', a.token, { phone: '+923005550013', name: 'Baker' });
      expect(await drainDirty(h.pool)).toMatchObject({ numbers: 1, upserted: 1 });
      expect((await h.pool.query('SELECT full_requested_at IS NOT NULL AS f FROM pack_meta WHERE salt_id = $1', [gen])).rows[0].f).toBe(true);
      expect(await fullRequested(h.pool)).toBeNull(); // only the live (format 1) generation counts
    } finally {
      initAppKeys([{ id: 1, hex: K1 }]);
    }
    // Back to the right value: the full pass catches format 2 up.
    const requested = await fullRequested(h.pool);
    expect(requested).not.toBeNull();
    const r = (await reconcilePack(h.pool))!;
    expect(r.format2![0].upserted).toBe(1);
    expect(await openV2(h.pool, gen, K1, '+923005550013')).toMatchObject([{ answer: { n: 'Baker' } }]);
    await checkParts(h.pool, gen);
  });

  it('rotates to a new key: the old generation retires and gets deletes only', async () => {
    const old = gen;
    initAppKeys([
      { id: 2, hex: K2 },
      { id: 1, hex: K1 },
    ]);
    // Until the new generation is built, the old one is served under key 1.
    expect((await req(a.token, 'GET', '/v1/pack/head')).json()).toMatchObject({ saltId: old, keyId: 1 });
    const r = (await syncFormat2(h.pool, { params: CHEAP }))!;
    expect(r.built).toMatchObject({ keyId: 2, replaced: { saltId: old, retiring: true } });
    gen = r.built!.saltId;
    await reconcilePack(h.pool); // what the worker runs after a swap
    await checkParts(h.pool, gen);
    await checkParts(h.pool, old);
    const head = (await req(a.token, 'GET', '/v1/pack/head')).json();
    expect(head).toMatchObject({ saltId: gen, keyId: 2, keyIds: [2, 1], retiring: { saltId: old, keyId: 1, until: expect.any(String) } });
    const keys = (await req(a.token, 'POST', '/v1/pack/key', {})).json().keys;
    expect(keys).toEqual([
      { id: 2, key: key(K2).toString('base64'), saltId: gen },
      { id: 1, key: key(K1).toString('base64'), saltId: old, until: head.retiring.until },
    ]);
    expect(await openV2(h.pool, gen, K2, X)).toMatchObject([{ answer: { n: 'Ali Khan' } }]);
    const oldMan = parseManifest(await bin(a.token, 'GET', `/v1/pack/manifest?saltId=${old}`));
    expect(oldMan).toMatchObject({ retiring: true, saltId: old, keyId: 1 });

    // A removal reaches both; a new name only the new one.
    const oldCursor = oldMan.cursor;
    await api(h, 'POST', '/v1/contacts/sync', a.token, {
      contacts: [
        { phone: Y, name: 'Bilal' },
        { phone: '+923005550014', name: 'Zubair' },
      ],
    });
    await drainDirty(h.pool);
    await checkParts(h.pool, gen);
    await checkParts(h.pool, old);
    expect(await openV2(h.pool, old, K1, '+923005550014')).toEqual([]);
    expect(await openV2(h.pool, gen, K2, '+923005550014')).toMatchObject([{ answer: { n: 'Zubair' } }]);
    const page = await changes(a.token, `since=${oldCursor}&saltId=${old}`);
    expect(page.saltId).toBe(old);
    const rows = page.sections.flatMap((s) => s.rows);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.kind === 2)).toBe(true);
    expect(await openV2(h.pool, old, K1, X)).toEqual([]); // X was dropped from a's contacts
    expect((await req(a.token, 'GET', '/v1/pack/changes?saltId=1')).json()).toMatchObject({ error: 'pack_generation' });

    // After retire_after the old generation goes.
    await h.pool.query("UPDATE pack_meta SET retire_after = now() - interval '1 second' WHERE salt_id = $1", [old]);
    expect((await syncFormat2(h.pool, { params: CHEAP }))!.dropped).toEqual([old]);
    expect((await req(a.token, 'GET', '/v1/pack/head')).json()).toMatchObject({ keyIds: [2], retiring: null });
  });

  it('builds and swaps from the worker loop, and never logs a key', async () => {
    initAppKeys([{ id: 3, hex: K3 }]);
    const lines: string[] = [];
    const log = { info: (m: string) => lines.push(m), error: (m: string) => lines.push(`ERROR ${m}`) };
    const runner = startPackRunner(h.pool, h.cfg.databaseUrl, log, { debounceMs: 50, pollMs: 200, format2Params: CHEAP });
    try {
      const deadline = Date.now() + 20_000;
      while (!lines.some((l) => /generation \d+ \(pack key 3\) is live/.test(l))) {
        if (Date.now() > deadline) throw new Error(`no swap: ${lines.join(' / ')}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      await runner.stop();
    }
    expect(lines.filter((l) => l.startsWith('ERROR'))).toEqual([]);
    expect(lines.some((l) => /building generation \d+ under pack key 3/.test(l))).toBe(true);
    // Key 2's generation was deleted: its key left PACK_APP_KEYS.
    expect(lines.some((l) => /deleted \(its key left PACK_APP_KEYS\)/.test(l))).toBe(true);
    const secrets = [K1, K2, K3].flatMap((x) => [x, key(x).toString('base64')]);
    for (const l of lines) for (const s of secrets) expect(l.includes(s)).toBe(false);
    gen = (await h.pool.query<{ s: number }>('SELECT max(salt_id) AS s FROM pack_meta WHERE format = 2')).rows[0].s;
    await checkParts(h.pool, gen);
  });

  it('answers 404 pack_disabled without PACK_APP_KEYS, and leaves format 1 alone', async () => {
    initAppKeys([]);
    for (const [method, url, body] of [
      ['POST', '/v1/pack/key', {}],
      ['GET', '/v1/pack/head'],
      ['GET', '/v1/pack/manifest'],
      ['GET', '/v1/pack/changes?since=0'],
      ['POST', '/v1/pack/parts', { parts: [{ s: 'g', id: 0 }] }],
    ] as const) {
      const res = await req(a.token, method, url, body);
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toMatchObject({ error: 'pack_disabled' });
    }
    expect(await syncFormat2(h.pool)).toBeNull();
    expect((await h.app.inject({ method: 'GET', url: '/v1/pack', headers: { authorization: `Bearer ${a.token}` } })).statusCode).toBe(200);
    expect((await api(h, 'GET', '/v1/sync?v=2', a.token)).body).toMatchObject({ packCursor: null, lookupMode: 'online' });
    initAppKeys([{ id: 3, hex: K3 }]);
  });
});

describe('without PACK_APP_KEYS', () => {
  it('builds no format-2 generation and serves no format-2 route', async () => {
    const h = await createHarness();
    try {
      const me = (await api(h, 'POST', '/v1/register', null, { phone: '+923004444444', name: 'Me' })).body;
      await api(h, 'PATCH', '/v1/me', me.token, { shareContacts: true });
      await api(h, 'POST', '/v1/contacts/sync', me.token, { contacts: [{ phone: X, name: 'Ali' }] });
      await drainDirty(h.pool);
      await reconcilePack(h.pool);
      expect(await syncFormat2(h.pool)).toBeNull();
      expect((await h.pool.query('SELECT format FROM pack_meta')).rows).toEqual([{ format: 1 }]);
      expect((await h.pool.query('SELECT count(*)::int AS n FROM pack_parts')).rows[0].n).toBe(0);
      expect((await h.pool.query('SELECT count(*)::int AS n FROM pack_entries WHERE tag16 IS NOT NULL')).rows[0].n).toBe(0);
      expect(await api(h, 'GET', '/v1/pack/head', me.token)).toMatchObject({ status: 404, body: { error: 'pack_disabled' } });
    } finally {
      await h.close();
    }
  });
});
