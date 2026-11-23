import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Email } from '../src/email.js';
import { parse } from '../src/http.js';
import { api, createHarness, registerAdmin, type Harness, type Session } from './helpers.js';

// The app shows the `invalid_request` message as is. These pin the text and the accepted input
// to what the server sent under zod 3, so the zod 4 upgrade changes neither.

const message = (schema: z.ZodType, data: unknown) => {
  try {
    parse(schema, data);
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};

describe('parse keeps the zod 3 messages', () => {
  it('words each kind of issue as zod 3 did', () => {
    const s = z.object({
      name: z.string().trim().min(2).max(5),
      kind: z.enum(['a', 'b']),
      n: z.number().int().min(1).max(5),
      list: z.array(z.string()).min(1).max(2),
    });
    const ok = { name: 'abc', kind: 'a', n: 3, list: ['x'] };
    expect(message(s, ok)).toBeNull();
    expect(message(s, {})).toBe('name: Required');
    expect(message(s, { ...ok, name: 7 })).toBe('name: Expected string, received number');
    expect(message(s, { ...ok, name: null })).toBe('name: Expected string, received null');
    expect(message(s, { ...ok, name: ' a ' })).toBe('name: String must contain at least 2 character(s)');
    expect(message(s, { ...ok, name: 'abcdef' })).toBe('name: String must contain at most 5 character(s)');
    expect(message(s, { ...ok, kind: undefined })).toBe('kind: Required');
    expect(message(s, { ...ok, kind: 'c' })).toBe("kind: Invalid enum value. Expected 'a' | 'b', received 'c'");
    expect(message(s, { ...ok, kind: 1 })).toBe("kind: Expected 'a' | 'b', received number");
    expect(message(s, { ...ok, n: 1.5 })).toBe('n: Expected integer, received float');
    expect(message(s, { ...ok, n: 0 })).toBe('n: Number must be greater than or equal to 1');
    expect(message(s, { ...ok, n: 6 })).toBe('n: Number must be less than or equal to 5');
    // zod 4's .int() also flags unsafe integers first; zod 3 reported the bound.
    expect(message(s, { ...ok, n: 1e20 })).toBe('n: Number must be less than or equal to 5');
    expect(message(s, { ...ok, n: -1e20 })).toBe('n: Number must be greater than or equal to 1');
    expect(message(s, { ...ok, list: [] })).toBe('list: Array must contain at least 1 element(s)');
    expect(message(s, { ...ok, list: ['a', 'b', 'c'] })).toBe('list: Array must contain at most 2 element(s)');
    expect(message(s, { ...ok, list: 'x' })).toBe('list: Expected array, received string');
    expect(message(s, 'x')).toBe('Expected object, received string');
  });

  it('keeps messages set on a schema', () => {
    const s = z.object({ a: z.string().refine((v) => v.length < 3, 'too long'), b: z.string().regex(/^x$/, 'not x') });
    expect(message(s, { a: 'abcd', b: 'x' })).toBe('a: too long');
    expect(message(s, { a: 'a', b: 'y' })).toBe('b: not x');
    expect(message(z.object({ a: z.string().refine(() => false) }), { a: '' })).toBe('a: Invalid input');
  });

  it('words record, uuid and coerced number issues as zod 3 did', () => {
    expect(message(z.object({ r: z.record(z.string(), z.unknown()) }), { r: [1] })).toBe('r: Expected object, received array');
    expect(message(z.object({ u: z.guid() }), { u: 'nope' })).toBe('u: Invalid uuid');
    const limit = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) });
    expect(parse(limit, {})).toEqual({ limit: 200 });
    expect(message(limit, { limit: 'abc' })).toBe('limit: Expected number, received nan');
    expect(message(limit, { limit: 'Infinity' })).toBe('limit: Expected integer, received float');
    expect(message(limit, { limit: '9e99' })).toBe('limit: Number must be less than or equal to 1000');
  });
});

describe('Email', () => {
  const ok = (s: string) => Email.safeParse(s).success;

  it('trims and lowercases', () => {
    expect(Email.parse('  Ali.Khan+x@Example.COM ')).toBe('ali.khan+x@example.com');
  });

  it('accepts what zod 3 accepted', () => {
    for (const e of ["o'brien@x.co", 'a_b-c@d-e.fg', 'a+b@c.de', 'A@B.CO', 'a.b.c@d.e.fg', '1@2.co', 'a-@b.co'])
      expect(ok(e), e).toBe(true);
  });

  it('rejects what zod 3 rejected', () => {
    for (const e of ['a..b@c.com', '.a@b.com', 'a.@b.com', "a'@b.com", 'a@b.c', 'a@-b.com', 'a@b..com', 'a@b.com.',
      'ü@b.com', 'a@ü.com', '"a"@b.com', 'a@[1.2.3.4]', 'a b@c.com', 'a@b.c1', 'a@@b.com', `${'x'.repeat(195)}@b.com`])
      expect(ok(e), e).toBe(false);
  });
});

describe('invalid_request bodies from real routes', () => {
  let h: Harness;
  let admin: Session;
  beforeAll(async () => {
    h = await createHarness();
    admin = await registerAdmin(h, '+923001239001', 'Ali Khan');
  });
  afterAll(async () => {
    await h.close();
  });

  const bad = (message: string) => ({ status: 400, body: { error: 'invalid_request', message } });

  it('privacy requests: required enum and email check', async () => {
    const post = (b: object) => api(h, 'POST', '/v1/privacy-requests', null, b);
    expect(await post({ phone: '+923001239002', email: 'a@b.co' })).toEqual(bad('kind: Required'));
    expect(await post({ kind: 'all', phone: '+923001239002', email: 'a@b.co' })).toEqual(
      bad("kind: Invalid enum value. Expected 'account' | 'remove', received 'all'"),
    );
    expect(await post({ kind: 'account', phone: '+923001239002', email: 'a..b@c.co' })).toEqual(bad('email: Invalid email'));
    expect(await post({ kind: 'account', phone: '+923001239002', email: `${'x'.repeat(200)}@b.co` })).toEqual(
      bad('email: String must contain at most 200 character(s)'),
    );
    expect((await post({ kind: 'account', phone: '+923001239002', email: ' A@B.co ' })).status).toBe(202);
  });

  it('handyman categories: a bad label in the list fails the whole union', async () => {
    const get = (q: string) => api(h, 'GET', `/v1/handymen?${q}`, admin.token);
    expect(await get('category=a')).toEqual(bad('category: Invalid input'));
    expect(await get('category=Plumber&category=a')).toEqual(bad('category: Invalid input'));
    expect(await get(`category=Plumber&category=${'x'.repeat(41)}`)).toEqual(bad('category: Invalid input'));
    expect((await get('category=Plumber&category=Painter')).status).toBe(200);
  });

  it('handyman area defaults when left out', async () => {
    const r = await api(h, 'POST', '/v1/handymen', admin.token, { name: 'No Area', phone: '03004449001', city: 'Lahore', category: 'Plumber' });
    expect(r.status).toBe(201);
    expect(r.body.area).toBeNull();
  });

  it('invites: integer bounds and the default', async () => {
    const post = (b: object) => api(h, 'POST', '/v1/invites', admin.token, b);
    expect(await post({ expiresInHours: 1.5 })).toEqual(bad('expiresInHours: Expected integer, received float'));
    expect(await post({ expiresInHours: 1e20 })).toEqual(bad('expiresInHours: Number must be less than or equal to 720'));
    const r = await post({});
    expect(new Date(r.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 71 * 3600_000);
  });

  it('backup data: any string-keyed object, nothing else', async () => {
    const put = (b: object) => api(h, 'PUT', '/v1/backup', admin.token, b);
    expect(await put({})).toEqual(bad('data: Required'));
    expect(await put({ data: 'x' })).toEqual(bad('data: Expected object, received string'));
    expect(await put({ data: [1] })).toEqual(bad('data: Expected object, received array'));
    expect((await put({ data: { a: { b: [1, null] }, '': 1 } })).status).toBe(200);
  });

  it('telemetry list: userId takes any 8-4-4-4-12 hex id, as zod 3 uuid() did', async () => {
    const get = (q: string) => api(h, 'GET', `/v1/telemetry?${q}`, admin.token);
    // Variant nibble "c" is outside RFC 9562, which zod 4's z.uuid() would reject.
    expect((await get('userId=123E4567-E89B-12D3-C456-426614174000')).status).toBe(200);
    expect((await get('userId=00000000-0000-0000-0000-000000000000')).status).toBe(200);
    expect(await get('userId=nope')).toEqual(bad('userId: Invalid uuid'));
  });
});
