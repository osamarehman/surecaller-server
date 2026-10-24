# SureCaller server

The open source backend behind SureCaller, a caller ID and spam blocking app for Android.
It handles caller ID from shared contacts, spam reports, a shared block list, family alerts
and SOS, a scam message checker, crash reports, and app updates.

Stack: Node.js 24, TypeScript, Fastify, PostgreSQL 17. It runs with Docker Compose.
Licence: [AGPL-3.0](LICENSE). The full HTTP API is documented in [`docs/API.md`](docs/API.md).

## What is open, and what isn't

This repository is the whole server: every rule that decides a caller's name, a spam label
or who can see what. You can read it, run it, and change it.

The official SureCaller Android app is not part of this repository. If you want your own
SureCaller, you bring the frontend: build a client against [`docs/API.md`](docs/API.md),
host this server on your own domain, and look after it (updates, backups, security, abuse).
Running a public caller ID service takes ongoing work, and that work is yours. If you
just want caller ID, install the official app instead.

Because of the AGPL, if you run a modified version of this server for other people, you
must share your changes with them under the same licence.

## Privacy model

- **Shared contacts are encrypted at rest.** The database never stores a contact's phone
  number or name. Numbers are replaced by a keyed hash (HMAC-SHA256). Names are sealed with
  AES-256-GCM under a key derived from the server's `CONTACTS_KEY` and the number itself.
  The same applies to name suggestions and the lookup log. See [`src/vault.ts`](src/vault.ts).
- **What that protects against.** A copy of the database on its own reveals no contacts.
  Nobody, including the server admin, can list or export anyone's address book. A name is
  only returned to someone who already has the number and looks it up, and lookups are
  rate limited.
- **What it does not do.** Caller ID needs the server to answer "whose number is this?", so
  this is not end-to-end encryption: a server holding `CONTACTS_KEY` can answer a lookup for
  any number it is asked about.
- **Accounts.** Member accounts (name and phone number) are visible to the server admin, so
  the operator knows who uses the service. Spam reports and block rules are stored as plain
  numbers, because phones download them for offline blocking.
- **Logs.** App logs and crash reports are tied to a random install ID and are deleted after
  `TELEMETRY_RETENTION_DAYS` (14 by default). The app masks phone numbers before sending them.
- **Family data stays in the family.** Accounts that joined with an invite code are "trusted".
  Open sign-ups only get caller ID and spam labels: never the member list, SOS alerts with
  locations, or contacts shared before open sign-up existed.

## Contributing

Issues and pull requests are welcome. Run the tests first (`npm test`, needs Docker). Please
report security problems privately through GitHub's "Report a vulnerability" button on the
Security tab, not in a public issue.

## Deploy on an Ubuntu VPS

Any small VPS works (1 vCPU, 1 GB RAM). These steps assume Ubuntu 22.04 or 24.04.

### 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # then log out and back in
docker compose version          # check it works
```

### 2. Get the code onto the server

```bash
git clone https://github.com/osamarehman/surecaller-server.git ~/surecaller-server
cd ~/surecaller-server
```

### 3. Configure

```bash
cp .env.example .env
nano .env
```

Set at least:

- `ADMIN_CODE`: a long random secret, e.g. from `openssl rand -hex 12` (at least 12
  characters, or the server won't start).
- `CONTACTS_KEY`: `openssl rand -hex 32`. Encrypts shared contacts at rest; back it up, it can't
  be recovered.
- `POSTGRES_PASSWORD`: letters and digits only, e.g. from `openssl rand -hex 16`.
- `PUBLIC_URL`: the address the phones use, e.g. `https://calls.example.com`.
- `DOMAIN`: only if you use the built-in HTTPS (step 5), e.g. `calls.example.com`.

Every variable is explained in `.env.example`.

### 4. Start

```bash
docker compose up -d --build
curl localhost:3000/health      # {"ok":true,"version":"1.0.0"}
```

The database schema is created automatically on first start. Logs:
`docker compose logs -f api`.

### 5. HTTPS

Phones must reach the server over HTTPS. Pick one option.

**Option A: built-in Caddy (easiest).**

1. Point a DNS A record (e.g. `calls.example.com`) at the server's IP.
2. Open ports 80 and 443 in your firewall (`sudo ufw allow 80,443/tcp`).
3. In `.env`, set `DOMAIN=calls.example.com`, `BIND_ADDRESS=127.0.0.1` (the default)
   and `TRUST_PROXY=1`.
4. Start with the profile:

   ```bash
   docker compose --profile https up -d --build
   ```

Caddy gets and renews a Let's Encrypt certificate automatically.

**Option B: your own reverse proxy (nginx, Traefik, Cloudflare Tunnel...).**
Proxy `https://your-domain` to `http://127.0.0.1:3000`. Keep `BIND_ADDRESS=127.0.0.1`
(the default) so port 3000 is not public, and set `TRUST_PROXY=1` (or your proxy's IP) so
rate limits see the real client IP. Never set `TRUST_PROXY` while port 3000 is reachable
from outside: clients could then fake their IP. Allow request bodies of at least 10 MB (contact sync).
For nginx: `client_max_body_size 10m;`.

### 6. Create the first admin

Register through your client, or directly with the API, using the `ADMIN_CODE` from `.env`
as the code:

```bash
curl -s https://calls.example.com/v1/register -H 'content-type: application/json' \
  -d '{"phone": "+923001234567", "name": "Your Name", "code": "<ADMIN_CODE>"}'
```

The first person to do this becomes admin. After that, `ADMIN_CODE` only works for an
existing admin re-registering (new phone or reinstall), which signs the old device out: treat
it as a master credential, keep it private, and rotate it (edit `.env`, `docker compose up -d`)
after a recovery or a suspected leak. Each such re-registration is logged with a `warn` line
(`docker compose logs api | grep ADMIN_CODE`).

**Open sign-up.** Registration needs no invite code: anyone who installs the app can create an
account with just a name and number, and everyone shares one pool (synced contacts and spam
reports feed every user's caller ID, Truecaller-style). There is **no proof of number ownership**
(no OTP), so a number can be squatted by someone else, and sign-ups are limited only by the
per-IP `REGISTER_RATE_LIMIT`. This is deliberate for a small, trusted deployment. If the server
is public, put it behind an allowlist/OTP or keep its URL private. An existing number can never be
taken over without an admin reset. The admin can still create one-time invite codes
(format `K7Q2-9XPM`, valid 72 hours) and, via "Reset device", an invite bound to a member's
number for a reinstall or new phone.

## Serve app updates (optional)

If your client is an Android app installed outside Google Play, the server can hand out
updates. Clients check `GET /v1/app/latest`, download the APK from `/downloads/`, and should
verify its SHA-256 (and signing key) before installing. Apps from Google Play must update
through Play instead. To publish a version, put two files in `downloads/`: the APK and
`latest.json`:

```json
{
  "versionCode": 2,
  "versionName": "1.0.1",
  "apkUrl": "surecaller-1.0.1.apk",
  "sha256": "<hex SHA-256 of the APK>",
  "minVersionCode": null,
  "mandatory": false,
  "notes": "Fixes the overlay on Android 15."
}
```

Upload the APK first, then `latest.json`. No restart is needed. `sha256` is required for automatic installs: a `latest.json` without it (or with
`"sha256": null`, as in `downloads/latest.example.json`) still works, but phones only offer a manual,
user-confirmed install. A relative `apkUrl` is served as
`PUBLIC_URL/downloads/<file>`; a full `https://` URL is used as is. New members can install from `https://your-domain/download` (or just `https://your-domain/`): it always
redirects to the newest APK, and so does any older `surecaller-*.apk` link.

## Debugging with telemetry

Phones send their logs, errors and crash reports to `POST /v1/telemetry`, even before sign-up
(so a crash on first start still shows up). Read them on the server, from the `backend` folder:

```bash
# One line per phone: member, device, app version, last seen, errors in the last 24 hours
docker compose exec api node dist/cli/logs.js --installs

# Errors and crashes from the last 2 hours, with stack traces
docker compose exec api node dist/cli/logs.js --level error --since 2h --details

# Live tail of everything phones send (Ctrl+C to stop)
docker compose exec api node dist/cli/logs.js --follow

# One phone or one member
docker compose exec api node dist/cli/logs.js --install 3f2a --since 3d
docker compose exec api node dist/cli/logs.js --user Ali --tag screening
```

`--help` lists every flag (`--q <text>`, `--tag`, `--limit`, `--json`). Times are UTC. Admins can
also read the same data over the API (`GET /v1/telemetry`, `GET /v1/telemetry/installs`).

**Verbose logging for one phone.** By default phones drop `debug` events. To get them from one
phone, copy its install id from `--installs`, add it to `.env`, and restart:

```bash
TELEMETRY_DEBUG_INSTALLS=3f2a9c1e-...     # comma-separated ids, or `all`
docker compose up -d
```

The phone switches to verbose logging after its next report. Remove the id again when done.
Phone logs are deleted after `TELEMETRY_RETENTION_DAYS` (default 14). Phone numbers in logs are
masked to their last 4 digits by the app, and again by the server before storing.

Limits: `TELEMETRY_RATE_LIMIT` reports per client IP per minute (default 120), at most
`TELEMETRY_MAX_EVENTS_PER_INSTALL_DAY` stored events per phone per 24 hours (default 5000; the
excess is dropped), and nothing is stored while the table is larger than `TELEMETRY_MAX_BYTES`
on disk (default 500 MB) or holds more than `TELEMETRY_MAX_ROWS` rows (default 2,000,000).
Reports without a valid token get smaller per-request limits (50 events, 1000-char messages, 4 KB details).

**Rate limits and `TRUST_PROXY`.** Behind a proxy without `TRUST_PROXY`, every phone appears to
come from the proxy's IP and shares one per-IP budget. Set `TRUST_PROXY` to the number of proxy
hops, e.g. `2` for Cloudflare in front of Caddy. Do not use `TRUST_PROXY=true`: it trusts every
`X-Forwarded-For` hop, so any client can forge its IP and dodge the per-IP limits (the server
logs a warning at start when it is set).

## Website and deletion requests (optional)

Put a static site in `site/` (or set `SITE_DIR`) and mount it at `/app/site`. When it holds an
`index.html`, the server serves it at `/`, and `/privacy` serves `privacy.html` and so on. Without
it, `/` keeps redirecting to the newest APK. `/download` always does.

App stores want a web page where people can ask to delete their account. Point a form at
`POST /v1/privacy-requests` (see `docs/API.md`), then handle the requests:

```bash
docker compose exec api node dist/cli/privacy.js              # list pending requests
docker compose exec api node dist/cli/privacy.js apply <id>   # after checking the number is theirs
docker compose exec api node dist/cli/privacy.js reject <id>
```

New requests also show in the logs as `privacy request received`.

## Push notifications (optional)

Without Firebase, the app gets family alerts and SOS by polling. For instant push:

1. In the Firebase console, open Project settings > Service accounts > Generate new
   private key.
2. Save the file as `secrets/fcm-service-account.json`.
3. In `.env`, set `FCM_SERVICE_ACCOUNT=/app/secrets/fcm-service-account.json`.
4. Run `docker compose up -d`.

## Backups

Back up the database:

```bash
docker compose exec -T db pg_dump -U surecaller -Fc surecaller > surecaller-$(date +%F).dump
```

Run this daily with cron, and copy the dumps off the server.

Restore into an empty database:

```bash
docker compose up -d db
docker compose exec -T db pg_restore -U surecaller -d surecaller --clean --if-exists < surecaller-2026-01-01.dump
docker compose up -d
```

Also keep a copy of `.env` (above all `CONTACTS_KEY`: without it the stored contact names can never be read again) and `secrets/`.

## Update the server

```bash
git pull                 # or copy the new backend/ folder over
docker compose up -d --build
```

New database migrations run automatically on start.

## Development

```bash
npm ci
npm run build
npm test          # starts a throwaway postgres:17 container with Docker
```

To test against an existing disposable database instead, set
`TEST_DATABASE_URL=postgres://...`. The tests wipe its tables.
