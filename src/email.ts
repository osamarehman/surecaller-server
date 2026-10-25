import crypto from 'node:crypto';
import { z } from 'zod';
import type { Client } from './db.js';
import { AppError } from './errors.js';
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
