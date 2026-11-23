import crypto from 'node:crypto';
import type pg from 'pg';
import { noStatementTimeout } from './db.js';
import { rankByCount } from './lookup.js';
import { cleanName } from './names.js';
import { vault } from './vault.js';
import {
  answerJson,
  appKeyCheck,
  appKeys,
  argon2Many,
  DEFAULT_PARAMS,
  entryKeys,
  entryKeysV2,
  h8Of,
  packVault,
  sealEntry,
  tag16Of,
  v2Password,
  type AppKey,
  type PackAnswer,
  type PackParams,
} from './pack.js';

/**
 * Builds the offline name pack: one encrypted entry per (generation, number, scope), kept in
 * pack_entries and handed out by GET /v1/pack (format 1) and the /v1/pack/* routes (format 2).
 * See docs/NAME_PACK.md and docs/NAME_PACK_V2.md (app repo) for the design.
 *
 * Generations (pack_meta rows): one serving format-1 generation, and with PACK_APP_KEYS one active
 * format-2 generation (keyed, in parts) plus at most one retiring one (deletes only). Every way in
 * holds the advisory lock of each generation it writes, so only one writer per generation:
 * - drainDirty: rebuilds only the numbers the database triggers queued in pack_dirty
 *   (migrations/021_pack_dirty.sql), for every live generation in one transaction per batch.
 *   The pack worker (src/pack-runner.ts) runs it.
 * - reconcilePack: the full walk over every number, as the nightly safety pass, after a directory
 *   import (pack_meta.full_requested_at) and from the pack CLI.
 * - syncFormat2: builds a format-2 generation under the current PACK_APP_KEYS key (first build,
 *   key rotation) in full, then swaps it in.
 */

/** Advisory lock class; the second key is the generation (salt_id) being written. */
const LOCK_ID = 737373;
/** Numbers per reconcile batch (read, diff and write), so memory stays flat. */
const BATCH = 5000;
/** Tombstones older than this are deleted; clients behind them must refetch everything. */
const PURGE_DAYS = 60;
/** More unreadable phone_enc rows than this share means a key or data problem: write nothing. */
const MAX_BAD_PHONE_ENC = 0.02;
/** About this many sealed numbers per table are checked (TABLESAMPLE), not every row. */
const CHECK_SAMPLE_ROWS = 2000;
/** Format 2: a replaced generation keeps being served (deletes only) this long. */
const RETIRE_DAYS = 14;
/** Format 2: raise part_bits when the average live global entries per part passes splitAvg (tests lower it). */
export const packTuning = { splitAvg: 3000 };
/** Format 2: bytes of one row in a full section besides its blob (kind, tag, blob length). */
export const ROW_OVERHEAD = 11;

/** PACK_KEY differs from the key the pack was built with. Fix .env; don't serve or rebuild. */
export class PackKeyMismatch extends Error {
  constructor() {
    super('PACK_KEY does not match the key the name pack was built with (pack_meta canary); refusing to use the pack');
  }
}

/**
 * A PACK_APP_KEYS key has a different value than the format-2 generation built under its id
 * (pack_meta.app_key_check). Nothing of format 2 is built or served until it is fixed.
 */
export class PackAppKeyMismatch extends Error {
  constructor(public readonly keyId: number) {
    super(
      `PACK_APP_KEYS key ${keyId} does not match the key the format-2 name pack was built with (pack_meta.app_key_check); ` +
        'refusing to build or serve format 2',
    );
  }
}

export interface PackMeta extends PackParams {
  saltId: number;
  purgeSeq: number;
  /** Live global entries as of the last build; null before the first one. */
  liveGlobal: number | null;
  /** 1 = GET /v1/pack, 2 = keyed and in parts. */
  format: 1 | 2;
  /** Format 2: the PACK_APP_KEYS id it is built under. */
  appKeyId: number | null;
  /** Format 2: that key when PACK_APP_KEYS holds it with the value it was built with. */
  appKey: AppKey | null;
  /** Format 2: 'missing' (id not in PACK_APP_KEYS) or 'mismatch' (another value) means not usable. */
  keyState: 'ok' | 'missing' | 'mismatch';
  partBits: number;
  active: boolean;
  /** Format 2: a replaced generation, served (deletes only) until then. */
  retireAfter: Date | null;
}

interface MetaRow {
  salt_id: number;
  salt: Buffer;
  t: number;
  m_kib: number;
  p: number;
  purge_seq: number;
  canary: Buffer;
  live_global: number | null;
  format: number;
  app_key_id: number | null;
  app_key_check: Buffer | null;
  part_bits: number;
  active_at: Date | null;
  retire_after: Date | null;
}

function toMeta(r: MetaRow): PackMeta {
  if (!packVault()!.checkCanary(r.canary)) throw new PackKeyMismatch();
  let appKey: AppKey | null = null;
  let keyState: PackMeta['keyState'] = 'ok';
  if (r.format === 2) {
    const k = appKeys().find((x) => x.id === r.app_key_id);
    if (!k) keyState = 'missing';
    else if (!r.app_key_check || !appKeyCheck(k.key).equals(r.app_key_check)) keyState = 'mismatch';
    else appKey = k;
  }
  return {
    saltId: r.salt_id,
    salt: r.salt,
    t: r.t,
    m: r.m_kib,
    p: r.p,
    purgeSeq: r.purge_seq,
    liveGlobal: r.live_global,
    format: r.format === 2 ? 2 : 1,
    appKeyId: r.app_key_id,
    appKey,
    keyState,
    partBits: r.part_bits,
    active: r.active_at !== null,
    retireAfter: r.retire_after,
  };
}

const newMetaValues = (params: Omit<PackParams, 'salt'> = DEFAULT_PARAMS) => [
  crypto.randomBytes(16),
  params.t,
  params.m,
  params.p,
  packVault()!.canary(),
];

/** The format-1 generation phones download with GET /v1/pack (read only). null before the first one exists. */
export async function servingMeta(db: pg.Pool | pg.PoolClient): Promise<PackMeta | null> {
  const { rows } = await db.query<MetaRow>(
    'SELECT * FROM pack_meta WHERE active_at IS NOT NULL AND format = 1 ORDER BY salt_id DESC LIMIT 1',
  );
  return rows[0] ? toMeta(rows[0]) : null;
}

/**
 * The serving format-1 generation, created (random salt, production cost) on first use.
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
  const made = await servingMeta(db);
  if (made) return made;
  // salt_id 1 is a format-2 generation's (syncFormat2 creates format 1 first, so only by hand).
  await db.query(
    `INSERT INTO pack_meta (salt_id, salt, t, m_kib, p, canary, active_at)
     SELECT coalesce(max(salt_id), 0) + 1, $1, $2, $3, $4, $5, now() FROM pack_meta`,
    newMetaValues(),
  );
  return (await servingMeta(db))!;
}

/**
 * The generations to write, under their locks: the serving format-1 one first (created when
 * missing), then the usable format-2 ones (active, then retiring). `stale`: active format-2
 * generations left out because PACK_APP_KEYS lacks their key or has another value for it.
 */
async function liveGenerations(db: pg.Pool | pg.PoolClient): Promise<{ gens: PackMeta[]; stale: number[] }> {
  const gens = [await packMeta(db)];
  const stale: number[] = [];
  const { rows } = await db.query<MetaRow>(
    `SELECT * FROM pack_meta WHERE format = 2 AND active_at IS NOT NULL
       AND (retire_after IS NULL OR retire_after > now()) ORDER BY retire_after NULLS FIRST, salt_id DESC`,
  );
  let active = false;
  for (const r of rows) {
    if (r.retire_after === null) {
      if (active) continue; // an older active row (never left behind by syncFormat2)
      active = true;
    }
    const m = toMeta(r);
    if (m.keyState === 'ok') gens.push(m);
    else if (r.retire_after === null) stale.push(r.salt_id);
  }
  return { gens, stale };
}

/** The salt ids drains write now (liveGenerations), ascending: a change means a swap happened. */
export async function liveGenerationIds(db: pg.Pool | pg.PoolClient): Promise<number[]> {
  return (await liveGenerations(db)).gens.map((g) => g.saltId).sort((a, b) => a - b);
}

/**
 * The format-2 generations GET /v1/pack/* serve: the active one and a retiring one, read only.
 * Throws PackKeyMismatch (PACK_KEY) or PackAppKeyMismatch (a PACK_APP_KEYS value changed).
 * `active` is null before the first format-2 build is done.
 */
export async function format2Serving(db: pg.Pool | pg.PoolClient): Promise<{ active: PackMeta | null; retiring: PackMeta | null }> {
  const { rows } = await db.query<MetaRow>(
    `SELECT * FROM pack_meta WHERE format = 2 AND active_at IS NOT NULL
       AND (retire_after IS NULL OR retire_after > now()) ORDER BY retire_after NULLS FIRST, salt_id DESC`,
  );
  let active: PackMeta | null = null;
  let retiring: PackMeta | null = null;
  for (const r of rows) {
    const m = toMeta(r);
    if (m.keyState === 'mismatch') throw new PackAppKeyMismatch(m.appKeyId!);
    if (m.keyState !== 'ok') continue;
    if (r.retire_after === null) active ??= m;
    else retiring ??= m;
  }
  return { active, retiring };
}

/**
 * The format-2 cursor a member's phone syncs to (the highest version of its parts: the global
 * ones and its family's), or null while format 2 is off, not built yet or not usable.
 */
export async function format2Cursor(db: pg.Pool | pg.PoolClient, family: string): Promise<number | null> {
  if (!appKeys().length || !packVault()) return null;
  let active: PackMeta | null;
  try {
    ({ active } = await format2Serving(db));
  } catch (err) {
    if (err instanceof PackKeyMismatch || err instanceof PackAppKeyMismatch) return null;
    throw err;
  }
  if (!active) return null;
  const { rows } = await db.query<{ v: number }>(
    'SELECT coalesce(max(version), 0) AS v FROM pack_parts WHERE salt_id = $1 AND (scope IS NULL OR scope = $2)',
    [active.saltId, family],
  );
  return rows[0].v;
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
  /** The same for each format-2 generation written, plus parts fixed by the digest check. */
  format2?: (Counts & { saltId: number; purged: number; drift: number; partBits: number })[];
}

/** One generation's share of a batch or pass. */
export interface Counts {
  entries: number;
  upserted: number;
  deleted: number;
  hashed: number;
  /** Format 2: entries skipped because another number has the same tag (logged). */
  collisions: number;
}

const zero = (): Counts => ({ entries: 0, upserted: 0, deleted: 0, hashed: 0, collisions: 0 });
const add = (a: Counts, b: Counts) => {
  a.entries += b.entries;
  a.upserted += b.upserted;
  a.deleted += b.deleted;
  a.hashed += b.hashed;
  a.collisions += b.collisions;
};

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
  /** The photo of the account on this number (users.photo_url), shown to every family. */
  photo: string | null;
}

interface Desired {
  hash: Buffer;
  scope: string | null;
  phone: string;
  plaintext: string;
}

const clip = (s: string) => s.slice(0, 100);

/** Same priority as buildLookups: member > contacts > directory > suggested. */
function names(f: Facts, family: string | null): PackAnswer | null {
  const contacts = family ? [...f.open, ...(f.familyOnly.get(family) ?? [])] : f.open;
  const k = contacts.length;
  const member = family ? f.members.get(family) : undefined;
  if (member !== undefined) return { n: clip(member), s: 'member', c: null, k, m: true };
  if (k) return { n: clip(rankByCount(contacts)[0].name), s: 'contacts', c: null, k, m: false };
  if (f.dir) return { n: clip(f.dir.name), s: 'directory', c: f.dir.category, k: 0, m: false };
  if (f.suggested.length) return { n: clip(rankByCount(f.suggested)[0].name), s: 'suggested', c: null, k: 0, m: false };
  return null;
}

/**
 * The answer one scope gets. Format 2 also carries the photo (`p`), like GET /v1/lookup's
 * photoUrl, and has an entry with a null name for a number that only has a photo.
 */
function answer(f: Facts, family: string | null, format: 1 | 2): PackAnswer | null {
  const a = names(f, family);
  if (format === 1 || !f.photo) return a;
  return a ? { ...a, p: f.photo } : { n: null, s: null, c: null, k: 0, m: false, p: f.photo };
}

/** The entries one number should have. */
function desiredFor(f: Facts, optedOut: boolean, format: 1 | 2): Desired[] {
  const out: Desired[] = [];
  const push = (scope: string | null) => {
    const a = answer(f, scope, format);
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
 * every one of them would turn into a tombstone. Checks a sample of about CHECK_SAMPLE_ROWS rows
 * per table (all of a small one), streamed; nothing is written. Runs before every full pass and
 * when the pack worker starts, not before each drain.
 */
export async function checkPhoneEnc(c: pg.PoolClient): Promise<void> {
  const v = vault();
  const pv = packVault()!;
  let total = 0;
  let bad = 0;
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    // Share of each table to read, from the planner's row estimate (-1 = never analyzed: all).
    const { rows: est } = await c.query<{ relname: string; n: number }>(
      `SELECT relname, reltuples::float8 AS n FROM pg_class
       WHERE relkind = 'r' AND relnamespace = current_schema()::regnamespace
         AND relname IN ('contacts', 'directory', 'name_suggestions')`,
    );
    const pct = (table: string) => {
      const n = est.find((r) => r.relname === table)?.n ?? -1;
      return n <= CHECK_SAMPLE_ROWS ? 100 : Math.max(0.001, (100 * CHECK_SAMPLE_ROWS) / n);
    };
    await c.query(`DECLARE pack_pe NO SCROLL CURSOR FOR
      SELECT phone_hash, phone_enc FROM contacts TABLESAMPLE SYSTEM (${pct('contacts')}) WHERE phone_enc IS NOT NULL
      UNION ALL SELECT phone_hash, phone_enc FROM directory TABLESAMPLE SYSTEM (${pct('directory')})
        WHERE phone_enc IS NOT NULL
      UNION ALL SELECT phone_hash, phone_enc FROM name_suggestions TABLESAMPLE SYSTEM (${pct('name_suggestions')})
        WHERE phone_enc IS NOT NULL`);
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

/** The members on some numbers: hash hex -> phone, name by family, and the account's photo. */
type Members = Map<string, { phone: string; hash: Buffer; members: Map<string, string>; photo: string | null }>;

type UserRowLite = { phone: string; name: string; family_id: string; photo_url: string | null };
const USERS_LITE = 'SELECT phone, name, family_id, photo_url FROM users';

function addMember(users: Members, u: UserRowLite) {
  const hash = vault().index(u.phone);
  const hex = hash.toString('hex');
  const x = users.get(hex) ?? { phone: u.phone, hash, members: new Map(), photo: null };
  x.members.set(u.family_id, u.name);
  x.photo ??= u.photo_url;
  users.set(hex, x);
}

/** The numbers one batch covers: a phone_hash range (lo, hi] (full build) or a set (drain). */
type Span = { lo: Buffer; hi: Buffer } | { hashes: Buffer[] };

/** A current entry, as a batch reads it. tag16, h8 and len are for the format-2 part upkeep. */
interface EntryRow {
  id: number;
  salt_id: number;
  phone_hash: Buffer;
  scope: string | null;
  fp: Buffer | null;
  deleted: boolean;
  tag16: number | null;
  h8: Buffer | null;
  len: number | null;
}

/**
 * One batch's source rows and current entries (of every generation in `saltIds`), read from one
 * snapshot. For a set, also the members on those numbers (a full build loads every member once
 * instead).
 */
async function readBatch(c: pg.PoolClient, saltIds: number[], span: Span) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const set = 'hashes' in span;
    const params: unknown[] = set ? [span.hashes] : [span.lo, span.hi];
    const where = (col: string) => (set ? `${col} = ANY($1::bytea[])` : `${col} > $1 AND ${col} <= $2`);
    const contacts = await c.query<Row & { at: Date; family_only: boolean; family_id: string }>(
      `SELECT c.phone_hash, c.phone_enc, c.name_enc, c.updated_at AS at, c.family_only, u.family_id
       FROM contacts c JOIN users u ON u.id = c.user_id WHERE ${where('c.phone_hash')}`,
      params,
    );
    const dir = await c.query<Row & { category: string | null }>(
      `SELECT phone_hash, phone_enc, name_enc, category FROM directory WHERE ${where('phone_hash')}`,
      params,
    );
    const sugg = await c.query<Row & { at: Date }>(
      `SELECT phone_hash, phone_enc, name_enc, created_at AS at FROM name_suggestions
       WHERE ${where('phone_hash')}`,
      params,
    );
    const optOuts = await c.query<{ phone_hash: Buffer }>(
      `SELECT phone_hash FROM opt_outs WHERE ${where('phone_hash')}`,
      params,
    );
    const entries = await c.query<EntryRow>(
      `SELECT id, salt_id, phone_hash, scope, fp, deleted, tag16, h8, octet_length(blob) AS len FROM pack_entries
       WHERE salt_id = ANY($${params.length + 1}::int[]) AND ${where('phone_hash')}`,
      [...params, saltIds],
    );
    const users: Members = new Map();
    if (set) {
      const { rows } = await c.query<UserRowLite>(`${USERS_LITE} WHERE phone_hash = ANY($1::bytea[])`, params);
      for (const u of rows) addMember(users, u);
    }
    return { contacts: contacts.rows, dir: dir.rows, sugg: sugg.rows, optOuts: optOuts.rows, entries: entries.rows, users };
  } finally {
    await c.query('COMMIT').catch(() => {});
  }
}

/** Facts per number for one batch. `users` are the batch's members (hash hex -> phone, names). */
function batchFacts(data: Awaited<ReturnType<typeof readBatch>>, users: Members): Map<string, Facts> {
  const v = vault();
  const pv = packVault()!;
  const facts = new Map<string, Facts>();
  const add = (hex: string, hash: Buffer, phone: string, members = new Map<string, string>(), photo: string | null = null) =>
    facts.set(hex, { phone, hash, open: [], familyOnly: new Map(), dir: null, suggested: [], members, photo });
  for (const [hex, u] of users) add(hex, u.hash, u.phone, u.members, u.photo);
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
    // Format 2 hashes the number keyed with the pack key, so the result needs that key too.
    const pw = (phone: string) => (meta.format === 2 ? v2Password(meta.appKey!.key, phone) : phone);
    const hs = await argon2Many(missing.map((x) => pw(x.phone)), meta, workers);
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

/** What one batch changes in one generation, worked out before its transaction. */
interface Plan {
  meta: PackMeta;
  /** New or changed answers, sealed (tag and blob). */
  changed: (Desired & { fp: Buffer; tag: Buffer; blob: Buffer })[];
  /** Live entries the data no longer wants: they become tombstones. */
  gone: EntryRow[];
  existing: Map<string, EntryRow>;
  liveDelta: number;
  counts: Counts;
}

const entryKey = (hash: Buffer, scope: string | null) => `${hash.toString('hex')}|${scope ?? ''}`;

/**
 * One generation's changes for a batch: the fp diff against its current entries, then Argon2
 * (cached) and sealing for the changed answers. A retiring format-2 generation only loses
 * entries. Format 2 skips an answer whose tag another number already holds in the same scope.
 */
async function planGen(
  c: pg.PoolClient,
  meta: PackMeta,
  facts: Map<string, Facts>,
  optedOut: Set<string>,
  entries: EntryRow[],
  workers: number | undefined,
): Promise<Plan> {
  const pv = packVault()!;
  const mine = entries.filter((e) => e.salt_id === meta.saltId);
  const existing = new Map(mine.map((e) => [entryKey(e.phone_hash, e.scope), e]));
  const wanted = new Set<string>();
  let wants: (Desired & { fp: Buffer })[] = [];
  for (const [hex, f] of facts) {
    for (const d of desiredFor(f, optedOut.has(hex), meta.format)) {
      const k = entryKey(d.hash, d.scope);
      wanted.add(k);
      const fp = pv.fp(d.plaintext);
      const e = existing.get(k);
      if (!e || e.deleted || !e.fp?.equals(fp)) wants.push({ ...d, fp });
    }
  }
  const gone = mine.filter((e) => !e.deleted && !wanted.has(entryKey(e.phone_hash, e.scope)));
  // A retiring generation gets removals only, no new names.
  if (meta.retireAfter) wants = [];

  const phones = new Map(wants.map((d) => [d.hash.toString('hex'), { hash: d.hash, phone: d.phone }]));
  const { keys, hashed } = phones.size
    ? await phoneKeys(c, meta, phones, workers)
    : { keys: new Map<string, Buffer>(), hashed: 0 };
  let changed = wants.map((d) => {
    const h = keys.get(d.hash.toString('hex'))!;
    const { tag, key: k } = meta.format === 2 ? entryKeysV2(h) : entryKeys(h);
    return { ...d, tag, blob: sealEntry(k, tag, d.plaintext) };
  });

  let collisions = 0;
  if (meta.format === 2 && changed.length) {
    // Two numbers with one 8-byte tag (about 1e-7 at 2M entries): the phone keeps one row per
    // (tag, scope), so the later number is left out of this generation (and logged).
    const { rows } = await c.query<{ phone_hash: Buffer; scope: string | null; tag: Buffer }>(
      `SELECT phone_hash, scope, tag FROM pack_entries
       WHERE salt_id = $1 AND tag = ANY($2::bytea[]) AND tag16 IS NOT NULL AND NOT deleted`,
      [meta.saltId, changed.map((d) => d.tag)],
    );
    const owner = new Map(rows.map((r) => [`${r.tag.toString('hex')}|${r.scope ?? ''}`, r.phone_hash.toString('hex')]));
    changed = changed.filter((d) => {
      const k = `${d.tag.toString('hex')}|${d.scope ?? ''}`;
      const me = d.hash.toString('hex');
      const o = owner.get(k);
      if (o !== undefined && o !== me) {
        collisions++;
        return false;
      }
      owner.set(k, me);
      return true;
    });
  }

  const liveDelta =
    changed.filter((d) => {
      const e = existing.get(entryKey(d.hash, d.scope));
      return d.scope === null && (!e || e.deleted);
    }).length - gone.filter((e) => e.scope === null).length;
  return {
    meta,
    changed,
    gone,
    existing,
    liveDelta,
    counts: { entries: wanted.size, upserted: changed.length, deleted: gone.length, hashed, collisions },
  };
}

/** A format-2 part's change from one batch. digest: XOR of h8s, as a 64-bit integer. */
interface PartDelta {
  scope: string | null;
  part: number;
  version: number;
  live: number;
  bytes: number;
  digest: bigint;
  removal: number;
}

/** The format-2 part of an entry: the family's part 0, or the global part its tag16 falls in. */
export const partOf = (scope: string | null, tag16: number, partBits: number) => (scope ? 0 : tag16 >> (16 - partBits));

/**
 * Writes one generation's plan (inside the caller's transaction). Format 2 also brings each
 * touched part in pack_parts along: digest ^= old h8 ^ new h8, live and bytes, version and
 * removal (the highest seq of any row, and of a delete).
 */
async function writeGen(c: pg.PoolClient, p: Plan) {
  const { meta } = p;
  const v2 = meta.format === 2;
  const parts = new Map<string, PartDelta>();
  const touch = (scope: string | null, tag16: number) => {
    const part = partOf(scope, tag16, meta.partBits);
    const k = `${scope ?? ''}|${part}`;
    let d = parts.get(k);
    if (!d) parts.set(k, (d = { scope, part, version: 0, live: 0, bytes: 0, digest: 0n, removal: 0 }));
    return d;
  };
  const less = (old: EntryRow | undefined) => {
    if (!old || old.deleted || old.tag16 === null || !old.h8) return;
    const d = touch(old.scope, old.tag16);
    d.live--;
    d.bytes -= ROW_OVERHEAD + (old.len ?? 0);
    d.digest ^= old.h8.readBigUInt64BE(0);
  };

  if (p.changed.length) {
    const { rows } = await c.query<{
      phone_hash: Buffer;
      scope: string | null;
      tag16: number | null;
      h8: Buffer | null;
      len: number;
      seq: number;
    }>(
      `INSERT INTO pack_entries (salt_id, phone_hash, scope, tag, blob, fp, tag16, h8)
       SELECT $6, h, s, t, b, f, t16, h8
       FROM unnest($1::bytea[], $2::uuid[], $3::bytea[], $4::bytea[], $5::bytea[], $7::int[], $8::bytea[]) AS x(h, s, t, b, f, t16, h8)
       WHERE s IS NULL OR EXISTS (SELECT 1 FROM families WHERE id = s)
       ON CONFLICT ON CONSTRAINT pack_entries_key DO UPDATE SET tag = EXCLUDED.tag, blob = EXCLUDED.blob,
         fp = EXCLUDED.fp, tag16 = EXCLUDED.tag16, h8 = EXCLUDED.h8, deleted = false, seq = nextval('pack_seq'), updated_at = now()
       RETURNING phone_hash, scope, tag16, h8, octet_length(blob) AS len, seq`,
      [
        p.changed.map((d) => d.hash),
        p.changed.map((d) => d.scope),
        p.changed.map((d) => d.tag),
        p.changed.map((d) => d.blob),
        p.changed.map((d) => d.fp),
        meta.saltId,
        p.changed.map((d) => (v2 ? tag16Of(d.tag) : null)),
        p.changed.map((d) => (v2 ? h8Of(d.tag, d.blob) : null)),
      ],
    );
    if (v2) {
      for (const r of rows) {
        less(p.existing.get(entryKey(r.phone_hash, r.scope)));
        const d = touch(r.scope, r.tag16!);
        d.live++;
        d.bytes += ROW_OVERHEAD + r.len;
        d.digest ^= r.h8!.readBigUInt64BE(0);
        d.version = Math.max(d.version, r.seq);
      }
    }
  }
  if (p.gone.length) {
    // Tombstones keep their tag (and tag16), so a format-2 delete can be filed under its part.
    const { rows } = await c.query<{ id: number; seq: number }>(
      `UPDATE pack_entries SET deleted = true, blob = NULL, fp = NULL, h8 = NULL,
         seq = nextval('pack_seq'), updated_at = now() WHERE id = ANY($1::bigint[]) RETURNING id, seq`,
      [p.gone.map((e) => e.id)],
    );
    if (v2) {
      const byId = new Map(p.gone.map((e) => [e.id, e]));
      for (const r of rows) {
        const old = byId.get(r.id)!;
        less(old);
        const d = touch(old.scope, old.tag16!);
        d.version = Math.max(d.version, r.seq);
        d.removal = Math.max(d.removal, r.seq);
      }
    }
  }
  if (p.liveDelta) {
    await c.query('UPDATE pack_meta SET live_global = live_global + $2 WHERE salt_id = $1 AND live_global IS NOT NULL', [
      meta.saltId,
      p.liveDelta,
    ]);
  }
  if (parts.size) {
    const ds = [...parts.values()];
    await c.query(
      `INSERT INTO pack_parts AS p (salt_id, scope, part, version, live, bytes, digest, removal)
       SELECT $1, s, pt, v, l, b, int8send(d), r
       FROM unnest($2::uuid[], $3::int[], $4::bigint[], $5::int[], $6::bigint[], $7::bigint[], $8::bigint[]) AS x(s, pt, v, l, b, d, r)
       WHERE s IS NULL OR EXISTS (SELECT 1 FROM families WHERE id = s)
       ON CONFLICT ON CONSTRAINT pack_parts_key DO UPDATE SET
         version = greatest(p.version, EXCLUDED.version),
         live = p.live + EXCLUDED.live,
         bytes = p.bytes + EXCLUDED.bytes,
         digest = int8send(('x' || encode(p.digest, 'hex'))::bit(64)::bigint # ('x' || encode(EXCLUDED.digest, 'hex'))::bit(64)::bigint),
         removal = greatest(p.removal, EXCLUDED.removal)`,
      [
        meta.saltId,
        ds.map((d) => d.scope),
        ds.map((d) => d.part),
        ds.map((d) => d.version),
        ds.map((d) => d.live),
        ds.map((d) => d.bytes),
        ds.map((d) => BigInt.asIntN(64, d.digest).toString()),
        ds.map((d) => d.removal),
      ],
    );
  }
}

/**
 * Brings one batch's entries in line with its source rows, for every generation in `gens`: new
 * or changed answers get a fresh blob and seq, vanished ones a tombstone, all in one transaction
 * (with `alsoInTx`, the drain's queue delete). Keeps pack_meta.live_global current for a drain; a
 * full build recounts it at the end. Counts per generation, in `gens` order.
 */
async function reconcileBatch(
  c: pg.PoolClient,
  gens: PackMeta[],
  data: Awaited<ReturnType<typeof readBatch>>,
  users: Members,
  workers: number | undefined,
  alsoInTx?: () => Promise<unknown>,
): Promise<Counts[]> {
  const facts = batchFacts(data, users);
  const optedOut = new Set(data.optOuts.map((r) => r.phone_hash.toString('hex')));
  const plans: Plan[] = [];
  for (const meta of gens) plans.push(await planGen(c, meta, facts, optedOut, data.entries, workers));

  await c.query('BEGIN');
  try {
    for (const p of plans) await writeGen(c, p);
    if (alsoInTx) await alsoInTx();
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  }
  return plans.map((p) => p.counts);
}

/**
 * Brings the entries of generations `gens` in line with the current data, BATCH numbers at a
 * time (in phone_hash order): new or changed answers get a fresh blob and seq, vanished ones a
 * tombstone. The caller holds each generation's lock. Each batch commits on its own; with one
 * writer per generation, seqs still become visible in order. `between` runs after each batch.
 */
async function build(
  c: pg.PoolClient,
  gens: PackMeta[],
  opts: BuildOpts & { between?: () => Promise<unknown> },
): Promise<Counts[]> {
  const batch = opts.batch ?? BATCH;
  await checkPhoneEnc(c);

  const users: Members = new Map();
  for (const u of (await c.query<UserRowLite>(USERS_LITE)).rows) {
    addMember(users, u);
  }
  const userHashes = [...users.values()].map((u) => u.hash).sort(Buffer.compare);
  const ids = gens.map((g) => g.saltId);
  // One index walk per generation (salt ids are integers from pack_meta).
  const entrySources = ids
    .map((id) => `UNION (SELECT phone_hash FROM pack_entries WHERE salt_id = ${Number(id)} AND phone_hash > $1 ORDER BY 1 LIMIT $2)`)
    .join('\n         ');

  const totals = gens.map(zero);
  let lo: Buffer = Buffer.alloc(0);
  for (;;) {
    // The next BATCH numbers after `lo` from every source (each subquery walks an index).
    const { rows: next } = await c.query<{ h: Buffer }>(
      `SELECT h FROM (
         (SELECT phone_hash AS h FROM contacts WHERE phone_hash > $1 ORDER BY 1 LIMIT $2)
         UNION (SELECT phone_hash FROM directory WHERE phone_hash > $1 ORDER BY 1 LIMIT $2)
         UNION (SELECT phone_hash FROM name_suggestions WHERE phone_hash > $1 ORDER BY 1 LIMIT $2)
         ${entrySources}
       ) u ORDER BY h LIMIT $2`,
      [lo, batch],
    );
    const candidates = [...next.map((r) => r.h), ...userHashes.filter((h) => Buffer.compare(h, lo) > 0).slice(0, batch)]
      .sort(Buffer.compare)
      .slice(0, batch);
    if (!candidates.length) break;
    const hi = candidates[candidates.length - 1];

    const data = await readBatch(c, ids, { lo, hi });
    const inRange = (h: Buffer) => Buffer.compare(h, lo) > 0 && Buffer.compare(h, hi) <= 0;
    const t = await reconcileBatch(c, gens, data, new Map([...users].filter(([, u]) => inRange(u.hash))), opts.workers);
    t.forEach((x, i) => add(totals[i], x));
    lo = hi;
    if (opts.between) await opts.between();
  }
  // The global part of GET /v1/pack's quota, counted here once instead of on every download
  // (and, for format 2, the split rule's input).
  await c.query(
    `UPDATE pack_meta m SET live_global =
       (SELECT count(*) FROM pack_entries e WHERE e.salt_id = m.salt_id AND e.scope IS NULL AND NOT e.deleted)
     WHERE m.salt_id = ANY($1::int[])`,
    [ids],
  );
  return totals;
}

/**
 * Deletes old tombstones (raising purge_seq, and for format 2 the floor of each part they were
 * in) and cached hashes no entry needs.
 */
async function purge(c: pg.PoolClient, meta: PackMeta): Promise<number> {
  await c.query('BEGIN');
  try {
    const p = await c.query<{ seq: number; scope: string | null; tag16: number | null }>(
      `DELETE FROM pack_entries WHERE salt_id = $1 AND deleted AND updated_at < now() - make_interval(days => $2)
       RETURNING seq, scope, tag16`,
      [meta.saltId, PURGE_DAYS],
    );
    const purged = p.rowCount ?? 0;
    if (purged) {
      await c.query('UPDATE pack_meta SET purge_seq = greatest(purge_seq, $2) WHERE salt_id = $1', [
        meta.saltId,
        p.rows.reduce((m, r) => Math.max(m, r.seq), 0),
      ]);
    }
    if (purged && meta.format === 2) {
      // A delta can't start below a purged delete any more: phones behind it refetch that part.
      const floors = new Map<string, { scope: string | null; part: number; floor: number }>();
      for (const r of p.rows) {
        const part = partOf(r.scope, r.tag16 ?? 0, meta.partBits);
        const k = `${r.scope ?? ''}|${part}`;
        const f = floors.get(k) ?? { scope: r.scope, part, floor: 0 };
        f.floor = Math.max(f.floor, r.seq);
        floors.set(k, f);
      }
      const fs = [...floors.values()];
      await c.query(
        `INSERT INTO pack_parts AS p (salt_id, scope, part, version, floor)
         SELECT $1, s, pt, f, f FROM unnest($2::uuid[], $3::int[], $4::bigint[]) AS x(s, pt, f)
         WHERE s IS NULL OR EXISTS (SELECT 1 FROM families WHERE id = s)
         ON CONFLICT ON CONSTRAINT pack_parts_key DO UPDATE SET
           floor = greatest(p.floor, EXCLUDED.floor), version = greatest(p.version, EXCLUDED.floor)`,
        [meta.saltId, fs.map((f) => f.scope), fs.map((f) => f.part), fs.map((f) => f.floor)],
      );
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

interface PartRow {
  scope: string | null;
  part: number;
  version: number;
  floor: number;
  live: number;
  bytes: number;
  digest: Buffer;
  removal: number;
}

/**
 * Recomputes a format-2 generation's pack_parts from its entries and rewrites them when anything
 * differs. With `bits` above the generation's part_bits it splits every global part (each child
 * keeps its parent's floor) and stores the new part_bits. Returns how many parts had drifted
 * (always 0 for a split). The caller holds the generation's lock.
 */
async function recomputeParts(c: pg.PoolClient, meta: PackMeta, bits = meta.partBits): Promise<number> {
  await c.query('BEGIN');
  try {
    const { rows: agg } = await c.query<{
      scope: string | null;
      part: number;
      maxseq: number;
      removal: number;
      live: number;
      bytes: number;
      d: string;
    }>(
      `SELECT scope, CASE WHEN scope IS NULL THEN tag16 >> (16 - $2) ELSE 0 END AS part,
         max(seq) AS maxseq, coalesce(max(seq) FILTER (WHERE deleted), 0) AS removal,
         count(*) FILTER (WHERE NOT deleted)::int AS live,
         coalesce(sum(${ROW_OVERHEAD} + octet_length(blob)) FILTER (WHERE NOT deleted), 0)::bigint AS bytes,
         coalesce(bit_xor(('x' || encode(h8, 'hex'))::bit(64)::bigint) FILTER (WHERE NOT deleted), 0)::text AS d
       FROM pack_entries WHERE salt_id = $1 AND tag16 IS NOT NULL GROUP BY 1, 2`,
      [meta.saltId, bits],
    );
    const { rows: stored } = await c.query<PartRow>(
      'SELECT scope, part, version, floor, live, bytes, digest, removal FROM pack_parts WHERE salt_id = $1',
      [meta.saltId],
    );
    const shift = bits - meta.partBits;
    const key = (scope: string | null, part: number) => `${scope ?? ''}|${part}`;
    const want = new Map<string, PartRow>();
    for (const s of stored) {
      const kids = s.scope ? [0] : Array.from({ length: 1 << shift }, (_, i) => (s.part << shift) + i);
      for (const part of kids) {
        want.set(key(s.scope, part), {
          scope: s.scope,
          part,
          version: s.floor,
          floor: s.floor,
          live: 0,
          bytes: 0,
          digest: Buffer.alloc(8),
          removal: shift ? 0 : s.removal,
        });
      }
    }
    for (const a of agg) {
      const k = key(a.scope, a.part);
      const w = want.get(k) ?? { scope: a.scope, part: a.part, version: 0, floor: 0, live: 0, bytes: 0, digest: Buffer.alloc(8), removal: 0 };
      w.version = Math.max(w.floor, a.maxseq);
      w.live = a.live;
      w.bytes = a.bytes;
      w.digest = Buffer.alloc(8);
      w.digest.writeBigInt64BE(BigInt(a.d));
      w.removal = Math.max(w.removal, a.removal);
      want.set(k, w);
    }
    let drift = 0;
    if (!shift) {
      const have = new Map(stored.map((s) => [key(s.scope, s.part), s]));
      for (const [k, w] of want) {
        const s = have.get(k);
        if (!s || s.version !== w.version || s.live !== w.live || s.bytes !== w.bytes || !s.digest.equals(w.digest)) drift++;
      }
    }
    if (drift || shift) {
      const ws = [...want.values()];
      await c.query('DELETE FROM pack_parts WHERE salt_id = $1', [meta.saltId]);
      await c.query(
        `INSERT INTO pack_parts (salt_id, scope, part, version, floor, live, bytes, digest, removal)
         SELECT $1, s, pt, v, f, l, b, d, r
         FROM unnest($2::uuid[], $3::int[], $4::bigint[], $5::bigint[], $6::int[], $7::bigint[], $8::bytea[], $9::bigint[])
           AS x(s, pt, v, f, l, b, d, r)
         WHERE s IS NULL OR EXISTS (SELECT 1 FROM families WHERE id = s)`,
        [
          meta.saltId,
          ws.map((w) => w.scope),
          ws.map((w) => w.part),
          ws.map((w) => w.version),
          ws.map((w) => w.floor),
          ws.map((w) => w.live),
          ws.map((w) => w.bytes),
          ws.map((w) => w.digest),
          ws.map((w) => w.removal),
        ],
      );
      if (shift) await c.query('UPDATE pack_meta SET part_bits = $2 WHERE salt_id = $1', [meta.saltId, bits]);
    }
    await c.query('COMMIT');
    return drift;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * The split rule: while the average live global entries per part pass packTuning.splitAvg, part_bits goes
 * up by one (every part splits in two; it never shrinks). Returns the part_bits now in force.
 */
async function maybeSplit(c: pg.PoolClient, meta: PackMeta): Promise<number> {
  const { rows } = await c.query<{ live: number | null; bits: number }>(
    'SELECT live_global AS live, part_bits AS bits FROM pack_meta WHERE salt_id = $1',
    [meta.saltId],
  );
  const from = rows[0].bits;
  let bits = from;
  while (bits < 16 && (rows[0].live ?? 0) / 2 ** bits > packTuning.splitAvg) bits++;
  if (bits !== from) await recomputeParts(c, { ...meta, partBits: from }, bits);
  return bits;
}

/**
 * Runs `fn` holding the lock of every live generation (liveGenerations) on a dedicated client
 * without a statement timeout. null when the pack is off, another writer holds one of the locks,
 * or the generations changed (a rotation swapped them) while we waited. Throws PackKeyMismatch
 * when PACK_KEY changed.
 */
async function withGens<T>(
  pool: pg.Pool,
  fn: (c: pg.PoolClient, gens: PackMeta[], stale: number[]) => Promise<T>,
): Promise<T | null> {
  if (!packVault()) return null;
  const c = await pool.connect();
  try {
    // A build runs far longer than the pool's statement_timeout allows a request.
    return await noStatementTimeout(c, async () => {
      const { gens, stale } = await liveGenerations(c);
      const ids = gens.map((g) => g.saltId).sort((a, b) => a - b);
      const held: number[] = [];
      try {
        for (const id of ids) {
          const { rows: lock } = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [LOCK_ID, id]);
          if (!lock[0].ok) return null;
          held.push(id);
        }
        // A rotation may have swapped generations while we waited.
        const again = (await liveGenerations(c)).gens.map((g) => g.saltId).sort((a, b) => a - b);
        if (again.join() !== ids.join()) return null;
        return await fn(c, gens, stale);
      } finally {
        for (const id of held) await c.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_ID, id]).catch(() => {});
      }
    });
  } finally {
    c.release();
  }
}

/**
 * Updates every live generation in full (format 1, and the format-2 ones). Only one runner at a
 * time (advisory locks); returns null when another one holds them or the pack is off (no
 * PACK_KEY). Throws PackKeyMismatch when PACK_KEY changed, and refuses (throws, writes nothing)
 * when many sealed numbers don't open. The top-level counts are format 1's; a format-2
 * generation also gets its purge, the split rule and a digest check of every part (`format2`).
 */
export async function reconcilePack(pool: pg.Pool, opts: BuildOpts = {}): Promise<ReconcileResult | null> {
  const started = Date.now();
  return withGens(pool, async (c, gens) => {
    const batch = opts.batch ?? BATCH;
    const removed = gens.map(zero);
    const t = await build(c, gens, {
      ...opts,
      // An opt-out doesn't wait for the rest of a long pass (a directory import hashes for minutes).
      between: async () => {
        for (let r; (r = await drainStep(c, gens, batch, opts.workers, true)); ) r.counts.forEach((x, i) => add(removed[i], x));
      },
    });
    const out = gens.map((g, i) => ({
      saltId: g.saltId,
      ...t[i],
      upserted: t[i].upserted + removed[i].upserted,
      deleted: t[i].deleted + removed[i].deleted,
      hashed: t[i].hashed + removed[i].hashed,
      collisions: t[i].collisions + removed[i].collisions,
      purged: 0,
      drift: 0,
      partBits: g.partBits,
    }));
    for (const [i, g] of gens.entries()) {
      out[i].purged = await purge(c, g);
      if (g.format !== 2) continue;
      out[i].partBits = await maybeSplit(c, g);
      // A digest drift means a bug or a hand edit: logged by the caller, and fixed.
      out[i].drift = await recomputeParts(c, { ...g, partBits: out[i].partBits });
    }
    const [v1, ...format2] = out;
    const { collisions: _c, drift: _d, partBits: _p, ...first } = v1;
    return { ...first, ms: Date.now() - started, ...(format2.length ? { format2 } : {}) };
  });
}

/** Writes users.phone_hash where it is missing (rows from before 021, or written by older code). */
export async function backfillUserHashes(db: pg.Pool | pg.PoolClient): Promise<number> {
  const { rows } = await db.query<{ id: string; phone: string }>('SELECT id, phone FROM users WHERE phone_hash IS NULL');
  if (!rows.length) return 0;
  const v = vault();
  // The update fires the users trigger, which queues these numbers.
  await db.query(
    `UPDATE users u SET phone_hash = x.h FROM unnest($1::uuid[], $2::bytea[]) AS x(id, h)
     WHERE u.id = x.id AND u.phone_hash IS NULL`,
    [rows.map((r) => r.id), rows.map((r) => v.index(r.phone))],
  );
  return rows.length;
}

export interface DrainResult {
  /** The format-1 generation. */
  saltId: number;
  /** Queued numbers processed. */
  numbers: number;
  /** Entries written, summed over the generations (format 1 and 2). */
  upserted: number;
  deleted: number;
  hashed: number;
  /** Format-2 entries skipped for a tag another number holds. */
  collisions: number;
  ms: number;
}

export interface DrainOpts extends BuildOpts {
  /** Only priority-0 rows (removals); the rest stay queued. */
  removalsOnly?: boolean;
}

/**
 * Rebuilds the numbers queued in pack_dirty for every live generation, BATCH at a time,
 * removals (priority 0) first, each batch in one transaction for all of them together with the
 * delete of the queue rows it read. A number queued again meanwhile has a newer queued_at, so
 * its row stays for the next pass. null when the pack is off or another writer holds a lock.
 */
export async function drainDirty(pool: pg.Pool, opts: DrainOpts = {}): Promise<DrainResult | null> {
  const batch = opts.batch ?? BATCH;
  const started = Date.now();
  return withGens(pool, async (c, gens, stale) => {
    await backfillUserHashes(c);
    const totals = { numbers: 0, upserted: 0, deleted: 0, hashed: 0, collisions: 0 };
    for (;;) {
      const t = await drainStep(c, gens, batch, opts.workers, opts.removalsOnly === true);
      if (!t) break;
      totals.numbers += t.numbers;
      for (const x of t.counts) {
        totals.upserted += x.upserted;
        totals.deleted += x.deleted;
        totals.hashed += x.hashed;
        totals.collisions += x.collisions;
      }
    }
    // A format-2 generation left out (PACK_APP_KEYS lacks its key, or has another value for it)
    // missed these numbers: one full pass catches it up once it can be written again.
    if (totals.numbers && stale.length) {
      await c.query('UPDATE pack_meta SET full_requested_at = coalesce(full_requested_at, now()) WHERE salt_id = ANY($1::int[])', [
        stale,
      ]);
    }
    return { saltId: gens[0].saltId, ...totals, ms: Date.now() - started };
  });
}

/**
 * One drain batch of the live generations (the caller holds their locks): up to `batch` queued
 * numbers of the most urgent priority waiting (with `removalsOnly`, priority 0 only), oldest
 * first. null when there are none, or when none of them could be taken off the queue.
 */
async function drainStep(c: pg.PoolClient, gens: PackMeta[], batch: number, workers: number | undefined, removalsOnly: boolean) {
  // queued_at as text: a JS Date drops the microseconds, and the delete must compare the exact
  // value it read.
  const { rows } = await c.query<{ phone_hash: Buffer; q: string }>(
    `SELECT phone_hash, queued_at::text AS q FROM pack_dirty
     WHERE priority = (SELECT min(priority) FROM pack_dirty) AND ($2 = false OR priority = 0)
     ORDER BY queued_at LIMIT $1`,
    [batch, removalsOnly],
  );
  if (!rows.length) return null;
  const hashes = rows.map((r) => r.phone_hash);
  const data = await readBatch(
    c,
    gens.map((g) => g.saltId),
    { hashes },
  );
  let dequeued = 0;
  const counts = await reconcileBatch(c, gens, data, data.users, workers, async () => {
    const r = await c.query(
      // SKIP LOCKED: a row a writer is queuing again right now is left alone (its queued_at is
      // about to be newer anyway). Waiting for it here, with other queue rows already locked,
      // could deadlock with that writer.
      `DELETE FROM pack_dirty d USING (
         SELECT q.phone_hash FROM pack_dirty q JOIN unnest($1::bytea[], $2::timestamptz[]) AS s(h, q)
           ON q.phone_hash = s.h AND q.queued_at <= s.q
         FOR UPDATE OF q SKIP LOCKED
       ) x WHERE d.phone_hash = x.phone_hash`,
      [hashes, rows.map((r) => r.q)],
    );
    dequeued = r.rowCount ?? 0;
  });
  // Every row was held or queued again by a writer: stop here instead of rebuilding the same
  // numbers in a loop. That writer's commit notifies the worker, which takes them then.
  if (!dequeued) return null;
  return { numbers: rows.length, counts };
}

/**
 * The newest pack_meta.full_requested_at of the live generations (set by a directory TRUNCATE),
 * as exact text, or null. Clear it with clearFullRequest and the same value, after the full pass.
 */
export async function fullRequested(pool: pg.Pool): Promise<string | null> {
  const { gens } = await liveGenerations(pool);
  const { rows } = await pool.query<{ f: string | null }>(
    'SELECT max(full_requested_at)::text AS f FROM pack_meta WHERE salt_id = ANY($1::int[])',
    [gens.map((g) => g.saltId)],
  );
  return rows[0]?.f ?? null;
}

/** Clears the live generations' requests, unless a newer one arrived during the pass. */
export async function clearFullRequest(pool: pg.Pool, seen: string): Promise<void> {
  const { gens } = await liveGenerations(pool);
  await pool.query('UPDATE pack_meta SET full_requested_at = NULL WHERE salt_id = ANY($1::int[]) AND full_requested_at <= $2::timestamptz', [
    gens.map((g) => g.saltId),
    seen,
  ]);
}

/** Sampled checkPhoneEnc on its own (the pack worker's start-up check). */
export async function checkSealedNumbers(pool: pg.Pool): Promise<void> {
  if (!packVault()) return;
  const c = await pool.connect();
  try {
    await noStatementTimeout(c, () => checkPhoneEnc(c));
  } finally {
    c.release();
  }
}

/**
 * After an opt-out: takes the number out of the pack now. The triggers queued it at priority 0;
 * this drains the removals itself when the lock is free, else waits for the pack worker to,
 * up to `waitMs`. `deleted` counts the number's entries turned into tombstones meanwhile.
 */
export async function removeFromPack(pool: pg.Pool, phoneHash: Buffer, waitMs = 60_000) {
  const started = Date.now();
  const { rows: s } = await pool.query<{ v: number }>(
    'SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS v FROM pack_seq',
  );
  const queued = async () => ((await pool.query('SELECT 1 FROM pack_dirty WHERE phone_hash = $1', [phoneHash])).rowCount ?? 0) > 0;
  let done = false;
  for (;;) {
    await drainDirty(pool, { removalsOnly: true });
    if (!(await queued())) {
      done = true;
      break;
    }
    if (Date.now() - started >= waitMs) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM pack_entries WHERE phone_hash = $1 AND deleted AND seq > $2',
    [phoneHash, s[0].v],
  );
  return { queued: true, done, doneMs: Date.now() - started, deleted: rows[0].n };
}

/**
 * Starts a new format-1 salt generation. It is built in full under its own salt while the old
 * one keeps serving, then swapped in with one transaction: the old generation's entries go, and
 * purge_seq tells every phone to refetch. Resumable: a rotation interrupted mid-build continues
 * the same pending generation. (Format 2 rotates with its key: see syncFormat2.)
 */
export async function rotatePack(pool: pg.Pool, opts: BuildOpts = {}): Promise<ReconcileResult> {
  if (!packVault()) throw new Error('PACK_KEY is not set');
  const started = Date.now();
  const c = await pool.connect();
  try {
    const serving = await packMeta(c);
    let row = (
      await c.query<MetaRow>('SELECT * FROM pack_meta WHERE active_at IS NULL AND format = 1 ORDER BY salt_id DESC LIMIT 1')
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
      const [t] = await build(c, [next], opts);
      const { collisions: _c, ...counts } = t;
      // Wait out any reconcile of the old generation, then swap.
      await c.query('SELECT pg_advisory_lock($1, $2)', [LOCK_ID, serving.saltId]);
      try {
        await c.query('BEGIN');
        await c.query(`UPDATE pack_meta SET active_at = now(), purge_seq = nextval('pack_seq') WHERE salt_id = $1`, [
          next.saltId,
        ]);
        // Older format-1 generations, their entries and cached hashes (ON DELETE CASCADE).
        await c.query('DELETE FROM pack_meta WHERE salt_id <> $1 AND format = 1', [next.saltId]);
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        await c.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_ID, serving.saltId]).catch(() => {});
      }
      return { saltId: next.saltId, ...counts, purged: 0, ms: Date.now() - started };
    } finally {
      await c.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_ID, next.saltId]).catch(() => {});
    }
  } finally {
    c.release();
  }
}

/** Deletes a format-2 generation (entries, parts and hashes cascade) unless someone writes it now. */
async function dropGeneration(c: pg.PoolClient, saltId: number): Promise<boolean> {
  const { rows: lock } = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [LOCK_ID, saltId]);
  if (!lock[0].ok) return false;
  try {
    await c.query('DELETE FROM pack_meta WHERE salt_id = $1 AND format = 2', [saltId]);
    return true;
  } finally {
    await c.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_ID, saltId]).catch(() => {});
  }
}

export interface Format2Sync {
  /** Format-2 generations deleted: past retire_after, their key gone, or half-built under an older key. */
  dropped: number[];
  /** Another worker is building the new generation. */
  busy: boolean;
  /** A generation built under the current key and swapped in. */
  built: {
    saltId: number;
    keyId: number;
    /** The generation it replaced: retiring (deletes only, RETIRE_DAYS) or deleted (its key is gone). */
    replaced: { saltId: number; retiring: boolean } | null;
    counts: Counts;
    partBits: number;
    ms: number;
  } | null;
}

/**
 * Keeps format 2 in line with PACK_APP_KEYS (the pack worker calls it on every pass; cheap when
 * nothing is to do). null when format 2 is off (no PACK_APP_KEYS, or no PACK_KEY).
 * - Throws PackAppKeyMismatch when a key's value changed (app_key_check): nothing is built.
 * - Deletes retiring generations past retire_after or whose key left PACK_APP_KEYS.
 * - When no active generation is built under the first (current) key, builds one in full (the
 *   first build, or a rotation after a new key went to the front), in batches, while the live
 *   generations keep draining between batches, then swaps it in: the old one retires for
 *   RETIRE_DAYS (deletes only) when its key is still in PACK_APP_KEYS, else it goes. Resumable:
 *   an interrupted build continues the same pending generation.
 * `params`: Argon2 cost of a new generation (tests use a cheap one); `onBuild`: told when a build starts.
 */
export async function syncFormat2(
  pool: pg.Pool,
  opts: BuildOpts & { params?: Omit<PackParams, 'salt'>; onBuild?: (saltId: number, keyId: number) => void } = {},
): Promise<Format2Sync | null> {
  const keys = appKeys();
  if (!keys.length || !packVault()) return null;
  const current = keys[0];
  const started = Date.now();
  const c = await pool.connect();
  try {
    return await noStatementTimeout(c, async () => {
      await packMeta(c); // format 1 first, so a new server keeps salt_id 1 for it
      const out: Format2Sync = { dropped: [], busy: false, built: null };
      const metas = (await c.query<MetaRow>('SELECT * FROM pack_meta WHERE format = 2 ORDER BY salt_id DESC')).rows.map(toMeta);
      const now = new Date();
      const expired = (m: PackMeta) => m.active && m.retireAfter !== null && m.retireAfter <= now;
      const mismatch = metas.find((m) => m.keyState === 'mismatch' && !expired(m));
      if (mismatch) throw new PackAppKeyMismatch(mismatch.appKeyId!);

      for (const m of metas) {
        if (m.active && m.retireAfter && (expired(m) || m.keyState !== 'ok') && (await dropGeneration(c, m.saltId))) {
          out.dropped.push(m.saltId);
        }
      }
      const active = metas.find((m) => m.active && !m.retireAfter) ?? null;
      if (active && active.keyState === 'ok' && active.appKeyId === current.id) return out;

      // A generation under the current key is needed: the first one, or a new key went to the
      // front of PACK_APP_KEYS. One half-built under an older key goes.
      let pending = metas.find((m) => !m.active && m.appKeyId === current.id);
      for (const m of metas) {
        if (!m.active && m !== pending && (await dropGeneration(c, m.saltId))) out.dropped.push(m.saltId);
      }
      if (!pending) {
        const { rows } = await c.query<MetaRow>(
          `INSERT INTO pack_meta (salt_id, salt, t, m_kib, p, canary, format, app_key_id, app_key_check)
           SELECT coalesce(max(salt_id), 0) + 1, $1, $2, $3, $4, $5, 2, $6, $7 FROM pack_meta RETURNING *`,
          [...newMetaValues(opts.params), current.id, appKeyCheck(current.key)],
        );
        pending = toMeta(rows[0]);
      }
      const { rows: lock } = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [LOCK_ID, pending.saltId]);
      if (!lock[0].ok) return { ...out, busy: true };
      try {
        // Another worker may have finished it meanwhile.
        const { rows: again } = await c.query<{ active_at: Date | null }>('SELECT active_at FROM pack_meta WHERE salt_id = $1', [
          pending.saltId,
        ]);
        if (!again[0] || again[0].active_at) return out;
        opts.onBuild?.(pending.saltId, current.id);
        // The live generations keep draining between batches; the full pass the worker runs
        // after the swap catches this one up with what they drained.
        const [counts] = await build(c, [pending], { ...opts, between: () => drainDirty(pool, { workers: opts.workers }) });
        const partBits = await maybeSplit(c, pending);

        // Swap, after any writer of the format-2 generations served now is done.
        const { rows: served } = await c.query<{ salt_id: number }>(
          'SELECT salt_id FROM pack_meta WHERE format = 2 AND active_at IS NOT NULL ORDER BY salt_id',
        );
        for (const r of served) await c.query('SELECT pg_advisory_lock($1, $2)', [LOCK_ID, r.salt_id]);
        const keep = active && active.keyState === 'ok' ? active.saltId : null;
        try {
          await c.query('BEGIN');
          await c.query('UPDATE pack_meta SET active_at = now() WHERE salt_id = $1', [pending.saltId]);
          // The replaced generation keeps answering phones that haven't switched yet (deletes
          // only); any older retiring one goes (at most one per format).
          if (keep !== null) {
            await c.query('UPDATE pack_meta SET retire_after = now() + make_interval(days => $2) WHERE salt_id = $1', [
              keep,
              RETIRE_DAYS,
            ]);
          }
          await c.query('DELETE FROM pack_meta WHERE format = 2 AND salt_id <> ALL($1::int[])', [
            [pending.saltId, ...(keep !== null ? [keep] : [])],
          ]);
          await c.query('COMMIT');
        } catch (err) {
          await c.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          for (const r of served) await c.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_ID, r.salt_id]).catch(() => {});
        }
        out.built = {
          saltId: pending.saltId,
          keyId: current.id,
          replaced: active ? { saltId: active.saltId, retiring: keep !== null } : null,
          counts,
          partBits,
          ms: Date.now() - started,
        };
        return out;
      } finally {
        await c.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_ID, pending.saltId]).catch(() => {});
      }
    });
  } finally {
    c.release();
  }
}
