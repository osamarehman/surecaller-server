import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import type { Client } from './db.js';
import { AppError, badRequest } from './errors.js';
import { hashToken, safeEqual } from './tokens.js';

export const Email = z
  .string()
  .trim()
  .max(200)
  .email()
  .transform((e) => e.toLowerCase());

const CODE_TTL_MIN = 15;
const MAX_ATTEMPTS = 5;
const RESEND_AFTER_S = 60;

const invalidEmailCode = () => new AppError(403, 'invalid_email_code', 'Email code is wrong or expired');

/** Stores a fresh 6-digit code for the email and returns it; null if one was sent under a minute ago. */
export async function issueEmailCode(db: Client, email: string): Promise<string | null> {
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const { rowCount } = await db.query(
    `INSERT INTO email_codes (email, code_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))
     ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, attempts = 0,
       expires_at = EXCLUDED.expires_at, sent_at = now()
     WHERE email_codes.sent_at < now() - make_interval(secs => $4)`,
    [email, hashToken(code), CODE_TTL_MIN, RESEND_AFTER_S],
  );
  return rowCount ? code : null;
}

/**
 * Throws 403 invalid_email_code unless the code matches. Counts the attempt first, on the pool,
 * so a failed try sticks even when the caller's transaction rolls back. Five tries per code.
 */
export async function checkEmailCode(db: Client, email: string, code: string): Promise<void> {
  const { rows } = await db.query<{ code_hash: string }>(
    `UPDATE email_codes SET attempts = attempts + 1
     WHERE email = $1 AND expires_at > now() AND attempts < $2 RETURNING code_hash`,
    [email, MAX_ATTEMPTS],
  );
  if (!rows[0] || !safeEqual(rows[0].code_hash, hashToken(code.trim()))) throw invalidEmailCode();
}

/** Call inside the transaction that uses the email, so a code works once. */
export const spendEmailCode = (db: Client, email: string) =>
  db.query('DELETE FROM email_codes WHERE email = $1', [email]);

/** Postgres unique violation on users.email. */
export const isEmailTaken = (e: unknown) =>
  (e as { code?: string; constraint?: string }).code === '23505' &&
  (e as { constraint?: string }).constraint === 'users_email_unique';

/** Returns the verified email in a Google ID token, or null if the token doesn't check out. */
export type GoogleVerifier = (idToken: string) => Promise<string | null>;

/** Checks Google ID tokens from the app's "Sign in with Google". audiences = the OAuth web client IDs. */
export function createGoogleVerifier(audiences: string[]): GoogleVerifier | null {
  if (!audiences.length) return null;
  const client = new OAuth2Client();
  return async (idToken) => {
    try {
      const p = (await client.verifyIdToken({ idToken, audience: audiences })).getPayload();
      return p?.email && p.email_verified ? p.email.toLowerCase() : null;
    } catch {
      return null; // ponytail: Google cert fetch failures also land here; split them out if they show up
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
  if (b.googleIdToken) {
    if (b.email || b.emailCode) throw badRequest('invalid_request', 'Send googleIdToken or email + emailCode, not both');
    if (!ctx.google) throw new AppError(503, 'google_unavailable', 'This server has no Google sign-in');
    const email = await ctx.google(b.googleIdToken);
    if (!email) throw new AppError(403, 'invalid_google_token', 'Google sign-in could not be verified');
    return email;
  }
  if (!b.email !== !b.emailCode) throw badRequest('invalid_request', 'email and emailCode go together');
  if (!b.email) return null;
  await checkEmailCode(ctx.pool, b.email, b.emailCode!);
  return b.email;
}
