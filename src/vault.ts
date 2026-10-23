import crypto from 'node:crypto';

/**
 * Encryption at rest for shared contact names, name suggestions and the lookup log.
 *
 * - A phone number is never stored: rows are keyed by `index(phone)`, an HMAC under a key
 *   derived from CONTACTS_KEY. The server can find rows for a number it is asked about, but
 *   can't list which numbers it holds.
 * - A name is sealed with AES-256-GCM under a key derived from CONTACTS_KEY *and the number*,
 *   so opening it needs both. A database dump alone reveals nothing, and nobody (admin
 *   included) can browse or export the address books: a name only comes back to someone who
 *   already has the number, through the rate-limited lookup.
 *
 * Losing CONTACTS_KEY makes every stored name unreadable: back it up with `.env`.
 */
export interface Vault {
  index(phone: string): Buffer;
  seal(phone: string, name: string): Buffer;
  /** null when the blob is corrupt or was sealed under another key / number. */
  open(phone: string, blob: Buffer): string | null;
}

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

export function createVault(keyHex: string): Vault {
  const master = Buffer.from(keyHex, 'hex');
  if (master.length !== 32) throw new Error('CONTACTS_KEY must be 64 hex characters (openssl rand -hex 32)');
  const derive = (info: string) => Buffer.from(crypto.hkdfSync('sha256', master, '', info, 32));
  const indexKey = derive('surecaller/index/v1');
  const nameKey = derive('surecaller/name/v1');
  const hmac = (key: Buffer, s: string) => crypto.createHmac('sha256', key).update(s).digest();

  return {
    index: (phone) => hmac(indexKey, phone),
    seal(phone, name) {
      const iv = crypto.randomBytes(IV_LEN);
      const c = crypto.createCipheriv('aes-256-gcm', hmac(nameKey, phone), iv);
      const ct = Buffer.concat([c.update(name, 'utf8'), c.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), ct]);
    },
    open(phone, blob) {
      if (blob.length < 1 + IV_LEN + TAG_LEN || blob[0] !== VERSION) return null;
      try {
        const d = crypto.createDecipheriv('aes-256-gcm', hmac(nameKey, phone), blob.subarray(1, 1 + IV_LEN));
        d.setAuthTag(blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN));
        return Buffer.concat([d.update(blob.subarray(1 + IV_LEN + TAG_LEN)), d.final()]).toString('utf8');
      } catch {
        return null;
      }
    },
  };
}

// ponytail: one process-wide vault (one CONTACTS_KEY per server) instead of threading it
// through every lookup / spam-state call. Set by initVault before the app serves requests.
let current: Vault | null = null;

export function initVault(keyHex: string): Vault {
  current = createVault(keyHex);
  return current;
}

export function vault(): Vault {
  if (!current) throw new Error('vault not initialised (call initVault with CONTACTS_KEY)');
  return current;
}
