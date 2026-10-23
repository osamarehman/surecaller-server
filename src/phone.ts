import { findPhoneNumbersInText, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { badRequest } from './errors.js';

/** Returns E.164, or null when the input can't be parsed as a possible number. */
export function normalizePhone(input: unknown, region: CountryCode): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 40) return null;
  // Accept the international "00" prefix as "+".
  const candidate = trimmed.startsWith('00') ? `+${trimmed.slice(2)}` : trimmed;
  try {
    const parsed = parsePhoneNumberFromString(candidate, region);
    if (!parsed || !parsed.isPossible()) return null;
    return parsed.number;
  } catch {
    return null;
  }
}

/** Like normalizePhone but throws 400 invalid_phone. */
export function requirePhone(input: unknown, region: CountryCode): string {
  const p = normalizePhone(input, region);
  if (!p) throw badRequest('invalid_phone', 'Could not parse phone number');
  return p;
}

/** Last 4 digits only, so logs never hold a full phone number (same shape as the app's Telemetry.mask). */
export function maskPhone(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\P{Nd}/gu, '');
  return digits ? `…${digits.slice(-4)}` : '?';
}

/** A run of digits with phone separators, including URL-encoded `+` / space; any script's digits. */
const PHONE_LIKE = /(?:%2B|\+)?\p{Nd}(?:\p{Nd}|%20|%2B|[ ().\-/])*\p{Nd}/gu;

/** Masks every run of 7+ digits that looks like a phone number. Port of the app's Telemetry.redact. */
export function redactPhones(text: string): string {
  return text.replace(PHONE_LIKE, (m) => (m.replace(/\P{Nd}/gu, '').length >= 7 ? maskPhone(m) : m));
}

/** All distinct phone numbers found in free text, as E.164. */
export function phonesInText(text: string, region: CountryCode): string[] {
  const out = new Set<string>();
  try {
    for (const m of findPhoneNumbersInText(text, region)) out.add(m.number.number);
  } catch {
    /* ignore unparsable text */
  }
  return [...out];
}
