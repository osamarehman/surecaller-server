import type { Client, Pool } from './db.js';
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
  nameSource: 'member' | 'contacts' | 'suggested' | null;
  altNames: { name: string; count: number }[];
  savedByCount: number;
  member: { id: string; name: string; status: string | null } | null;
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

const NO_REPORTS: RawSpam = { reports: 0, notSpam: 0, adminReported: false, topCategory: null, lastComment: null };

/** Report aggregates for many phones in one query. Phones without reports are absent. */
async function rawSpam(db: Client, phones: string[]): Promise<Map<string, RawSpam>> {
  const { rows } = await db.query<{
    phone: string;
    reports: number;
    not_spam: number;
    admin_reported: boolean;
    top_category: string | null;
    last_comment: string | null;
  }>(
    `WITH agg AS (
       SELECT r.phone,
         count(*) FILTER (WHERE NOT r.not_spam) AS reports,
         count(*) FILTER (WHERE r.not_spam) AS not_spam,
         -- Only the trusted family's admins can label a number alone; anyone else's own family doesn't count.
         coalesce(bool_or(u.is_admin AND f.trusted AND NOT r.not_spam), false) AS admin_reported
       FROM reports r JOIN users u ON u.id = r.user_id JOIN families f ON f.id = u.family_id
       WHERE r.phone = ANY($1::text[])
       GROUP BY r.phone
     ), top AS (
       SELECT DISTINCT ON (phone) phone, category
       FROM (SELECT phone, category, count(*) AS n, max(created_at) AS latest FROM reports
             WHERE phone = ANY($1::text[]) AND NOT not_spam AND category IS NOT NULL
             GROUP BY phone, category) t
       ORDER BY phone, n DESC, latest DESC
     ), lc AS (
       SELECT DISTINCT ON (phone) phone, comment FROM reports
       WHERE phone = ANY($1::text[]) AND NOT not_spam AND coalesce(comment, '') <> ''
       ORDER BY phone, created_at DESC
     )
     SELECT agg.*, top.category AS top_category, lc.comment AS last_comment
     FROM agg LEFT JOIN top USING (phone) LEFT JOIN lc USING (phone)`,
    [phones],
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

/** Opens sealed names and ranks them per phone: most people first, then most recent. */
function rankNames(
  rows: { phone_hash: Buffer; name_enc: Buffer; at: Date }[],
  phoneOf: (h: Buffer) => string | undefined,
): Map<string, NameCount[]> {
  const acc = new Map<string, Map<string, { count: number; at: number }>>();
  for (const r of rows) {
    const phone = phoneOf(r.phone_hash);
    const name = phone ? vault().open(phone, r.name_enc) : null;
    if (!phone || name === null) continue;
    let names = acc.get(phone);
    if (!names) acc.set(phone, (names = new Map()));
    const n = names.get(name);
    if (n) {
      n.count++;
      n.at = Math.max(n.at, r.at.getTime());
    } else names.set(name, { count: 1, at: r.at.getTime() });
  }
  const out = new Map<string, NameCount[]>();
  for (const [phone, names] of acc) {
    out.set(
      phone,
      [...names].sort((a, b) => b[1].count - a[1].count || b[1].at - a[1].at).map(([name, x]) => ({ name, count: x.count })),
    );
  }
  return out;
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
  return raw;
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

interface NameCount {
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
  const [callsBy, memberRes, contactRes, suggestRes, blockRes, spamBy] = await Promise.all([
    callCounts(pool, phones),
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
  const contactsBy = rankNames(contactRes.rows, index.phoneOf);
  const suggestBy = rankNames(suggestRes.rows, index.phoneOf);
  const blockBy = new Map(blockRes.rows.map((r) => [r.phone, r]));

  return phones.map((phone): Lookup => {
    const calls = callsBy.get(phone) ?? 0;
    const member = memberBy.get(phone) ?? null;
    const contacts = contactsBy.get(phone) ?? [];
    const suggested = suggestBy.get(phone) ?? [];
    const block = blockBy.get(phone);

    let name: string | null = null;
    let nameSource: Lookup['nameSource'] = null;
    if (member) {
      name = member.name;
      nameSource = 'member';
    } else if (contacts.length > 0) {
      name = contacts[0].name;
      nameSource = 'contacts';
    } else if (suggested.length > 0) {
      name = suggested[0].name;
      nameSource = 'suggested';
    }

    return {
      phone,
      name,
      nameSource,
      // Only the single best caller-ID name is exposed; the other names people saved for this
      // number are never returned, so no one can read the shared contacts through a lookup.
      altNames: [],
      savedByCount: contacts.reduce((s, c) => s + c.count, 0),
      member: member ? { id: member.id, name: member.name, status: member.status } : null,
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
  if (opts.logUserId) {
    await pool.query('INSERT INTO lookups (phone_hash, user_id) VALUES ($1, $2)', [vault().index(phone), opts.logUserId]);
  }
  return (await buildLookups(pool, [phone], opts.threshold, opts.spamRaw, opts.familyId))[0];
}
