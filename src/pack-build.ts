import crypto from 'node:crypto';
import type pg from 'pg';
import { rankByCount } from './lookup.js';
import { cleanName } from './names.js';
import { vault } from './vault.js';
import {
  answerJson,
  argon2Many,
  DEFAULT_PARAMS,
  entryKeys,
  packVault,
  sealEntry,
  type PackAnswer,
  type PackParams,
} from './pack.js';

/**
 * Builds the offline name pack: one encrypted entry per (generation, number, scope), kept in
 * pack_entries and handed out by GET /v1/pack. See docs/NAME_PACK.md (app repo) for the design.
 */

/** Advisory lock class; the second key is the generation (salt_id) being written. */
const LOCK_ID = 737373;
/** Numbers per reconcile batch (read, diff and write), so memory stays flat. */
const BATCH = 5000;
/** Tombstones older than this are deleted; clients behind them must refetch everything. */
const PURGE_DAYS = 60;
/** More unreadable phone_enc rows than this share means a key or data problem: write nothing. */
const MAX_BAD_PHONE_ENC = 0.02;

/** PACK_KEY differs from the key the pack was built with. Fix .env; don't serve or rebuild. */
export class PackKeyMismatch extends Error {
  constructor() {
    super('PACK_KEY does not match the key the name pack was built with (pack_meta canary); refusing to use the pack');
  }
}

export interface PackMeta extends PackParams {
  saltId: number;
  purgeSeq: number;
}

interface MetaRow {
  salt_id: number;
  salt: Buffer;
  t: number;
  m_kib: number;
  p: number;
  purge_seq: number;
  canary: Buffer;
}

function toMeta(r: MetaRow): PackMeta {
  if (!packVault()!.checkCanary(r.canary)) throw new PackKeyMismatch();
  return { saltId: r.salt_id, salt: r.salt, t: r.t, m: r.m_kib, p: r.p, purgeSeq: r.purge_seq };
}

const newMetaValues = () => [
  crypto.randomBytes(16),
  DEFAULT_PARAMS.t,
  DEFAULT_PARAMS.m,
  DEFAULT_PARAMS.p,
  packVault()!.canary(),
];

/** The generation phones download (read only). null before the first one exists. */
export async function servingMeta(db: pg.Pool | pg.PoolClient): Promise<PackMeta | null> {
  const { rows } = await db.query<MetaRow>(
    'SELECT * FROM pack_meta WHERE active_at IS NOT NULL ORDER BY salt_id DESC LIMIT 1',
  );
  return rows[0] ? toMeta(rows[0]) : null;
}

/**
 * The serving generation, created (random salt, production cost) on first use.
 * Throws PackKeyMismatch when PACK_KEY changed.
 */
export async function packMeta(db: pg.Pool | pg.PoolClient): Promise<PackMeta> {
  const meta = await servingMeta(db);
  if (meta) return meta;
  // Generation 1; when two first callers race, the second one's insert is a no-op.
  await db.query(
    `INSERT INTO pack_meta (salt_id, salt, t, m_kib, p, canary, active_at)
     VALUES (1, $1, $2, $3, $4, $5, now()) ON CONFLICT (salt_id) DO NOTHING`,
    newMetaValues(),
  );
  return (await servingMeta(db))!;
}

export interface ReconcileResult {
  saltId: number;
  /** Entries the pack should hold now (global + family). */
  entries: number;
  upserted: number;
  deleted: number;
  /** Numbers that needed a fresh Argon2 hash. */
  hashed: number;
  purged: number;
  ms: number;
}

interface Named {
  name: string;
  at: Date;
}

interface Facts {
  phone: string;
  hash: Buffer;
  /** Contacts anyone can see. */
  open: Named[];
  /** family_only contacts, by the uploader's family. */
  familyOnly: Map<string, Named[]>;
  dir: { name: string; category: string | null } | null;
  suggested: Named[];
  /** Member name, by family. */
  members: Map<string, string>;
}

interface Desired {
  hash: Buffer;
  scope: string | null;
  phone: string;
  plaintext: string;
}

const clip = (s: string) => s.slice(0, 100);

/** Same priority as buildLookups: member > contacts > directory > suggested. */
function answer(f: Facts, family: string | null): PackAnswer | null {
  const contacts = family ? [...f.open, ...(f.familyOnly.get(family) ?? [])] : f.open;
  const k = contacts.length;
  const member = family ? f.members.get(family) : undefined;
  if (member !== undefined) return { n: clip(member), s: 'member', c: null, k, m: true };
  if (k) return { n: clip(rankByCount(contacts)[0].name), s: 'contacts', c: null, k, m: false };
  if (f.dir) return { n: clip(f.dir.name), s: 'directory', c: f.dir.category, k: 0, m: false };
  if (f.suggested.length) return { n: clip(rankByCount(f.suggested)[0].name), s: 'suggested', c: null, k: 0, m: false };
  return null;
}

/** The entries one number should have. */
function desiredFor(f: Facts, optedOut: boolean): Desired[] {
  const out: Desired[] = [];
  const push = (scope: string | null) => {
    const a = answer(f, scope);
    if (a) out.push({ hash: f.hash, scope, phone: f.phone, plaintext: answerJson(a) });
  };
  // An opted-out number gets no global or family-only-contact entry, but (as in buildLookups)
  // its own family still sees it as a member.
  if (!optedOut) push(null);
  for (const fam of new Set([...f.members.keys(), ...(optedOut ? [] : f.familyOnly.keys())])) push(fam);
  return out;
}

/**
 * Refuses to build when too many sealed numbers don't open (wrong PACK_KEY, corrupt data):
 * every one of them would turn into a tombstone. Streams the rows; nothing is written.
 */
async function checkPhoneEnc(c: pg.PoolClient): Promise<void> {
  const v = vault();
  const pv = packVault()!;
  let total = 0;
  let bad = 0;
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query(`DECLARE pack_pe NO SCROLL CURSOR FOR
      SELECT phone_hash, phone_enc FROM contacts WHERE phone_enc IS NOT NULL
      UNION ALL SELECT phone_hash, phone_enc FROM directory WHERE phone_enc IS NOT NULL
      UNION ALL SELECT phone_hash, phone_enc FROM name_suggestions WHERE phone_enc IS NOT NULL`);
    for (;;) {
      const { rows } = await c.query<{ phone_hash: Buffer; phone_enc: Buffer }>('FETCH 10000 FROM pack_pe');
      if (!rows.length) break;
      for (const r of rows) {
        total++;
        const phone = pv.openPhone(r.phone_enc);
        if (!phone || !v.index(phone).equals(r.phone_hash)) bad++;
      }
    }
  } finally {
    await c.query('COMMIT').catch(() => {});
  }
  if (total && bad / total > MAX_BAD_PHONE_ENC) {
    throw new Error(`name pack: ${bad} of ${total} sealed numbers do not open under PACK_KEY; refusing to update the pack`);
  }
}

/** workers: Argon2 threads (default PACK_WORKERS); batch: numbers per batch (tests). */
export interface BuildOpts {
  workers?: number;
  batch?: number;
}

type Row = { phone_hash: Buffer; phone_enc: Buffer | null; name_enc: Buffer };

/** One batch's source rows and current entries, read from one snapshot. */
async function readBatch(c: pg.PoolClient, saltId: number, lo: Buffer, hi: Buffer) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const range = [lo, hi];
    const contacts = await c.query<Row & { at: Date; family_only: boolean; family_id: string }>(
      `SELECT c.phone_hash, c.phone_enc, c.name_enc, c.updated_at AS at, c.family_only, u.family_id
       FROM contacts c JOIN users u ON u.id = c.user_id WHERE c.phone_hash > $1 AND c.phone_hash <= $2`,
      range,
    );
    const dir = await c.query<Row & { category: string | null }>(
      'SELECT phone_hash, phone_enc, name_enc, category FROM directory WHERE phone_hash > $1 AND phone_hash <= $2',
      range,
    );
    const sugg = await c.query<Row & { at: Date }>(
      `SELECT phone_hash, phone_enc, name_enc, created_at AS at FROM name_suggestions
       WHERE phone_hash > $1 AND phone_hash <= $2`,
      range,
    );
    const optOuts = await c.query<{ phone_hash: Buffer }>(
      'SELECT phone_hash FROM opt_outs WHERE phone_hash > $1 AND phone_hash <= $2',
      range,
    );
    const entries = await c.query<{ id: number; phone_hash: Buffer; scope: string | null; fp: Buffer | null; deleted: boolean }>(
      `SELECT id, phone_hash, scope, fp, deleted FROM pack_entries
       WHERE salt_id = $3 AND phone_hash > $1 AND phone_hash <= $2`,
      [lo, hi, saltId],
    );
    return { contacts: contacts.rows, dir: dir.rows, sugg: sugg.rows, optOuts: optOuts.rows, entries: entries.rows };
  } finally {
    await c.query('COMMIT').catch(() => {});
  }
}

/** Facts per number for one batch. `users` are the batch's members (hash hex -> phone, names). */
function batchFacts(
  data: Awaited<ReturnType<typeof readBatch>>,
  users: Map<string, { phone: string; hash: Buffer; members: Map<string, string> }>,
): Map<string, Facts> {
  const v = vault();
  const pv = packVault()!;
  const facts = new Map<string, Facts>();
  const add = (hex: string, hash: Buffer, phone: string, members = new Map<string, string>()) =>
    facts.set(hex, { phone, hash, open: [], familyOnly: new Map(), dir: null, suggested: [], members });
  for (const [hex, u] of users) add(hex, u.hash, u.phone, u.members);
  // A number is known from any row that carries it: a member's phone, or any phone_enc. Rows of
  // a number nobody re-uploaded with phone_enc stay out.
  for (const r of [...data.contacts, ...data.dir, ...data.sugg]) {
    const hex = r.phone_hash.toString('hex');
    if (facts.has(hex) || !r.phone_enc) continue;
    const phone = pv.openPhone(r.phone_enc);
    if (phone && v.index(phone).equals(r.phone_hash)) add(hex, r.phone_hash, phone);
  }
  const opened = (r: Row) => {
    const f = facts.get(r.phone_hash.toString('hex'));
    const name = f ? v.open(f.phone, r.name_enc) : null;
    return f && name !== null ? { f, name } : null;
  };
  // Shared and suggested names get the same cleaning as a live lookup (src/names.ts).
  const cleaned = (r: Row) => {
    const o = opened(r);
    const name = o ? cleanName(o.name) : null;
    return o && name !== null ? { f: o.f, name } : null;
  };
  for (const r of data.contacts) {
    const o = cleaned(r);
    if (!o) continue;
    if (!r.family_only) o.f.open.push({ name: o.name, at: r.at });
    else {
      const list = o.f.familyOnly.get(r.family_id) ?? [];
      list.push({ name: o.name, at: r.at });
      o.f.familyOnly.set(r.family_id, list);
    }
  }
  for (const r of data.dir) {
    const o = opened(r);
    if (o) o.f.dir = { name: o.name, category: r.category };
  }
  for (const r of data.sugg) {
    const o = cleaned(r);
    if (o) o.f.suggested.push({ name: o.name, at: r.at });
  }
  return facts;
}

/** Argon2 outputs for these numbers under `meta`'s salt: from the cache, else computed and cached. */
async function phoneKeys(
  c: pg.PoolClient,
  meta: PackMeta,
  phones: Map<string, { hash: Buffer; phone: string }>,
  workers: number | undefined,
): Promise<{ keys: Map<string, Buffer>; hashed: number }> {
  const pv = packVault()!;
  const keys = new Map<string, Buffer>();
  const { rows } = await c.query<{ phone_hash: Buffer; key_enc: Buffer }>(
    'SELECT phone_hash, key_enc FROM pack_phone_keys WHERE salt_id = $1 AND phone_hash = ANY($2::bytea[])',
    [meta.saltId, [...phones.values()].map((x) => x.hash)],
  );
  for (const r of rows) {
    const h = pv.openKey(r.phone_hash, r.key_enc);
    if (h) keys.set(r.phone_hash.toString('hex'), h);
  }
  const missing = [...phones].filter(([hex]) => !keys.has(hex)).map(([, x]) => x);
  if (missing.length) {
    const hs = await argon2Many(missing.map((x) => x.phone), meta, workers);
    missing.forEach((x, j) => keys.set(x.hash.toString('hex'), hs[j]));
    await c.query(
      `INSERT INTO pack_phone_keys (salt_id, phone_hash, key_enc)
       SELECT $1, h, k FROM unnest($2::bytea[], $3::bytea[]) AS t(h, k)
       ON CONFLICT (salt_id, phone_hash) DO UPDATE SET key_enc = EXCLUDED.key_enc`,
      [meta.saltId, missing.map((x) => x.hash), missing.map((x, j) => pv.sealKey(x.hash, hs[j]))],
    );
  }
  return { keys, hashed: missing.length };
}

/**
 * Brings generation `meta`'s entries in line with the current data, BATCH numbers at a time
 * (in phone_hash order): new or changed answers get a fresh blob and seq, vanished ones a
 * tombstone. The caller holds the generation's lock. Each batch commits on its own; with one
 * writer per generation, seqs still become visible in order.
 */
async function build(c: pg.PoolClient, meta: PackMeta, opts: BuildOpts) {
  const batch = opts.batch ?? BATCH;
  const pv = packVault()!;
  await checkPhoneEnc(c);

  const users = new Map<string, { phone: string; hash: Buffer; members: Map<string, string> }>();
  for (const u of (await c.query<{ phone: string; name: string; family_id: string }>('SELECT phone, name, family_id FROM users')).rows) {
    const hash = vault().index(u.phone);
    const hex = hash.toString('hex');
    const x = users.get(hex) ?? { phone: u.phone, hash, members: new Map() };
    x.members.set(u.family_id, u.name);
    users.set(hex, x);
  }
  const userHashes = [...users.values()].map((u) => u.hash).sort(Buffer.compare);

  const totals = { entries: 0, upserted: 0, deleted: 0, hashed: 0 };
  let lo: Buffer = Buffer.alloc(0);
  for (;;) {
    // The next BATCH numbers after `lo` from every source (each subquery walks an index).
    const { rows: next } = await c.query<{ h: Buffer }>(
      `SELECT h FROM (
         (SELECT phone_hash AS h FROM contacts WHERE phone_hash > $1 ORDER BY 1 LIMIT $2)
         UNION (SELECT phone_hash FROM directory WHERE phone_hash > $1 ORDER BY 1 LIMIT $2)
         UNION (SELECT phone_hash FROM name_suggestions WHERE phone_hash > $1 ORDER BY 1 LIMIT $2)
         UNION (SELECT phone_hash FROM pack_entries WHERE salt_id = $3 AND phone_hash > $1 ORDER BY 1 LIMIT $2)
       ) u ORDER BY h LIMIT $2`,
      [lo, batch, meta.saltId],
    );
    const candidates = [...next.map((r) => r.h), ...userHashes.filter((h) => Buffer.compare(h, lo) > 0).slice(0, batch)]
      .sort(Buffer.compare)
      .slice(0, batch);
    if (!candidates.length) break;
    const hi = candidates[candidates.length - 1];

    const data = await readBatch(c, meta.saltId, lo, hi);
    const inRange = (h: Buffer) => Buffer.compare(h, lo) > 0 && Buffer.compare(h, hi) <= 0;
    const facts = batchFacts(data, new Map([...users].filter(([, u]) => inRange(u.hash))));
    const optedOut = new Set(data.optOuts.map((r) => r.phone_hash.toString('hex')));

    const key = (hash: Buffer, scope: string | null) => `${hash.toString('hex')}|${scope ?? ''}`;
    const existing = new Map(data.entries.map((e) => [key(e.phone_hash, e.scope), e]));
    const wanted = new Set<string>();
    const changed: (Desired & { fp: Buffer })[] = [];
    for (const [hex, f] of facts) {
      for (const d of desiredFor(f, optedOut.has(hex))) {
        const k = key(d.hash, d.scope);
        wanted.add(k);
        const fp = pv.fp(d.plaintext);
        const e = existing.get(k);
        if (!e || e.deleted || !e.fp?.equals(fp)) changed.push({ ...d, fp });
      }
    }
    const gone = data.entries.filter((e) => !e.deleted && !wanted.has(key(e.phone_hash, e.scope))).map((e) => e.id);

    const phones = new Map(changed.map((d) => [d.hash.toString('hex'), { hash: d.hash, phone: d.phone }]));
    const { keys, hashed } = await phoneKeys(c, meta, phones, opts.workers);

    await c.query('BEGIN');
    try {
      if (changed.length) {
        const sealed = changed.map((d) => {
          const { tag, key: k } = entryKeys(keys.get(d.hash.toString('hex'))!);
          return { tag, blob: sealEntry(k, tag, d.plaintext) };
        });
        await c.query(
          `INSERT INTO pack_entries (salt_id, phone_hash, scope, tag, blob, fp)
           SELECT $6, h, s, t, b, f FROM unnest($1::bytea[], $2::uuid[], $3::bytea[], $4::bytea[], $5::bytea[]) AS x(h, s, t, b, f)
           WHERE s IS NULL OR EXISTS (SELECT 1 FROM families WHERE id = s)
           ON CONFLICT ON CONSTRAINT pack_entries_key DO UPDATE SET tag = EXCLUDED.tag, blob = EXCLUDED.blob,
             fp = EXCLUDED.fp, deleted = false, seq = nextval('pack_seq'), updated_at = now()`,
          [
            changed.map((d) => d.hash),
            changed.map((d) => d.scope),
            sealed.map((s) => s.tag),
            sealed.map((s) => s.blob),
            changed.map((d) => d.fp),
            meta.saltId,
          ],
        );
      }
      if (gone.length) {
        await c.query(
          `UPDATE pack_entries SET deleted = true, tag = NULL, blob = NULL, fp = NULL,
             seq = nextval('pack_seq'), updated_at = now() WHERE id = ANY($1::bigint[])`,
          [gone],
        );
      }
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    }
    totals.entries += wanted.size;
    totals.upserted += changed.length;
    totals.deleted += gone.length;
    totals.hashed += hashed;
    lo = hi;
  }
  return totals;
}

/** Deletes old tombstones (raising purge_seq) and cached hashes no entry needs. */
async function purge(c: pg.PoolClient, meta: PackMeta): Promise<number> {
  await c.query('BEGIN');
  try {
    const p = await c.query<{ seq: number }>(
      `DELETE FROM pack_entries WHERE salt_id = $1 AND deleted AND updated_at < now() - make_interval(days => $2) RETURNING seq`,
      [meta.saltId, PURGE_DAYS],
    );
    const purged = p.rowCount ?? 0;
    if (purged) {
      await c.query('UPDATE pack_meta SET purge_seq = greatest(purge_seq, $2) WHERE salt_id = $1', [
        meta.saltId,
        p.rows.reduce((m, r) => Math.max(m, r.seq), 0),
      ]);
    }
    await c.query(
      `DELETE FROM pack_phone_keys k WHERE salt_id = $1
         AND NOT EXISTS (SELECT 1 FROM pack_entries e WHERE e.salt_id = k.salt_id AND e.phone_hash = k.phone_hash)`,
      [meta.saltId],
    );
    await c.query('COMMIT');
    return purged;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * Updates the serving generation. Only one runner at a time (advisory lock); returns null when
 * another one holds it or the pack is off (no PACK_KEY). Throws PackKeyMismatch when PACK_KEY
 * changed, and refuses (throws, writes nothing) when many sealed numbers don't open.
 */
export async function reconcilePack(pool: pg.Pool, opts: BuildOpts = {}): Promise<ReconcileResult | null> {
  if (!packVault()) return null;
  const started = Date.now();
  const c = await pool.connect();
  try {
    const meta = await packMeta(c);
    const { rows: lock } = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [LOCK_ID, meta.saltId]);
    if (!lock[0].ok) return null;
    try {
      // A rotation may have swapped generations while we waited.
      if ((await servingMeta(c))?.saltId !== meta.saltId) return null;
      const t = await build(c, meta, opts);
      const purged = await purge(c, meta);
      return { saltId: meta.saltId, ...t, purged, ms: Date.now() - started };
    } finally {
      await c.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_ID, meta.saltId]).catch(() => {});
    }
  } finally {
    c.release();
  }
}

/**
 * Starts a new salt generation. It is built in full under its own salt while the old one keeps
 * serving, then swapped in with one transaction: the old generation's entries go, and purge_seq
 * tells every phone to refetch. Resumable: a rotation interrupted mid-build continues the same
 * pending generation.
 */
export async function rotatePack(pool: pg.Pool, opts: BuildOpts = {}): Promise<ReconcileResult> {
  if (!packVault()) throw new Error('PACK_KEY is not set');
  const started = Date.now();
  const c = await pool.connect();
  try {
    const serving = await packMeta(c);
    let row = (
      await c.query<MetaRow>('SELECT * FROM pack_meta WHERE active_at IS NULL ORDER BY salt_id DESC LIMIT 1')
    ).rows[0];
    if (!row) {
      row = (
        await c.query<MetaRow>(
          `INSERT INTO pack_meta (salt_id, salt, t, m_kib, p, canary)
           SELECT coalesce(max(salt_id), 0) + 1, $1, $2, $3, $4, $5 FROM pack_meta RETURNING *`,
          newMetaValues(),
        )
      ).rows[0];
    }
    const next = toMeta(row);
    await c.query('SELECT pg_advisory_lock($1, $2)', [LOCK_ID, next.saltId]);
    try {
      const t = await build(c, next, opts);
      // Wait out any reconcile of the old generation, then swap.
      await c.query('SELECT pg_advisory_lock($1, $2)', [LOCK_ID, serving.saltId]);
      try {
        await c.query('BEGIN');
        await c.query(`UPDATE pack_meta SET active_at = now(), purge_seq = nextval('pack_seq') WHERE salt_id = $1`, [
          next.saltId,
        ]);
        // Older generations, their entries and cached hashes (ON DELETE CASCADE).
        await c.query('DELETE FROM pack_meta WHERE salt_id <> $1', [next.saltId]);
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        await c.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_ID, serving.saltId]).catch(() => {});
      }
      return { saltId: next.saltId, ...t, purged: 0, ms: Date.now() - started };
    } finally {
      await c.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_ID, next.saltId]).catch(() => {});
    }
  } finally {
    c.release();
  }
}
