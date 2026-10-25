import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, createHarness, registerAdmin, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ emailRequired: true, smtpUrl: 'smtp://unused' });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.pool.query('TRUNCATE families, users, invites, email_codes CASCADE');
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
});
