import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CountryCode } from 'libphonenumber-js';
import { createVault } from './vault.js';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = '1.0.0';

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  adminCode: string | null;
  /** 64 hex chars; encrypts shared contact names at rest (src/vault.ts). */
  contactsKey: string;
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
  if (cfg.adminCode !== null) {
    if (cfg.adminCode.length < MIN_ADMIN_CODE_LENGTH) {
      throw new Error(`ADMIN_CODE must be at least ${MIN_ADMIN_CODE_LENGTH} characters (try \`openssl rand -hex 12\`)`);
    }
    if (cfg.adminCode === EXAMPLE_ADMIN_CODE) {
      throw new Error('ADMIN_CODE is still the example value from .env.example; set your own random secret');
    }
  }
  return cfg;
}

function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer`);
  return n;
}

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
    adminCode: process.env.ADMIN_CODE?.trim() || null,
    contactsKey: process.env.CONTACTS_KEY?.trim() ?? '',
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
    ...overrides,
  });
}
