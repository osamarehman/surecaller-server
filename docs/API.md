# SureCaller server API (v1)

One server, one user base: family members (joined with an invite code) plus, optionally, open
sign-ups. Everything below is the contract between the Android app and the backend. Change it here first, then in code.

- Base URL: configured in the app at setup, e.g. `https://surecaller.example.com`.
- All bodies are JSON (`Content-Type: application/json`). Times are ISO-8601 UTC strings.
- Phone numbers are always E.164 (`+923001234567`). The server re-normalizes and rejects
  anything it can't parse (`400 {"error":"invalid_phone"}`).
- Auth: `Authorization: Bearer <token>` on every route except `/health`,
  `POST /v1/register`, `POST /v1/email-codes`, `POST /v1/privacy-requests` and `GET /downloads/*`.
- Errors: non-2xx with `{"error": "<snake_case_code>", "message": "<human text>"}`.

## Joining

Every user belongs to one **family**. Family data never crosses families: the member roster,
invites, stats, SOS and alert events, the block list, and the `member` field on a lookup only
ever show your own family. Caller-ID names and spam labels are shared by every user.

The first person to register uses the server's `ADMIN_CODE` (env var). That makes them admin of
the **trusted** family (the operator's). After that, `ADMIN_CODE` only re-registers an admin of
that family.

Registration is **open**: `POST /v1/register` with no `code` creates a brand-new number's
account in a new family of its own, with the user as its admin (an existing number still needs a
reset, see below). An invite code joins the inviter's family.

Only **trusted** families add to what everyone sees: contact sync, spam reports, name
suggestions and link reports return `403 forbidden` for everyone else. `isTrusted` on a `User`
says which. Server-wide admin routes (`GET /v1/telemetry`) are for admins of the trusted family.

**Email.** Each account can have one verified email (one account per email). With
`EMAIL_VERIFICATION=required` on the server, every new account needs one. The app first calls
`POST /v1/email-codes`, the user types the 6-digit code from the email, and the app sends
`email` + `emailCode` with `POST /v1/register`.

**Sign in with Google** proves the email in one tap and is the preferred path: the app gets a
Google ID token (Credential Manager, `serverClientId` = the server's web client ID in
`GOOGLE_CLIENT_IDS`) and sends `googleIdToken` instead of `email` + `emailCode`. The server checks
the signature, the audience and `email_verified`, and uses the token's email. Keep the email code
as the fallback for phones without Google Play services. Both prove the same thing, so an account
made with Google can later sign in with an email code to the same address, and the other way round.
Errors: `403 invalid_google_token`, `503 google_unavailable` (server has no `GOOGLE_CLIENT_IDS`),
`400 invalid_request` when a request sends both kinds of proof.

Either proof also signs an existing member in on
a new phone without an admin (open sign-up path, no `code`), as long as the email matches the
account's. The email is shown only to its owner (`GET /v1/me`), never to other members.

### `POST /v1/email-codes`
```json
{ "email": "ali@example.com" }
```
→ `202 {"ok": true}`. Emails a 6-digit code, valid 15 minutes, 5 tries. The answer is the same
whether or not the email has an account. Errors: `429 rate_limited` (a code was sent under a
minute ago, or more than `EMAIL_CODE_RATE_LIMIT` requests per IP per hour, default 5),
`503 email_unavailable` (server has no `SMTP_URL`), `503 email_failed` (sending failed).

Invites (admins, or up to 5 per member):

- **Plain invite** (`POST /v1/invites` without `phone`): joins a number that is *not* a
  member yet. It can never re-register an existing member.
- **Phone-bound invite** (`POST /v1/invites` with `phone`): works only for that exact
  number. This is how an existing member re-registers after a reinstall or on a new phone
  (admin UI: "Reset device" on the member). It can also pre-bind a brand-new member's code.

### `POST /v1/register`
```json
{ "phone": "+923001234567", "name": "Ali", "code": "K7Q2-9XPM", "deviceName": "Pixel 8",
  "email": "ali@example.com", "emailCode": "482913" }
```
`email` and `emailCode` are optional unless the server requires email, and always go together.
`googleIdToken` can replace them (see Email above).
→ `201`
```json
{ "token": "<opaque, 64 hex chars>", "user": User }
```
`name` is required for a new member and optional when re-registering.

Re-registering an existing member's phone replaces that user's token (the old device is
signed out and its FCM token cleared) and keeps their id, name and admin role. Allowed only with:
- the account's verified email and a fresh code (no `code`), or
- a phone-bound invite for that phone, or
- `ADMIN_CODE`, and only when that phone is an existing **admin** (or no admin exists yet).

`ADMIN_CODE` is a **master credential**: with it and an admin's phone number, anyone can take
over that admin's account (the previous device is signed out). The server keeps this path open
on purpose, so a sole admin who loses their phone can still get back in. Every such takeover is
written to the server log (`warn`, phone masked, client IP, device name): watch for it, keep the
code off shared chats, and rotate it (change `.env`, `docker compose up -d`) after any recovery
or whenever it may have leaked.

Errors:
- `403 invalid_code`: unknown, used or expired code; a phone-bound invite for a different
  phone; `ADMIN_CODE` used by a non-admin once an admin exists.
- `409 phone_taken`: a plain invite used for a phone that is already a member. The code is
  **not** consumed. App: tell the user "This number is already in the circle; ask an admin
  to reset your device."
- `403 invalid_email_code`: wrong, used or expired email code, or 5 wrong tries.
- `409 phone_taken` also for open sign-up of an existing number without its email.
- `409 email_taken`: the email belongs to another account.
- `400 email_required`: the server requires email and this is a new account.
- `400 invalid_phone`, `400 invalid_request` (e.g. `name: required` for a new member).
- `User` in the response also has `email` (string or null).
- `429 rate_limited`: `REGISTER_RATE_LIMIT` attempts per client IP per minute (default 10).

### `User`
```json
{
  "id": "uuid", "phone": "+923001234567", "name": "Ali", "isAdmin": true, "isTrusted": true,
  "status": "Driving",            // free text, may be null
  "shareContacts": true,
  "sharedContactCount": 412,
  "protection": { "screening": true, "overlay": true, "recording": false, "reportedAt": "..." },
  "watched": true,                 // admin gets alerts for this member's spam calls
  "lastSeenAt": "..."
}
```

## Me

- `GET /v1/me` → `User` plus `"email"` (string or null)
- `PATCH /v1/me` body (all optional): `{ "name", "status", "shareContacts", "protection": {...}, "fcmToken" }` → `User`.
  To add or change the email, send `"googleIdToken"`, or `"email"` with an `"emailCode"` from `POST /v1/email-codes`
  (`403 invalid_email_code`, `409 email_taken`). Existing accounts use this to add a recovery email.
- `DELETE /v1/me` → `204`. Deletes the user, their shared contacts, reports and token.
  `409 last_admin` if the caller is the only admin and other members remain (make someone
  else admin first).

## Circle

All of these act on the caller's family only; another family's member is `404`.

- `GET /v1/members` → `{ "members": [User] }`
- `PATCH /v1/members/:id` (admin) `{ "watched": bool, "isAdmin": bool }` → `User`
- `DELETE /v1/members/:id` (admin) → `204`. `409 last_admin` if it is the only admin and
  other members remain.
- `POST /v1/invites` (admin) `{ "expiresInHours": 72, "phone": "+923001234567" }`
  (both optional; `expiresInHours` 1..720, default 72) →
  `201 { "code": "K7Q2-9XPM", "expiresAt": "...", "phone": "+923001234567" | null }`.
  With `phone` (any format the server can normalize; `400 invalid_phone` otherwise) the code
  only registers that number and is the way to re-register an existing member ("Reset
  device"). Without it, `phone` is `null` and the code only registers a new number.
  A `phone` that belongs to another family is `409 phone_taken`.
- `GET /v1/stats` → `{ "members": 9, "knownNumbers": 2860, "spamBlocked": 47 }` (`members` and
  `spamBlocked` are your family's; `knownNumbers` is the shared database)

## Contacts (crowd names)

### `POST /v1/contacts/sync`
Replaces the caller's whole shared address book.
```json
{ "contacts": [ { "phone": "+923215550142", "name": "Ali Raza" } ] }
```
→ `{ "stored": 412 }`. Max 20 000 entries per request. Ignored when `shareContacts` is false
(`409 sharing_off`).

- `DELETE /v1/contacts` → `204` (remove everything this user shared)

## Lookup

### `GET /v1/lookup/:phone`
→ `Lookup`
```json
{
  "phone": "+923215550142",
  "name": "Ali Raza",                     // best name or null
  "nameSource": "member" | "contacts" | "suggested" | null,
  "altNames": [],                         // always empty: other saved names are never exposed
  "savedByCount": 3,                      // how many users have it saved
  "member": { "id": "uuid", "name": "Ali", "status": "Driving" } | null,
  "spam": {
    "label": "none" | "suspected" | "likely_scam",
    "score": 0,                           // 0..100
    "reports": 14,                        // distinct reporters
    "notSpam": 1,
    "topCategory": "scam" | "telemarketing" | "robocall" | "harassment" | "other" | null,
    "lastComment": "Asks for card PIN" | null
  },
  "blocked": { "byCircle": true, "addedBy": "Abbu" } | null,
  "callsToday": 31                        // lookups for this number in the last 24h
}
```
Name priority: circle member's own profile → most common name among shared contacts
(ties: most recent) → suggested names. Every lookup is logged (phone, user, time) for `callsToday`.

Rate limit: `LOOKUP_RATE_LIMIT` (default 120) per member per minute → `429 rate_limited`.

### `POST /v1/lookup/batch`
`{ "phones": ["+92..."] }` (max 100, else `400`) → `{ "results": [Lookup] }` — used to label
Recents. Results are deduped, in request order; unparsable numbers are skipped. Not logged
(doesn't affect `callsToday`).

Rate limit: a separate per-member budget of `BATCH_LOOKUP_RATE_LIMIT` (default 300) numbers
per minute; each distinct parsable number costs 1 (an empty/all-junk batch costs 1). It
does not use up the single-lookup budget. Over budget → `429 rate_limited` with a
`Retry-After` header (seconds); the rejected batch costs nothing. App: send Recents in
chunks of ≤100 and back off on 429.

## Reports and names

- `POST /v1/reports` `{ "phone", "category", "comment"?, "notSpam": false }` → `Lookup`.
  One active report per (user, phone); posting again replaces it. `notSpam: true` is a vote against.
- `DELETE /v1/reports/:phone` → `204` (withdraw my report)
- `POST /v1/names` `{ "phone", "name" }` → `Lookup` (suggest a name; one per user per phone)

Spam rules (server env, defaults): `label = likely_scam` when distinct reporters minus
not-spam votes ≥ `SPAM_THRESHOLD` (2), or any admin reported it; `suspected` at ≥ 1.
`score = min(100, 40*net_reports + 2*callsToday)`, 0 when `net_reports <= 0`.

## Spam + block sync (for the phone's offline database)

### `GET /v1/sync?since=<ISO time or empty>`
```json
{
  "serverTime": "...",
  "spam":   [ { "phone": "+92...", "label": "likely_scam", "score": 92, "reports": 14, "topCategory": "scam", "deleted": false } ],
  "blocks": [ { "id": "uuid", "type": "number" | "prefix" | "country", "value": "+92304111", "label": "Bank scam series", "addedBy": "Abbu", "deleted": false } ]
}
```
Empty `since` = full snapshot. Rows whose label dropped to `none` or were removed come back with
`"deleted": true`. The app stores `serverTime` and sends it next time.

### Family block list (one per family)
- `POST /v1/blocks` `{ "type", "value", "label"? }` → block row. `number` = E.164, `prefix` = E.164 prefix
  (`+92304111`), `country` = calling code with plus (`+234`).
- `DELETE /v1/blocks/:id` → `204`

## Events (family alerts + SOS)

Events stay inside the sender's family.

- `POST /v1/events`
  ```json
  { "type": "spam_call" | "sos" | "scam_sms", "phone": "+92...", "message": "...", "lat": 31.52, "lng": 74.35 }
  ```
  → `201 Event`. `spam_call` / `scam_sms` go to admins (only for `watched` members);
  `sos` goes to every other member of the family. Delivered by FCM when `FCM_SERVICE_ACCOUNT` is configured,
  always available by polling.
- `GET /v1/events?since=<ISO>` → `{ "events": [Event] }` (last 7 days, newest first)

`Event`: `{ "id", "type", "fromUser": {"id","name"}, "phone", "message", "lat", "lng", "createdAt" }`

**Push payload.** The FCM message is data-only and carries nothing but the id:
`{ "kind": "event", "id": "<uuid>" }`. No type, phone, message, SOS position or member name goes
through Google. On receipt the app must call `GET /v1/events?since=<last cursor>` to get the
`Event` (and anything else it missed) and build the notification from that; a push with an id
the app cannot fetch is ignored. The full row stays on the server, visible only inside the circle.

## Scam checker

- `POST /v1/check` `{ "text": "pasted message or link" }` →
  ```json
  { "phones": [Lookup], "urls": [ { "url": "https://...", "reports": 3, "label": "likely_scam" } ], "verdict": "safe" | "unknown" | "suspicious" | "scam" }
  ```
- `POST /v1/reports/url` `{ "url" }` → `{ "url", "reports", "label" }`

## Privacy requests (public, for a website form)

### `POST /v1/privacy-requests`

`{"kind": "account" | "remove", "phone": "+923001234567", "email": "you@example.com"}` → `202 {"ok": true}`.
Five per IP per hour. Nothing is deleted at this point: the operator checks the number belongs to
the requester, then runs `node dist/cli/privacy.js apply <id>`. `account` deletes that member;
`remove` (for people who don't use the app) deletes every shared name for the number and ignores
future uploads of it. One pending request per kind and number; a repeat updates the email.

## App updates (no Play Store)

- `GET /v1/app/latest` →
  ```json
  { "versionCode": 7, "versionName": "1.0.6", "apkUrl": "https://host/downloads/surecaller-1.0.6.apk",
    "notes": "...", "sha256": "<64 hex chars>" | null, "minVersionCode": 5 | null, "mandatory": false }
  ```
  read from `downloads/latest.json` on the server (you publish it; see the README). 404 until
  that file exists. A relative `apkUrl` in the file is returned as `PUBLIC_URL/downloads/<file>`;
  when `PUBLIC_URL` is not set the server answers `503 public_url_unset` (and logs it) instead of
  guessing an `http://` link from the `Host` header, which the app would refuse anyway. An
  absolute `https://` `apkUrl` needs no `PUBLIC_URL`.
  - `sha256`: lower-case hex SHA-256 of the APK. **Required** for automatic (silent) installs; the
    app verifies the download against it. Missing, `null` (as in `downloads/latest.example.json`) or
    malformed → `null`, and the app only offers a
    manual, user-confirmed install from Settings (backward compatible with old `latest.json` files).
  - `minVersionCode` (optional): builds below this must update (the app shows the update as
    required and ignores "only on Wi-Fi" for it). Non-positive / non-integer → `null`.
  - `mandatory` (optional, default `false`): same as above for every older build.
- `GET /downloads/<file>` → static files from the server's `downloads/` folder, no auth.

## Telemetry (debugging from the server)

Phones send logs and crash reports so problems can be debugged on the server. Works before
sign-up too (a crash on first start still gets reported), so the bearer token is optional.

### `POST /v1/telemetry`
Auth optional: with a valid `Authorization: Bearer <token>` the events are linked to that
member; with no token (or an invalid one) they are stored with `userId = null`.
```json
{
  "installId": "uuid made on first start (survives app updates, not reinstalls)",
  "appVersion": "1.0.3+4",
  "device": "Google Pixel 9a",
  "os": "Android 16 (SDK 36)",
  "events": [
    { "at": "2026-10-21T09:50:15.917Z", "level": "error", "source": "dart",
      "tag": "startup", "message": "PlatformException(...)", "details": { "stack": "..." } }
  ]
}
```
- `level`: `debug` | `info` | `warn` | `error` | `fatal`. `source`: `dart` | `native`.
- Limits with a valid token: 1..200 events; `tag` ≤ 64 chars; `message` ≤ 4000 chars; `details`
  (any JSON object) ≤ 16 KB serialized; request body ≤ 512 KB. Longer strings are truncated by the
  server, not rejected. Without a valid token (anyone can post those) the server keeps at most 50
  events per request, `message` ≤ 1000 chars and `details` ≤ 4 KB; the rest is dropped the same way.
- Phone numbers must not be sent in full: the app masks them to the last 4 digits. The server
  masks again before storing (every run of 7+ digits, with separators or URL-encoded `+`/space,
  in `message` and in every string inside `details` → `…1234`), so a stale app or a stranger
  posting here cannot put a full number in the logs.
- Rate limit: `TELEMETRY_RATE_LIMIT` requests per client IP per minute (default 120) → `429`.
- Caps (never an error, so the phone doesn't retry): at most `TELEMETRY_MAX_EVENTS_PER_INSTALL_DAY`
  events per install per 24h (default 5000), and nothing while the table is larger than
  `TELEMETRY_MAX_BYTES` on disk (default 500 MB, exact, checked before every insert) or holds more
  than `TELEMETRY_MAX_ROWS` rows (default 2,000,000, planner estimate). The per-install cap can be
  dodged with random install ids; the size cap bounds the disk regardless. Events over a cap are
  dropped and `stored` says how many were kept.
- NUL characters are removed. An `at` that is missing, unparsable, more than 30 days in the past
  or more than 1 day in the future is replaced with the server time. A batch the database still
  rejects (Postgres data error) → `400 invalid_data`; the phone should drop it, not retry.

→ `200 { "stored": 12, "debug": false }`. `debug: true` asks the phone to also record `debug`
level events (set per install with `TELEMETRY_DEBUG_INSTALLS`, comma-separated install ids or
`all`). Without it the phone drops `debug` events.

### `GET /v1/telemetry` (admin)
Query (all optional): `installId`, `userId`, `level` (minimum level, e.g. `warn`), `tag`,
`since` (ISO time), `q` (case-insensitive text in message), `limit` (1..1000, default 200).
→ `{ "events": [TelemetryEvent] }`, newest first.

`TelemetryEvent`: `{ "id", "receivedAt", "at", "installId", "userId", "userName", "appVersion",
"device", "os", "level", "source", "tag", "message", "details" }`

### `GET /v1/telemetry/installs` (admin)
→ `{ "installs": [ { "installId", "userId", "userName", "appVersion", "device", "os",
"lastSeenAt", "errors24h", "events24h" } ] }` — one row per phone that sent anything in the
retention window, most recent first.

On the server, `docker compose exec api node dist/cli/logs.js` prints the same data in the
terminal (see `backend/README.md`). Events older than `TELEMETRY_RETENTION_DAYS` (default 14)
are deleted.

## Health
- `GET /health` → `{ "ok": true, "version": "1.0.0" }`
