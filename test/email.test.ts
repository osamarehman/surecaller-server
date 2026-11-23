import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { googlePhotoUrl, MAX_CODES_PER_EMAIL_DAY, MAX_FAILS_PER_EMAIL_DAY } from '../src/email.js';
import { api, createHarness, fakePhoto, registerAdmin, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ emailRequired: true, smtpUrl: 'smtp://unused' });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.pool.query('TRUNCATE families, users, invites, email_codes, email_code_limits CASCADE');
  h.mails.length = 0;
});

const lastCode = () => /\b(\d{6})\b/.exec(h.mails.at(-1)!.text)![1];

async function getCode(email: string) {
  const r = await api(h, 'POST', '/v1/email-codes', null, { email });
  expect(r.status).toBe(202);
  return lastCode();
}

describe('email verification', () => {
  it('requires a verified email for a new account, then lets it sign in on a new phone', async () => {
    const none = await api(h, 'POST', '/v1/register', null, { phone: '+923001110001', name: 'A' });
    expect(none.status).toBe(400);
    expect(none.body.error).toBe('email_required');

    const code = await getCode('A@Example.com ');
    expect(h.mails.at(-1)!.to).toBe('a@example.com');
    const wrong = await api(h, 'POST', '/v1/register', null, {
      phone: '+923001110001',
      name: 'A',
      email: 'a@example.com',
      emailCode: code === '000000' ? '111111' : '000000',
    });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe('invalid_email_code');

    const ok = await api(h, 'POST', '/v1/register', null, {
      phone: '+923001110001',
      name: 'A',
      email: 'a@example.com',
      emailCode: code,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.user.email).toBe('a@example.com');
    expect(ok.body.user.isAdmin).toBe(true);

    // The code works once.
    const again = await api(h, 'POST', '/v1/register', null, {
      phone: '+923001110001',
      email: 'a@example.com',
      emailCode: code,
    });
    expect(again.status).toBe(403);

    // Without the email, the number stays locked.
    const squat = await api(h, 'POST', '/v1/register', null, { phone: '+923001110001', name: 'X' });
    expect(squat.status).toBe(409);
    expect(squat.body.error).toBe('phone_taken');

    // Another email can't take the number.
    const other = await getCode('b@example.com');
    const hijack = await api(h, 'POST', '/v1/register', null, {
      phone: '+923001110001',
      email: 'b@example.com',
      emailCode: other,
    });
    expect(hijack.status).toBe(409);

    // A new phone with the account's email signs back in: same user, old token revoked.
    await h.pool.query('UPDATE email_codes SET sent_at = now() - interval \'2 minutes\'');
    const fresh = await getCode('a@example.com');
    const back = await api(h, 'POST', '/v1/register', null, {
      phone: '+923001110001',
      email: 'a@example.com',
      emailCode: fresh,
    });
    expect(back.status).toBe(201);
    expect(back.body.user.id).toBe(ok.body.user.id);
    expect((await api(h, 'GET', '/v1/me', ok.body.token)).status).toBe(401);
  });

  it('allows one account per email and limits tries and resends', async () => {
    const code = await getCode('c@example.com');
    await api(h, 'POST', '/v1/register', null, { phone: '+923001110002', name: 'C', email: 'c@example.com', emailCode: code });

    // Resend within a minute is refused.
    expect((await api(h, 'POST', '/v1/email-codes', null, { email: 'c@example.com' })).status).toBe(202);
    expect((await api(h, 'POST', '/v1/email-codes', null, { email: 'c@example.com' })).status).toBe(429);

    const taken = await api(h, 'POST', '/v1/register', null, {
      phone: '+923001110003',
      name: 'D',
      email: 'c@example.com',
      emailCode: lastCode(),
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe('email_taken');

    // Five wrong tries burn the code, even the right one fails after that.
    await h.pool.query('UPDATE email_codes SET sent_at = now() - interval \'2 minutes\'');
    const good = await getCode('e@example.com');
    const bad = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await api(h, 'POST', '/v1/register', null, { phone: '+923001110004', name: 'E', email: 'e@example.com', emailCode: bad });
    }
    const late = await api(h, 'POST', '/v1/register', null, {
      phone: '+923001110004',
      name: 'E',
      email: 'e@example.com',
      emailCode: good,
    });
    expect(late.status).toBe(403);
  });

  it('caps codes sent and wrong tries per email per day, whatever the IP', async () => {
    const email = 'cap@example.com';
    const ask = (ip: string) =>
      h.app.inject({ method: 'POST', url: '/v1/email-codes', remoteAddress: ip, payload: { email } });
    const wait = () => h.pool.query("UPDATE email_codes SET sent_at = now() - interval '2 minutes'");
    for (let i = 0; i < MAX_CODES_PER_EMAIL_DAY; i++) {
      expect((await ask(`10.0.0.${i + 1}`)).statusCode).toBe(202);
      await wait();
    }
    const over = await ask('10.0.1.1');
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toBe('rate_limited');
    // Another address is not affected.
    expect((await api(h, 'POST', '/v1/email-codes', null, { email: 'other@example.com' })).status).toBe(202);

    // Wrong tries: after MAX_FAILS_PER_EMAIL_DAY today, even the right code fails.
    const good = lastCode();
    const bad = good === '000000' ? '111111' : '000000';
    const reg = (emailCode: string) =>
      api(h, 'POST', '/v1/register', null, { phone: '+923001110030', name: 'O', email: 'other@example.com', emailCode });
    await h.pool.query("UPDATE email_code_limits SET failed = $1 WHERE email = 'other@example.com'", [
      MAX_FAILS_PER_EMAIL_DAY - 1,
    ]);
    expect((await reg(bad)).body.error).toBe('invalid_email_code');
    const { rows } = await h.pool.query("SELECT failed FROM email_code_limits WHERE email = 'other@example.com'");
    expect(rows[0].failed).toBe(MAX_FAILS_PER_EMAIL_DAY);
    const late = await reg(good);
    expect(late.status).toBe(403);
    expect(late.body.error).toBe('invalid_email_code');

    // Yesterday's counts don't count.
    await h.pool.query("UPDATE email_code_limits SET day = day - 1 WHERE email = 'other@example.com'");
    expect((await reg(good)).status).toBe(201);
  });

  it('existing members add an email with PATCH /v1/me; others never see it', async () => {
    const admin = await registerAdmin(h).catch(() => null);
    expect(admin).toBeNull(); // ADMIN_CODE sign-up is a new account too, so it needs an email
    const code = await getCode('f@example.com');
    const a = (
      await api(h, 'POST', '/v1/register', null, {
        phone: '+923001110005',
        name: 'F',
        email: 'f@example.com',
        emailCode: code,
      })
    ).body;
    const g = await getCode('g@example.com');
    const p = await api(h, 'PATCH', '/v1/me', a.token, { email: 'g@example.com', emailCode: g });
    expect(p.status).toBe(200);
    expect(p.body.email).toBe('g@example.com');
    const half = await api(h, 'PATCH', '/v1/me', a.token, { email: 'g@example.com' });
    expect(half.status).toBe(400);
    const members = await api(h, 'GET', '/v1/members', a.token);
    expect(members.body.members[0].email).toBeUndefined();
  });

  it('a Google account proves the email, for sign-up, a new phone and adding it later', async () => {
    const r = await api(h, 'POST', '/v1/register', null, {
      phone: '+923001110006',
      name: 'G',
      googleIdToken: 'google:G@gmail.com',
    });
    expect(r.status).toBe(201);
    expect(r.body.user.email).toBe('g@gmail.com');

    const bad = await api(h, 'POST', '/v1/register', null, { phone: '+923001110006', googleIdToken: 'forged' });
    expect(bad.status).toBe(403);
    expect(bad.body.error).toBe('invalid_google_token');
    const both = await api(h, 'POST', '/v1/register', null, {
      phone: '+923001110006',
      googleIdToken: 'google:g@gmail.com',
      email: 'g@gmail.com',
      emailCode: '123456',
    });
    expect(both.status).toBe(400);

    // Another Google account can't take the number; the right one signs back in.
    const other = await api(h, 'POST', '/v1/register', null, { phone: '+923001110006', googleIdToken: 'google:x@gmail.com' });
    expect(other.status).toBe(409);
    const back = await api(h, 'POST', '/v1/register', null, { phone: '+923001110006', googleIdToken: 'google:g@gmail.com' });
    expect(back.status).toBe(201);
    expect(back.body.user.id).toBe(r.body.user.id);

    // The same email works either way: an email code for a Google-made account is the same account.
    const code = await getCode('g@gmail.com');
    const viaCode = await api(h, 'POST', '/v1/register', null, { phone: '+923001110006', email: 'g@gmail.com', emailCode: code });
    expect(viaCode.body.user.id).toBe(r.body.user.id);

    const p = await api(h, 'PATCH', '/v1/me', viaCode.body.token, { googleIdToken: 'google:new@gmail.com' });
    expect(p.status).toBe(200);
    expect(p.body.email).toBe('new@gmail.com');
  });

  it('a Google account gives the member a photo, shown to every user who looks the number up', async () => {
    const r = await api(h, 'POST', '/v1/register', null, {
      phone: '+923001110020',
      name: 'Pic',
      googleIdToken: 'google:pic@gmail.com',
    });
    expect(r.body.user.photoUrl).toBe(fakePhoto('pic@gmail.com'));

    // A user from another family sees the photo, but no member badge.
    const other = await api(h, 'POST', '/v1/register', null, {
      phone: '+923001110021',
      name: 'Other',
      googleIdToken: 'google:nopic@gmail.com',
    });
    expect(other.body.user.photoUrl).toBeNull();
    const seen = await api(h, 'GET', '/v1/lookup/+923001110020', other.body.token);
    expect(seen.body.photoUrl).toBe(fakePhoto('pic@gmail.com'));
    expect(seen.body.member).toBeNull();
    expect((await api(h, 'GET', '/v1/lookup/+923001110021', r.body.token)).body.photoUrl).toBeNull();

    // Removing it: gone from the account and from lookups. Signing in again does not bring it back.
    const gone = await api(h, 'DELETE', '/v1/me/photo', r.body.token);
    expect(gone.status).toBe(200);
    expect(gone.body.photoUrl).toBeNull();
    expect((await api(h, 'GET', '/v1/lookup/+923001110020', other.body.token)).body.photoUrl).toBeNull();
    const again = await api(h, 'POST', '/v1/register', null, { googleIdToken: 'google:pic@gmail.com' });
    expect(again.body.user.photoUrl).toBeNull();

    // Adding it takes a Google token; any Google account's picture will do, the email stays.
    const put = await api(h, 'PUT', '/v1/me/photo', again.body.token, { googleIdToken: 'google:face@gmail.com' });
    expect(put.status).toBe(200);
    expect(put.body.photoUrl).toBe(fakePhoto('face@gmail.com'));
    expect(put.body.email).toBe('pic@gmail.com');

    expect((await api(h, 'PUT', '/v1/me/photo', again.body.token, { googleIdToken: 'forged' })).status).toBe(403);
    const none = await api(h, 'PUT', '/v1/me/photo', again.body.token, { googleIdToken: 'google:nopic@gmail.com' });
    expect(none.status).toBe(422);
    expect(none.body.error).toBe('no_photo');
    // A client can't hand the server a link of its own.
    expect((await api(h, 'PUT', '/v1/me/photo', again.body.token, { photoUrl: 'https://evil.example/x.png' })).status).toBe(400);
    expect((await api(h, 'PATCH', '/v1/me', again.body.token, { photoUrl: 'https://evil.example/x.png' })).body.photoUrl).toBe(
      fakePhoto('face@gmail.com'),
    );
    expect((await api(h, 'PUT', '/v1/me/photo', null, { googleIdToken: 'google:face@gmail.com' })).status).toBe(401);
  });

  it('Google being unreachable is 503 google_unavailable, not a bad token', async () => {
    const r = await api(h, 'POST', '/v1/register', null, { phone: '+923001110040', name: 'U', googleIdToken: 'unreachable' });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('google_unavailable');
    const a = (await api(h, 'POST', '/v1/register', null, { phone: '+923001110041', name: 'U', googleIdToken: 'google:u@gmail.com' })).body;
    expect((await api(h, 'PUT', '/v1/me/photo', a.token, { googleIdToken: 'unreachable' })).status).toBe(503);
    expect((await api(h, 'PATCH', '/v1/me', a.token, { googleIdToken: 'unreachable' })).status).toBe(503);
  });

  it('only keeps Google-hosted https picture links', () => {
    expect(googlePhotoUrl('https://lh3.googleusercontent.com/a/abc=s96-c')).toBe('https://lh3.googleusercontent.com/a/abc=s256-c');
    expect(googlePhotoUrl('https://lh3.googleusercontent.com/a/abc')).toBe('https://lh3.googleusercontent.com/a/abc');
    expect(googlePhotoUrl('http://lh3.googleusercontent.com/a/abc')).toBeNull();
    expect(googlePhotoUrl('https://evil.example/googleusercontent.com/a')).toBeNull();
    expect(googlePhotoUrl('https://googleusercontent.com.evil.example/a')).toBeNull();
    expect(googlePhotoUrl('https://user@lh3.googleusercontent.com/a')).toBeNull();
    expect(googlePhotoUrl('not a link')).toBeNull();
    expect(googlePhotoUrl(undefined)).toBeNull();
  });

  it('signs in with email alone, on a phone with any SIM', async () => {
    const r = await api(h, 'POST', '/v1/register', null, {
      phone: '+923001110007',
      name: 'S',
      googleIdToken: 'google:s@gmail.com',
    });
    const viaGoogle = await api(h, 'POST', '/v1/register', null, { googleIdToken: 'google:s@gmail.com', deviceName: 'New' });
    expect(viaGoogle.status).toBe(201);
    expect(viaGoogle.body.user.id).toBe(r.body.user.id);
    expect(viaGoogle.body.user.phone).toBe('+923001110007');
    expect((await api(h, 'GET', '/v1/me', r.body.token)).status).toBe(401);

    const code = await getCode('s@gmail.com');
    const viaCode = await api(h, 'POST', '/v1/register', null, { email: 's@gmail.com', emailCode: code });
    expect(viaCode.body.user.id).toBe(r.body.user.id);

    // Unknown email: 404, and the code is not spent, so it can still create the account.
    const fresh = await getCode('nobody@example.com');
    const none = await api(h, 'POST', '/v1/register', null, { email: 'nobody@example.com', emailCode: fresh });
    expect(none.status).toBe(404);
    expect(none.body.error).toBe('no_account');
    const signUp = await api(h, 'POST', '/v1/register', null, {
      phone: '+923001110008',
      name: 'N',
      email: 'nobody@example.com',
      emailCode: fresh,
    });
    expect(signUp.status).toBe(201);

    // No phone needs a verified email.
    expect((await api(h, 'POST', '/v1/register', null, { name: 'X' })).status).toBe(400);
    expect((await api(h, 'POST', '/v1/register', null, { googleIdToken: 'forged' })).status).toBe(403);
  });
});
