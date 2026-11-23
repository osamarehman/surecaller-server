import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROOT_DIR } from '../src/config.js';
import { canonicalEmail } from '../src/email.js';
import { setSpamReporters, syncSpamRules } from '../src/lookup.js';
import { ADMIN_CODE, api, createHarness, registerAdmin, type Harness, type Session } from './helpers.js';

let h: Harness;

const lastCode = () => /\b(\d{6})\b/.exec(h.mails.at(-1)!.text)![1];
async function getCode(email: string) {
  await h.pool.query("UPDATE email_codes SET sent_at = now() - interval '2 minutes'");
  const r = await api(h, 'POST', '/v1/email-codes', null, { email });
  expect(r.status).toBe(202);
  return lastCode();
}
const reg = (body: Record<string, unknown>) => api(h, 'POST', '/v1/register', null, body);
async function invite(admin: Session, phone?: string): Promise<string> {
  const r = await api(h, 'POST', '/v1/invites', admin.token, phone ? { phone } : { expiresInHours: 1 });
  expect(r.status).toBe(201);
  return r.body.code;
}

describe('SIGNUP_PROOF=google', () => {
  beforeAll(async () => {
    h = await createHarness({ signupProof: 'google', googleClientIds: ['test-client'], smtpUrl: 'smtp://unused' });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.pool.query('TRUNCATE families, users, invites, email_codes, email_code_limits, reports, spam_state CASCADE');
    h.mails.length = 0;
    h.cfg.signupProof = 'google';
  });

  it('health says so', async () => {
    const r = await api(h, 'GET', '/health');
    expect(r.body).toEqual({ ok: true, version: '1.0.0', signupProof: 'google' });
  });

  it('refuses new accounts without Google, and does not spend an email code sent along', async () => {
    const none = await reg({ phone: '+923001110001', name: 'A' });
    expect(none.status).toBe(403);
    expect(none.body.error).toBe('google_required');
    expect(none.body.message).toBe(
      'New accounts need a Google account. Tap “Continue with Google”, or update SureCaller from Google Play.',
    );

    const code = await getCode('a@example.com');
    const byCode = await reg({ phone: '+923001110001', name: 'A', email: 'a@example.com', emailCode: code });
    expect(byCode.status).toBe(403);
    expect(byCode.body.error).toBe('google_required');
    expect((await h.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(0);

    // The code still works: an existing account adds that email with it.
    const g = await reg({ phone: '+923001110002', name: 'G', googleIdToken: 'google:g@gmail.com' });
    const p = await api(h, 'PATCH', '/v1/me', g.body.token, { email: 'a@example.com', emailCode: code });
    expect(p.status).toBe(200);
    expect(p.body.email).toBe('a@example.com');
  });

  it('a Google sign-up works and is Google-verified', async () => {
    const r = await reg({ phone: '+923001110003', name: 'V', googleIdToken: 'google:V@gmail.com' });
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ email: 'v@gmail.com', googleVerified: true, reportsCount: true });
    expect((await api(h, 'GET', '/v1/me', r.body.token)).body.googleVerified).toBe(true);
    const { rows } = await h.pool.query('SELECT google_sub, google_verified_at FROM users');
    expect(rows[0].google_sub).toBe('sub:v@gmail.com');
    expect(rows[0].google_verified_at).toBeInstanceOf(Date);
  });

  it('ADMIN_CODE bootstrap, admin re-registration and a phone-bound reset need no Google; an invite for a new number does', async () => {
    const admin = await registerAdmin(h);
    expect(admin.user.isAdmin).toBe(true);
    const again = await reg({ phone: admin.user.phone, code: ADMIN_CODE });
    expect(again.status).toBe(201);

    const code = await invite(again.body);
    const noGoogle = await reg({ phone: '+923001110004', name: 'M', code });
    expect(noGoogle.status).toBe(403);
    expect(noGoogle.body.error).toBe('google_required');
    // The invite was not used up by the refused attempt.
    const m = await reg({ phone: '+923001110004', name: 'M', code, googleIdToken: 'google:m@gmail.com' });
    expect(m.status).toBe(201);
    expect(m.body.user.familyId).toBe(again.body.user.familyId);

    const reset = await invite(again.body, '+923001110004');
    const back = await reg({ phone: '+923001110004', code: reset });
    expect(back.status).toBe(201);
    expect(back.body.user.id).toBe(m.body.user.id);
  });

  it('an account made by email code signs in by code, and by Google with the same address (and gets linked)', async () => {
    h.cfg.signupProof = 'email'; // made before the switch to google
    const code = await getCode('old.user@gmail.com');
    const old = await reg({ phone: '+923001110005', name: 'O', email: 'old.user@gmail.com', emailCode: code });
    expect(old.status).toBe(201);
    expect(old.body.user.googleVerified).toBe(false);
    h.cfg.signupProof = 'google';

    const byCode = await reg({ email: 'old.user@gmail.com', emailCode: await getCode('old.user@gmail.com') });
    expect(byCode.status).toBe(201);
    expect(byCode.body.user.id).toBe(old.body.user.id);
    expect(byCode.body.user.googleVerified).toBe(false);
    const byPhone = await reg({ phone: '+923001110005', email: 'old.user@gmail.com', emailCode: await getCode('old.user@gmail.com') });
    expect(byPhone.body.user.id).toBe(old.body.user.id);

    // Google, same Gmail address written differently: the same account, now linked.
    const g = await reg({ googleIdToken: 'google:OldUser@gmail.com' });
    expect(g.status).toBe(201);
    expect(g.body.user).toMatchObject({ id: old.body.user.id, email: 'olduser@gmail.com', googleVerified: true });

    // The existing-number path links too.
    h.cfg.signupProof = 'email';
    const c2 = await getCode('second@example.com');
    const two = await reg({ phone: '+923001110006', name: 'T', email: 'second@example.com', emailCode: c2 });
    h.cfg.signupProof = 'google';
    const viaPhone = await reg({ phone: '+923001110006', googleIdToken: 'google:Second@example.com' });
    expect(viaPhone.status).toBe(201);
    expect(viaPhone.body.user).toMatchObject({ id: two.body.user.id, googleVerified: true });
    // Once linked, another Google account with that address can't take the number.
    const other = await reg({ phone: '+923001110006', googleIdToken: 'google:second@example.com#another' });
    expect(other.status).toBe(409);
    expect(other.body.error).toBe('phone_taken');
  });

  it('the same Google account on a new number gets email_taken with the last digits, then signs in to the original', async () => {
    const first = await reg({ phone: '+923001117788', name: 'F', googleIdToken: 'google:f@gmail.com' });
    const dup = await reg({ phone: '+923009990000', name: 'F2', googleIdToken: 'google:f@gmail.com' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('email_taken');
    expect(dup.body.message).toBe(
      'This Google account already has a SureCaller account (number ending 7788). Sign in with Google instead.',
    );
    expect(dup.body.message).not.toContain('923001117788');
    const back = await reg({ googleIdToken: 'google:f@gmail.com' });
    expect(back.body.user.id).toBe(first.body.user.id);
  });

  it('one account per Gmail address, however it is written', async () => {
    await reg({ phone: '+923001110007', name: 'AB', googleIdToken: 'google:ab@gmail.com' });
    const dots = await reg({ phone: '+923001110008', name: 'X', googleIdToken: 'google:a.b+x@gmail.com#other-google' });
    expect(dots.status).toBe(409);
    expect(dots.body.error).toBe('email_taken');
    const gm = await reg({ phone: '+923001110008', name: 'X', googleIdToken: 'google:A.B@googlemail.com#third' });
    expect(gm.status).toBe(409);
  });

  it('the same Google account under a renamed email signs in and updates the email', async () => {
    const r = await reg({ phone: '+923001110009', name: 'R', googleIdToken: 'google:old@gmail.com#S1' });
    const back = await reg({ googleIdToken: 'google:new@gmail.com#S1' });
    expect(back.body.user).toMatchObject({ id: r.body.user.id, email: 'new@gmail.com' });
    const byPhone = await reg({ phone: '+923001110009', googleIdToken: 'google:newer@gmail.com#S1' });
    expect(byPhone.body.user).toMatchObject({ id: r.body.user.id, email: 'newer@gmail.com' });
  });

  it('PATCH /v1/me links an unlinked account, refuses a second Google account, and email changes keep the link', async () => {
    h.cfg.signupProof = 'email';
    const code = await getCode('p@example.com');
    const a = (await reg({ phone: '+923001110010', name: 'P', email: 'p@example.com', emailCode: code })).body;
    h.cfg.signupProof = 'google';
    expect(a.user.googleVerified).toBe(false);

    const link = await api(h, 'PATCH', '/v1/me', a.token, { googleIdToken: 'google:p@gmail.com' });
    expect(link.status).toBe(200);
    expect(link.body).toMatchObject({ googleVerified: true, email: 'p@gmail.com' });
    // The same Google account again is fine.
    expect((await api(h, 'PATCH', '/v1/me', a.token, { googleIdToken: 'google:p@gmail.com' })).status).toBe(200);

    const other = await api(h, 'PATCH', '/v1/me', a.token, { googleIdToken: 'google:q@gmail.com' });
    expect(other.status).toBe(409);
    expect(other.body.error).toBe('google_account_set');
    expect(other.body.message).toBe('This account is already confirmed with another Google account.');

    // Rotating the email by code keeps the Google link, so the Google account stays used up.
    const c2 = await getCode('elsewhere@example.com');
    const moved = await api(h, 'PATCH', '/v1/me', a.token, { email: 'elsewhere@example.com', emailCode: c2 });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ email: 'elsewhere@example.com', googleVerified: true });
    const second = await reg({ phone: '+923001110011', name: 'P2', googleIdToken: 'google:p@gmail.com' });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('email_taken');
    expect(second.body.message).toContain('number ending 0010');

    // A Google account already linked elsewhere can't be linked here.
    const b = (await reg({ phone: '+923001110012', name: 'B', googleIdToken: 'google:b@gmail.com' })).body;
    h.cfg.signupProof = 'email';
    const c3 = await getCode('c@example.com');
    const c = (await reg({ phone: '+923001110013', name: 'C', email: 'c@example.com', emailCode: c3 })).body;
    h.cfg.signupProof = 'google';
    const steal = await api(h, 'PATCH', '/v1/me', c.token, { googleIdToken: 'google:b@gmail.com' });
    expect(steal.status).toBe(409);
    expect(steal.body.error).toBe('email_taken');
    expect(b.user.googleVerified).toBe(true);
  });

  it('Google being unreachable is 503, a bad token stays 403', async () => {
    const down = await reg({ phone: '+923001110014', name: 'D', googleIdToken: 'unreachable' });
    expect(down.status).toBe(503);
    expect(down.body.error).toBe('google_unavailable');
    const bad = await reg({ phone: '+923001110014', name: 'D', googleIdToken: 'forged' });
    expect(bad.status).toBe(403);
    expect(bad.body.error).toBe('invalid_google_token');
  });
});

describe('default settings', () => {
  beforeAll(async () => {
    h = await createHarness({ smtpUrl: 'smtp://unused' });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.pool.query('TRUNCATE families, users, invites, email_codes, email_code_limits CASCADE');
    h.mails.length = 0;
  });

  it('health has no signupProof, sign-up needs no proof, Google sign-ups are linked', async () => {
    expect((await api(h, 'GET', '/health')).body).toEqual({ ok: true, version: '1.0.0' });
    const plain = await reg({ phone: '+923001120001', name: 'N' });
    expect(plain.status).toBe(201);
    expect(plain.body.user).toMatchObject({ googleVerified: false, reportsCount: true });
    const g = await reg({ phone: '+923001120002', name: 'G', googleIdToken: 'google:g@gmail.com' });
    expect(g.body.user.googleVerified).toBe(true);
  });

  it('email codes for the same Gmail address written differently are one account', async () => {
    const a = await reg({ phone: '+923001120003', name: 'A', email: 'ab@gmail.com', emailCode: await getCode('ab@gmail.com') });
    expect(a.status).toBe(201);
    const b = await reg({
      phone: '+923001120004',
      name: 'B',
      email: 'a.b+x@gmail.com',
      emailCode: await getCode('a.b+x@gmail.com'),
    });
    expect(b.status).toBe(409);
    expect(b.body.error).toBe('email_taken');
  });

  it('canonicalEmail matches the SQL email_canonical()', async () => {
    const fixtures = [
      'ab@gmail.com',
      'A.B@Gmail.com',
      'a.b+tag@gmail.com',
      'a.b+tag+more@googlemail.com',
      '.a..b.@GOOGLEMAIL.COM',
      'a.b+x@example.com',
      'Ali.Khan@Example.COM',
      'x@gmail.com.evil.example',
      'x@notgmail.com',
      'first.last@sub.gmail.com',
      'plus+only@yahoo.com',
    ];
    const { rows } = await h.pool.query<{ e: string; c: string }>(
      'SELECT e, email_canonical(e) AS c FROM unnest($1::text[]) AS e',
      [fixtures],
    );
    for (const r of rows) expect([r.e, canonicalEmail(r.e)]).toEqual([r.e, r.c]);
    expect(canonicalEmail('A.B+x@googlemail.com')).toBe('ab@gmail.com');
    expect(canonicalEmail('A.B+x@example.com')).toBe('a.b+x@example.com');
  });

  it('the migration only makes the canonical index unique when no two accounts share an address', async () => {
    const sql = fs.readFileSync(path.join(ROOT_DIR, 'migrations', '019_google_identity.sql'), 'utf8');
    const idx = async () =>
      (
        await h.pool.query(
          "SELECT to_regclass('users_email_canonical_unique') AS u, to_regclass('users_email_canonical_idx') AS p",
        )
      ).rows[0];
    const c = await h.pool.connect();
    const notices: string[] = [];
    c.on('notice', (n) => notices.push(n.message ?? ''));
    try {
      await c.query('DROP INDEX users_email_canonical_unique');
      const fam = (await c.query("INSERT INTO families (trusted) VALUES (false) RETURNING id")).rows[0].id;
      await c.query(
        `INSERT INTO users (phone, name, family_id, email) VALUES
         ('+923001120010', 'D1', $1, 'dup.x@gmail.com'), ('+923001120011', 'D2', $1, 'dupx+1@gmail.com')`,
        [fam],
      );
      await c.query(sql);
      expect(await idx()).toEqual({ u: null, p: 'users_email_canonical_idx' });
      expect(notices.some((m) => m.includes('plain index'))).toBe(true);

      // Once the duplicates are gone, running it again makes the unique index.
      await c.query("DELETE FROM users WHERE phone = '+923001120011'");
      await c.query('DROP INDEX users_email_canonical_idx');
      await c.query(sql);
      expect(await idx()).toEqual({ u: 'users_email_canonical_unique', p: null });
    } finally {
      await c.query("DELETE FROM users WHERE phone IN ('+923001120010', '+923001120011')");
      await c.query('DROP INDEX IF EXISTS users_email_canonical_idx');
      await c.query('CREATE UNIQUE INDEX IF NOT EXISTS users_email_canonical_unique ON users (email_canonical(email))');
      c.release();
    }
  });
});

describe('SPAM_REPORTERS=google', () => {
  let admin: Session;
  let u1: Session;
  let u2: Session;
  let v1: Session;
  let v2: Session;
  const member = async (phone: string, name: string, googleIdToken?: string): Promise<Session> => {
    const r = await reg({ phone, name, code: await invite(admin), ...(googleIdToken ? { googleIdToken } : {}) });
    expect(r.status).toBe(201);
    return r.body;
  };
  const report = (s: Session, phone: string, body: Record<string, unknown> = {}) =>
    api(h, 'POST', '/v1/reports', s.token, { phone, category: 'scam', ...body });
  const state = async (phone: string) =>
    (await h.pool.query('SELECT label, reports, updated_at FROM spam_state WHERE phone = $1', [phone])).rows[0] ?? null;

  beforeAll(async () => {
    h = await createHarness({ spamReporters: 'google' });
    admin = await registerAdmin(h);
    u1 = await member('+923001130001', 'U1');
    u2 = await member('+923001130002', 'U2');
    v1 = await member('+923001130003', 'V1', 'google:v1@gmail.com');
    v2 = await member('+923001130004', 'V2', 'google:v2@gmail.com');
  });
  afterAll(async () => {
    await h.pool.query("DELETE FROM server_state WHERE key = 'spam_reporters'");
    await h.close();
  });

  it('tells each account whether its reports count', async () => {
    expect((await api(h, 'GET', '/v1/me', u1.token)).body.reportsCount).toBe(false);
    expect((await api(h, 'GET', '/v1/me', v1.token)).body.reportsCount).toBe(true);
    expect((await api(h, 'GET', '/v1/me', admin.token)).body).toMatchObject({ reportsCount: true, googleVerified: false });
  });

  it('counts only Google-linked accounts and trusted admins', async () => {
    const X = '+923041000001';
    await report(u1, X);
    const r = await report(u2, X);
    expect(r.status).toBe(200); // still stored, no error
    expect(r.body.spam).toMatchObject({ label: 'none', reports: 0 });
    expect((await h.pool.query('SELECT count(*)::int AS n FROM reports WHERE phone = $1', [X])).rows[0].n).toBe(2);

    const Y = '+923041000002';
    await report(v1, Y);
    expect((await report(v2, Y)).body.spam).toMatchObject({ label: 'likely_scam', reports: 2 });
    // An unverified not-spam vote is ignored.
    expect((await report(u1, Y, { notSpam: true })).body.spam).toMatchObject({ label: 'likely_scam', notSpam: 0 });

    const Z = '+923041000003';
    expect((await report(admin, Z)).body.spam).toMatchObject({ label: 'likely_scam', reports: 1 });

    // Unverified category and comment are not shown.
    const W = '+923041000004';
    await report(v1, W, { comment: 'verified says' });
    const w = await report(u2, W, { category: 'robocall', comment: 'unverified says' });
    expect(w.body.spam).toMatchObject({ reports: 1, topCategory: 'scam', lastComment: 'verified says' });
  });

  it('linking an account relabels the numbers it reported', async () => {
    const X = '+923041000001';
    expect(await state(X)).toBeNull();
    const l1 = await api(h, 'PATCH', '/v1/me', u1.token, { googleIdToken: 'google:u1@gmail.com' });
    expect(l1.body).toMatchObject({ googleVerified: true, reportsCount: true });
    const s1 = await state(X);
    expect(s1).toMatchObject({ label: 'suspected', reports: 1 });
    await new Promise((r) => setTimeout(r, 20));
    // An account with no email can't be claimed on its number by a Google account; it confirms from Settings.
    expect((await reg({ phone: '+923001130002', googleIdToken: 'google:u2@gmail.com' })).body.error).toBe('phone_taken');
    await api(h, 'PATCH', '/v1/me', u2.token, { googleIdToken: 'google:u2@gmail.com' });
    const s2 = await state(X);
    expect(s2).toMatchObject({ label: 'likely_scam', reports: 2 });
    expect(s2.updated_at.getTime()).toBeGreaterThan(s1.updated_at.getTime());
  });

  it('recomputes every number once when the rule changes between starts', async () => {
    const P = '+923041000009';
    const u3 = await member('+923001130005', 'U3');
    const u4 = await member('+923001130006', 'U4');
    await report(u3, P);
    await report(u4, P);
    expect(await state(P)).toBeNull();

    await h.pool.query("DELETE FROM server_state WHERE key = 'spam_reporters'");
    // Never stored = computed with 'all': switching to google recomputes, once.
    expect(await syncSpamRules(h.pool, 2)).toBeGreaterThan(0);
    expect(await syncSpamRules(h.pool, 2)).toBeNull();

    setSpamReporters('all');
    try {
      expect(await syncSpamRules(h.pool, 2)).toBeGreaterThan(0);
      expect(await state(P)).toMatchObject({ label: 'likely_scam', reports: 2 });
      expect(await syncSpamRules(h.pool, 2)).toBeNull();
      const sync = await api(h, 'GET', '/v1/sync', v1.token);
      expect(JSON.stringify(sync.body)).toContain(P);
    } finally {
      setSpamReporters('google');
    }
    expect(await syncSpamRules(h.pool, 2)).toBeGreaterThan(0);
    expect(await state(P)).toMatchObject({ label: 'none' });
    expect((await h.pool.query("SELECT value FROM server_state WHERE key = 'spam_reporters'")).rows[0].value).toBe('google');
  });
});
