import crypto from 'node:crypto';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { argon2id } from 'hash-wasm';

/**
 * Crypto for the offline name pack (docs/NAME_PACK.md in the app repo).
 *
 * - Every pack entry is opened with a key that only someone holding the number can derive:
 *   Argon2id(phone, salt) -> tag (8 bytes, the lookup handle) and an AES-256-GCM key.
 * - PACK_KEY (separate from CONTACTS_KEY) lets the server get numbers back to build entries:
 *   it seals `phone_enc` on contact / suggestion / directory rows, the cached Argon2 outputs and
 *   the fingerprints used to skip unchanged answers. Without PACK_KEY the pack is off.
 */

/** Argon2id cost and salt of one salt generation (a pack_meta row). */
export interface PackParams {
  salt: Buffer;
  t: number;
  m: number;
  p: number;
}

/** The production cost: about 20 ms per number on a desktop CPU. */
export const DEFAULT_PARAMS = { t: 2, m: 16384, p: 1 } as const;

/** password: the E.164 number (format 1) or v2Password (format 2). */
export async function argon2(phone: string | Uint8Array, prm: PackParams): Promise<Buffer> {
  return Buffer.from(
    await argon2id({
      password: phone,
      salt: prm.salt,
      iterations: prm.t,
      memorySize: prm.m,
      parallelism: prm.p,
      hashLength: 32,
      outputType: 'binary',
    }),
  );
}

/** tag = HMAC(h, "surecaller/pack/tag")[0..8), key = HMAC(h, "surecaller/pack/key"). */
export function entryKeys(h: Buffer): { tag: Buffer; key: Buffer } {
  const mac = (msg: string) => crypto.createHmac('sha256', h).update(msg).digest();
  return { tag: mac('surecaller/pack/tag').subarray(0, 8), key: mac('surecaller/pack/key') };
}

/**
 * Format 2 (keyed): the Argon2 password is HMAC-SHA256(packKey, "surecaller/pack/v2/pw" || phone)
 * instead of the number, so nothing opens without the pack key (PACK_APP_KEYS).
 */
export function v2Password(packKey: Buffer, phone: string): Buffer {
  return crypto.createHmac('sha256', packKey).update('surecaller/pack/v2/pw').update(phone, 'utf8').digest();
}

/** Format 2: tag = HMAC(h, "surecaller/pack/v2/tag")[0..8), key = HMAC(h, "surecaller/pack/v2/key"). */
export function entryKeysV2(h: Buffer): { tag: Buffer; key: Buffer } {
  const mac = (msg: string) => crypto.createHmac('sha256', h).update(msg).digest();
  return { tag: mac('surecaller/pack/v2/tag').subarray(0, 8), key: mac('surecaller/pack/v2/key') };
}

/** A format-2 entry's part key: the tag's first two bytes, big-endian. */
export const tag16Of = (tag: Buffer): number => (tag[0] << 8) | tag[1];

/** A format-2 entry's share of its part digest: SHA-256(tag || blob)[0..8). */
export const h8Of = (tag: Buffer, blob: Buffer): Buffer =>
  crypto.createHash('sha256').update(tag).update(blob).digest().subarray(0, 8);

/** HMAC(packKey, "surecaller/pack/app/check"), kept in pack_meta to catch a changed PACK_APP_KEYS value. */
export const appKeyCheck = (packKey: Buffer): Buffer =>
  crypto.createHmac('sha256', packKey).update('surecaller/pack/app/check').digest();

/** blob = nonce(12) || AES-256-GCM(key, nonce, plaintext, aad = tag) || gcmTag(16). */
export function sealEntry(key: Buffer, tag: Buffer, plaintext: string, nonce = crypto.randomBytes(12)): Buffer {
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(tag);
  return Buffer.concat([nonce, c.update(plaintext, 'utf8'), c.final(), c.getAuthTag()]);
}

/** null when the blob doesn't open under this key / tag. */
export function openEntry(key: Buffer, tag: Buffer, blob: Buffer): string | null {
  if (blob.length < 12 + 16) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
    d.setAAD(tag);
    d.setAuthTag(blob.subarray(blob.length - 16));
    return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * The entry plaintext, keys in the documented order. Format 2 adds `p` (photo URL) when there
 * is one; there `n` and `s` may be null for an entry that carries only a photo.
 */
export interface PackAnswer {
  n: string | null;
  s: 'member' | 'contacts' | 'directory' | 'suggested' | null;
  c: string | null;
  k: number;
  m: boolean;
  p?: string | null;
}

/**
 * The entry plaintext: JSON padded with trailing spaces to a multiple of 32 bytes, so blob
 * lengths don't give away name lengths. JSON parsers ignore the padding.
 */
export function answerJson(a: PackAnswer): string {
  const json = JSON.stringify({ n: a.n, s: a.s, c: a.c, k: a.k, m: a.m, ...(a.p ? { p: a.p } : {}) });
  const pad = (32 - (Buffer.byteLength(json, 'utf8') % 32)) % 32;
  return json + ' '.repeat(pad);
}

export interface PackVault {
  sealPhone(phone: string): Buffer;
  /** null when corrupt or sealed under another key. */
  openPhone(blob: Buffer): string | null;
  /** Seals a cached Argon2 output, bound to its phone_hash. */
  sealKey(phoneHash: Buffer, h: Buffer): Buffer;
  openKey(phoneHash: Buffer, blob: Buffer): Buffer | null;
  /** Keyed fingerprint of an entry plaintext: equal answers, equal fp. */
  fp(plaintext: string): Buffer;
  /** A sealed fixed text, stored in pack_meta to detect a changed PACK_KEY. */
  canary(): Buffer;
  checkCanary(blob: Buffer): boolean;
}

const CANARY = 'surecaller/pack/canary/v1';

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

export function createPackVault(keyHex: string): PackVault {
  const master = Buffer.from(keyHex, 'hex');
  if (master.length !== 32) throw new Error('PACK_KEY must be 64 hex characters (openssl rand -hex 32)');
  const derive = (info: string) => Buffer.from(crypto.hkdfSync('sha256', master, '', info, 32));
  const phoneKey = derive('surecaller/pack/phone/v1');
  const argonKey = derive('surecaller/pack/argon/v1');
  const fpKey = derive('surecaller/pack/fp/v1');

  const seal = (key: Buffer, data: Buffer, aad?: Buffer) => {
    const iv = crypto.randomBytes(IV_LEN);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    if (aad) c.setAAD(aad);
    const ct = Buffer.concat([c.update(data), c.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), ct]);
  };
  const open = (key: Buffer, blob: Buffer, aad?: Buffer): Buffer | null => {
    if (blob.length < 1 + IV_LEN + TAG_LEN || blob[0] !== VERSION) return null;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(1, 1 + IV_LEN));
      if (aad) d.setAAD(aad);
      d.setAuthTag(blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN));
      return Buffer.concat([d.update(blob.subarray(1 + IV_LEN + TAG_LEN)), d.final()]);
    } catch {
      return null;
    }
  };

  return {
    sealPhone: (phone) => seal(phoneKey, Buffer.from(phone, 'utf8')),
    openPhone: (blob) => open(phoneKey, blob)?.toString('utf8') ?? null,
    sealKey: (phoneHash, h) => seal(argonKey, h, phoneHash),
    openKey: (phoneHash, blob) => open(argonKey, blob, phoneHash),
    fp: (plaintext) => crypto.createHmac('sha256', fpKey).update(plaintext, 'utf8').digest(),
    canary: () => seal(phoneKey, Buffer.from(CANARY, 'utf8')),
    checkCanary: (blob) => open(phoneKey, blob)?.toString('utf8') === CANARY,
  };
}

// Like vault(): one process-wide PACK_KEY, set by initPack before the app serves requests.
let current: PackVault | null = null;

export function initPack(keyHex: string | null): PackVault | null {
  current = keyHex ? createPackVault(keyHex) : null;
  return current;
}

/** null when PACK_KEY is not set (the pack is off). */
export function packVault(): PackVault | null {
  return current;
}

/** One pack key of PACK_APP_KEYS. */
export interface AppKey {
  id: number;
  key: Buffer;
}

// Like `current`: the process-wide PACK_APP_KEYS, current first. Empty = format 2 off.
let appKeyList: AppKey[] = [];

export function initAppKeys(keys: readonly { id: number; hex: string }[]): AppKey[] {
  appKeyList = keys.map((k) => ({ id: k.id, key: Buffer.from(k.hex, 'hex') }));
  return appKeyList;
}

/** PACK_APP_KEYS, current first; empty when format 2 is off. */
export function appKeys(): readonly AppKey[] {
  return appKeyList;
}

/** sealPhone when the pack is on, else null (nothing written). */
export function sealPhoneOrNull(phone: string): Buffer | null {
  return current ? current.sealPhone(phone) : null;
}

const workerUrl = new URL(import.meta.url.endsWith('.ts') ? './pack-worker.ts' : './pack-worker.js', import.meta.url);

/** PACK_WORKERS, else one per CPU but one, at most 4 (each hash holds m KiB of memory). */
export function defaultWorkers(): number {
  const env = Number.parseInt(process.env.PACK_WORKERS ?? '', 10);
  return Number.isFinite(env) && env >= 0 ? env : Math.min(4, Math.max(1, os.cpus().length - 1));
}

/**
 * Argon2id of many numbers, in input order, on `workers` threads. Small batches run inline:
 * a worker costs more to start than a few hashes.
 */
export async function argon2Many(
  phones: (string | Uint8Array)[],
  prm: PackParams,
  workers = defaultWorkers(),
): Promise<Buffer[]> {
  if (workers <= 0 || phones.length < 16) {
    const out: Buffer[] = [];
    for (const p of phones) out.push(await argon2(p, prm));
    return out;
  }
  const CHUNK = 64;
  const out: Buffer[] = new Array(phones.length);
  let next = 0;
  const pool: Worker[] = [];
  try {
    for (let i = Math.min(workers, Math.ceil(phones.length / CHUNK)); i > 0; i--) pool.push(new Worker(workerUrl));
    await Promise.all(
      pool.map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            const send = () => {
              if (next >= phones.length) return resolve();
              const start = next;
              next += CHUNK;
              // A Buffer may be a view on a shared pool: send copies of just its bytes.
              const chunk = phones.slice(start, start + CHUNK).map((x) => (typeof x === 'string' ? x : new Uint8Array(x)));
              w.postMessage({ id: start, phones: chunk, salt: prm.salt, t: prm.t, m: prm.m, p: prm.p });
            };
            w.on('message', (msg: { id: number; hashes?: Uint8Array[]; error?: string }) => {
              if (msg.error || !msg.hashes) return reject(new Error(`argon2 worker: ${msg.error}`));
              msg.hashes.forEach((h, i) => (out[msg.id + i] = Buffer.from(h)));
              send();
            });
            w.on('error', reject);
            // A worker that dies without an error event (OOM kill, process.exit) must not hang us.
            w.on('exit', (code) => reject(new Error(`argon2 worker exited (code ${code})`)));
            send();
          }),
      ),
    );
  } finally {
    await Promise.all(pool.map((w) => w.terminate()));
  }
  return out;
}
