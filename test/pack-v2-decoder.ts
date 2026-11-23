import crypto from 'node:crypto';

/**
 * A reference client for the format-2 name pack, written from docs/API.md ("Offline name pack,
 * format 2") and not from the server code, so the document and the server can't drift apart.
 * The Kotlin client follows the same document. Every parser is strict: wrong magic, version,
 * truncation or trailing bytes throw.
 */

class Reader {
  o = 0;
  constructor(private readonly b: Buffer) {}
  need(n: number) {
    if (this.o + n > this.b.length) throw new Error(`truncated at ${this.o} (+${n} of ${this.b.length})`);
  }
  u8() {
    this.need(1);
    return this.b.readUInt8(this.o++);
  }
  u16() {
    this.need(2);
    const v = this.b.readUInt16BE(this.o);
    this.o += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.b.readUInt32BE(this.o);
    this.o += 4;
    return v;
  }
  u64() {
    this.need(8);
    const v = this.b.readBigUInt64BE(this.o);
    this.o += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('u64 beyond 2^53');
    return Number(v);
  }
  bytes(n: number) {
    this.need(n);
    const v = Buffer.from(this.b.subarray(this.o, this.o + n));
    this.o += n;
    return v;
  }
  ascii(n: number) {
    return this.bytes(n).toString('ascii');
  }
  end() {
    if (this.o !== this.b.length) throw new Error(`${this.b.length - this.o} trailing bytes`);
  }
}

export interface ManifestPart {
  scope: 0 | 1;
  id: number;
  version: number;
  floor: number;
  live: number;
  bytes: number;
  digest: Buffer;
}

export interface Manifest {
  retiring: boolean;
  saltId: number;
  keyId: number;
  salt: Buffer;
  t: number;
  m: number;
  p: number;
  partBits: number;
  cursor: number;
  removalSeq: number;
  parts: ManifestPart[];
}

/**
 * "SCPM" | u8 version=1 | u8 flags (bit0 retiring) | u32 saltId | u16 keyId | 16B salt | u8 t |
 * u32 mKiB | u8 p | u8 partBits | u64 cursor | u64 removalSeq | u32 count
 * part × count: u8 scope | u16 id | u64 version | u64 floor | u32 live | u32 bytes | 8B digest
 */
export function parseManifest(buf: Buffer): Manifest {
  const r = new Reader(buf);
  if (r.ascii(4) !== 'SCPM') throw new Error('not a manifest');
  if (r.u8() !== 1) throw new Error('manifest version');
  const flags = r.u8();
  const m: Manifest = {
    retiring: (flags & 1) !== 0,
    saltId: r.u32(),
    keyId: r.u16(),
    salt: r.bytes(16),
    t: r.u8(),
    m: r.u32(),
    p: r.u8(),
    partBits: r.u8(),
    cursor: r.u64(),
    removalSeq: r.u64(),
    parts: [],
  };
  const count = r.u32();
  for (let i = 0; i < count; i++) {
    const scope = r.u8();
    if (scope > 1) throw new Error('scope');
    m.parts.push({ scope: scope as 0 | 1, id: r.u16(), version: r.u64(), floor: r.u64(), live: r.u32(), bytes: r.u32(), digest: r.bytes(8) });
  }
  r.end();
  return m;
}

export interface Row {
  kind: 0 | 2;
  tag: Buffer;
  blob?: Buffer;
}

export interface Section {
  scope: 0 | 1;
  id: number;
  /** 0 full, 1 delta, 2 resync (fetch the part whole with POST /v1/pack/parts). */
  mode: 0 | 1 | 2;
  version: number;
  live: number;
  digest: Buffer;
  rows: Row[];
}

export interface Page {
  more: boolean;
  saltId: number;
  keyId: number;
  partBits: number;
  cursor: number;
  next: number;
  sections: Section[];
}

/**
 * "SCPS" | u8 version=1 | u8 flags (bit0 more) | u32 saltId | u16 keyId | u8 partBits | u64 cursor |
 * u16 next | u16 count
 * section × count: u8 scope | u16 id | u8 mode | u64 version | u32 live | 8B digest | u32 rows
 *   row × rows: u8 kind (0 upsert, 2 delete) | 8B tag | upsert: u16 blobLen | blob
 */
export function parsePage(buf: Buffer): Page {
  const r = new Reader(buf);
  if (r.ascii(4) !== 'SCPS') throw new Error('not a section page');
  if (r.u8() !== 1) throw new Error('page version');
  const flags = r.u8();
  const p: Page = { more: (flags & 1) !== 0, saltId: r.u32(), keyId: r.u16(), partBits: r.u8(), cursor: r.u64(), next: r.u16(), sections: [] };
  const count = r.u16();
  for (let i = 0; i < count; i++) {
    const scope = r.u8();
    const id = r.u16();
    const mode = r.u8();
    if (scope > 1 || mode > 2) throw new Error('scope or mode');
    const s: Section = { scope: scope as 0 | 1, id, mode: mode as 0 | 1 | 2, version: r.u64(), live: r.u32(), digest: r.bytes(8), rows: [] };
    const n = r.u32();
    for (let j = 0; j < n; j++) {
      const kind = r.u8();
      if (kind !== 0 && kind !== 2) throw new Error(`row kind ${kind}`);
      const tag = r.bytes(8);
      s.rows.push(kind === 0 ? { kind, tag, blob: r.bytes(r.u16()) } : { kind, tag });
    }
    p.sections.push(s);
  }
  r.end();
  return p;
}

/** SHA-256(tag || blob)[0..8). */
export const h8 = (tag: Buffer, blob: Buffer) => crypto.createHash('sha256').update(tag).update(blob).digest().subarray(0, 8);

/** XOR of 8-byte values. */
export function xor8(xs: Buffer[]): Buffer {
  const out = Buffer.alloc(8);
  for (const x of xs) for (let i = 0; i < 8; i++) out[i] ^= x[i];
  return out;
}

/** The global part of a tag: (tag[0] << 8 | tag[1]) >> (16 - partBits). */
export const globalPart = (tag: Buffer, partBits: number) => ((tag[0] << 8) | tag[1]) >> (16 - partBits);

/**
 * What a phone keeps: entries by (family flag, tag), and per part its version. Applies sections
 * the way docs/API.md says, checking each part's live count and digest afterwards.
 */
export class PhonePack {
  partBits = 0;
  saltId = 0;
  /** key `${scope}|${tagHex}` -> blob */
  entries = new Map<string, Buffer>();
  versions = new Map<string, number>();
  /** Parts a resync section told us to fetch whole. */
  resync: { s: 'g' | 'f'; id: number }[] = [];

  private partKey = (scope: number, id: number) => `${scope}|${id}`;
  private inPart(key: string, scope: number, id: number) {
    const [s, hex] = key.split('|');
    if (Number(s) !== scope) return false;
    return scope === 1 || globalPart(Buffer.from(hex, 'hex'), this.partBits) === id;
  }

  /** Raises partBits: every part splits in two locally, children keep the parent's version. */
  split(bits: number) {
    if (bits < this.partBits) throw new Error('partBits shrank');
    const shift = bits - this.partBits;
    if (shift && this.partBits) {
      const next = new Map<string, number>();
      for (const [k, v] of this.versions) {
        const [s, id] = k.split('|').map(Number);
        if (s === 1) next.set(k, v);
        else for (let i = 0; i < 1 << shift; i++) next.set(this.partKey(0, (id << shift) + i), v);
      }
      this.versions = next;
    }
    this.partBits = bits;
  }

  apply(page: Page) {
    if (this.saltId && page.saltId !== this.saltId) throw new Error('generation changed');
    this.saltId = page.saltId;
    this.split(page.partBits);
    for (const s of page.sections) {
      if (s.mode === 2) {
        this.resync.push({ s: s.scope ? 'f' : 'g', id: s.id });
        continue;
      }
      const keys = [...this.entries.keys()].filter((k) => this.inPart(k, s.scope, s.id));
      const before = new Map(keys.map((k) => [k, this.entries.get(k)!]));
      if (s.mode === 0) for (const k of keys) this.entries.delete(k);
      for (const r of s.rows) {
        if (s.scope === 0 && globalPart(r.tag, this.partBits) !== s.id) throw new Error('row outside its part');
        const k = `${s.scope}|${r.tag.toString('hex')}`;
        if (r.kind === 0) this.entries.set(k, r.blob!);
        else this.entries.delete(k);
      }
      const now = [...this.entries].filter(([k]) => this.inPart(k, s.scope, s.id));
      const digest = xor8(now.map(([k, b]) => h8(Buffer.from(k.split('|')[1], 'hex'), b)));
      if (now.length !== s.live || !digest.equals(s.digest)) {
        // Roll the part back and fetch it whole.
        for (const [k] of now) this.entries.delete(k);
        for (const [k, b] of before) this.entries.set(k, b);
        throw new Error(`part ${s.scope}/${s.id}: live ${now.length} vs ${s.live}, digest mismatch=${!digest.equals(s.digest)}`);
      }
      this.versions.set(this.partKey(s.scope, s.id), s.version);
    }
  }
}
