import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { inject } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Notifier } from '../src/fcm.js';
import type { Mailer } from '../src/mail.js';
import { migrate } from '../src/migrate.js';

export const ADMIN_CODE = 'test-admin-code';

export interface Harness {
  app: FastifyInstance;
  pool: pg.Pool;
  cfg: Config;
  sent: { tokens: string[]; data: Record<string, string> }[];
  mails: { to: string; subject: string; text: string }[];
  close(): Promise<void>;
}

export async function createHarness(overrides: Partial<Config> = {}): Promise<Harness> {
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surecaller-dl-'));
  const cfg = loadConfig({
    databaseUrl: inject('databaseUrl'),
    adminCode: ADMIN_CODE,
    defaultRegion: 'PK',
    spamThreshold: 2,
    publicUrl: 'https://calls.example.com',
    fcmServiceAccount: null,
    downloadsDir,
    lookupRateLimit: 1000,
    registerRateLimit: 1000,
    emailCodeRateLimit: 1000,
    logLevel: 'silent',
    ...overrides,
  });
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 10 });
  await migrate(pool);
  await pool.query(`TRUNCATE families, users, invites, contacts, reports, name_suggestions, lookups,
    spam_state, blocks, events, url_reports, telemetry, email_codes, feedback RESTART IDENTITY CASCADE`);
  const sent: Harness['sent'] = [];
  const notifier: Notifier = {
    enabled: true,
    send: async (tokens, data) => {
      sent.push({ tokens, data });
    },
  };
  const mails: Harness['mails'] = [];
  const mailer: Mailer = {
    enabled: true,
    send: async (to, subject, text) => {
      mails.push({ to, subject, text });
    },
  };
  // Fake Google: a token "google:<email>" proves that email, anything else fails.
  const google = async (t: string) => (t.startsWith('google:') ? t.slice(7).toLowerCase() : null);
  const app = await buildApp(cfg, pool, notifier, mailer, google);
  await app.ready();
  return {
    app,
    pool,
    cfg,
    sent,
    mails,
    async close() {
      await app.close();
      await pool.end();
      fs.rmSync(downloadsDir, { recursive: true, force: true });
    },
  };
}

export interface Session {
  token: string;
  user: { id: string; phone: string; name: string; isAdmin: boolean };
}

export async function api(
  h: Harness,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  token?: string | null,
  body?: unknown,
) {
  const res = await h.app.inject({
    method,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

export async function registerAdmin(h: Harness, phone = '+923001234567', name = 'Abbu'): Promise<Session> {
  const r = await api(h, 'POST', '/v1/register', null, { phone, name, code: ADMIN_CODE, deviceName: 'Pixel' });
  if (r.status !== 201) throw new Error(`admin register failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function registerMember(h: Harness, admin: Session, phone: string, name: string): Promise<Session> {
  const inv = await api(h, 'POST', '/v1/invites', admin.token, { expiresInHours: 1 });
  const r = await api(h, 'POST', '/v1/register', null, { phone, name, code: inv.body.code });
  if (r.status !== 201) throw new Error(`member register failed: ${JSON.stringify(r.body)}`);
  return r.body;
}
