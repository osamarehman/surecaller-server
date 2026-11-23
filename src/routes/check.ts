import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Client } from '../db.js';
import { badRequest } from '../errors.js';
import { parse, userKey } from '../http.js';
import { buildLookups, spamLabel } from '../lookup.js';
import { named } from './lookup.js';
import { phonesInText } from '../phone.js';

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const MAX_ITEMS = 20;
/** POST /v1/check per member per hour (the app sends a message the user pasted by hand). */
export const CHECK_RATE_LIMIT = 120;

/** Canonical form used as the url_reports key; null when it isn't a usable web URL. */
export function normalizeUrl(raw: string): string | null {
  let s = raw.trim().replace(/[)\]}.,;:!?'"]+$/, '');
  if (!s || s.length > 2000) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname.includes('.')) return null;
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return null;
  }
}

export function urlsInText(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const u = normalizeUrl(m[0]);
    if (u) out.add(u);
  }
  return [...out];
}

async function urlInfo(db: Client, url: string, threshold: number) {
  const { rows } = await db.query<{ reports: number; admin: boolean }>(
    `SELECT count(*) AS reports, coalesce(bool_or(u.is_admin AND f.trusted), false) AS admin
     FROM url_reports r JOIN users u ON u.id = r.user_id JOIN families f ON f.id = u.family_id
     WHERE r.url = $1`,
    [url],
  );
  const { reports, admin } = rows[0];
  // Links have no "not spam" votes, so net = reports.
  return { url, reports, label: spamLabel(reports, admin, threshold) };
}

const CheckBody = z.object({ text: z.string().max(20_000) });
const UrlReportBody = z.object({ url: z.string().max(2000) });

export async function checkRoutes(app: FastifyInstance) {
  const { cfg, pool, budget } = app.ctx;
  const threshold = cfg.spamThreshold;

  // ?names=0: phones carry { phone, spam } only, outside the daily name budget (src/usage.ts).
  app.post<{ Querystring: { names?: string } }>('/check', { config: { rateLimit: { max: CHECK_RATE_LIMIT, timeWindow: '1 hour', keyGenerator: userKey } } }, async (req, reply) => {
    const b = parse(CheckBody, req.body);
    const phoneList = phonesInText(b.text, cfg.defaultRegion).slice(0, MAX_ITEMS);
    const urlList = urlsInText(b.text).slice(0, MAX_ITEMS);
    const noNames = req.query.names === '0';
    if (!noNames && phoneList.length) await budget.check(req, reply);
    const [phones, urls] = await Promise.all([
      buildLookups(pool, phoneList, threshold, undefined, req.user.family_id),
      Promise.all(urlList.map((u) => urlInfo(pool, u, threshold))),
    ]);

    const labels = [...phones.map((p) => p.spam.label), ...urls.map((u) => u.label)];
    let verdict: 'safe' | 'unknown' | 'suspicious' | 'scam';
    if (labels.includes('likely_scam') || phones.some((p) => p.blocked)) verdict = 'scam';
    else if (labels.includes('suspected')) verdict = 'suspicious';
    else if (
      phones.length > 0 &&
      urls.length === 0 &&
      phones.every((p) => p.nameSource === 'member' || p.nameSource === 'contacts')
    )
      verdict = 'safe';
    else verdict = 'unknown';

    if (noNames) return { phones: phones.map((p) => ({ phone: p.phone, spam: p.spam })), urls, verdict };
    await budget.charge(req, reply, named(phones));
    return { phones, urls, verdict };
  });

  app.post('/reports/url', { config: { rateLimit: { max: 30, timeWindow: '1 hour', keyGenerator: userKey } } }, async (req) => {
    const b = parse(UrlReportBody, req.body);
    const url = normalizeUrl(b.url);
    if (!url) throw badRequest('invalid_url', 'Not a valid web link');
    await pool.query(
      'INSERT INTO url_reports (user_id, url) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.user.id, url],
    );
    return urlInfo(pool, url, threshold);
  });
}
