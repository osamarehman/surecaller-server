/**
 * The pack worker: keeps the offline name pack current off the API process.
 *
 *   node dist/pack-runner.js     # docker compose service `pack-worker` (same image and .env as the API)
 *
 * - Drains pack_dirty (numbers the database triggers queued, migrations/021_pack_dirty.sql):
 *   woken by NOTIFY pack_dirty (3 s debounce) and at least every 60 s. Removals go first.
 * - A full reconcile as a safety pass nightly at 03:00 Pakistan time (22:00 UTC), after a directory
 *   import (pack_meta.full_requested_at) and after a rotation swapped generations.
 * - Checks a sample of the sealed numbers at start (and before every full pass); until that check
 *   passes nothing is written.
 * - With PACK_APP_KEYS: keeps format 2 current from the same queue, and builds a format-2
 *   generation under the current key when there is none (first build, key rotation; syncFormat2),
 *   draining the live generations between its batches.
 *
 * Every write holds the generation's advisory lock, so a second worker (or an API run with
 * PACK_INLINE=true) only waits its turn. With PACK_INLINE=true the API runs this same loop itself
 * (server.ts), for a deployment without this service.
 */
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { loadConfig } from './config.js';
import { createPool, waitForDb } from './db.js';
import { migrate } from './migrate.js';
import { appKeys, initAppKeys, initPack, packVault } from './pack.js';
import {
  checkSealedNumbers,
  clearFullRequest,
  drainDirty,
  fullRequested,
  liveGenerationIds,
  PackAppKeyMismatch,
  PackKeyMismatch,
  reconcilePack,
  syncFormat2,
  type DrainResult,
} from './pack-build.js';
import { initVault } from './vault.js';

/** 03:00 in Pakistan (UTC+5, no daylight saving). */
const NIGHTLY_UTC_HOUR = 22;
/** The same error is logged again at most this often. */
const REPEAT_ERROR_MS = 10 * 60_000;

export interface RunnerLog {
  info(msg: string): void;
  error(msg: string): void;
}

export interface RunnerOpts {
  /** Wait after a NOTIFY before draining, so a burst of writes shares one drain. */
  debounceMs?: number;
  /** Drain at least this often, also when no NOTIFY arrives. */
  pollMs?: number;
  /** Argon2 cost of a new format-2 generation (tests); default the production cost. */
  format2Params?: { t: number; m: number; p: number };
}

/** The next nightly pass after `now` (ms). */
export function nextNightly(now: number): number {
  const d = new Date(now);
  d.setUTCHours(NIGHTLY_UTC_HOUR, 0, 0, 0);
  if (d.getTime() <= now) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

const drained = (what: string, r: DrainResult) =>
  `name pack: ${what} ${r.numbers} queued numbers, ${r.upserted} updated, ${r.deleted} deleted, ${r.hashed} hashed in ${r.ms} ms` +
  (r.collisions ? ` (${r.collisions} format-2 entries skipped: tag collision)` : '');

export interface PackRunner {
  stop(): Promise<void>;
}

/** Runs the drain loop on `pool` until stop(). Needs PACK_KEY (initPack) to do anything. */
export function startPackRunner(pool: pg.Pool, databaseUrl: string, log: RunnerLog, opts: RunnerOpts = {}): PackRunner {
  const debounceMs = opts.debounceMs ?? 3_000;
  const pollMs = opts.pollMs ?? 60_000;
  let stopped = false;
  let checked = false;
  let nightlyAt = nextNightly(Date.now());
  /** The live generations last seen (salt ids), to notice a rotation or a format-2 swap. */
  let lastLive: string | null = null;
  let lastError = { msg: '', at: 0 };

  let wake: (() => void) | null = null;
  let soon: NodeJS.Timeout | undefined;
  const onNotify = () => {
    soon ??= setTimeout(() => {
      soon = undefined;
      wake?.();
    }, debounceMs);
  };
  const sleep = () =>
    new Promise<void>((resolve) => {
      const t = setTimeout(done, pollMs);
      function done() {
        clearTimeout(t);
        wake = null;
        resolve();
      }
      wake = done;
    });

  const fail = (err: unknown) => {
    const msg =
      err instanceof PackKeyMismatch
        ? `${err.message}. Restore the original PACK_KEY in .env.`
        : err instanceof PackAppKeyMismatch
          ? `${err.message}. Restore the original value of key ${err.keyId} in PACK_APP_KEYS (.env); to replace ` +
            'the key, put a new key with a new id at the front instead. Format 1 (GET /v1/pack) is not affected.'
          : `name pack: ${(err as Error).message ?? String(err)}`;
    if (msg !== lastError.msg || Date.now() - lastError.at > REPEAT_ERROR_MS) {
      log.error(msg);
      lastError = { msg, at: Date.now() };
    }
  };

  // LISTEN on its own connection (a pooled one would be handed to other queries); reconnects.
  let listener: pg.Client | null = null;
  const listen = async () => {
    if (stopped) return;
    const c = new pg.Client({ connectionString: databaseUrl });
    let retried = false;
    const retry = (err: Error) => {
      if (retried || stopped) return;
      retried = true;
      if (listener === c) listener = null;
      c.end().catch(() => {});
      fail(new Error(`LISTEN connection lost (${err.message}); retrying in 5 s, polling meanwhile`));
      setTimeout(() => void listen(), 5_000).unref();
    };
    c.on('notification', onNotify);
    c.on('error', retry);
    try {
      await c.connect();
      await c.query('LISTEN pack_dirty');
      if (stopped) return void c.end().catch(() => {});
      listener = c;
      onNotify(); // anything queued while we were not listening
    } catch (err) {
      retry(err as Error);
    }
  };

  const pass = async () => {
    if (!packVault()) return;
    try {
      if (!checked) {
        await checkSealedNumbers(pool);
        checked = true;
      }
      // Removals never wait behind a full pass.
      const removals = await drainDirty(pool, { removalsOnly: true });
      if (removals?.numbers) log.info(drained('removed', removals));

      const live = (await liveGenerationIds(pool)).join(',');
      const requested = await fullRequested(pool);
      const nightly = Date.now() >= nightlyAt;
      const rotated = lastLive !== null && live !== lastLive;
      if (requested || nightly || rotated) {
        const why = [requested && 'directory import', nightly && 'nightly', rotated && 'new generation'].filter(Boolean).join(', ');
        const r = await reconcilePack(pool);
        if (r) {
          log.info(
            `name pack: full pass (${why}): ${r.entries} entries, ${r.upserted} updated, ${r.deleted} deleted, ` +
              `${r.hashed} hashed, ${r.purged} purged in ${r.ms} ms`,
          );
          for (const f of r.format2 ?? []) {
            log.info(
              `name pack format 2 (generation ${f.saltId}): ${f.entries} entries, ${f.upserted} updated, ${f.deleted} deleted, ` +
                `${f.hashed} hashed, ${f.purged} purged, ${2 ** f.partBits} parts` +
                (f.collisions ? `, ${f.collisions} skipped (tag collision)` : ''),
            );
            if (f.drift) log.error(`name pack format 2 (generation ${f.saltId}): ${f.drift} parts had drifted from their entries; fixed`);
          }
          if (requested) await clearFullRequest(pool, requested);
          if (nightly) nightlyAt = nextNightly(Date.now());
          lastLive = (await liveGenerationIds(pool)).join(',');
        }
      } else lastLive = live;

      const r = await drainDirty(pool);
      if (r?.numbers) log.info(drained('drained', r));

      // Format 2: the first build, or a rotation after a new key went to the front of
      // PACK_APP_KEYS. Long (Argon2 of every number); the live generations drain meanwhile.
      const f2 = await syncFormat2(pool, {
        params: opts.format2Params,
        onBuild: (saltId, keyId) =>
          log.info(`name pack format 2: building generation ${saltId} under pack key ${keyId}; format 1 keeps serving meanwhile`),
      });
      if (f2?.dropped.length) log.info(`name pack format 2: deleted generation(s) ${f2.dropped.join(', ')} (retired or replaced)`);
      if (f2?.built) {
        const b = f2.built;
        log.info(
          `name pack format 2: generation ${b.saltId} (pack key ${b.keyId}) is live: ${b.counts.entries} entries, ` +
            `${b.counts.hashed} hashed, ${2 ** b.partBits} parts in ${b.ms} ms` +
            (b.replaced
              ? b.replaced.retiring
                ? `; generation ${b.replaced.saltId} retires (deletes only) for 14 days`
                : `; generation ${b.replaced.saltId} deleted (its key left PACK_APP_KEYS)`
              : ''),
        );
      }
    } catch (err) {
      // A failed sealed-number check stays failed until it passes again: nothing is written.
      if (/do not open/.test((err as Error).message ?? '')) checked = false;
      fail(err);
    }
  };

  const loop = (async () => {
    await listen();
    while (!stopped) {
      await pass();
      if (!stopped) await sleep();
    }
  })();

  return {
    async stop() {
      stopped = true;
      clearTimeout(soon);
      wake?.();
      await loop;
      await listener?.end().catch(() => {});
    },
  };
}

async function main() {
  const cfg = loadConfig();
  const stamp = () => new Date().toISOString();
  const log: RunnerLog = {
    info: (m) => console.log(`${stamp()} ${m}`),
    error: (m) => console.error(`${stamp()} ERROR ${m}`),
  };
  initVault(cfg.contactsKey);
  initPack(cfg.packKey);
  initAppKeys(cfg.packAppKeys);
  const pool = createPool(cfg.databaseUrl, { max: 4, statementTimeoutMs: cfg.dbStatementTimeoutMs });
  await waitForDb(pool, log.info);
  // Serialized with the API's own start-up run (advisory lock), so either may start first.
  await migrate(pool, log.info);

  let runner: PackRunner | null = null;
  if (!cfg.packKey) {
    log.info('pack worker: PACK_KEY is not set, so the offline name pack is off; idling');
    setInterval(() => {}, 1 << 30);
  } else {
    if (cfg.packInline) {
      log.info('pack worker: PACK_INLINE=true, so the API builds the pack too; both take turns on the lock');
    }
    // Key ids only: a key value never goes to a log.
    const ids = appKeys().map((k) => k.id);
    log.info(
      ids.length
        ? `pack worker: format 2 on, PACK_APP_KEYS ids ${ids.join(', ')} (current ${ids[0]})`
        : 'pack worker: format 2 off (no PACK_APP_KEYS); GET /v1/pack (format 1) only',
    );
    runner = startPackRunner(pool, cfg.databaseUrl, log);
    log.info(
      `pack worker: started; drains queued numbers on NOTIFY pack_dirty and every 60 s, full pass nightly at ` +
        `${String(NIGHTLY_UTC_HOUR).padStart(2, '0')}:00 UTC`,
    );
  }
  const shutdown = async (sig: string) => {
    log.info(`pack worker: ${sig} received, stopping`);
    await runner?.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
