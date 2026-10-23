import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { api, createHarness, registerAdmin, registerMember, type Harness, type Session } from './helpers.js';

let h: Harness;
let admin: Session;
let ali: Session;
let sara: Session;

beforeAll(async () => {
  h = await createHarness();
  admin = await registerAdmin(h);
  ali = await registerMember(h, admin, '+923211111111', 'Ali');
  sara = await registerMember(h, admin, '+923222222222', 'Sara');
  await api(h, 'PATCH', '/v1/me', admin.token, { fcmToken: 'fcm-admin' });
  await api(h, 'PATCH', '/v1/me', ali.token, { fcmToken: 'fcm-ali' });
  await api(h, 'PATCH', '/v1/me', sara.token, { fcmToken: 'fcm-sara' });
});
afterAll(async () => {
  await h.close();
});

describe('events', () => {
  it('routes spam_call to admins only for watched members, sos to everyone', async () => {
    // Ali is not watched: event stored, nobody pushed, admin doesn't see it.
    let r = await api(h, 'POST', '/v1/events', ali.token, { type: 'spam_call', phone: '+923041112233' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      type: 'spam_call',
      fromUser: { id: ali.user.id, name: 'Ali' },
      phone: '+923041112233',
      message: null,
      lat: null,
      lng: null,
    });
    expect(h.sent).toHaveLength(0);
    expect((await api(h, 'GET', '/v1/events', admin.token)).body.events).toHaveLength(0);
    expect((await api(h, 'GET', '/v1/events', ali.token)).body.events).toHaveLength(1);

    await api(h, 'PATCH', `/v1/members/${ali.user.id}`, admin.token, { watched: true });
    r = await api(h, 'POST', '/v1/events', ali.token, { type: 'scam_sms', message: 'Your parcel is held' });
    expect(r.status).toBe(201);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].tokens).toEqual(['fcm-admin']);
    // The push carries only the id: no phone, message, position or name goes through FCM.
    expect(h.sent[0].data).toEqual({ kind: 'event', id: r.body.id });

    const adminView = await api(h, 'GET', '/v1/events', admin.token);
    expect(adminView.body.events.map((e: { type: string }) => e.type)).toEqual(['scam_sms', 'spam_call']);
    expect((await api(h, 'GET', '/v1/events', sara.token)).body.events).toHaveLength(0);

    const sos = await api(h, 'POST', '/v1/events', sara.token, { type: 'sos', message: 'Help', lat: 31.52, lng: 74.35 });
    expect(sos.body).toMatchObject({ lat: 31.52, lng: 74.35 });
    expect(h.sent[1].tokens.sort()).toEqual(['fcm-admin', 'fcm-ali']);

    const aliView = await api(h, 'GET', '/v1/events', ali.token);
    expect(aliView.body.events[0].type).toBe('sos');

    const since = await api(h, 'GET', `/v1/events?since=${encodeURIComponent(sos.body.createdAt)}`, ali.token);
    expect(since.body.events).toHaveLength(0);

    await h.pool.query("UPDATE events SET created_at = now() - interval '8 days'");
    expect((await api(h, 'GET', '/v1/events', ali.token)).body.events).toHaveLength(0);

    const stats = await api(h, 'GET', '/v1/stats', ali.token);
    expect(stats.body.spamBlocked).toBe(1);
  });

  it('validates event bodies', async () => {
    let r = await api(h, 'POST', '/v1/events', ali.token, { type: 'party' });
    expect(r.status).toBe(400);
    r = await api(h, 'POST', '/v1/events', ali.token, { type: 'sos', lat: 200 });
    expect(r.status).toBe(400);
    r = await api(h, 'POST', '/v1/events', ali.token, { type: 'spam_call', phone: 'x' });
    expect(r.body.error).toBe('invalid_phone');
  });
});

describe('scam checker', () => {
  it('extracts phones and urls and gives a verdict', async () => {
    let r = await api(h, 'POST', '/v1/check', ali.token, { text: 'hello there' });
    expect(r.body).toEqual({ phones: [], urls: [], verdict: 'unknown' });

    r = await api(h, 'POST', '/v1/check', ali.token, { text: 'Call Sara on 0322 2222222' });
    expect(r.body.phones[0]).toMatchObject({ phone: '+923222222222', name: 'Sara' });
    expect(r.body.verdict).toBe('safe');

    const rep = await api(h, 'POST', '/v1/reports/url', sara.token, { url: 'http://Bit.ly/xyz?a=1).' });
    expect(rep.body).toEqual({ url: 'http://bit.ly/xyz?a=1', reports: 1, label: 'suspected' });

    r = await api(h, 'POST', '/v1/check', ali.token, {
      text: 'Your HBL account is blocked, verify at http://bit.ly/xyz?a=1 or call +92 304 1112233',
    });
    expect(r.body.urls).toEqual([{ url: 'http://bit.ly/xyz?a=1', reports: 1, label: 'suspected' }]);
    expect(r.body.phones[0].phone).toBe('+923041112233');
    expect(r.body.verdict).toBe('suspicious');

    await api(h, 'POST', '/v1/reports/url', admin.token, { url: 'www.fake-bank.pk/login' });
    r = await api(h, 'POST', '/v1/check', ali.token, { text: 'go to www.fake-bank.pk/login now' });
    expect(r.body.urls[0]).toMatchObject({ url: 'https://www.fake-bank.pk/login', label: 'likely_scam' });
    expect(r.body.verdict).toBe('scam');

    const bad = await api(h, 'POST', '/v1/reports/url', ali.token, { url: 'not a url' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_url');
  });
});

describe('app updates and downloads', () => {
  it('404s until latest.json exists, then serves it and the apk without auth', async () => {
    expect((await api(h, 'GET', '/v1/app/latest', ali.token)).status).toBe(404);
    fs.writeFileSync(
      path.join(h.cfg.downloadsDir, 'latest.json'),
      JSON.stringify({ versionCode: 7, versionName: '1.0.6', apkUrl: 'surecaller.apk', notes: 'Fixes' }),
    );
    fs.writeFileSync(path.join(h.cfg.downloadsDir, 'surecaller.apk'), 'APK');
    const r = await api(h, 'GET', '/v1/app/latest', ali.token);
    expect(r.body).toEqual({
      versionCode: 7,
      versionName: '1.0.6',
      apkUrl: 'https://calls.example.com/downloads/surecaller.apk',
      notes: 'Fixes',
      sha256: null,
      minVersionCode: null,
      mandatory: false,
    });
    const apk = await h.app.inject({ method: 'GET', url: '/downloads/surecaller.apk' });
    expect(apk.statusCode).toBe(200);
    expect(apk.body).toBe('APK');
    const trav = await h.app.inject({ method: 'GET', url: '/downloads/..%2f..%2fpackage.json' });
    expect([403, 404]).toContain(trav.statusCode);
  });

  it('sends /, /download and older APK links to the newest APK', async () => {
    const dl = (url: string) => h.app.inject({ method: 'GET', url });
    fs.writeFileSync(
      path.join(h.cfg.downloadsDir, 'latest.json'),
      JSON.stringify({ versionCode: 11, versionName: '1.0.10', apkUrl: 'surecaller-1.0.10.apk' }),
    );
    fs.writeFileSync(path.join(h.cfg.downloadsDir, 'surecaller-1.0.10.apk'), 'NEW');
    fs.writeFileSync(path.join(h.cfg.downloadsDir, 'surecaller-1.0.8.apk'), 'OLD');
    for (const url of ['/', '/download', '/downloads/surecaller-1.0.8.apk', '/downloads/surecaller-0.9.apk?x=1']) {
      const r = await dl(url);
      expect(r.statusCode, url).toBe(302);
      expect(r.headers.location).toBe('/downloads/surecaller-1.0.10.apk');
      expect(r.headers['cache-control']).toBe('no-store');
    }
    const cur = await dl('/downloads/surecaller-1.0.10.apk');
    expect(cur.statusCode).toBe(200);
    expect(cur.body).toBe('NEW');
    expect((await dl('/downloads/latest.json')).statusCode).toBe(200);
  });

  it('answers 503 for a relative apkUrl when PUBLIC_URL is unset (never a Host-derived http:// link)', async () => {
    const app = await buildApp({ ...h.cfg, publicUrl: null }, h.pool, { enabled: false, send: async () => {} });
    await app.ready();
    try {
      const h2 = { ...h, app };
      const r = await api(h2, 'GET', '/v1/app/latest', ali.token);
      expect(r.status).toBe(503);
      expect(r.body.error).toBe('public_url_unset');
      // An absolute apkUrl needs no PUBLIC_URL.
      fs.writeFileSync(
        path.join(h.cfg.downloadsDir, 'latest.json'),
        JSON.stringify({ versionCode: 7, versionName: '1.0.6', apkUrl: 'https://cdn.example.com/s.apk' }),
      );
      expect((await api(h2, 'GET', '/v1/app/latest', ali.token)).body.apkUrl).toBe('https://cdn.example.com/s.apk');
    } finally {
      await app.close();
    }
  });

  it('returns sha256, minVersionCode and mandatory; drops malformed values', async () => {
    const sha = 'AB'.repeat(32);
    const file = path.join(h.cfg.downloadsDir, 'latest.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        versionCode: 8,
        versionName: '1.0.7',
        apkUrl: 'https://cdn.example.com/s.apk',
        notes: '',
        sha256: sha,
        minVersionCode: 5,
        mandatory: true,
      }),
    );
    const r = await api(h, 'GET', '/v1/app/latest', ali.token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      versionCode: 8,
      apkUrl: 'https://cdn.example.com/s.apk',
      sha256: sha.toLowerCase(),
      minVersionCode: 5,
      mandatory: true,
    });

    fs.writeFileSync(
      file,
      JSON.stringify({ versionCode: 8, apkUrl: 'x.apk', sha256: 'abc', minVersionCode: 'soon', mandatory: 'yes' }),
    );
    // Force a different mtime so the cached parse is replaced even on coarse file clocks.
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    const bad = await api(h, 'GET', '/v1/app/latest', ali.token);
    expect(bad.body).toMatchObject({ sha256: null, minVersionCode: null, mandatory: false });

    // Unchanged file: served from the cache. Removed file: 404 again.
    expect((await api(h, 'GET', '/v1/app/latest', ali.token)).body.versionCode).toBe(8);
    fs.unlinkSync(file);
    expect((await api(h, 'GET', '/v1/app/latest', ali.token)).status).toBe(404);
  });
});
