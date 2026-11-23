import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CountryCode } from 'libphonenumber-js';
import { createPackVault } from './pack.js';
import { createVault } from './vault.js';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = '1.0.0';

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  /** Postgres connections in the API's pool. */
  dbPoolMax: number;
  /** statement_timeout for the API's queries, in ms (0 = none). Migrations and pack builds lift it. */
  dbStatementTimeoutMs: number;
  adminCode: string | null;
  /** 64 hex chars; encrypts shared contact names at rest (src/vault.ts). */
  contactsKey: string;
  /** 64 hex chars; seals numbers for the offline name pack (src/pack.ts). null = pack off. */
  packKey: string | null;
  /**
   * PACK_INLINE: the API process also runs the pack worker loop (src/pack-runner.ts), for a
   * deployment without the pack-worker service. Default false: the service builds the pack.
   */
  packInline: boolean;
  /**
   * PACK_APP_KEYS: the secret pack keys format-2 name packs are built under (`id:64hex`, comma-
   * separated, current first; src/pack.ts). Empty = format 2 off.
   */
  packAppKeys: PackAppKey[];
  /** Who POST /v1/pack/key hands the pack key to (PACK_KEY_HOLDERS); 'google' when SIGNUP_PROOF=google. */
  packKeyHolders: PackKeyHolders;
  /** LOOKUP_MODE, sent in /v1/sync?v=2: 'local' lets new apps answer caller ID from the pack. */
  lookupMode: 'local' | 'online';
  /** Caller-ID names from the server per member per UTC day, all lookup routes together. */
  lookupDailyLimit: number;
  /** LOOKUP_DAILY_ENFORCE: refuse past the limit (429). false = count and log only. */
  lookupDailyEnforce: boolean;
  defaultRegion: CountryCode;
  spamThreshold: number;
  publicUrl: string | null;
  fcmServiceAccount: string | null;
  downloadsDir: string;
  /** Optional static website; served at `/` when it holds an index.html. */
  siteDir: string;
  lookupRateLimit: number;
  registerRateLimit: number;
  /** Distinct numbers per member per minute across all batch lookups. */
  batchLookupRateLimit: number;
  /**
   * Fastify `trustProxy`: false (default, use the socket address), true (trust
   * every X-Forwarded-For hop), a hop count, or a comma-separated IP/CIDR list.
   */
  trustProxy: boolean | number | string;
  logLevel: string;
  /** POST /v1/telemetry requests per client IP per minute. */
  telemetryRateLimit: number;
  /** Telemetry rows older than this are deleted. */
  telemetryRetentionDays: number;
  /** Events one install may store per 24h; the excess is dropped (not rejected). */
  telemetryMaxEventsPerInstallDay: number;
  /** Table-size safety cap (planner estimate): above it, reports are dropped. */
  telemetryMaxRows: number;
  /** On-disk size cap for the telemetry table (pg_total_relation_size): above it, reports are dropped. */
  telemetryMaxBytes: number;
  /** Installs asked to also send `debug` events: a set of install ids, or 'all'. */
  telemetryDebugInstalls: ReadonlySet<string> | 'all';
  /** smtp(s):// URL for sign-up codes; null = no mail. */
  smtpUrl: string | null;
  mailFrom: string;
  /**
   * Deprecated input (EMAIL_VERIFICATION=required): read only by validateConfig, which turns it
   * into signupProof 'email' when signupProof is 'none'. Use signupProof.
   */
  emailRequired: boolean;
  /**
   * What a new account must prove (SIGNUP_PROOF): 'none', 'email' (an email code or Google, the
   * old EMAIL_VERIFICATION=required) or 'google' (a Google account; one account per Google account).
   */
  signupProof: SignupProof;
  /** Whose spam reports count (SPAM_REPORTERS): 'all', or 'google' (Google-linked accounts and trusted admins). */
  spamReporters: SpamReporters;
  /** OAuth web client IDs accepted as the audience of Google ID tokens; empty = no Google sign-in. */
  googleClientIds: string[];
  /** POST /v1/email-codes requests per IP per hour. */
  emailCodeRateLimit: number;
}

export type SignupProof = 'none' | 'email' | 'google';
export type SpamReporters = 'all' | 'google';
export type PackKeyHolders = 'all' | 'google';
/** One PACK_APP_KEYS entry: a key id (1..65535) and 32 secret bytes as 64 hex characters. */
export interface PackAppKey {
  id: number;
  hex: string;
}

/** PACK_APP_KEYS (`2:<64 hex>,1:<64 hex>`) as entries; throws on a malformed one. */
export function parsePackAppKeys(raw: string): PackAppKey[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(\d{1,5}):([0-9a-fA-F]{64})$/.exec(s);
      if (!m || Number(m[1]) < 1 || Number(m[1]) > 65535) {
        throw new Error('PACK_APP_KEYS must be id:key pairs, e.g. 1:<64 hex> (id 1..65535, key `openssl rand -hex 32`)');
      }
      return { id: Number(m[1]), hex: m[2].toLowerCase() };
    });
}

export const MIN_ADMIN_CODE_LENGTH = 12;
const EXAMPLE_ADMIN_CODE = 'change-me-to-something-long';

function trustProxyEnv(): boolean | number | string {
  const raw = process.env.TRUST_PROXY?.trim() ?? '';
  if (raw === '' || /^(false|0|no|off)$/i.test(raw)) return false;
  if (/^(true|yes|on)$/i.test(raw)) return true;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  return raw;
}

/** Throws when the config is unsafe to run with. */
export function validateConfig(cfg: Config): Config {
  createVault(cfg.contactsKey); // throws on a missing or malformed CONTACTS_KEY
  if (cfg.packKey !== null) {
    createPackVault(cfg.packKey); // throws on a malformed PACK_KEY
    if (cfg.packKey.toLowerCase() === cfg.contactsKey.toLowerCase()) {
      throw new Error('PACK_KEY must differ from CONTACTS_KEY (openssl rand -hex 32)');
    }
  }
  if (cfg.adminCode !== null) {
    if (cfg.adminCode.length < MIN_ADMIN_CODE_LENGTH) {
      throw new Error(`ADMIN_CODE must be at least ${MIN_ADMIN_CODE_LENGTH} characters (try \`openssl rand -hex 12\`)`);
    }
    if (cfg.adminCode === EXAMPLE_ADMIN_CODE) {
      throw new Error('ADMIN_CODE is still the example value from .env.example; set your own random secret');
    }
  }
  if (!['none', 'email', 'google'].includes(cfg.signupProof)) {
    throw new Error('SIGNUP_PROOF must be none, email or google');
  }
  if (!['all', 'google'].includes(cfg.spamReporters)) {
    throw new Error('SPAM_REPORTERS must be all or google');
  }
  if (!['all', 'google'].includes(cfg.packKeyHolders)) {
    throw new Error('PACK_KEY_HOLDERS must be all or google');
  }
  if (!['local', 'online'].includes(cfg.lookupMode)) {
    throw new Error('LOOKUP_MODE must be local or online');
  }
  if (cfg.packAppKeys.length) {
    if (cfg.packKey === null) throw new Error('PACK_APP_KEYS needs PACK_KEY (format 2 is built from the same sealed numbers)');
    const ids = new Set(cfg.packAppKeys.map((k) => k.id));
    const hexes = new Set(cfg.packAppKeys.map((k) => k.hex.toLowerCase()));
    if (ids.size !== cfg.packAppKeys.length || hexes.size !== cfg.packAppKeys.length) {
      throw new Error('PACK_APP_KEYS: every key id and every key must be different');
    }
    if (hexes.has(cfg.packKey.toLowerCase()) || hexes.has(cfg.contactsKey.toLowerCase())) {
      throw new Error('PACK_APP_KEYS keys must differ from PACK_KEY and CONTACTS_KEY (openssl rand -hex 32)');
    }
  }
  // EMAIL_VERIFICATION=required is the old name for SIGNUP_PROOF=email.
  const signupProof = cfg.signupProof === 'none' && cfg.emailRequired ? 'email' : cfg.signupProof;
  if (signupProof === 'email' && !cfg.smtpUrl && !cfg.googleClientIds.length) {
    throw new Error('SIGNUP_PROOF=email (EMAIL_VERIFICATION=required) needs SMTP_URL or GOOGLE_CLIENT_IDS');
  }
  if (signupProof === 'google' && !cfg.googleClientIds.length) {
    throw new Error('SIGNUP_PROOF=google needs GOOGLE_CLIENT_IDS');
  }
  // One key holder per Google account: when every new account needs Google, so does the key.
  const packKeyHolders = signupProof === 'google' ? 'google' : cfg.packKeyHolders;
  return { ...cfg, signupProof, packKeyHolders };
}

function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer`);
  return n;
}

/** true, 1, yes, on (any case) = true; anything else, or unset, = false. */
const boolEnv = (name: string) => /^(true|1|yes|on)$/i.test(process.env[name]?.trim() ?? '');

function telemetryDebugEnv(): ReadonlySet<string> | 'all' {
  const raw = process.env.TELEMETRY_DEBUG_INSTALLS?.trim() ?? '';
  if (raw.toLowerCase() === 'all') return 'all';
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

/** DATABASE_URL, or one built from the POSTGRES_* variables (docker-compose). */
export function databaseUrlFromEnv(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const user = process.env.POSTGRES_USER ?? 'surecaller';
  const pass = process.env.POSTGRES_PASSWORD ?? '';
  const host = process.env.POSTGRES_HOST ?? 'localhost';
  const port = process.env.POSTGRES_PORT ?? '5432';
  const db = process.env.POSTGRES_DB ?? 'surecaller';
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return validateConfig({
    port: intEnv('PORT', 3000),
    host: process.env.HOST ?? '0.0.0.0',
    databaseUrl: databaseUrlFromEnv(),
    dbPoolMax: Math.max(2, intEnv('DB_POOL_MAX', 25)),
    dbStatementTimeoutMs: Math.max(0, intEnv('DB_STATEMENT_TIMEOUT_MS', 30_000)),
    adminCode: process.env.ADMIN_CODE?.trim() || null,
    contactsKey: process.env.CONTACTS_KEY?.trim() ?? '',
    packKey: process.env.PACK_KEY?.trim() || null,
    packInline: boolEnv('PACK_INLINE'),
    packAppKeys: parsePackAppKeys(process.env.PACK_APP_KEYS ?? ''),
    packKeyHolders: (process.env.PACK_KEY_HOLDERS?.trim().toLowerCase() || 'all') as PackKeyHolders,
    lookupMode: (process.env.LOOKUP_MODE?.trim().toLowerCase() || 'local') as 'local' | 'online',
    lookupDailyLimit: Math.max(1, intEnv('LOOKUP_DAILY_LIMIT', 2000)),
    lookupDailyEnforce: boolEnv('LOOKUP_DAILY_ENFORCE'),
    defaultRegion: (process.env.DEFAULT_REGION?.trim().toUpperCase() || 'PK') as CountryCode,
    spamThreshold: Math.max(1, intEnv('SPAM_THRESHOLD', 2)),
    publicUrl: process.env.PUBLIC_URL?.trim().replace(/\/+$/, '') || null,
    fcmServiceAccount: process.env.FCM_SERVICE_ACCOUNT?.trim() || null,
    downloadsDir: path.resolve(ROOT_DIR, process.env.DOWNLOADS_DIR ?? 'downloads'),
    siteDir: path.resolve(ROOT_DIR, process.env.SITE_DIR ?? 'site'),
    lookupRateLimit: Math.max(1, intEnv('LOOKUP_RATE_LIMIT', 120)),
    registerRateLimit: Math.max(1, intEnv('REGISTER_RATE_LIMIT', 10)),
    batchLookupRateLimit: Math.max(1, intEnv('BATCH_LOOKUP_RATE_LIMIT', 300)),
    trustProxy: trustProxyEnv(),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    // Per client IP. Behind a proxy without TRUST_PROXY every phone shares one IP, so keep it roomy.
    telemetryRateLimit: Math.max(1, intEnv('TELEMETRY_RATE_LIMIT', 120)),
    telemetryRetentionDays: Math.max(1, intEnv('TELEMETRY_RETENTION_DAYS', 14)),
    telemetryMaxEventsPerInstallDay: Math.max(1, intEnv('TELEMETRY_MAX_EVENTS_PER_INSTALL_DAY', 5000)),
    telemetryMaxRows: Math.max(1, intEnv('TELEMETRY_MAX_ROWS', 2_000_000)),
    telemetryMaxBytes: Math.max(1, intEnv('TELEMETRY_MAX_BYTES', 500 * 1024 * 1024)),
    telemetryDebugInstalls: telemetryDebugEnv(),
    smtpUrl: process.env.SMTP_URL?.trim() || null,
    mailFrom: process.env.MAIL_FROM?.trim() || 'SureCaller <noreply@localhost>',
    emailCodeRateLimit: Math.max(1, intEnv('EMAIL_CODE_RATE_LIMIT', 5)),
    googleClientIds: (process.env.GOOGLE_CLIENT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    emailRequired: process.env.EMAIL_VERIFICATION?.trim().toLowerCase() === 'required',
    signupProof: (process.env.SIGNUP_PROOF?.trim().toLowerCase() || 'none') as SignupProof,
    spamReporters: (process.env.SPAM_REPORTERS?.trim().toLowerCase() || 'all') as SpamReporters,
    ...overrides,
  });
}
