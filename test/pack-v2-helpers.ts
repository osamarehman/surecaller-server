import pg from 'pg';
import { expect } from 'vitest';
import { argon2, entryKeysV2, openEntry, v2Password } from '../src/pack.js';
import { globalPart, h8, xor8 } from './pack-v2-decoder.js';

const key = (hex: string) => Buffer.from(hex, 'hex');
/**
 * pack_parts invariants of a format-2 generation, recomputed here from its entries: version =
 * max(highest seq in the part, floor), live, bytes, digest = XOR of h8 (checked against the
 * stored h8 too), removal >= highest delete; every entry's part has a row; tombstones keep tags.
 */
export async function checkParts(pool: pg.Pool, saltId: number) {
  const { rows: m } = await pool.query<{ part_bits: number }>('SELECT part_bits FROM pack_meta WHERE salt_id = $1', [saltId]);
  const bits = m[0].part_bits;
  const { rows: entries } = await pool.query<{
    scope: string | null;
    tag: Buffer | null;
    tag16: number | null;
    blob: Buffer | null;
    h8: Buffer | null;
    seq: number;
    deleted: boolean;
  }>('SELECT scope, tag, tag16, blob, h8, seq, deleted FROM pack_entries WHERE salt_id = $1', [saltId]);
  const { rows: parts } = await pool.query<{
    scope: string | null;
    part: number;
    version: number;
    floor: number;
    live: number;
    bytes: number;
    digest: Buffer;
    removal: number;
  }>('SELECT * FROM pack_parts WHERE salt_id = $1', [saltId]);
  const want = new Map<string, { max: number; live: number; bytes: number; h8s: Buffer[]; del: number }>();
  for (const e of entries) {
    expect(e.tag, 'tombstones keep their tag').not.toBeNull();
    expect(e.tag16).toBe((e.tag![0] << 8) | e.tag![1]);
    const k = `${e.scope ?? ''}|${e.scope ? 0 : globalPart(e.tag!, bits)}`;
    const w = want.get(k) ?? { max: 0, live: 0, bytes: 0, h8s: [], del: 0 };
    w.max = Math.max(w.max, e.seq);
    if (e.deleted) {
      w.del = Math.max(w.del, e.seq);
      expect(e.blob).toBeNull();
    } else {
      w.live++;
      w.bytes += 11 + e.blob!.length;
      expect(e.h8!.equals(h8(e.tag!, e.blob!))).toBe(true);
      w.h8s.push(h8(e.tag!, e.blob!));
    }
    want.set(k, w);
  }
  const have = new Map(parts.map((p) => [`${p.scope ?? ''}|${p.part}`, p]));
  for (const k of want.keys()) expect(have.has(k), `part ${k} has a row`).toBe(true);
  for (const [k, p] of have) {
    const w = want.get(k) ?? { max: 0, live: 0, bytes: 0, h8s: [], del: 0 };
    expect({ k, version: p.version, live: p.live, bytes: p.bytes, digest: p.digest.toString('hex') }).toEqual({
      k,
      version: Math.max(w.max, p.floor),
      live: w.live,
      bytes: w.bytes,
      digest: xor8(w.h8s).toString('hex'),
    });
    expect(p.removal).toBeGreaterThanOrEqual(w.del);
    if (!p.scope) expect(p.part).toBeLessThan(1 << bits);
  }
}

/** A format-2 generation's live answers for `phone`, opened with `hex` (scope -> plaintext JSON). */
export async function openV2(pool: pg.Pool, saltId: number, hex: string, phone: string) {
  const { rows: m } = await pool.query<{ salt: Buffer; t: number; m_kib: number; p: number }>(
    'SELECT salt, t, m_kib, p FROM pack_meta WHERE salt_id = $1',
    [saltId],
  );
  const { tag, key: k } = entryKeysV2(await argon2(v2Password(key(hex), phone), { salt: m[0].salt, t: m[0].t, m: m[0].m_kib, p: m[0].p }));
  const { rows } = await pool.query<{ scope: string | null; blob: Buffer }>(
    'SELECT scope, blob FROM pack_entries WHERE salt_id = $1 AND tag = $2 AND NOT deleted ORDER BY scope NULLS FIRST',
    [saltId, tag],
  );
  return rows.map((r) => ({ scope: r.scope, answer: JSON.parse(openEntry(k, tag, r.blob)!) }));
}
