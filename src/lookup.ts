import type { SpamReporters } from './config.js';
import { withTx, type Client, type Pool } from './db.js';
import { cleanName, romanize } from './names.js';
import { vault } from './vault.js';

export type SpamLabel = 'none' | 'suspected' | 'likely_scam';

export interface SpamInfo {
  label: SpamLabel;
  score: number;
  reports: number;
  notSpam: number;
  topCategory: string | null;
  lastComment: string | null;
}

export interface Lookup {
  phone: string;
  name: string | null;
  nameSource: 'member' | 'contacts' | 'directory' | 'suggested' | null;
  /** The business type, when the name comes from the directory (e.g. "restaurant"). */
  category: string | null;
  altNames: { name: string; count: number }[];
  savedByCount: number;
  member: { id: string; name: string; status: string | null } | null;
  /**
   * The Google profile picture of the SureCaller account on this number, from any family, when
   * its owner has one. Null otherwise.
   */
  photoUrl: string | null;
  spam: SpamInfo;
  blocked: { byCircle: true; addedBy: string | null } | null;
  callsToday: number;
}

/** Applies the documented spam rules to raw report counts. */
export function spamLabel(net: number, adminReported: boolean, threshold: number): SpamLabel {
  if (net >= threshold || adminReported) return 'likely_scam';
  if (net >= 1) return 'suspected';
  return 'none';
}

export function spamScore(net: number, calls: number): number {
  if (net <= 0) return 0;
  return Math.min(100, 40 * net + 2 * calls);
}

export interface RawSpam {
  reports: number;
  notSpam: number;
  adminReported: boolean;
  topCategory: string | null;
  lastComment: string | null;
}

let reporters: SpamReporters = 'all';

/** SPAM_REPORTERS for this process; set once from the config (buildApp). */
export function setSpamReporters(r: SpamReporters): void {
  reporters = r;
}

export const spamReporters = (): SpamReporters => reporters;

/**
 * Whether this account's reports count with the current SPAM_REPORTERS: with 'google', only
 * Google-linked accounts and the trusted family's admins count. Mirrors the filter in rawSpam.
 */
export const reportsCount = (u: { google_sub?: string | null; is_admin: boolean; trusted: boolean }): boolean =>
  reporters === 'all' || u.google_sub != null || (u.is_admin && u.trusted);

const NO_REPORTS: RawSpam = { reports: 0, notSpam: 0, adminReported: false, topCategory: null, lastComment: null };

/**
 * Report aggregates for many phones in one query. Phones without reports are absent. With
 * SPAM_REPORTERS=google only reports (and not-spam votes, categories, comments) from Google-linked
 * accounts and the trusted family's admins count; the others stay stored but are left out here.
 */
async function rawSpam(db: Client, phones: string[]): Promise<Map<string, RawSpam>> {
  const { rows } = await db.query<{
    phone: string;
    reports: number;
    not_spam: number;
    admin_reported: boolean;
    top_category: string | null;
    last_comment: string | null;
  }>(
    `WITH r AS (
       SELECT r.*, u.is_admin AND f.trusted AS trusted_admin
       FROM reports r JOIN users u ON u.id = r.user_id JOIN families f ON f.id = u.family_id
       WHERE r.phone = ANY($1::text[])
         AND ($2 = 'all' OR u.google_sub IS NOT NULL OR (u.is_admin AND f.trusted))
     ), agg AS (
       SELECT r.phone,
         count(*) FILTER (WHERE NOT r.not_spam) AS reports,
         count(*) FILTER (WHERE r.not_spam) AS not_spam,
         -- Only the trusted family's admins can label a number alone; anyone else's own family doesn't count.
         coalesce(bool_or(r.trusted_admin AND NOT r.not_spam), false) AS admin_reported
       FROM r
       GROUP BY r.phone
     ), top AS (
       SELECT DISTINCT ON (phone) phone, category
       FROM (SELECT phone, category, count(*) AS n, max(created_at) AS latest FROM r
             WHERE NOT not_spam AND category IS NOT NULL
             GROUP BY phone, category) t
       ORDER BY phone, n DESC, latest DESC
     ), lc AS (
       SELECT DISTINCT ON (phone) phone, comment FROM r
       WHERE NOT not_spam AND coalesce(comment, '') <> ''
       ORDER BY phone, created_at DESC
     )
     SELECT agg.*, top.category AS top_category, lc.comment AS last_comment
     FROM agg LEFT JOIN top USING (phone) LEFT JOIN lc USING (phone)`,
    [phones, reporters],
  );
  return new Map(
    rows.map((r) => [
      r.phone,
      {
        reports: r.reports,
        notSpam: r.not_spam,
        adminReported: r.admin_reported === true,
        topCategory: r.top_category,
        lastComment: r.last_comment,
      },
    ]),
  );
}

function toSpamInfo(raw: RawSpam, threshold: number, calls: number): SpamInfo {
  const net = raw.reports - raw.notSpam;
  return {
    label: spamLabel(net, raw.adminReported, threshold),
    score: spamScore(net, calls),
    reports: raw.reports,
    notSpam: raw.notSpam,
    topCategory: raw.topCategory,
    lastComment: raw.lastComment,
  };
}

/** Lookups logged in the last 24h per phone. Phones without any are absent. */
async function callCounts(db: Client, phones: string[]): Promise<Map<string, number>> {
  const { hashes, phoneOf } = indexPhones(phones);
  const { rows } = await db.query<{ phone_hash: Buffer; n: number }>(
    `SELECT phone_hash, count(*) AS n FROM lookups
     WHERE phone_hash = ANY($1::bytea[]) AND created_at > now() - interval '24 hours'
     GROUP BY phone_hash`,
    [hashes],
  );
  return new Map(rows.map((r) => [phoneOf(r.phone_hash)!, r.n]));
}

/** Vault indexes for `phones`, and the way back from a stored index to the phone. */
function indexPhones(phones: string[]) {
  const v = vault();
  const hashes = phones.map((p) => v.index(p));
  const byHex = new Map(hashes.map((h, i) => [h.toString('hex'), phones[i]]));
  return { hashes, phoneOf: (h: Buffer) => byHex.get(h.toString('hex')) };
}

// A spelling someone typed in English beats one converted from Urdu (romanize, after ranking).
const latin = (name: string) => (/\p{Script=Latin}/u.test(name) ? 1 : 0);

/** Opens and cleans sealed names, then ranks them per phone: English spelling, most people, most recent. */
function rankNames(
  rows: { phone_hash: Buffer; name_enc: Buffer; at: Date }[],
  phoneOf: (h: Buffer) => string | undefined,
): Map<string, NameCount[]> {
  const acc = new Map<string, { name: string; at: Date }[]>();
  for (const r of rows) {
    const phone = phoneOf(r.phone_hash);
    const opened = phone ? vault().open(phone, r.name_enc) : null;
    const name = opened === null ? null : cleanName(opened);
    if (!phone || name === null) continue;
    let names = acc.get(phone);
    if (!names) acc.set(phone, (names = []));
    names.push({ name, at: r.at });
  }
  const out = new Map<string, NameCount[]>();
  for (const [phone, names] of acc) out.set(phone, rankByCount(names));
  return out;
}

/** Ranks the (already cleaned) names saved for one number: English spelling, most people, most recent. */
export function rankByCount(items: { name: string; at: Date }[]): NameCount[] {
  const names = new Map<string, { count: number; at: number }>();
  for (const { name, at } of items) {
    const n = names.get(name);
    if (n) {
      n.count++;
      n.at = Math.max(n.at, at.getTime());
    } else names.set(name, { count: 1, at: at.getTime() });
  }
  return [...names]
    .sort((a, b) => latin(b[0]) - latin(a[0]) || b[1].count - a[1].count || b[1].at - a[1].at)
    .map(([name, x]) => ({ name: romanize(name), count: x.count }));
}

/**
 * Recomputes the materialized spam_state rows used by /v1/sync for many phones
 * with one aggregate query, one count and one batched upsert. Only bumps
 * updated_at when something the app stores actually changed; a phone that
 * drops to 'none' only gets a row update when it previously had a label.
 * Returns the raw report aggregates (phones without reports are absent).
 */
export async function refreshSpamState(
  db: Client,
  phoneList: string[],
  threshold: number,
): Promise<Map<string, RawSpam>> {
  const phones = [...new Set(phoneList)];
  if (phones.length === 0) return new Map();
  // Serialize per phone so concurrent reporters don't overwrite each other with stale counts.
  // Sorted to avoid deadlocks. Released at commit, so callers must be inside a transaction.
  await db.query(
    'SELECT pg_advisory_xact_lock(hashtext(p)) FROM unnest($1::text[]) AS t(p) ORDER BY p',
    [phones],
  );
  const raw = await rawSpam(db, phones);
  const calls = await callCounts(db, phones);
  const spam = phones.map((p) => toSpamInfo(raw.get(p) ?? NO_REPORTS, threshold, calls.get(p) ?? 0));
  await db.query(
    `INSERT INTO spam_state (phone, label, score, reports, top_category, updated_at)
     SELECT t.phone, t.label, t.score, t.reports, t.top_category, now()
     FROM unnest($1::text[], $2::text[], $3::int[], $4::int[], $5::text[])
       AS t(phone, label, score, reports, top_category)
     WHERE t.label <> 'none'
        OR EXISTS (SELECT 1 FROM spam_state s WHERE s.phone = t.phone AND s.label <> 'none')
     ON CONFLICT (phone) DO UPDATE SET
       label = EXCLUDED.label, score = EXCLUDED.score, reports = EXCLUDED.reports,
       top_category = EXCLUDED.top_category, updated_at = now()
     WHERE (spam_state.label, spam_state.score, spam_state.reports, spam_state.top_category)
       IS DISTINCT FROM (EXCLUDED.label, EXCLUDED.score, EXCLUDED.reports, EXCLUDED.top_category)`,
    [
      phones,
      spam.map((x) => x.label),
      spam.map((x) => x.score),
      spam.map((x) => x.reports),
      spam.map((x) => x.topCategory),
    ],
  );
  await writeSpamDetails(db, phones, raw, calls);
  return raw;
}

/**
 * The spam_state details /v1/sync?v=2 carries for lookups on the phone: not-spam votes, the last
 * comment and calls (lookups in the last 24 h), on rows spam_state already has. Bumps
 * detail_updated_at, never updated_at, and only when one changed, so callers without ?v=2 get
 * the same answer as before. Returns the rows changed.
 */
async function writeSpamDetails(db: Client, phones: string[], raw: Map<string, RawSpam>, calls: Map<string, number>) {
  const { rowCount } = await db.query(
    `UPDATE spam_state s SET not_spam = t.ns, last_comment = t.lc, calls = t.c, detail_updated_at = now()
     FROM unnest($1::text[], $2::int[], $3::text[], $4::int[]) AS t(phone, ns, lc, c)
     WHERE s.phone = t.phone AND (s.not_spam, s.last_comment, s.calls) IS DISTINCT FROM (t.ns, t.lc, t.c)`,
    [
      phones,
      phones.map((p) => raw.get(p)?.notSpam ?? 0),
      phones.map((p) => raw.get(p)?.lastComment ?? null),
      phones.map((p) => calls.get(p) ?? 0),
    ],
  );
  return rowCount ?? 0;
}

/**
 * Refreshes the /v1/sync?v=2 details (writeSpamDetails) of every labelled number, in batches:
 * hourly from the API (calls change with every lookup) and once at start, which also fills them
 * in for rows from before 022_pack_v2.sql. Returns the rows changed.
 */
export async function refreshSpamDetails(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ phone: string }>("SELECT phone FROM spam_state WHERE label <> 'none' ORDER BY phone");
  let changed = 0;
  for (let i = 0; i < rows.length; i += RECOMPUTE_BATCH) {
    const phones = rows.slice(i, i + RECOMPUTE_BATCH).map((r) => r.phone);
    changed += await writeSpamDetails(pool, phones, await rawSpam(pool, phones), await callCounts(pool, phones));
  }
  return changed;
}

async function reportedPhones(db: Client, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ phone: string }>('SELECT phone FROM reports WHERE user_id = $1', [
    userId,
  ]);
  return rows.map((r) => r.phone);
}

/**
 * Refreshes spam state for every phone a user has reported (trusted admins' reports count
 * as likely_scam). `change` runs in between, so it may remove those reports,
 * e.g. by deleting the user.
 */
export async function refreshSpamForUser(
  db: Client,
  userId: string,
  threshold: number,
  change?: () => Promise<unknown>,
): Promise<void> {
  const phones = await reportedPhones(db, userId);
  if (change) await change();
  await refreshSpamState(db, phones, threshold);
}

const SPAM_RULES_KEY = 'spam_reporters';
const RECOMPUTE_BATCH = 500;

/**
 * On start: when SPAM_REPORTERS differs from the rule spam_state was last computed with
 * (server_state, 'all' when never stored), recomputes spam_state for every reported or labelled
 * number in batches, so /v1/sync delivers the new labels, then stores the rule. Returns how many
 * numbers it recomputed, or null when the rule had not changed.
 */
export async function syncSpamRules(pool: Pool, threshold: number): Promise<number | null> {
  const { rows } = await pool.query<{ value: string }>('SELECT value FROM server_state WHERE key = $1', [
    SPAM_RULES_KEY,
  ]);
  if ((rows[0]?.value ?? 'all') === reporters) {
    if (!rows[0]) await storeSpamRules(pool);
    return null;
  }
  const { rows: phones } = await pool.query<{ phone: string }>(
    `SELECT phone FROM reports UNION SELECT phone FROM spam_state WHERE label <> 'none' ORDER BY phone`,
  );
  for (let i = 0; i < phones.length; i += RECOMPUTE_BATCH) {
    const batch = phones.slice(i, i + RECOMPUTE_BATCH).map((r) => r.phone);
    await withTx(pool, (c) => refreshSpamState(c, batch, threshold));
  }
  await storeSpamRules(pool);
  return phones.length;
}

const storeSpamRules = (pool: Pool) =>
  pool.query(
    `INSERT INTO server_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [SPAM_RULES_KEY, reporters],
  );

export interface NameCount {
  name: string;
  count: number;
}

/**
 * Builds Lookups for many phones with a fixed handful of set-based queries
 * (independent of how many phones), run in parallel on the pool, in input
 * order, deduped. Does not log. `spamRaw`, when given, must come from
 * rawSpam/refreshSpamState for these phones and skips recomputing it.
 */
export async function buildLookups(
  pool: Pool,
  phoneList: string[],
  threshold: number,
  spamRaw: Map<string, RawSpam> | undefined,
  // The caller's family: member badges and block rules come only from it.
  familyId: string,
): Promise<Lookup[]> {
  const phones = [...new Set(phoneList)];
  if (phones.length === 0) return [];
  const index = indexPhones(phones);
  const [callsBy, photoRes, memberRes, contactRes, dirRes, suggestRes, blockRes, spamBy] = await Promise.all([
    callCounts(pool, phones),
    // A member's photo shows to every user they call, not only their family: they chose to have one.
    pool.query<{ phone: string; photo_url: string }>(
      'SELECT phone, photo_url FROM users WHERE phone = ANY($1::text[]) AND photo_url IS NOT NULL',
      [phones],
    ),
    pool.query<{ phone: string; id: string; name: string; status: string | null }>(
      // Only your own family members are badged as "member"; other families stay invisible.
      'SELECT phone, id, name, status FROM users WHERE family_id = $2 AND phone = ANY($1::text[])',
      [phones, familyId],
    ),
    // Contacts shared before open sign-up (family_only) only answer the uploader's family.
    pool.query<{ phone_hash: Buffer; name_enc: Buffer; at: Date }>(
      `SELECT phone_hash, name_enc, updated_at AS at FROM contacts
       WHERE phone_hash = ANY($1::bytea[])
         AND (NOT family_only OR user_id IN (SELECT id FROM users WHERE family_id = $2))`,
      [index.hashes, familyId],
    ),
    pool.query<{ phone_hash: Buffer; name_enc: Buffer; category: string | null }>(
      'SELECT phone_hash, name_enc, category FROM directory WHERE phone_hash = ANY($1::bytea[])',
      [index.hashes],
    ),
    pool.query<{ phone_hash: Buffer; name_enc: Buffer; at: Date }>(
      'SELECT phone_hash, name_enc, created_at AS at FROM name_suggestions WHERE phone_hash = ANY($1::bytea[])',
      [index.hashes],
    ),
    pool.query<{ phone: string; added_by: string | null }>(
      `SELECT DISTINCT ON (p.phone) p.phone, coalesce(u.name, b.added_by_name) AS added_by
       FROM unnest($1::text[]) AS p(phone)
       JOIN blocks b ON b.family_id = $2 AND b.deleted_at IS NULL AND (
         (b.type = 'number' AND b.value = p.phone) OR
         (b.type IN ('prefix', 'country') AND starts_with(p.phone, b.value)))
       LEFT JOIN users u ON u.id = b.added_by
       ORDER BY p.phone, length(b.value) DESC`,
      [phones, familyId],
    ),
    spamRaw ?? rawSpam(pool, phones),
  ]);
  const memberBy = new Map(memberRes.rows.map((r) => [r.phone, r]));
  const photoBy = new Map(photoRes.rows.map((r) => [r.phone, r.photo_url]));
  const contactsBy = rankNames(contactRes.rows, index.phoneOf);
  const suggestBy = rankNames(suggestRes.rows, index.phoneOf);
  const dirBy = new Map(
    dirRes.rows.flatMap((r) => {
      const phone = index.phoneOf(r.phone_hash);
      const name = phone ? vault().open(phone, r.name_enc) : null;
      return phone && name !== null ? [[phone, { name, category: r.category }] as const] : [];
    }),
  );
  const blockBy = new Map(blockRes.rows.map((r) => [r.phone, r]));

  return phones.map((phone): Lookup => {
    const calls = callsBy.get(phone) ?? 0;
    const member = memberBy.get(phone) ?? null;
    const contacts = contactsBy.get(phone) ?? [];
    const suggested = suggestBy.get(phone) ?? [];
    const block = blockBy.get(phone);
    const dir = dirBy.get(phone);

    let name: string | null = null;
    let nameSource: Lookup['nameSource'] = null;
    if (member) {
      name = member.name;
      nameSource = 'member';
    } else if (contacts.length > 0) {
      name = contacts[0].name;
      nameSource = 'contacts';
    } else if (dir) {
      name = dir.name;
      nameSource = 'directory';
    } else if (suggested.length > 0) {
      name = suggested[0].name;
      nameSource = 'suggested';
    }

    return {
      phone,
      name,
      nameSource,
      category: nameSource === 'directory' ? dir!.category : null,
      // Only the single best caller-ID name is exposed; the other names people saved for this
      // number are never returned, so no one can read the shared contacts through a lookup.
      altNames: [],
      savedByCount: contacts.reduce((s, c) => s + c.count, 0),
      member: member ? { id: member.id, name: member.name, status: member.status } : null,
      photoUrl: photoBy.get(phone) ?? null,
      spam: toSpamInfo(spamBy.get(phone) ?? NO_REPORTS, threshold, calls),
      blocked: block ? { byCircle: true, addedBy: block.added_by } : null,
      callsToday: calls,
    };
  });
}

export async function buildLookup(
  pool: Pool,
  phone: string,
  opts: { threshold: number; familyId: string; logUserId?: string; spamRaw?: Map<string, RawSpam> },
): Promise<Lookup> {
  // Logged before building so callsToday counts this call; `found` is filled in after.
  const logged = opts.logUserId
    ? await pool.query<{ id: string }>('INSERT INTO lookups (phone_hash, user_id) VALUES ($1, $2) RETURNING id', [
        vault().index(phone),
        opts.logUserId,
      ])
    : null;
  const lookup = (await buildLookups(pool, [phone], opts.threshold, opts.spamRaw, opts.familyId))[0];
  if (logged) await pool.query('UPDATE lookups SET found = $2 WHERE id = $1', [logged.rows[0].id, lookup.name !== null]);
  return lookup;
}
