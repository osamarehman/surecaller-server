import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, parse } from '../http.js';
import { VERSION } from '../config.js';
import { lockCircle, withTx, type Client } from '../db.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { maskPhone, requirePhone } from '../phone.js';
import { canonicalInviteCode, hashToken, newToken, safeEqual } from '../tokens.js';
import {
  canonicalEmail,
  Email,
  EmailProof,
  emailTaken,
  issueEmailCode,
  proveIdentity,
  spendEmailCode,
} from '../email.js';
import { refreshSpamForUser, spamReporters } from '../lookup.js';
import { getUser, toMe, type UserRow } from '../users.js';
import { vault } from '../vault.js';

const RegisterBody = z.object({
  // Optional only for "sign in with email": a verified email and no phone finds the account by email.
  phone: z.string().optional(),
  name: z.string().trim().max(60).optional(),
  code: z.string().max(200).optional().default(''),
  deviceName: z.string().trim().max(100).nullish(),
  // A verified email: a Google ID token, or email + a code from POST /v1/email-codes. Required for
  // new accounts with SIGNUP_PROOF=email (a Google ID token with SIGNUP_PROOF=google), and signs an
  // existing member in on a new phone.
  ...EmailProof,
});

const EmailCodeBody = z.object({ email: Email });

const PrivacyRequestBody = z.object({
  kind: z.enum(['account', 'remove']),
  phone: z.string().max(40),
  email: z.string().trim().pipe(z.email().max(200)),
});

const phoneTaken = () =>
  conflict(
    'phone_taken',
    'This number is already registered; sign in with its email or ask an admin to reset your device',
  );

const invalidCode = () => new AppError(403, 'invalid_code', 'Invite or admin code is not valid');

const googleRequired = () =>
  new AppError(
    403,
    'google_required',
    'New accounts need a Google account. Tap “Continue with Google”, or update SureCaller from Google Play.',
  );

const googleAccountTaken = (phone: string) =>
  conflict(
    'email_taken',
    `This Google account already has a SureCaller account (number ending ${phone.slice(-4)}). Sign in with Google instead.`,
  );

export async function publicRoutes(app: FastifyInstance) {
  const { cfg, pool } = app.ctx;

  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
    } catch {
      return reply.status(503).send({ error: 'db_unavailable', message: 'Database not reachable' });
    }
    // signupProof only when set, so the answer stays as it was for servers that don't use it
    // (the app reads a missing one as 'none').
    return { ok: true, version: VERSION, ...(cfg.signupProof !== 'none' ? { signupProof: cfg.signupProof } : {}) };
  });

  app.post(
    '/v1/register',
    { bodyLimit: 4096, config: { rateLimit: { max: cfg.registerRateLimit, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parse(RegisterBody, req.body);
      const code = body.code.trim();
      const token = newToken();
      const proof = await proveIdentity(app.ctx, body);
      const email = proof?.email ?? null;
      const sub = proof?.sub ?? null; // set only for a Google proof

      // With SPAM_REPORTERS=google a newly linked account's reports start counting: relabel them.
      const linked = async (c: Client, id: string) => {
        if (spamReporters() === 'google') await refreshSpamForUser(c, id, cfg.spamThreshold);
      };

      // Sign in with email: the verified email finds the account, whatever SIM this phone has.
      if (body.phone === undefined) {
        if (!email) throw badRequest('invalid_request', 'phone: required');
        if (code) throw badRequest('invalid_request', 'Sign in with email takes no code');
        const id = await withTx(pool, async (c) => {
          await spendEmailCode(c, email);
          const noAccount = () => new AppError(404, 'no_account', 'No account uses this email; sign up instead');
          if (!sub) {
            // An email code: the account with that email, as before. No Google link.
            const { rows } = await c.query<{ id: string }>(
              `UPDATE users SET token_hash = $2, device_name = coalesce($3, device_name),
                 fcm_token = NULL, last_seen_at = now()
               WHERE email = $1 RETURNING id`,
              [email, hashToken(token), body.deviceName ?? null],
            );
            if (!rows[0]) throw noAccount();
            return rows[0].id;
          }
          // Google: the account linked to this Google account, else an unlinked one with the same
          // address. It gets linked, and its email follows the Google account's.
          const { rows } = await c.query<{ id: string; google_sub: string | null }>(
            `SELECT id, google_sub FROM users
             WHERE google_sub = $1 OR (google_sub IS NULL AND email_canonical(email) = $2)
             ORDER BY google_sub IS NULL, email = $3 DESC, created_at
             LIMIT 1 FOR UPDATE`,
            [sub, canonicalEmail(email), email],
          );
          if (!rows[0]) throw noAccount();
          await c.query(
            `UPDATE users SET token_hash = $2, device_name = coalesce($3, device_name),
               fcm_token = NULL, last_seen_at = now(), email = $4, google_sub = $5, google_verified_at = now()
             WHERE id = $1`,
            [rows[0].id, hashToken(token), body.deviceName ?? null, email, sub],
          );
          if (rows[0].google_sub === null) await linked(c, rows[0].id);
          return rows[0].id;
        }).catch(emailTaken);
        return reply.status(201).send({ token, user: toMe((await getUser(pool, id))!) });
      }
      const phone = requirePhone(body.phone, cfg.defaultRegion);

      const { userId, adminTakeover } = await withTx(pool, async (c) => {
        if (email) await spendEmailCode(c, email);
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
        let bootstrap = false; // the first ADMIN_CODE sign-up, which sets up the operator's family
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
            bootstrap = true;
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
          if (invite.phone === null && existing) throw phoneTaken();
          // Resetting a device never moves a member into another family.
          if (existing && existing.family_id !== invite.family_id) throw invalidCode();
          await c.query('UPDATE invites SET used_at = now() WHERE code = $1', [invite.code]);
          inviteCode = invite.code;
          familyId = invite.family_id;
        } else {
          // Open sign-up: no code needed. A brand-new number starts its own family as its admin.
          // An existing number needs its account's verified email (or an admin reset) to sign in again:
          // with Google, the linked Google account, or the same address on an account not linked to
          // another one; with an email code, the account's email.
          if (existing) {
            const ok = sub
              ? existing.google_sub === sub ||
                (existing.google_sub === null &&
                  existing.email !== null &&
                  canonicalEmail(existing.email) === canonicalEmail(email!))
              : email !== null && existing.email === email;
            if (!ok) throw phoneTaken();
          } else {
            familyId = await newFamily(false);
            makeAdmin = true;
          }
        }
        if (!existing && cfg.signupProof === 'email' && !email) {
          throw badRequest('email_required', 'Verify an email address to create an account');
        }
        // One account per Google account. The first ADMIN_CODE sign-up (setting up the server) is
        // exempt. An email code sent along is not spent: the transaction rolls back.
        if (!existing && cfg.signupProof === 'google' && !bootstrap && !sub) throw googleRequired();

        let id: string;
        if (existing) {
          // A Google proof links an unlinked account; one linked to another Google account keeps its link.
          const link = sub !== null && existing.google_sub === null;
          await c.query(
            `UPDATE users SET token_hash = $2, device_name = coalesce($3, device_name),
               name = coalesce(nullif($4, ''), name), is_admin = is_admin OR $5,
               fcm_token = NULL, last_seen_at = now(), email = coalesce($6, email),
               google_sub = coalesce(google_sub, $7),
               google_verified_at = CASE WHEN $8 THEN now() ELSE google_verified_at END
             WHERE id = $1`,
            [
              existing.id,
              hashToken(token),
              body.deviceName ?? null,
              body.name ?? null,
              makeAdmin,
              email,
              link ? sub : null,
              sub !== null && (link || existing.google_sub === sub),
            ],
          );
          id = existing.id;
          if (link) await linked(c, id);
        } else {
          if (!body.name) throw badRequest('invalid_request', 'name: required');
          if (sub) {
            // A clear answer instead of a bare unique violation: which account this Google account has.
            const { rows: taken } = await c.query<{ phone: string }>(
              'SELECT phone FROM users WHERE google_sub = $1 OR email_canonical(email) = $2 LIMIT 1',
              [sub, canonicalEmail(email!)],
            );
            if (taken[0]) throw googleAccountTaken(taken[0].phone);
          }
          const { rows } = await c.query<{ id: string }>(
            // A new account made with Google starts with its Google picture. Signing in again never
            // changes the photo: the member may have removed it (PUT / DELETE /v1/me/photo).
            // phone_hash lets the name pack triggers queue the new member's number.
            `INSERT INTO users (phone, name, is_admin, family_id, device_name, token_hash, last_seen_at, email, photo_url,
               google_sub, google_verified_at, phone_hash)
             VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9::text, CASE WHEN $9::text IS NULL THEN NULL ELSE now() END, $10)
             RETURNING id`,
            [
              phone,
              body.name,
              makeAdmin,
              familyId,
              body.deviceName ?? null,
              hashToken(token),
              email,
              proof?.picture ?? null,
              sub,
              vault().index(phone),
            ],
          );
          id = rows[0].id;
        }
        if (inviteCode) await c.query('UPDATE invites SET used_by = $2 WHERE code = $1', [inviteCode, id]);
        return { userId: id, adminTakeover };
      }).catch(emailTaken);

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
      return reply.status(201).send({ token, user: toMe(user!) });
    },
  );

  // Emails a 6-digit sign-up code. Same answer whether or not the email has an account.
  app.post(
    '/v1/email-codes',
    { bodyLimit: 1024, config: { rateLimit: { max: cfg.emailCodeRateLimit, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const { email } = parse(EmailCodeBody, req.body);
      if (!app.ctx.mailer.enabled) throw new AppError(503, 'email_unavailable', 'This server cannot send email');
      const code = await issueEmailCode(pool, email);
      if (!code) throw new AppError(429, 'rate_limited', 'Wait a minute before asking for another code');
      try {
        await app.ctx.mailer.send(
          email,
          `Your SureCaller code: ${code}`,
          `Your SureCaller code is ${code}. It expires in 15 minutes.\n\nIf you didn't ask for it, ignore this email.`,
        );
      } catch (err) {
        await spendEmailCode(pool, email);
        req.log.error({ err }, 'sending the email code failed');
        throw new AppError(503, 'email_failed', 'Could not send the email, try again later');
      }
      return reply.status(202).send({ ok: true });
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
