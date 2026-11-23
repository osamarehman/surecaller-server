import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { importDirectory } from '../src/directory.js';
import { argon2, entryKeys, initAppKeys, openEntry, packVault } from '../src/pack.js';
import { clearFullRequest, drainDirty, fullRequested, reconcilePack, rotatePack, syncFormat2 } from '../src/pack-build.js';
import { checkParts, openV2 } from './pack-v2-helpers.js';
import { startPackRunner } from '../src/pack-runner.js';
import { optOutNumber } from '../src/privacy.js';
import { vault } from '../src/vault.js';
import { api, createHarness, registerAdmin, type Harness, type Session } from './helpers.js';

/** Small deterministic PRNG (mulberry32), so a failing sequence can be replayed from its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)],
    subset: <T>(xs: T[], p = 0.4) => xs.filter(() => next() < p),
    chance: (p: number) => next() < p,
  };
}

const PHONES = Array.from({ length: 14 }, (_, i) => `+92300888${String(i).padStart(4, '0')}`);
const NAMES = ['Ali', 'Bilal', 'Sana', 'Zara', 'Omar', 'محمد علی', 'Hina'];

/** The serving generation's live entries as "hash|scope|fp" (fp is a keyed hash of the plaintext). */
async function liveEntries(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ k: string }>(
    `SELECT encode(phone_hash, 'hex') || '|' || coalesce(scope::text, '') || '|' || encode(fp, 'hex') AS k
     FROM pack_entries WHERE NOT deleted
       AND salt_id = (SELECT max(salt_id) FROM pack_meta WHERE active_at IS NOT NULL)
     ORDER BY 1`,
  );
  return rows.map((r) => r.k);
}

/** What the pack worker does on one pass (src/pack-runner.ts), without the timers. */
async function workerPass(pool: pg.Pool) {
  const requested = await fullRequested(pool);
  if (requested) {
    await reconcilePack(pool);
    await clearFullRequest(pool, requested);
  }
  await drainDirty(pool, { batch: 4 });
}

describe('incremental pack builds', () => {
  let h: Harness;
  const members: Session[] = [];

  beforeAll(async () => {
    h = await createHarness();
    await h.pool.query(
      'INSERT INTO pack_meta (salt_id, salt, t, m_kib, p, canary, active_at) VALUES (1, $1, 1, 64, 1, $2, now())',
      [Buffer.alloc(16, 3), packVault()!.canary()],
    );
  });
  afterAll(async () => {
    await h.close();
  });

  it('gives exactly the entries of a full build from scratch, for random changes', async () => {
    const r = rng(20261118);
    // Some members are numbers that others also save, suggest or list in the directory.
    const memberPhones = PHONES.slice(0, 5);
    const admin = await registerAdmin(h, memberPhones[0], 'Admin');
    members.push(admin);
    await api(h, 'PATCH', '/v1/me', admin.token, { shareContacts: true });

    const ops: Record<string, () => Promise<unknown>> = {
      async register() {
        const phone = r.pick(memberPhones);
        if (members.some((m) => m.user.phone === phone)) return;
        const s = (await api(h, 'POST', '/v1/register', null, { phone, name: r.pick(NAMES) })).body as Session;
        if (!s?.token) return;
        members.push(s);
        await api(h, 'PATCH', '/v1/me', s.token, { shareContacts: true });
      },
      async upload() {
        const m = r.pick(members);
        await api(h, 'POST', '/v1/contacts/sync', m.token, {
          contacts: r.subset(PHONES, 0.25).map((phone) => ({ phone, name: r.pick(NAMES) })),
        });
      },
      async deleteContacts() {
        await api(h, 'DELETE', '/v1/contacts', r.pick(members).token);
      },
      async familyOnly() {
        // Contacts shared before open sign-up: some of an uploader's become family-only (or back).
        const { rows } = await h.pool.query<{ u: string }>('SELECT DISTINCT user_id AS u FROM contacts ORDER BY 1');
        if (!rows.length) return;
        await h.pool.query('UPDATE contacts SET family_only = $3 WHERE user_id = $1 AND phone_hash = ANY($2::bytea[])', [
          r.pick(rows).u,
          r.subset(PHONES, 0.6).map((p) => vault().index(p)),
          r.chance(0.8),
        ]);
      },
      async suggest() {
        await api(h, 'POST', '/v1/names', r.pick(members).token, { phone: r.pick(PHONES), name: r.pick(NAMES) });
      },
      async rename() {
        await api(h, 'PATCH', '/v1/me', r.pick(members).token, { name: r.pick(NAMES) });
      },
      async moveFamily() {
        // Most often someone whose family-only contacts move with them.
        const { rows: fo } = await h.pool.query<{ u: string }>('SELECT DISTINCT user_id AS u FROM contacts WHERE family_only ORDER BY 1');
        const m = (fo.length && r.chance(0.7) && members.find((x) => x.user.id === r.pick(fo).u)) || r.pick(members);
        // An admin of another family invites m; else m leaves to a family of their own.
        const { rows: admins } = await h.pool.query<{ id: string }>(
          `SELECT id FROM users WHERE is_admin AND family_id <> (SELECT family_id FROM users WHERE id = $1) ORDER BY id`,
          [m.user.id],
        );
        const inviter = admins.length && r.chance(0.7) ? members.find((x) => x.user.id === r.pick(admins).id) : undefined;
        if (!inviter) {
          await api(h, 'POST', '/v1/family/leave', m.token);
          return;
        }
        const inv = await api(h, 'POST', '/v1/invites', inviter.token, { expiresInHours: 1 });
        if (inv.status === 201) await api(h, 'POST', '/v1/family/join', m.token, { code: inv.body.code });
      },
      async deleteMember() {
        if (members.length < 3) return;
        const m = members.splice(1 + r.int(members.length - 1), 1)[0];
        await api(h, 'DELETE', '/v1/me', m.token);
      },
      async optOut() {
        await optOutNumber(h.pool, r.pick(PHONES), 5_000);
      },
      async optIn() {
        await h.pool.query('DELETE FROM opt_outs WHERE phone_hash = $1', [vault().index(r.pick(PHONES))]);
      },
      async importDirectory() {
        await importDirectory(
          h.pool,
          r.subset(PHONES, 0.3).map((phone) => ({ phone, name: `Shop ${r.pick(NAMES)}`, category: r.chance(0.5) ? 'shop' : null })),
          'PK',
        );
      },
      async dropDirectoryRow() {
        await h.pool.query('DELETE FROM directory WHERE phone_hash = $1', [vault().index(r.pick(PHONES))]);
      },
    };
    // Family moves and family-only contacts are the subtle cases: give them more weight.
    const names = [...Object.keys(ops), 'moveFamily', 'moveFamily', 'moveFamily', 'familyOnly', 'register', 'upload'];

    const log: string[] = [];
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 40; i++) {
        const op = r.pick(names);
        log.push(op);
        await ops[op]();
        if (r.chance(0.5)) {
          await workerPass(h.pool);
          // A full pass over the same generation finds nothing the drains missed.
          expect(await reconcilePack(h.pool), `after ${log.join(', ')}`).toMatchObject({ upserted: 0, deleted: 0 });
        }
      }
      await workerPass(h.pool);
      expect((await h.pool.query('SELECT 1 FROM pack_dirty')).rowCount).toBe(0);
      const incremental = await liveEntries(h.pool);
      // From scratch: a new salt generation built in full, compared by plaintext fingerprint.
      await rotatePack(h.pool);
      expect(await liveEntries(h.pool)).toEqual(incremental);
      expect(incremental.length).toBeGreaterThan(0);
      // The rotation's own changes (none) and anything queued keep the next round honest.
      await workerPass(h.pool);
    }
  }, 120_000);

  it('decrypts only the queued numbers', async () => {
    await h.pool.query('DELETE FROM opt_outs');
    const m = members[0];
    await api(h, 'POST', '/v1/contacts/sync', m.token, {
      contacts: PHONES.slice(5).map((phone) => ({ phone, name: 'Kept' })),
    });
    await workerPass(h.pool);
    expect((await h.pool.query('SELECT 1 FROM pack_dirty')).rowCount).toBe(0);
    // One number changes; every other row stays sealed.
    await h.pool.query(
      'UPDATE contacts SET name_enc = $1 WHERE phone_hash = $2 AND user_id = $3',
      [vault().seal(PHONES[9], 'Changed'), vault().index(PHONES[9]), m.user.id],
    );
    const open = vi.spyOn(vault(), 'open');
    const openPhone = vi.spyOn(packVault()!, 'openPhone');
    try {
      const r = (await drainDirty(h.pool))!;
      expect(r).toMatchObject({ numbers: 1 });
      expect(open).toHaveBeenCalled();
      expect(new Set(open.mock.calls.map((c) => c[0]))).toEqual(new Set([PHONES[9]]));
      const sealedRows = await h.pool.query(
        `SELECT 1 FROM contacts WHERE phone_hash = $1 AND phone_enc IS NOT NULL
         UNION ALL SELECT 1 FROM directory WHERE phone_hash = $1 AND phone_enc IS NOT NULL
         UNION ALL SELECT 1 FROM name_suggestions WHERE phone_hash = $1 AND phone_enc IS NOT NULL`,
        [vault().index(PHONES[9])],
      );
      expect(openPhone.mock.calls.length).toBeLessThanOrEqual(sealedRows.rowCount!);
    } finally {
      open.mockRestore();
      openPhone.mockRestore();
    }
  });

  it('lets only one of two workers write at a time', async () => {
    const m = members[0];
    await api(h, 'POST', '/v1/contacts/sync', m.token, {
      contacts: PHONES.map((phone, i) => ({ phone, name: `Two ${i}` })),
    });
    const queued = (await h.pool.query('SELECT 1 FROM pack_dirty')).rowCount!;
    expect(queued).toBeGreaterThan(0);

    // Someone else holds the generation's lock: both entry points step aside.
    const holder = new pg.Client({ connectionString: h.cfg.databaseUrl });
    await holder.connect();
    try {
      const { rows } = await holder.query<{ s: number }>('SELECT max(salt_id) AS s FROM pack_meta WHERE active_at IS NOT NULL');
      await holder.query('SELECT pg_advisory_lock(737373, $1)', [rows[0].s]);
      expect(await drainDirty(h.pool)).toBeNull();
      expect(await reconcilePack(h.pool)).toBeNull();
      expect((await h.pool.query('SELECT 1 FROM pack_dirty')).rowCount).toBe(queued);
    } finally {
      await holder.end();
    }

    // Two at once: each queued number is processed once, by whichever got the lock.
    const before = (await h.pool.query<{ s: number }>("SELECT last_value::int AS s FROM pack_seq")).rows[0].s;
    const [x, y] = await Promise.all([drainDirty(h.pool, { batch: 3 }), drainDirty(h.pool, { batch: 3 })]);
    const done = [x, y].filter((r) => r !== null);
    expect(done.length).toBeGreaterThanOrEqual(1);
    expect(done.reduce((n, r) => n + r!.numbers, 0)).toBe(queued);
    expect((await h.pool.query('SELECT 1 FROM pack_dirty')).rowCount).toBe(0);
    const { rows: seqs } = await h.pool.query<{ n: number; d: number }>(
      'SELECT count(*)::int AS n, count(DISTINCT seq)::int AS d FROM pack_entries WHERE seq > $1',
      [before],
    );
    expect(seqs[0].n).toBe(seqs[0].d);
  });

  it('runs as a worker loop: drains on NOTIFY, two loops side by side', async () => {
    const lines: string[] = [];
    const log = { info: (m: string) => lines.push(m), error: (m: string) => lines.push(`ERROR ${m}`) };
    const one = startPackRunner(h.pool, h.cfg.databaseUrl, log, { debounceMs: 50, pollMs: 5_000 });
    const two = startPackRunner(h.pool, h.cfg.databaseUrl, log, { debounceMs: 50, pollMs: 5_000 });
    try {
      await new Promise((r) => setTimeout(r, 300)); // both listening
      const m = members[0];
      await api(h, 'POST', '/v1/contacts/sync', m.token, { contacts: [{ phone: PHONES[13], name: 'Worker' }] });
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rowCount } = await h.pool.query('SELECT 1 FROM pack_dirty');
        if (rowCount === 0) break;
        if (Date.now() > deadline) throw new Error(`queue not drained: ${lines.join(' / ')}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(lines.some((l) => /name pack: drained \d+ queued numbers/.test(l))).toBe(true);
      expect(lines.filter((l) => l.startsWith('ERROR'))).toEqual([]);
    } finally {
      await Promise.all([one.stop(), two.stop()]);
    }
    const incremental = await liveEntries(h.pool);
    await rotatePack(h.pool);
    expect(await liveEntries(h.pool)).toEqual(incremental);
  });
});

describe('format 1 and format 2 from one queue', () => {
  let h: Harness;
  const members: Session[] = [];
  // Test keys only: one per format-2 generation built from scratch.
  const KEYS = ['e1', 'e2', 'e3', 'e4', 'e5'].map((x) => x.repeat(32));
  const CHEAP = { t: 1, m: 64, p: 1 };
  let gen = 0;
  let keyIx = 0;

  beforeAll(async () => {
    h = await createHarness({ packAppKeys: [{ id: 1, hex: KEYS[0] }] });
    await h.pool.query(
      'INSERT INTO pack_meta (salt_id, salt, t, m_kib, p, canary, active_at) VALUES (1, $1, 1, 64, 1, $2, now())',
      [Buffer.alloc(16, 3), packVault()!.canary()],
    );
  });
  afterAll(async () => {
    initAppKeys([]);
    await h.close();
  });

  /** Format 1's live answers for `phone`, by scope. */
  async function openV1(phone: string) {
    const { rows: m } = await h.pool.query<{ salt: Buffer; t: number; m_kib: number; p: number }>(
      'SELECT salt, t, m_kib, p FROM pack_meta WHERE salt_id = 1',
    );
    const { tag, key } = entryKeys(await argon2(phone, { salt: m[0].salt, t: m[0].t, m: m[0].m_kib, p: m[0].p }));
    const { rows } = await h.pool.query<{ scope: string | null; blob: Buffer }>(
      'SELECT scope, blob FROM pack_entries WHERE salt_id = 1 AND tag = $1 AND NOT deleted',
      [tag],
    );
    return rows.map((r) => ({ scope: r.scope, answer: JSON.parse(openEntry(key, tag, r.blob)!) }));
  }

  /**
   * Both formats answer the same numbers with the same plaintext. Format 2 adds the photo (`p`,
   * the account's photo_url) and, for a number that has only a photo, a global entry without a name.
   */
  let compared = 0;
  let photoOnly = 0;
  async function sameContent(context: string) {
    const { rows: photos } = await h.pool.query<{ phone: string; photo_url: string }>(
      'SELECT phone, photo_url FROM users WHERE photo_url IS NOT NULL',
    );
    const photoOf = new Map(photos.map((r) => [r.phone, r.photo_url]));
    for (const phone of PHONES) {
      const v1 = new Map((await openV1(phone)).map((e) => [e.scope ?? '', e.answer]));
      const v2 = new Map((await openV2(h.pool, gen, KEYS[keyIx], phone)).map((e) => [e.scope ?? '', e.answer]));
      for (const [scope, a] of v2) {
        expect(a.p ?? null, `${context}: photo of ${phone}`).toBe(photoOf.get(phone) ?? null);
        delete a.p;
        if (a.n === null) {
          expect(scope, `${context}: photo-only entry is global`).toBe('');
          expect(v1.has(scope), `${context}: format 1 has no entry for a photo-only ${phone}`).toBe(false);
          v2.delete(scope);
          photoOnly++;
        }
      }
      expect(v2, `${context}: ${phone}`).toEqual(v1);
      compared += v1.size;
    }
  }

  async function workerPass() {
    const requested = await fullRequested(h.pool);
    if (requested) {
      await reconcilePack(h.pool);
      await clearFullRequest(h.pool, requested);
    }
    await drainDirty(h.pool, { batch: 4 });
  }

  /** The live format-2 entries as "hash|scope|fp" (fp: keyed hash of the plaintext). */
  async function liveV2(saltId: number) {
    const { rows } = await h.pool.query<{ k: string }>(
      `SELECT encode(phone_hash, 'hex') || '|' || coalesce(scope::text, '') || '|' || encode(fp, 'hex') AS k
       FROM pack_entries WHERE NOT deleted AND salt_id = $1 ORDER BY 1`,
      [saltId],
    );
    return rows.map((r) => r.k);
  }

  it('stay equal in content, and format 2 equals a build from scratch, for random changes', async () => {
    const r = rng(20261119);
    const memberPhones = PHONES.slice(0, 5);
    const admin = await registerAdmin(h, memberPhones[0], 'Admin');
    members.push(admin);
    await api(h, 'PATCH', '/v1/me', admin.token, { shareContacts: true });
    gen = (await syncFormat2(h.pool, { params: CHEAP }))!.built!.saltId;

    const ops: Record<string, () => Promise<unknown>> = {
      async register() {
        const phone = r.pick(memberPhones);
        if (members.some((m) => m.user.phone === phone)) return;
        const s = (await api(h, 'POST', '/v1/register', null, { phone, name: r.pick(NAMES) })).body as Session;
        if (!s?.token) return;
        members.push(s);
        await api(h, 'PATCH', '/v1/me', s.token, { shareContacts: true });
      },
      async upload() {
        await api(h, 'POST', '/v1/contacts/sync', r.pick(members).token, {
          contacts: r.subset(PHONES, 0.25).map((phone) => ({ phone, name: r.pick(NAMES) })),
        });
      },
      async deleteContacts() {
        await api(h, 'DELETE', '/v1/contacts', r.pick(members).token);
      },
      async familyOnly() {
        const { rows } = await h.pool.query<{ u: string }>('SELECT DISTINCT user_id AS u FROM contacts ORDER BY 1');
        if (!rows.length) return;
        await h.pool.query('UPDATE contacts SET family_only = $3 WHERE user_id = $1 AND phone_hash = ANY($2::bytea[])', [
          r.pick(rows).u,
          r.subset(PHONES, 0.6).map((p) => vault().index(p)),
          r.chance(0.8),
        ]);
      },
      async suggest() {
        await api(h, 'POST', '/v1/names', r.pick(members).token, { phone: r.pick(PHONES), name: r.pick(NAMES) });
      },
      async rename() {
        await api(h, 'PATCH', '/v1/me', r.pick(members).token, { name: r.pick(NAMES) });
      },
      async photo() {
        // The account's photo goes into format 2 only (`p`).
        await h.pool.query('UPDATE users SET photo_url = $2 WHERE id = $1', [
          r.pick(members).user.id,
          r.chance(0.6) ? `https://lh3.googleusercontent.com/a/p${r.int(3)}=s256-c` : null,
        ]);
      },
      async moveFamily() {
        const m = r.pick(members);
        const { rows: admins } = await h.pool.query<{ id: string }>(
          `SELECT id FROM users WHERE is_admin AND family_id <> (SELECT family_id FROM users WHERE id = $1) ORDER BY id`,
          [m.user.id],
        );
        const inviter = admins.length && r.chance(0.7) ? members.find((x) => x.user.id === r.pick(admins).id) : undefined;
        if (!inviter) {
          await api(h, 'POST', '/v1/family/leave', m.token);
          return;
        }
        const inv = await api(h, 'POST', '/v1/invites', inviter.token, { expiresInHours: 1 });
        if (inv.status === 201) await api(h, 'POST', '/v1/family/join', m.token, { code: inv.body.code });
      },
      async deleteMember() {
        if (members.length < 3) return;
        const m = members.splice(1 + r.int(members.length - 1), 1)[0];
        await api(h, 'DELETE', '/v1/me', m.token);
      },
      async optOut() {
        await optOutNumber(h.pool, r.pick(PHONES), 5_000);
      },
      async optIn() {
        await h.pool.query('DELETE FROM opt_outs WHERE phone_hash = $1', [vault().index(r.pick(PHONES))]);
      },
      async importDirectory() {
        await importDirectory(
          h.pool,
          r.subset(PHONES, 0.3).map((phone) => ({ phone, name: `Shop ${r.pick(NAMES)}`, category: r.chance(0.5) ? 'shop' : null })),
          'PK',
        );
      },
      async dropDirectoryRow() {
        await h.pool.query('DELETE FROM directory WHERE phone_hash = $1', [vault().index(r.pick(PHONES))]);
      },
    };
    const names = [...Object.keys(ops), 'moveFamily', 'moveFamily', 'familyOnly', 'photo', 'register', 'upload'];

    const log: string[] = [];
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 30; i++) {
        const op = r.pick(names);
        log.push(op);
        await ops[op]();
        if (r.chance(0.5)) {
          await workerPass();
          await checkParts(h.pool, gen);
          await sameContent(log.join(', '));
        }
      }
      await workerPass();
      expect((await h.pool.query('SELECT 1 FROM pack_dirty')).rowCount).toBe(0);
      await checkParts(h.pool, gen);
      await sameContent(`end of round ${round}`);
      expect(compared).toBeGreaterThan(0);

      // From scratch: a new key at the front builds a new format-2 generation in full.
      const incremental = await liveV2(gen);
      expect(incremental.length).toBeGreaterThan(0);
      const old = gen;
      keyIx++;
      initAppKeys([
        { id: keyIx + 1, hex: KEYS[keyIx] },
        { id: keyIx, hex: KEYS[keyIx - 1] },
      ]);
      const built = (await syncFormat2(h.pool, { params: CHEAP }))!.built!;
      expect(built.replaced).toEqual({ saltId: old, retiring: true });
      gen = built.saltId;
      expect(await liveV2(gen), `round ${round}: ${log.join(', ')}`).toEqual(incremental);
      await checkParts(h.pool, gen);
      // The retiring generation goes once its key leaves PACK_APP_KEYS.
      initAppKeys([{ id: keyIx + 1, hex: KEYS[keyIx] }]);
      expect((await syncFormat2(h.pool, { params: CHEAP }))!.dropped).toEqual([old]);
      await workerPass();
    }
    // The sequences covered photos without a name too.
    expect(photoOnly).toBeGreaterThan(0);
  }, 180_000);
});