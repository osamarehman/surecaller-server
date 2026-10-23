import crypto from 'node:crypto';

export function newToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// No 0/O, 1/I/L so codes are easy to read aloud and type.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newInviteCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Uppercases and re-inserts the dash so "k7q2 9xpm" matches "K7Q2-9XPM". */
export function canonicalInviteCode(input: string): string {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
