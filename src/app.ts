import fs from 'node:fs';
import path from 'node:path';
import Fastify, { LogController, type FastifyInstance, type FastifyReply } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type pg from 'pg';
import type { Config } from './config.js';
import { AppError, badRequest, tooManyRequests } from './errors.js';
import { createNotifier, type Notifier } from './fcm.js';
import { authenticate } from './http.js';
import { initVault } from './vault.js';
import type { UserRow } from './users.js';
import { publicRoutes } from './routes/public.js';
import { meRoutes } from './routes/me.js';
import { circleRoutes } from './routes/circle.js';
import { lookupRoutes } from './routes/lookup.js';
import { syncRoutes } from './routes/sync.js';
import { eventRoutes } from './routes/events.js';
import { checkRoutes } from './routes/check.js';
import { telemetryAdminRoutes, telemetryIngestRoutes } from './routes/telemetry.js';

// 20 000 contacts at ~100 bytes each is ~2 MB; leave generous headroom.
const BODY_LIMIT = 10 * 1024 * 1024;

export async function buildApp(cfg: Config, pool: pg.Pool, notifier?: Notifier): Promise<FastifyInstance> {
  const app = Fastify({
    logger: cfg.logLevel === 'silent' ? false : { level: cfg.logLevel },
    // Keep looked-up phone numbers out of the logs.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: BODY_LIMIT,
    // Only trust X-Forwarded-For when configured (TRUST_PROXY); otherwise anyone
    // could spoof their IP and dodge the per-IP register rate limit.
    trustProxy:
      typeof cfg.trustProxy === 'number'
        ? (_addr: string, hop: number) => hop < (cfg.trustProxy as number)
        : cfg.trustProxy,
  });

  initVault(cfg.contactsKey);
  app.decorate('ctx', {
    cfg,
    pool,
    notifier:
      notifier ??
      createNotifier(cfg.fcmServiceAccount, app.log, async (token) => {
        await pool.query('UPDATE users SET fcm_token = NULL WHERE fcm_token = $1', [token]);
      }),
  });
  app.decorateRequest('user', null as unknown as UserRow);

  // Accept empty JSON bodies (e.g. DELETE with Content-Type set).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim();
    if (!text) return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(badRequest('invalid_json', 'Body is not valid JSON'), undefined);
    }
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    const e = err as { code?: string; statusCode?: number; message?: string };
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send({ error: 'payload_too_large', message: 'Request body too large' });
    }
    if (e.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.status(415).send({ error: 'unsupported_media_type', message: 'Send application/json' });
    }
    if (e.statusCode === 429) {
      return reply.status(429).send({ error: 'rate_limited', message: 'Too many requests, slow down' });
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: 'bad_request', message: e.message ?? 'Bad request' });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'Something went wrong' });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: 'not_found', message: 'Not found' });
  });

  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) => tooManyRequests(ctx.ttl),
  });

  try {
    fs.mkdirSync(cfg.downloadsDir, { recursive: true });
  } catch {
    /* read-only mount is fine */
  }
  // Stable install links: `/` and `/download` always give the newest APK, and so does any
  // older `surecaller-*.apk` link. The newest one (latest.json's apkUrl) is served as is.
  const latestApk = async (): Promise<string | null> => {
    try {
      const { apkUrl } = JSON.parse(await fs.promises.readFile(path.join(cfg.downloadsDir, 'latest.json'), 'utf8'));
      return typeof apkUrl === 'string' && /^[\w.-]+\.apk$/.test(apkUrl) ? apkUrl : null;
    } catch {
      return null;
    }
  };
  const toLatest = (reply: FastifyReply, apk: string) =>
    reply.header('cache-control', 'no-store').redirect(`/downloads/${apk}`, 302);
  app.addHook('onRequest', async (req, reply) => {
    const m = /^\/downloads\/(surecaller-[\w.-]*\.apk)(?:\?|$)/.exec(req.url);
    if (!m) return;
    const apk = await latestApk();
    if (apk && apk !== m[1]) return toLatest(reply, apk);
  });
  // With a website in SITE_DIR, `/` is its home page; without one, `/` is an install link.
  const hasSite = fs.existsSync(path.join(cfg.siteDir, 'index.html'));
  for (const url of hasSite ? ['/download'] : ['/', '/download']) {
    app.get(url, async (_req, reply) => {
      const apk = await latestApk();
      if (!apk) throw new AppError(404, 'not_found', 'No app release published yet');
      return toLatest(reply, apk);
    });
  }

  await app.register(fastifyStatic, {
    root: cfg.downloadsDir,
    prefix: '/downloads/',
    index: false,
    list: false,
    dotfiles: 'deny',
  });

  if (hasSite) {
    await app.register(fastifyStatic, {
      root: cfg.siteDir,
      prefix: '/',
      decorateReply: false,
      extensions: ['html'], // /privacy -> privacy.html
      list: false,
      dotfiles: 'deny',
    });
  }

  await app.register(publicRoutes);
  await app.register(telemetryIngestRoutes);
  await app.register(async (v1) => {
    v1.addHook('onRequest', authenticate);
    await v1.register(meRoutes);
    await v1.register(circleRoutes);
    await v1.register(lookupRoutes);
    await v1.register(syncRoutes);
    await v1.register(eventRoutes);
    await v1.register(checkRoutes);
    await v1.register(telemetryAdminRoutes);
  }, { prefix: '/v1' });

  return app;
}
