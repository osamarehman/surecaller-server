import crypto from 'node:crypto';
import { argon2id } from 'hash-wasm';
import { describe, expect, it } from 'vitest';
import { answerJson, appKeyCheck, argon2, entryKeys, entryKeysV2, h8Of, openEntry, sealEntry, tag16Of, v2Password } from '../src/pack.js';

// The published TEST pack key (never a real one): bytes 00..1f.
const TEST_KEY = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const SALT = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const PHONE = '+923001234567';
const PLAINTEXT = '{"n":"Ali Raza","s":"contacts","c":null,"k":3,"m":false,"p":"https://lh3.googleusercontent.com/a/x=s256-c"}';
const NONCE = Buffer.from('0c0b0a090807060504030201', 'hex');

/** docs/API.md's format-2 derivation, written out with node:crypto and hash-wasm (not src/pack.ts). */
async function derive(key: Buffer, phone: string, salt = SALT) {
  const pw = crypto.createHmac('sha256', key).update(Buffer.concat([Buffer.from('surecaller/pack/v2/pw'), Buffer.from(phone, 'utf8')])).digest();
  const h = Buffer.from(
    await argon2id({ password: pw, salt, iterations: 2, memorySize: 16384, parallelism: 1, hashLength: 32, outputType: 'binary' }),
  );
  const mac = (m: string) => crypto.createHmac('sha256', h).update(m).digest();
  return { pw, h, tag: mac('surecaller/pack/v2/tag').subarray(0, 8), key: mac('surecaller/pack/v2/key') };
}

describe('pack format 2 crypto', () => {
  it('reproduces the docs/API.md format-2 test vector', async () => {
    const d = await derive(TEST_KEY, PHONE);
    expect(d.pw.toString('hex')).toBe('9af5deb2892fc3b499700fc72414591a9dc95fe5de34abeb6691e9ffe3e14868');
    expect(d.h.toString('hex')).toBe('678cdd1858ca55c51040dd73062a00e64e9608062bbe2a51357cab086812fde2');
    expect(d.tag.toString('hex')).toBe('73e4bc6d6950700b');
    expect(d.key.toString('hex')).toBe('4bb9fe6185f545400edf809b8facc8c5ad9e2d2b0d59d43291ce0e4422375ef2');
    const blob = sealEntry(d.key, d.tag, PLAINTEXT, NONCE);
    expect(blob.toString('hex')).toBe(
      '0c0b0a090807060504030201f7d85431fe8b7239e820c035d673b4f7399d279bd3cf20be1aedd37ee73e09dca6d6b957a190aec7716b1d472bfe4ddb8bed8b32d7444f4e604c105306cdcdca8fd04396c99741900f959ee9e32d9b38f232ffd784618f7add9b58a0f062a11083ebb2f5ce4ce28802e620524867ae551d635bce97a4b37bdc031a',
    );
    expect(openEntry(d.key, d.tag, blob)).toBe(PLAINTEXT);
    // Part key, part digest share and the key check, as documented.
    expect(tag16Of(d.tag)).toBe(0x73e4);
    expect(h8Of(d.tag, blob).toString('hex')).toBe('43063ae7f612b06a');
    expect(appKeyCheck(TEST_KEY).toString('hex')).toBe('950e27795ad697362f8bb6d64132aaf67c73d42a08d4c84ef2f9764f11e8a473');

    // The server's own code gives the same.
    const h = await argon2(v2Password(TEST_KEY, PHONE), { salt: SALT, t: 2, m: 16384, p: 1 });
    expect(h.equals(d.h)).toBe(true);
    expect(entryKeysV2(h)).toEqual({ tag: d.tag, key: d.key });
  });

  it('opens nothing without the key, or with another key', async () => {
    const d = await derive(TEST_KEY, PHONE);
    const blob = sealEntry(d.key, d.tag, PLAINTEXT, NONCE);
    // Another key: another tag and key for the same number.
    const other = await derive(Buffer.alloc(32, 0x42), PHONE);
    expect(other.tag.equals(d.tag)).toBe(false);
    expect(openEntry(other.key, other.tag, blob)).toBeNull();
    expect(openEntry(other.key, d.tag, blob)).toBeNull();
    // No key at all: format 1's derivation from the number alone finds and opens nothing.
    const v1 = entryKeys(await argon2(PHONE, { salt: SALT, t: 2, m: 16384, p: 1 }));
    expect(v1.tag.equals(d.tag)).toBe(false);
    expect(openEntry(v1.key, v1.tag, blob)).toBeNull();
    expect(openEntry(v1.key, d.tag, blob)).toBeNull();
  });

  it('keeps the format-1 plaintext unchanged and adds p only in format 2', () => {
    const a = { n: 'Ali Raza', s: 'contacts' as const, c: null, k: 3, m: false };
    expect(answerJson(a).trimEnd()).toBe('{"n":"Ali Raza","s":"contacts","c":null,"k":3,"m":false}');
    expect(answerJson({ ...a, p: null }).trimEnd()).toBe('{"n":"Ali Raza","s":"contacts","c":null,"k":3,"m":false}');
    const withPhoto = answerJson({ ...a, p: 'https://x/y' });
    expect(Buffer.byteLength(withPhoto) % 32).toBe(0);
    expect(JSON.parse(withPhoto)).toEqual({ ...a, p: 'https://x/y' });
    const photoOnly = answerJson({ n: null, s: null, c: null, k: 0, m: false, p: 'https://x/y' });
    expect(JSON.parse(photoOnly)).toEqual({ n: null, s: null, c: null, k: 0, m: false, p: 'https://x/y' });
  });
});
