import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import type { Client } from './db.js';
import { AppError, badRequest, conflict } from './errors.js';
import { hashToken, safeEqual } from './tokens.js';

export const Email = z
  .string()
  .trim()
  .max(200)
  .pipe(z.email())
  .transform((e) => e.toLowerCase());

const CODE_TTL_MIN = 15;
const MAX_ATTEMPTS = 5;
const RESEND_AFTER_S = 60;
/**
 * Per email address per UTC day, whatever IP asks: codes sent, and wrong codes tried. A new code
 * resets the 5 tries, so without these a guesser on rotating IPs gets 5 tries a minute. With them
 * a code is guessed with odds of 1 in 50 000 a day at most (20 tries out of a million codes; never
 * more than 10 codes x 5 tries even when guesses race). A real user asks for one or two codes.
 */
export const MAX_CODES_PER_EMAIL_DAY = 10;
export const MAX_FAILS_PER_EMAIL_DAY = 20;
const TODAY = "(now() AT TIME ZONE 'utc')::date";
/** Timeout for calls to Google (ID token certs). */
const OUTBOUND_TIMEOUT_MS = 10_000;

const invalidEmailCode = () => new AppError(403, 'invalid_email_code', 'Email code is wrong or expired');

/**
 * Stores a fresh 6-digit code for the email and returns it; null if one was sent under a minute ago.
 * 429 rate_limited after MAX_CODES_PER_EMAIL_DAY codes today.
 */
export async function issueEmailCode(db: Client, email: string): Promise<string | null> {
  const { rows: lim } = await db.query<{ sent: number }>(
    `SELECT sent FROM email_code_limits WHERE email = $1 AND day = ${TODAY}`,
    [email],
  );
  if ((lim[0]?.sent ?? 0) >= MAX_CODES_PER_EMAIL_DAY) {
    throw new AppError(429, 'rate_limited', 'Too many codes for this email today; try again tomorrow');
  }
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const { rowCount } = await db.query(
    `INSERT INTO email_codes (email, code_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))
     ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, attempts = 0,
       expires_at = EXCLUDED.expires_at, sent_at = now()
     WHERE email_codes.sent_at < now() - make_interval(secs => $4)`,
    [email, hashToken(code), CODE_TTL_MIN, RESEND_AFTER_S],
  );
  if (!rowCount) return null;
  await db.query(
    `INSERT INTO email_code_limits (email, day, sent) VALUES ($1, ${TODAY}, 1)
     ON CONFLICT (email, day) DO UPDATE SET sent = email_code_limits.sent + 1`,
    [email],
  );
  return code;
}

/**
 * Throws 403 invalid_email_code unless the code matches. Counts the attempt first, on the pool,
 * so a failed try sticks even when the caller's transaction rolls back. Five tries per code, and
 * MAX_FAILS_PER_EMAIL_DAY wrong ones per email per day (after that even the right code fails).
 */
export async function checkEmailCode(db: Client, email: string, code: string): Promise<void> {
  const { rows: lim } = await db.query<{ failed: number }>(
    `SELECT failed FROM email_code_limits WHERE email = $1 AND day = ${TODAY}`,
    [email],
  );
  if ((lim[0]?.failed ?? 0) >= MAX_FAILS_PER_EMAIL_DAY) throw invalidEmailCode();
  const { rows } = await db.query<{ code_hash: string }>(
    `UPDATE email_codes SET attempts = attempts + 1
     WHERE email = $1 AND expires_at > now() AND attempts < $2 RETURNING code_hash`,
    [email, MAX_ATTEMPTS],
  );
  if (!rows[0]) throw invalidEmailCode();
  if (!safeEqual(rows[0].code_hash, hashToken(code.trim()))) {
    await db.query(
      `INSERT INTO email_code_limits (email, day, failed) VALUES ($1, ${TODAY}, 1)
       ON CONFLICT (email, day) DO UPDATE SET failed = email_code_limits.failed + 1`,
      [email],
    );
    throw invalidEmailCode();
  }
}

/** Call inside the transaction that uses the email, so a code works once. */
export const spendEmailCode = (db: Client, email: string) =>
  db.query('DELETE FROM email_codes WHERE email = $1', [email]);

/**
 * The address an email reaches, for "one account per email": lowercase, and for Gmail the local
 * part without dots or a +tag, at gmail.com. Mirrors email_canonical() in
 * migrations/019_google_identity.sql (test/signup-google.test.ts checks they agree).
 */
export function canonicalEmail(email: string): string {
  const e = email.toLowerCase();
  if (!/@(gmail|googlemail)\.com$/.test(e)) return e;
  return `${e.split('@')[0].split('+')[0].replaceAll('.', '')}@gmail.com`;
}

const EMAIL_UNIQUE = new Set(['users_email_unique', 'users_email_canonical_unique', 'users_google_sub_unique']);

/**
 * `.catch(emailTaken)`: turns a unique violation on users.email, its canonical form or google_sub
 * into 409 email_taken.
 */
export function emailTaken(e: unknown): never {
  const pg = e as { code?: string; constraint?: string };
  if (pg.code === '23505' && pg.constraint && EMAIL_UNIQUE.has(pg.constraint)) {
    throw conflict('email_taken', 'This email is already used by another account');
  }
  throw e;
}

/**
 * What a verified Google ID token proves: the email, the account's profile picture link, and the
 * Google account's stable id (`sub`). An email code proves only the email (sub null).
 */
export interface GoogleProfile {
  email: string;
  picture: string | null;
  sub: string | null;
}

/**
 * Returns the verified profile in a Google ID token, or null if the token doesn't check out.
 * Throws when Google can't be reached (its signing certificates can't be fetched).
 */
export type GoogleVerifier = (idToken: string) => Promise<GoogleProfile | null>;

/**
 * A Google profile picture link safe to store and hand to other users' phones: https on
 * googleusercontent.com only, asked for at 256 px. Anything else is dropped (null).
 */
export function googlePhotoUrl(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 1000) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !u.hostname.endsWith('.googleusercontent.com')) return null;
  if (u.username || u.password || u.port) return null;
  // Google appends the size ("=s96-c"); ask for one that still looks sharp on a call screen.
  return u.toString().replace(/=s\d+(-c)?$/, '=s256-c');
}

/** Checks Google ID tokens from the app's "Sign in with Google". audiences = the OAuth web client IDs. */
export function createGoogleVerifier(audiences: string[]): GoogleVerifier | null {
  if (!audiences.length) return null;
  // verifyIdToken fetches Google's signing certs (cached until they expire): don't let a stalled
  // fetch hold a sign-up request open. The timeout is per attempt, so allow one retry, not gaxios's 3.
  const client = new OAuth2Client({ transporterOptions: { timeout: OUTBOUND_TIMEOUT_MS, retryConfig: { retry: 1 } } });
  return async (idToken) => {
    // Fetch (or reuse the cached) certificates first: a failure here is Google being unreachable,
    // not a bad token, so it is thrown (503) instead of returning null (403).
    await client.getFederatedSignonCertsAsync();
    try {
      const p = (await client.verifyIdToken({ idToken, audience: audiences })).getPayload();
      if (!p?.email || !p.email_verified || !p.sub) return null;
      return { email: p.email.toLowerCase(), picture: googlePhotoUrl(p.picture), sub: p.sub };
    } catch {
      return null;
    }
  };
}

export const EmailProof = {
  email: Email.optional(),
  emailCode: z.string().max(20).optional(),
  googleIdToken: z.string().max(4096).optional(),
};

/**
 * The email a request proves, from a Google ID token or an email code; null when it sends neither.
 * An email code counts one try on the pool (see checkEmailCode); spend it in the caller's transaction.
 */
export async function proveEmail(
  ctx: { pool: Client; google: GoogleVerifier | null },
  b: { email?: string; emailCode?: string; googleIdToken?: string },
): Promise<string | null> {
  return (await proveIdentity(ctx, b))?.email ?? null;
}

/** [proveEmail], plus the Google profile picture and account id (`sub`) when the proof was a Google ID token. */
export async function proveIdentity(
  ctx: { pool: Client; google: GoogleVerifier | null },
  b: { email?: string; emailCode?: string; googleIdToken?: string },
): Promise<GoogleProfile | null> {
  if (b.googleIdToken) {
    if (b.email || b.emailCode) throw badRequest('invalid_request', 'Send googleIdToken or email + emailCode, not both');
    return verifyGoogle(ctx, b.googleIdToken);
  }
  if (!b.email !== !b.emailCode) throw badRequest('invalid_request', 'email and emailCode go together');
  if (!b.email) return null;
  await checkEmailCode(ctx.pool, b.email, b.emailCode!);
  return { email: b.email, picture: null, sub: null };
}

/**
 * The profile in a Google ID token; 503 without Google sign-in or when Google can't be reached,
 * 403 for a token that fails.
 */
export async function verifyGoogle(ctx: { google: GoogleVerifier | null }, idToken: string): Promise<GoogleProfile> {
  if (!ctx.google) throw new AppError(503, 'google_unavailable', 'This server has no Google sign-in');
  let profile: GoogleProfile | null;
  try {
    profile = await ctx.google(idToken);
  } catch {
    throw new AppError(503, 'google_unavailable', 'Could not reach Google to check the sign-in; try again');
  }
  if (!profile) throw new AppError(403, 'invalid_google_token', 'Google sign-in could not be verified');
  return profile;
}
