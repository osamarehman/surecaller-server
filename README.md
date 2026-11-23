# SureCaller server

The open source backend behind SureCaller, a caller ID and spam blocking app for Android.
This is the code the official app's server runs.

Stack: Node.js 24, TypeScript, Fastify, PostgreSQL 17. It runs with Docker Compose.
Licence: [AGPL-3.0](LICENSE). The full HTTP API is documented in [`docs/API.md`](docs/API.md).

## What it does

- **Caller ID** from contacts that users share, with name suggestions and an optional
  business directory for numbers nobody has saved.
- **Offline name pack**: an encrypted file phones download, so caller ID works with no
  connection. Built by a worker within seconds of each change. Two formats: format 1 for older
  apps, format 2 (keyed, in parts) for app 1.0.48 and later.
- **Spam reports and a shared block list**, which phones sync for offline blocking.
- **Families**: every user belongs to one. Members get each other's alerts and SOS locations,
  and can join another family with an invite ([`docs/JOIN_FAMILY.md`](docs/JOIN_FAMILY.md)).
- **Sign-up** by name and number, with optional proof by email code or Google account
  (`SIGNUP_PROOF`), and members' Google profile photos on caller ID.
- **Daily name budget** per member (`LOOKUP_DAILY_LIMIT`), in log-only mode until you enforce it.
- **Scam message checker**: paste a message or link and get a verdict from reported numbers and links.
- **Handyman directory**: local workers by city and trade, with ratings and reviews
  ([`docs/HANDYMAN.md`](docs/HANDYMAN.md)).
- **Cloud backup** of the app's local data (block rules, notes, favourites, settings), stored
  sealed, one per member.
- **Feedback board**: a public page for bug reports, feature requests and votes
  ([`docs/FEEDBACK.md`](docs/FEEDBACK.md)).
- **Operator tools**: phone logs and crash reports, a user list with usage, account deletion
  requests, and app updates for builds installed outside Google Play.

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
- **Offline name pack (optional, `PACK_KEY`).** With `PACK_KEY` set, contact, suggestion and
  directory rows also keep the number sealed under that separate key, so the server can build
  an encrypted pack that phones download for offline caller ID. Each entry opens only with its
  number, through a slow Argon2id hash. See [`src/pack.ts`](src/pack.ts) and `docs/API.md`.
  With `PACK_APP_KEYS` too, a second format is built beside it for newer apps: every entry is
  also keyed with a secret pack key that the server hands to signed-in phones, so the pack
  bytes alone open nothing. That makes harvesting dearer, not impossible: anyone who gets the
  key (an account can ask for it) still opens entries one Argon2 hash per guessed number.
- **What it does not do.** Caller ID needs the server to answer "whose number is this?", so
  this is not end-to-end encryption: a server holding `CONTACTS_KEY` can answer a lookup for
  any number it is asked about.
- **Accounts.** Member accounts (name and phone number) are visible to the server admin, so
  the operator knows who uses the service. Spam reports and block rules are stored as plain
  numbers, because phones download them for offline blocking.
- **Logs.** App logs and crash reports are tied to a random install ID and are deleted after
  `TELEMETRY_RETENTION_DAYS` (14 by default). The app masks phone numbers before sending them.
- **Family data stays in the family.** Every user belongs to one family: sign up without a code
  to start your own, or use an invite to join one. Members, alerts, SOS locations and the block
  list never cross families. Every user adds to the shared caller-ID names and spam
  labels, with per-user rate limits. The trusted family (the operator's, set up with
  `ADMIN_CODE`) keeps the server-wide admin routes, and its admins' spam reports count on their
  own. Contacts shared before open sign-up only answer that family's lookups.

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
- `PACK_KEY` (optional): `openssl rand -hex 32`, different from `CONTACTS_KEY`. Turns on the
  offline name pack.
- `POSTGRES_PASSWORD`: letters and digits only, e.g. from `openssl rand -hex 16`.
- `PUBLIC_URL`: the address the phones use, e.g. `https://calls.example.com`.
- `DOMAIN`: only if you use the built-in HTTPS (step 5), e.g. `calls.example.com`.

Every variable is explained in `.env.example`.

### 4. Start

```bash
docker compose up -d --build
curl localhost:3000/health      # {"ok":true,"version":"1.0.0"}
```

With `SIGNUP_PROOF` set, the answer also carries `"signupProof":"email"` or `"google"`.

The database schema is created automatically on first start. Logs:
`docker compose logs -f api`.

This starts three services: `db`, `api` and `pack-worker`. The pack worker builds the offline
name pack (with `PACK_KEY`; without it, it idles): it rebuilds each changed number within seconds
and runs a full pass nightly at 03:00 Pakistan time. Its log (`docker compose logs -f pack-worker`)
shows lines like `name pack: drained 3 queued numbers, 3 updated, ...`. To run the API alone
instead, set `PACK_INLINE=true` in `.env`: the API then builds the pack itself.

**Name pack format 2 (optional, for app 1.0.48 and later).** Format 1 (`GET /v1/pack`) stays as
it is for older apps. To also build format 2 (keyed, in parts; `docs/API.md`):

1. With `PACK_KEY` already set, generate a pack key (`openssl rand -hex 32`) and add
   `PACK_APP_KEYS=1:<that key>` to `.env`. Keep a copy with your other keys.
2. `docker compose up -d` (both `api` and `pack-worker` read it). The worker logs
   `pack worker: format 2 on, PACK_APP_KEYS ids 1 (current 1)`, then
   `name pack format 2: building generation N under pack key 1`. The first build hashes every
   number once more (about 10 to 20 minutes per 100,000 numbers with 4 `PACK_WORKERS`); format 1
   keeps serving and changes keep flowing meanwhile. Until it is done the format-2 routes answer
   `503 pack_not_ready`.
3. `name pack format 2: generation N (pack key 1) is live: ...` means phones can use it. From then
   on every change reaches both formats within seconds.

To turn it off again, empty `PACK_APP_KEYS` and `docker compose up -d`: the format-2 routes answer
`404 pack_disabled` and nothing more is written to it (the rows stay; turning it back on catches
them up with one full pass). **Key rotation** (when a key may have leaked): put a new id and a new
key at the front, `PACK_APP_KEYS=2:<new>,1:<old>`, and `docker compose up -d`. The worker builds a
new generation (as long as the first build), swaps it in, and serves the old one for deletes for
14 days; every phone downloads the whole pack again. Remove `1:<old>` after those 14 days. Never
change the value behind an id in use: the worker logs `PACK_APP_KEYS key N does not match ...`
and builds and serves nothing of format 2 until it is restored. `PACK_KEY_HOLDERS=google` limits
the key to Google-linked accounts; `docker compose exec pack-worker node dist/cli/pack.js revoke
<phone>` cuts one account off (`unrevoke` undoes it).

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
account with just a name and number, and starts a family of their own. Every user gets the shared
caller ID, which every user feeds with their synced contacts and spam reports. There is **no proof of number ownership**
(no SMS code), so a number can be squatted by someone else. Set `SMTP_URL` (email codes) and/or `GOOGLE_CLIENT_IDS` (Sign in with Google), and
`SIGNUP_PROOF=email` (old name `EMAIL_VERIFICATION=required`) to make every new account verify an
email (one account per email), which slows down mass sign-ups and lets members sign back in on a
new phone with their email. `SIGNUP_PROOF=google` (needs `GOOGLE_CLIENT_IDS`) goes further: every
new account needs a Google account, one SureCaller account per Google account; existing accounts
keep signing in as before, and the first `ADMIN_CODE` sign-up is exempt. Add `SPAM_REPORTERS=google`
to count spam reports only from Google-confirmed accounts and your own family's admins (others are
stored, not counted; the server relabels every reported number on the next start after a change).
Check `GET /health` shows the `signupProof` you set. If the migration logs that
`users_email_canonical_unique` is missing, two accounts share a Gmail address written differently:
change one's email, then create the index as in `migrations/019_google_identity.sql`.
Sign-ups are also limited by the per-IP `REGISTER_RATE_LIMIT`. An existing number can never be
taken over without its email or an admin reset. The admin can still create one-time invite codes
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
logs a warning at start when it is set). The server logs its setting at every start
(`docker compose logs api | grep TRUST_PROXY`).

### Client IP behind a proxy

A hop count only works when every proxy in front passes on the `X-Forwarded-For` it received.
Caddy does not by default: it replaces the incoming header with the address that connected to it
unless that address is in its `trusted_proxies`. Behind Cloudflare that address is a Cloudflare
edge server, so with `TRUST_PROXY=2` the API sees the edge as the client, and every phone that
comes through the same edge shares the per-IP limits (`REGISTER_RATE_LIMIT`,
`EMAIL_CODE_RATE_LIMIT`, `TELEMETRY_RATE_LIMIT`, privacy requests).

To check what the API sees:

1. Set `LOG_LEVEL=debug` in `.env` and run `docker compose up -d`.
2. From your own computer or phone (not the server), open `https://your-domain/health`.
3. Run `docker compose logs api | grep "client address"`. Each request logs `ip` (what the rate
   limits use), `xff` (the `X-Forwarded-For` the API got) and `cfConnectingIp` (the client as
   Cloudflare saw it).
4. Set `LOG_LEVEL=info` again and run `docker compose up -d`.

If `ip` equals `cfConnectingIp` (your own public address), all is well. If `ip` is some other
address and `xff` holds only that one address, Caddy dropped the client's entry. Tell Caddy to
trust Cloudflare, in the global options block at the top of the Caddyfile:

```
{
	servers {
		trusted_proxies static <Cloudflare's IPv4 and IPv6 ranges, from https://www.cloudflare.com/ips/>
	}
}
```

Reload Caddy and check again: `xff` should now hold two addresses (the client, then the
Cloudflare edge) and `ip` the client. Keep `TRUST_PROXY=2`. The built-in Caddy (`--profile
https`) runs `caddy reverse-proxy` with no Caddyfile, so it can't take this setting; without
Cloudflare in front it needs none (`TRUST_PROXY=1`). Cloudflare changes its ranges now and then:
recheck the list when the addresses look wrong again.

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

New requests also show in the logs as `privacy request received`. With `PACK_KEY`, `apply` of a
removal waits up to 60 s for the name to leave the offline name pack and says whether it did.

## Daily name budget

Each member gets at most `LOOKUP_DAILY_LIMIT` caller-ID names a day from the server (see
`docs/API.md`, "Online answer budget"). It starts in log-only mode. After a week, look at the
real use and pick the limit, then set `LOOKUP_DAILY_ENFORCE=true`:

```bash
docker compose exec api node dist/cli/usage.js       # p50 / p99 / max names per member per day, last 7 days
```

## Business directory (optional)

Names for business numbers no user has saved, from [Overture Maps](https://docs.overturemaps.org/guides/places)
places (CDLA Permissive 2.0, Apache 2.0 and CC0, depending on the source). Lookups use a saved
contact first, then the directory, then name suggestions. Build the file with
[DuckDB](https://duckdb.org) (edit the release, bounding box and country in the script), then
load it. Each import replaces the last one and skips opted-out numbers.

For Pakistan, the [Yellow Pages of Pakistan](https://opendata.com.pk/dataset/yellow-pages-of-pakistan)
open dataset (PDDL, 2019) adds older listings, mostly landlines. Put it after Overture so
Overture's name wins where both list a number.

```bash
duckdb < scripts/overture-directory.sql        # writes directory.ndjson
python3 scripts/yellow-pages.py yp/*.csv >> directory.ndjson   # optional, Pakistan only
docker compose exec -T api node dist/cli/directory.js import < directory.ndjson
```

With `PACK_KEY`, the pack worker then runs a full pass to bring the offline name pack up to date.

## Handyman directory

Members add local workers and review them in the app; the contract is in
[`docs/HANDYMAN.md`](docs/HANDYMAN.md). To start a city with some listings, seed it from one
member's own contacts whose saved names carry a trade ("Ali Plumber"). It needs `PACK_KEY`, and
it only prints what it would add until you pass `--apply`:

```bash
docker compose exec api node dist/cli/handymen-seed.js --user <id|phone> --city Hyderabad
docker compose exec api node dist/cli/handymen-seed.js --user <id|phone> --city Hyderabad --apply
```

## Operator user list

Admins of the family that `ADMIN_CODE` set up can list every account and see one account's use
(lookups, shared contacts, spam reports, devices): `GET /v1/admin/users` and
`GET /v1/admin/users/:id/usage`, in `docs/API.md` under "Users (operator only)".

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
