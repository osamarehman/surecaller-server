import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, parse } from '../http.js';
import { VERSION } from '../config.js';
import { lockCircle, withTx } from '../db.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { maskPhone, requirePhone } from '../phone.js';
import { canonicalInviteCode, hashToken, newToken, safeEqual } from '../tokens.js';
import { getUser, toUser, type UserRow } from '../users.js';

const RegisterBody = z.object({
  phone: z.string(),
  name: z.string().trim().max(60).optional(),
  code: z.string().max(200).optional().default(''),
  deviceName: z.string().trim().max(100).nullish(),
});

const PrivacyRequestBody = z.object({
  kind: z.enum(['account', 'remove']),
  phone: z.string().max(40),
  email: z.string().trim().email().max(200),
});

const invalidCode = () => new AppError(403, 'invalid_code', 'Invite or admin code is not valid');

export async function publicRoutes(app: FastifyInstance) {
  const { cfg, pool } = app.ctx;

  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
    } catch {
      return reply.status(503).send({ error: 'db_unavailable', message: 'Database not reachable' });
    }
    return { ok: true, version: VERSION };
  });

  app.post(
    '/v1/register',
    { bodyLimit: 4096, config: { rateLimit: { max: cfg.registerRateLimit, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parse(RegisterBody, req.body);
      const phone = requirePhone(body.phone, cfg.defaultRegion);
      const code = body.code.trim();
      const token = newToken();

      const { userId, adminTakeover } = await withTx(pool, async (c) => {
        // Serialize registrations so two people can't both bootstrap as admin.
        await lockCircle(c);
        const existing = (
          await c.query<UserRow>(
            `SELECT u.*, f.trusted FROM users u JOIN families f ON f.id = u.family_id
             WHERE u.phone = $1 FOR UPDATE OF u`,
            [phone],
          )
        ).rows[0];
        const newFamily = async (trusted: boolean) =>
          (await c.query<{ id: string }>('INSERT INTO families (trusted) VALUES ($1) RETURNING id', [trusted]))
            .rows[0].id;

        let makeAdmin = false;
        let adminTakeover: { id: string; name: string } | null = null;
        let inviteCode: string | null = null;
        let familyId: string | null = null; // the family a new member joins
        // Case-insensitive: the app uppercases every code it sends, and `openssl rand -hex` is lowercase.
        if (code && cfg.adminCode && safeEqual(code.toUpperCase(), cfg.adminCode.toUpperCase())) {
          const op = (await c.query<{ id: string }>('SELECT id FROM families WHERE trusted LIMIT 1')).rows[0];
          if (op) {
            // ADMIN_CODE set up the trusted (operator's) family; after that it only lets that
            // family's admins re-register. It stays open on purpose: a sole admin who loses their
            // phone has no other way back in. That makes ADMIN_CODE a master credential (it rotates
            // that admin's token and signs the old device out), so every such use is logged below.
            if (!existing?.is_admin || existing.family_id !== op.id) throw invalidCode();
            adminTakeover = { id: existing.id, name: existing.name };
          } else if (existing) {
            await c.query('UPDATE families SET trusted = true WHERE id = $1', [existing.family_id]);
          } else {
            familyId = await newFamily(true);
          }
          makeAdmin = true;
        } else if (code) {
          // A non-empty code is treated as an invite code: it joins the inviter's family.
          const invite = (
            await c.query<{ code: string; phone: string | null; family_id: string }>(
              `SELECT code, phone, family_id FROM invites
               WHERE code = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
              [canonicalInviteCode(code)],
            )
          ).rows[0];
          if (!invite) throw invalidCode();
          // A phone-bound invite only works for that exact phone.
          if (invite.phone !== null && invite.phone !== phone) throw invalidCode();
          if (invite.phone === null && existing) {
            throw conflict('phone_taken', 'This number is already registered; ask an admin to reset your device');
          }
          // Resetting a device never moves a member into another family.
          if (existing && existing.family_id !== invite.family_id) throw invalidCode();
          await c.query('UPDATE invites SET used_at = now() WHERE code = $1', [invite.code]);
          inviteCode = invite.code;
          familyId = invite.family_id;
        } else {
          // Open sign-up: no code needed. A brand-new number starts its own family as its admin;
          // an existing number can't be taken over without an admin reset (anti-hijack).
          if (existing) {
            throw conflict('phone_taken', 'This number is already registered; ask an admin to reset your device');
          }
          familyId = await newFamily(false);
          makeAdmin = true;
        }

        let id: string;
        if (existing) {
          await c.query(
            `UPDATE users SET token_hash = $2, device_name = coalesce($3, device_name),
               name = coalesce(nullif($4, ''), name), is_admin = is_admin OR $5,
               fcm_token = NULL, last_seen_at = now()
             WHERE id = $1`,
            [existing.id, hashToken(token), body.deviceName ?? null, body.name ?? null, makeAdmin],
          );
          id = existing.id;
        } else {
          if (!body.name) throw badRequest('invalid_request', 'name: required');
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO users (phone, name, is_admin, family_id, device_name, token_hash, last_seen_at)
             VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id`,
            [phone, body.name, makeAdmin, familyId, body.deviceName ?? null, hashToken(token)],
          );
          id = rows[0].id;
        }
        if (inviteCode) await c.query('UPDATE invites SET used_by = $2 WHERE code = $1', [inviteCode, id]);
        return { userId: id, adminTakeover };
      });

      // Audit trail for the master credential: logged after commit so a rolled-back attempt
      // does not show up as a takeover. Phone masked; the IP is what the rate limiter sees.
      if (adminTakeover) {
        req.log.warn(
          {
            userId: adminTakeover.id,
            name: adminTakeover.name,
            phone: maskPhone(phone),
            ip: req.ip,
            deviceName: body.deviceName ?? null,
          },
          'ADMIN_CODE used to re-register an existing admin: token rotated, previous device signed out',
        );
      }

      const user = await getUser(pool, userId);
      return reply.status(201).send({ token, user: toUser(user!) });
    },
  );

  // From the website's delete page. Nothing is deleted here: the operator checks the number
  // belongs to the requester, then applies it with src/cli/privacy.ts.
  app.post(
    '/v1/privacy-requests',
    { bodyLimit: 1024, config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const b = parse(PrivacyRequestBody, req.body);
      const phone = requirePhone(b.phone, cfg.defaultRegion);
      await pool.query(
        `INSERT INTO privacy_requests (kind, phone, email) VALUES ($1, $2, $3)
         ON CONFLICT (kind, phone) DO UPDATE SET email = EXCLUDED.email, created_at = now()`,
        [b.kind, phone, b.email],
      );
      req.log.warn({ kind: b.kind, phone: maskPhone(phone) }, 'privacy request received: run dist/cli/privacy.js');
      return reply.status(202).send({ ok: true });
    },
  );

  // Parsed downloads/latest.json, re-read only when its mtime or size changes.
  type Release = {
    versionCode: number;
    versionName: string;
    apkUrl: string;
    notes: string;
    sha256: string | null;
    minVersionCode: number | null;
    mandatory: boolean;
  };
  let release: { key: string; value: Release } | null = null;

  const loadRelease = async (log: FastifyInstance['log']): Promise<Release> => {
    const file = path.join(cfg.downloadsDir, 'latest.json');
    let key: string;
    try {
      const st = await fs.stat(file);
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      release = null;
      throw notFound('No app release published yet');
    }
    if (release?.key === key) return release.value;
    let info: Record<string, unknown>;
    try {
      info = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('No app release published yet');
      throw new AppError(500, 'bad_release_file', 'downloads/latest.json is not valid JSON');
    }
    // sha256 is required for silent installs; without it (old latest.json, or null as in the
    // example file) the app only offers a manual, user-confirmed install. Malformed = missing.
    const sha256 =
      typeof info.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(info.sha256.trim())
        ? info.sha256.trim().toLowerCase()
        : null;
    // Logged once per file version (the cache key), not on every request.
    if (sha256 === null) log.warn('downloads/latest.json has no valid sha256: clients will not auto-install');
    const minVersionCode = Number(info.minVersionCode);
    const value: Release = {
      versionCode: Number(info.versionCode) || 0,
      versionName: typeof info.versionName === 'string' ? info.versionName : '',
      apkUrl: typeof info.apkUrl === 'string' ? info.apkUrl : 'surecaller.apk',
      notes: typeof info.notes === 'string' ? info.notes : '',
      sha256,
      minVersionCode: Number.isInteger(minVersionCode) && minVersionCode > 0 ? minVersionCode : null,
      mandatory: info.mandatory === true,
    };
    release = { key, value };
    return value;
  };

  app.get('/v1/app/latest', { onRequest: authenticate }, async (req) => {
    const r = await loadRelease(req.log);
    let apkUrl = r.apkUrl;
    if (!/^https?:\/\//i.test(apkUrl)) {
      // A Host-derived base would be http:// behind the proxy, and the app refuses to
      // download over plain http: better a clear error than a link that never installs.
      if (!cfg.publicUrl) {
        req.log.warn('PUBLIC_URL is not set: cannot build the APK download link from a relative apkUrl');
        throw new AppError(
          503,
          'public_url_unset',
          'Server has no PUBLIC_URL configured; the admin must set it before updates can be served',
        );
      }
      const rel = apkUrl.replace(/^\/+/, '');
      apkUrl = `${cfg.publicUrl}/${rel.startsWith('downloads/') ? rel : `downloads/${rel}`}`;
    }
    return { ...r, apkUrl };
  });
}
