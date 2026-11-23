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
- Build header: new builds send `X-SureCaller-Build: <versionCode>` on every request. The server
  stores the last value per member (`users.app_build`, written at most once a minute unless the
  build changes). Requests without it come from builds up to 1.0.47.

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

Every user has the same features: everyone starts or joins a family, and everyone adds to the
shared caller ID (contact sync, name suggestions, spam and link reports), with per-user limits
(contact sync 30 per hour, reports and names 60, link reports 30). Other per-user limits, all
`429 rate_limited` with `Retry-After`: invites 30 per hour, family block rules 120 per hour,
`spam_call` / `scam_sms` events 120 per hour (an SOS is never limited), scam checks 120 per hour,
photo changes 20 per hour, `GET /v1/stats` 60 per minute. `isTrusted` on a `User` is
**deprecated and always `true`**; apps should stop reading it. The server still knows the
operator's family (set up with `ADMIN_CODE`): only its admins see `GET /v1/telemetry`, and only
their spam reports label a number `likely_scam` on their own. Anyone else's report counts as one
of the reporters `SPAM_THRESHOLD` needs.

**Email.** Each account can have one verified email (one account per email; for Gmail, dots and
a `+tag` in the address don't make it a different email: `a.b+x@gmail.com` is `ab@gmail.com`). With
`SIGNUP_PROOF=email` (the old `EMAIL_VERIFICATION=required`) on the server, every new account needs one. The app first calls
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

**Google sign-up proof.** With `SIGNUP_PROOF=google`, every new account (open sign-up, or an
invite code for a new number) needs a `googleIdToken`: one SureCaller account per Google account.
An email code is not enough (`403 google_required`, and the code is not spent). Exempt: the first
`ADMIN_CODE` sign-up that sets the server up, an `ADMIN_CODE` re-registration of an admin, and a
phone-bound invite (device reset) of an existing member. Existing accounts keep every way in they
had: an email code still signs them in. The account remembers the Google account (its ID token
`sub`) it was made or confirmed with (`googleVerified` on `GET /v1/me`); signing in with Google
finds it by that first, so it still works after the Google account's address changes. A Google
proof on an account that has none links it, whatever `SIGNUP_PROOF` is.

Either proof also signs an existing member in on
a new phone without an admin (open sign-up path, no `code`), as long as the email matches the
account's. With Google: the account linked to that Google account, or an account not linked to
any with the same address (it gets linked). With an email code: the account's exact email. The email is shown only to its owner (`GET /v1/me`), never to other members.

**Sign in with email.** `POST /v1/register` with a verified email (`googleIdToken`, or `email` +
`emailCode`) and **no `phone`** (and no `code`) signs in to the account that has that email,
whatever SIM the phone has. Same response as register; the account keeps its own phone number,
and the previous device is signed out. A `googleIdToken` finds the account linked to that Google
account first, else an account not linked to any with the same address; it gets linked and its
email becomes the token's. `404 no_account` when no account has the email (the email
code is not spent, so the app can go on to sign-up with it).

### `POST /v1/email-codes`
```json
{ "email": "ali@example.com" }
```
→ `202 {"ok": true}`. Emails a 6-digit code, valid 15 minutes, 5 tries. The answer is the same
whether or not the email has an account. Errors: `429 rate_limited` (a code was sent under a
minute ago, more than `EMAIL_CODE_RATE_LIMIT` requests per IP per hour, default 5, or 10 codes
for this email address already today, UTC, from any IP),
`503 email_unavailable` (server has no `SMTP_URL`), `503 email_failed` (sending failed).

Each email address also gets at most 20 wrong codes per UTC day, from any IP; after that every
code for it fails with `403 invalid_email_code` until the next day (Google sign-in still works).

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
- `403 invalid_email_code`: wrong, used or expired email code, 5 wrong tries for this code, or 20
  wrong tries for this email today.
- `409 phone_taken` also for open sign-up of an existing number without its email.
- `409 email_taken`: the email (or the same Gmail address written differently, or the Google
  account) belongs to another account. For a new account made with Google the message names it:
  "This Google account already has a SureCaller account (number ending 1234). Sign in with Google
  instead." (last 4 digits only). The app should offer sign in with the same token (no `phone`).
- `400 email_required`: the server requires email (`SIGNUP_PROOF=email`) and this is a new account.
- `403 google_required`: `SIGNUP_PROOF=google` and this new account sent no `googleIdToken`.
  Message: "New accounts need a Google account. Tap “Continue with Google”, or update SureCaller
  from Google Play." (old apps show it as is).
- `503 google_unavailable`: the server has no Google sign-in, or could not reach Google to check
  the token (try again). `403 invalid_google_token` is only for a token that fails the check.
- `400 invalid_phone`, `400 invalid_request` (e.g. `name: required` for a new member).
- `User` in the response also has `email` (string or null).
- `429 rate_limited`: `REGISTER_RATE_LIMIT` attempts per client IP per minute (default 10).

### `User`
```json
{
  "id": "uuid", "phone": "+923001234567", "name": "Ali", "isAdmin": true, "isTrusted": true,
  "photoUrl": "https://lh3.googleusercontent.com/a/...=s256-c",  // Google profile picture, or null
  "status": "Driving",            // free text, may be null
  "shareContacts": true,
  "sharedContactCount": 412,
  "protection": { "screening": true, "overlay": true, "recording": false, "reportedAt": "..." },
  "watched": true,                 // admin gets alerts for this member's spam calls
  "lastSeenAt": "..."
}
```

## Me

- `GET /v1/me` → `User` plus `"email"` (string or null) and `"familyId"` (the app refetches its offline name pack when it changes)
  and `"contactsResyncNeeded"`: true while some of the caller's shared contacts were uploaded before
  the offline name pack existed. The app should then upload its full address book once
  (`POST /v1/contacts/sync`, skipping the unchanged-address-book check); it turns false after that.
  Also `"isOperator"` (true for an admin of the operator's family: the app then shows the Users list below),
  `"googleVerified"` (the account is linked to a Google account) and `"reportsCount"` (false only when
  the server has `SPAM_REPORTERS=google` and this account is neither Google-linked nor an admin of the
  operator's family: its spam reports are stored but don't count; the app asks it to confirm with Google)
- `PATCH /v1/me` body (all optional): `{ "name", "status", "shareContacts", "protection": {...}, "fcmToken" }` → `User`.
  To add or change the email, send `"googleIdToken"`, or `"email"` with an `"emailCode"` from `POST /v1/email-codes`
  (`403 invalid_email_code`, `409 email_taken`). Existing accounts use this to add a recovery email.
  A `googleIdToken` also links an account that has no Google account yet ("Confirm with Google").
  With `SIGNUP_PROOF=google`, one linked to a different Google account gets
  `409 google_account_set` ("This account is already confirmed with another Google account.").
  Changing the email by code never changes the link. A Google account already linked to another
  account: `409 email_taken`.
- `PUT /v1/me/photo` body `{ "googleIdToken": "..." }` → `User` (as `GET /v1/me`). The member's photo
  becomes the profile picture of that Google account. The link always comes out of a verified
  Google ID token (https on `googleusercontent.com`); a client can't set a link of its own.
  `403 invalid_google_token`, `422 no_photo`, `503 google_unavailable`. The recovery email is not changed.
- `DELETE /v1/me/photo` → `User`. Removes the photo.
- A new account made with `googleIdToken` starts with that Google picture. Signing in again never
  changes the photo, so a removed photo stays removed.
- `DELETE /v1/me` → `204`. Deletes the user, their shared contacts, reports and token.
  `409 last_admin` if the caller is the only admin and other members remain (make someone
  else admin first).

## Backup

The app's local data (block rules, notes, favourites, settings), so a reinstall or a move to
another build restores it. One backup per member; the server stores it sealed and never reads it.

- `PUT /v1/backup` body `{ "data": { ... } }` (a JSON object, at most 1 MB) → `{ "updatedAt": "..." }`.
  Replaces the previous backup. `413 too_large` over 1 MB; 60 per hour.
- `GET /v1/backup` → `{ "data": { ... }, "updatedAt": "..." }`, or `404 no_backup`.
- `DELETE /v1/backup` → `204`. Deleting the account deletes the backup too.

## Circle

All of these act on the caller's family only; another family's member is `404`.

- `POST /v1/family/join` (also `POST /v1/join`) `{ "code": "K7Q2-9XPM" }` → `User` (with `email`). A signed-in user
  joins the invite's family as a member (not admin). They leave their old family: its admin rule
  applies (`409 last_admin` if they are its only admin and others stay), an emptied family is
  deleted, and their own recent alerts and SOS are deleted (they belonged to the old family).
  `403 invalid_code` (unknown, used, expired, or bound to another phone), `409 already_member`.
- `POST /v1/family/leave` → `User`. Leaves the family and starts a new one with the caller as its
  admin. Same rules as above; `409 alone` if they are the only member already.
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
  `spamBlocked` are your family's; `knownNumbers` is the shared database, counted at most every
  5 minutes, so it can lag that long)

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
  "nameSource": "member" | "contacts" | "directory" | "suggested" | null,
  "category": "restaurant" | null,        // business type, only when nameSource is "directory"
  "altNames": [],                         // always empty: other saved names are never exposed
  "savedByCount": 3,                      // how many users have it saved
  "member": { "id": "uuid", "name": "Ali", "status": "Driving" } | null,
  "photoUrl": "https://lh3.googleusercontent.com/a/...=s256-c" | null,
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
(ties: most recent) → suggested names. Shared contact and suggested names are cleaned first
(`src/names.ts`): a name that only says how the uploader knows the person ("Wife", "Ammi", "Me")
is never shown; tags like "Jazz", "Office", "Bhai", digits and trailing initials are dropped; a
name typed in English beats one typed in Urdu, and an Urdu-only name is written in English letters.
Every lookup is logged (phone, user, time) for `callsToday`; the log is deleted after 2 days.

`photoUrl` is the photo of the SureCaller account on that number (see `PUT /v1/me/photo`). Unlike
`member`, it is sent to users of every family: a member with a photo is recognisable to anyone
they call. A member who wants that undone removes the photo.

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

### Online answer budget

A server answer that carries a caller-ID name (`name` not null) counts against
`LOOKUP_DAILY_LIMIT` (default 2000) names per member per UTC day, shared by
`GET /v1/lookup/:phone`, `POST /v1/lookup/batch`, the phones in `POST /v1/check`, and the `Lookup`
returned by `POST /v1/reports` and `POST /v1/names`. Answers without a name are free. The
per-minute and per-hour limits above still apply.

- With `LOOKUP_DAILY_ENFORCE=false` (the default) nothing is refused: the server counts and logs
  each member who passes the limit (`node dist/cli/usage.js` shows the distribution).
- With `LOOKUP_DAILY_ENFORCE=true`, a member at the limit gets `429 rate_limited` with
  `Retry-After` (seconds to the next UTC midnight). A batch or check whose names would cross the
  limit is refused whole and counts nothing. A refused report or name suggestion is not stored;
  one already under the limit is always answered in full.

Opt-outs for new apps, never counted and never refused by this budget:

- `POST /v1/reports?view=spam` → `{ "spam": SpamInfo }` (the report is stored as usual).
- `POST /v1/names?view=none` → `204` (the suggestion is stored as usual).
- `POST /v1/check?names=0` → `phones` hold `{ "phone", "spam" }` only; `urls` and `verdict` as usual.

## Reports and names

- `POST /v1/reports` `{ "phone", "category", "comment"?, "notSpam": false }` → `Lookup`
  (`?view=spam` → `{ "spam" }`, see the budget above).
  One active report per (user, phone); posting again replaces it. `notSpam: true` is a vote against.
- `DELETE /v1/reports/:phone` → `204` (withdraw my report)
- `POST /v1/names` `{ "phone", "name" }` → `Lookup` (suggest a name; one per user per phone;
  `?view=none` → `204`)

Spam rules (server env, defaults): `label = likely_scam` when distinct reporters minus
not-spam votes ≥ `SPAM_THRESHOLD` (2), or any admin reported it; `suspected` at ≥ 1.
With `SPAM_REPORTERS=google` only reports from Google-linked accounts and the operator's family
admins count (reports, not-spam votes, `topCategory`, `lastComment`); everyone's reports are still
accepted and stored. When an account gets linked its reports start counting at once, and when
`SPAM_REPORTERS` changes the server relabels every reported number on its next start, so
`/v1/sync` sends the new labels.
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

For caller ID answered on the phone (new apps only; without these parameters the answer is
exactly the one above):

- `?v=2`: spam rows also carry `"notSpam": 1, "lastComment": "Asks for card PIN" | null, "calls": 31`
  (lookups of the number in the last 24 h, recomputed hourly). A change to these alone sends the
  row again in a `v=2` delta, never in a plain one. The answer also carries
  `"packCursor": 98123 | null` (the format-2 pack cursor of your parts, as `GET /v1/pack/head`
  `cursor`; null while format 2 is off, not built yet, or your account gets no pack key: call
  `GET /v1/pack/changes` when it moved) and `"lookupMode": "local" | "online"` (`LOOKUP_MODE`;
  always `online` while `packCursor` is null): `local` lets the app answer caller ID from its pack,
  `online` sends it back to `GET /v1/lookup`.
- `?members=1`: adds `"members": [ { "id", "phone", "name", "status", "photoUrl" } ]`, your family's
  roster (always the full list).

## Offline name pack

The phone keeps an encrypted copy of every caller-ID name it may see, so caller ID works offline.
Only on servers with `PACK_KEY` set (64 hex characters, `openssl rand -hex 32`, different from
`CONTACTS_KEY`); without it `GET /v1/pack` answers `404 pack_disabled`.

Each entry holds one number's best answer (same priority and visibility as `GET /v1/lookup`).
The pack holds no numbers: a phone finds and opens an entry only with the number in hand.

```
h    = Argon2id(password = E.164 phone (UTF-8), salt, t, m KiB, p, len = 32)   // salt and cost from the header
tag  = HMAC-SHA256(key = h, "surecaller/pack/tag")[0..8)
key  = HMAC-SHA256(key = h, "surecaller/pack/key")
blob = nonce(12) || AES-256-GCM(key, nonce, plaintext, aad = tag) || gcmTag(16)
plaintext = {"n":"Ali Raza","s":"contacts","c":null,"k":3,"m":false}   // + trailing spaces
```

The plaintext JSON is padded with trailing spaces to a multiple of 32 bytes (so blob sizes don't
reveal name lengths): trim it, or use a parser that ignores trailing whitespace.

`n` name, `s` `member` | `contacts` | `directory` | `suggested`, `c` directory category or null,
`k` how many shared contacts are behind it, `m` true when the number is a member of your family.
Test vector (salt `000102…0f`, t=2, m=16384, p=1): `test/pack.test.ts`.

Scopes: a **global** entry is everyone's answer. A **family** entry is your family's own answer
for a number where it differs (your family's members, contacts shared only with your family);
prefer it over a global entry with the same tag. Opted-out numbers have no entry.

### `GET /v1/pack?since=<seq>&limit=<n>`
`application/octet-stream`. `since` absent or `0` = full download (tombstones left out).
`limit` 1–20000, default 20000. All integers big-endian.

```
header (44 bytes):
  "SCNP" | u8 version = 1 | u8 flags (bit0 reset, bit1 more) |
  u32 saltId | 16B salt | u8 t | u32 mKiB | u8 p | u64 nextSince | u32 count
entry × count:
  u64 id | u64 seq | u8 kind (0 upsert global, 1 upsert family, 2 delete) |
  upsert only: 8B tag | u16 blobLen | blob
```

- Rows with `seq > since` that are global or your family's, in `seq` order. An `id` is stable
  for its number and scope: an upsert replaces the row with that id, a delete removes it.
  `id` and `seq` come from server-wide sequences shared by every family and generation, so
  gaps between the values one member sees are normal.
- On a full download `nextSince` also skips tombstones after the last row sent.
- `reset`: wipe the local pack; this page starts from 0. Set for `since=0`, when `since` is
  behind purged tombstones (kept 60 days) or a new salt generation, and on the first download
  after the member moved to another family (the server remembers the family it last served).
- Belt and braces on the phone: when `saltId` or `GET /v1/me` `familyId` changed since the last
  sync, wipe and fetch from `since=0`.
- `more`: another page follows; call again with `since = nextSince`. Store `nextSince` only after
  the page is applied.
- Quota: every row served (full downloads and deltas alike) counts against a per-member budget
  per UTC day of 5 × the live entries that member can see, at least 50 000. A page is cut short
  (with `more`) at the budget; past it → `429 pack_quota` until the next UTC day. The global part
  of "live entries" is the count from the last rebuild, not a live count.
- `503 pack_key_mismatch`: the server's `PACK_KEY` is not the one the pack was built with; keep
  the local pack and retry later.

The pack worker (`node dist/pack-runner.js`, compose service `pack-worker`; or the API itself with
`PACK_INLINE=true`) rebuilds a changed number within seconds: database triggers queue every number
whose answer may have changed, and the worker rebuilds only those, opt-outs first. A privacy
opt-out waits up to 60 s for the name to leave the pack. A full pass runs nightly at 03:00
Pakistan time (22:00 UTC), after a directory import and on `node dist/cli/pack.js reconcile`.
The server refuses to build or serve when `PACK_KEY` changed (a canary in `pack_meta`), and
writes nothing when more than 2% of a sample of the sealed numbers fail to open. `node dist/cli/pack.js rotate` builds a new salt generation while the old
one keeps serving, then swaps it in: every phone refetches. Argon2 runs on `PACK_WORKERS`
threads (default: CPUs − 1, at most 4).

## Offline name pack, format 2 (keyed, in parts)

For app 1.0.48 and later. `GET /v1/pack` (format 1) above stays as it is for the apps in the
field. Only on servers with `PACK_APP_KEYS` (and `PACK_KEY`); without it every route below answers
`404 pack_disabled`. The server builds a format-2 generation beside format 1, from the same data
and the same change queue, and keeps both current.

### Entry crypto

As format 1, except that the Argon2 password is keyed with the secret **pack key** (32 bytes,
handed out by `POST /v1/pack/key`) and the labels say `v2`:

```
pw   = HMAC-SHA256(key = packKey, msg = "surecaller/pack/v2/pw" || phone)   // phone: E.164, UTF-8; 32 bytes
h    = Argon2id(password = pw, salt, t, m KiB, p, len = 32)                 // salt and cost from the manifest
tag  = HMAC-SHA256(key = h, "surecaller/pack/v2/tag")[0..8)
key  = HMAC-SHA256(key = h, "surecaller/pack/v2/key")
blob = nonce(12) || AES-256-GCM(key, nonce, plaintext, aad = tag) || gcmTag(16)
plaintext = {"n":"Ali Raza","s":"contacts","c":null,"k":3,"m":false,"p":"https://..."}   // + trailing spaces
```

The plaintext is format 1's, padded the same way, plus `"p"`, the photo URL of the SureCaller
account on that number (as `Lookup.photoUrl`), present only when there is one. A number whose
only answer is a photo has a global entry `{"n":null,"s":null,"c":null,"k":0,"m":false,"p":"..."}`:
show the photo, no name.

Test vector (a published **test** key, never a real one; `test/pack-v2-crypto.test.ts`):

```
packKey   000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
phone     +923001234567
salt      000102030405060708090a0b0c0d0e0f        t 2, m 16384, p 1
pw        9af5deb2892fc3b499700fc72414591a9dc95fe5de34abeb6691e9ffe3e14868
h         678cdd1858ca55c51040dd73062a00e64e9608062bbe2a51357cab086812fde2
tag       73e4bc6d6950700b                        (tag16 0x73e4)
key       4bb9fe6185f545400edf809b8facc8c5ad9e2d2b0d59d43291ce0e4422375ef2
nonce     0c0b0a090807060504030201
plaintext {"n":"Ali Raza","s":"contacts","c":null,"k":3,"m":false,"p":"https://lh3.googleusercontent.com/a/x=s256-c"}
blob      0c0b0a090807060504030201f7d85431fe8b7239e820c035d673b4f7399d279bd3cf20be1aedd37ee73e09dca6d6b957a190aec7716b1d472bfe4ddb8bed8b32d7444f4e604c105306cdcdca8fd04396c99741900f959ee9e32d9b38f232ffd784618f7add9b58a0f062a11083ebb2f5ce4ce28802e620524867ae551d635bce97a4b37bdc031a
h8        43063ae7f612b06a                        (SHA-256(tag || blob)[0..8))
```

### Parts

- A **global** entry belongs to part `(tag[0] << 8 | tag[1]) >> (16 - partBits)`; your **family's**
  entries (your family's members, contacts shared only with your family) form one more part,
  scope `family`, id 0. Prefer a family entry over a global one with the same tag.
- A part's **version** is the highest `seq` of any row in it, deletes included (`seq` values are
  server-wide, so they have gaps). **floor**: the lowest `since` a delta of it can start from
  (older deletes were purged, after 60 days). **live**: its live entries. **bytes**: the rows of
  a full section (the 28-byte section header not included). **digest**: the XOR over its live
  entries of `h8 = SHA-256(tag || blob)[0..8)` (a part without entries: eight zero bytes).
- `partBits` only grows (when parts average more than 3,000 live entries). When a response
  carries a higher `partBits` than yours, split every global part first: part `p` becomes
  `p << k ... (p << k) + 2^k - 1` for `k` more bits, each child keeps its parent's version, and
  each entry goes to the child its tag says.
- After applying a section (full or delta), the part's live count and digest must equal the
  section's. If not, put the part back as it was and fetch it whole with `POST /v1/pack/parts`.
- All integers big-endian.

### Errors (every route below)

- `404 pack_disabled`: no `PACK_APP_KEYS` on this server. Stay on format 1 (`GET /v1/pack`).
- `403 pack_key_denied` with `"reason": "google_required" | "revoked"`. `google_required`: the
  server has `PACK_KEY_HOLDERS=google` (forced when `SIGNUP_PROOF=google`) and this account is not
  linked to a Google account (nor an admin of the operator's family): offer "Confirm with Google"
  (`PATCH /v1/me` with `googleIdToken`). `revoked`: the operator turned it off for this account;
  wipe the format-2 pack and its keys.
- `503 pack_not_ready` (`Retry-After: 600`): the first format-2 generation is still being built.
- `503 pack_key_mismatch`: the server's `PACK_KEY` or `PACK_APP_KEYS` value is not the one the
  pack was built with. Keep what you have and retry later.
- `409 pack_generation`: that `saltId` is no longer served. Start over from `head`.
- `429 pack_quota`: today's download bytes are used up (below).
- `400 invalid_since` / `invalid_after` / `invalid_saltId` / `invalid_part` / `invalid_request`.

### `POST /v1/pack/key`

Body `{}` (or none; room for an integrity token later) →
```json
{ "keys": [ { "id": 2, "key": "<base64, 32 bytes>", "saltId": 7 },
            { "id": 1, "key": "<base64, 32 bytes>", "saltId": 5, "until": "2026-12-01T00:00:00.000Z" } ] }
```
Every key whose generation is served: the active generation's first, then a retiring one with
`until`. `cache-control: no-store`; keep the key in native code only (Keystore-wrapped), never in
Dart or logs. 10 handouts per account per UTC day (`429 rate_limited`, `Retry-After` to the next
UTC midnight). Each handout is logged on the server (account, key id, time, IP).

### `GET /v1/pack/head`

```json
{ "saltId": 7, "keyId": 2, "keyIds": [2, 1], "partBits": 8, "cursor": 98123, "removalSeq": 98100,
  "familyChanged": false, "retiring": { "saltId": 5, "keyId": 1, "until": "..." } | null }
```
About 200 bytes, with an `ETag`: send `If-None-Match` and get `304` when nothing changed. Poll it
hourly. `keyId`: the active generation's key; a `keyId` you don't hold means call
`POST /v1/pack/key` and download that generation (`saltId`) whole; the retiring one keeps
answering (deletes only) until then. `cursor`: the highest version of your parts; above your
stored cursor means call `changes`. `removalSeq`: the highest delete in your parts; above your
cursor means a name must leave the phone, so don't wait. `familyChanged`: you moved family since
your family part was last sent; call `changes`. Not counted in the quota.

### `GET /v1/pack/manifest?saltId=<id>`

Every part of a generation (`saltId` optional: the active one; or the retiring one), to start a
download or to check every part's digest. `application/octet-stream`:

```
header (55 bytes):
  "SCPM" | u8 version = 1 | u8 flags (bit0 retiring) | u32 saltId | u16 keyId | 16B salt |
  u8 t | u32 mKiB | u8 p | u8 partBits | u64 cursor | u64 removalSeq | u32 count
part × count (35 bytes each):
  u8 scope (0 global, 1 family) | u16 id | u64 version | u64 floor | u32 live | u32 bytes | 8B digest
```
Global parts in id order, then your family's part. A global part not listed is empty (version 0,
floor 0, live 0, digest zero). A first download: the manifest, then every listed part with
`POST /v1/pack/parts`; store `cursor` once all are in. A part that is in is already usable.

### `GET /v1/pack/changes?since=<cursor>&after=<partId>&saltId=<id>`

What changed after `since` (default 0), as sections (format below):

- On the first page (no `after`): your family's part first. Whole (`mode 0`) once after you moved
  family; otherwise a delta when its version is above `since`.
- Then every global part whose version is above `since` and whose id is above `after`, in id
  order.
- A delta (`mode 1`) holds the part's rows with `seq > since`, in `seq` order: upserts and
  deletes. A part whose `floor` is above `since` comes as `mode 2` with no rows: fetch it whole.
- A page stops after the section that takes it past 2 MB, with `more` set and `next` = the last
  global part id on it: call again with the same `since` and `after=next`. A page with `more` set
  always holds at least one global part (the family part alone never ends a page).
- Store a new cursor only after the last page is applied, and store the **first** page's
  `cursor` (later pages may already hold newer rows; they come again, harmlessly).
- `saltId` of the retiring generation: deletes only (no upserts; a whole part comes as `mode 2`).

### `POST /v1/pack/parts`

`{ "saltId": 7, "parts": [ { "s": "g", "id": 17 }, { "s": "f", "id": 0 } ] }` (1 to 64 parts;
`saltId` optional: the active one) → full sections (`mode 0`, every live row, by tag), in request
order. A global id must be below `2^partBits`, the family part is `id 0`. A reply stops after the
section that takes it past 4 MB, with `more` set and `next` = the number of sections in it: ask
again for the rest.

### Section response (`changes` and `parts`)

`application/octet-stream`:
```
header (25 bytes):
  "SCPS" | u8 version = 1 | u8 flags (bit0 more) | u32 saltId | u16 keyId | u8 partBits |
  u64 cursor | u16 next | u16 count
section × count (28-byte header, then its rows):
  u8 scope (0 global, 1 family) | u16 id | u8 mode (0 full, 1 delta, 2 resync) | u64 version |
  u32 live | 8B digest | u32 rows
  row × rows:
    u8 kind (0 upsert, 2 delete) | 8B tag | upsert only: u16 blobLen | blob
```
- `mode 0`: replace the whole part with these rows. `mode 1`: apply the rows in order (an upsert
  replaces the entry with that tag in that scope, a delete removes it). `mode 2`: no rows; fetch
  the part whole. `version`, `live` and `digest` are the part's after the section: check them.
- `cursor`: the highest version of your parts when the page was made.

### Quota

Bytes of `manifest`, `changes` and `parts` replies per member per UTC day: once today's total
reaches max(3 × the full pack, 64 MB), these routes answer `429 pack_quota` until the next UTC
day (the full pack: every part you can see, with headers). A reply is checked before it is made
and never cut short by the quota. A key rotation's re-download fits inside it.

### Server side

The pack worker keeps format 2 current from the same queue as format 1 (both in one transaction
per batch): a change is in both within seconds, an opt-out first. It builds the first format-2
generation under the first key of `PACK_APP_KEYS` in batches (Argon2 of every number) while
format 1 keeps serving and both keep draining, then swaps it in. Putting a new key (new id) at
the front of `PACK_APP_KEYS` and restarting the worker builds a new generation the same way; the
old one then retires: served for 14 more days, deletes only, then deleted. A key whose value
changed under the same id (`pack_meta.app_key_check`) is refused, logged, and nothing of format 2
is built or served until it is put back. `node dist/cli/pack.js revoke <phone or user id>` turns
the format-2 pack off for one account (`unrevoke` undoes it); it can't take back a key the
account already has: only a rotation does.

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
  `?names=0`: `phones` hold `{ "phone", "spam" }` only, outside the daily name budget.
- `POST /v1/reports/url` `{ "url" }` → `{ "url", "reports", "label" }`

## Privacy requests (public, for a website form)

### `POST /v1/privacy-requests`

`{"kind": "account" | "remove", "phone": "+923001234567", "email": "you@example.com"}` → `202 {"ok": true}`.
Five per IP per hour. Nothing is deleted at this point: the operator checks the number belongs to
the requester, then runs `node dist/cli/privacy.js apply <id>`. `account` deletes that member;
`remove` (for people who don't use the app) deletes every shared name and every handyman listing
(with its reviews) for the number, and ignores future uploads and listings of it. One pending request per kind and number; a repeat updates the email.

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

## Users (operator only)

The operator is an admin of the family `ADMIN_CODE` set up. Anyone else gets `403 forbidden`.

### `GET /v1/admin/users`
→ `{ "users": [ { "id", "name", "phone", "email", "isAdmin", "familyId", "trustedFamily",
"familySize", "createdAt", "lastSeenAt", "appVersion", "device" } ] }` — everyone on the server,
newest sign-up first. `appVersion` and `device` come from the user's latest telemetry (null if none).

### `GET /v1/admin/users/:id/usage`
→ `{ "user": {...}, "usage": {...}, "lookupsByDay": [ { "day": "YYYY-MM-DD", "lookups" } ], "devices": [...] }`

- `user`: the list fields plus `status`, `shareContacts`, `protection`, `pushEnabled`.
- `usage`: `lookups7d`, `lookups30d`, `sharedContacts`, `spamReports`, `notSpamVotes`,
  `namesSuggested`, `linksReported`, `spamCallAlerts`, `scamSmsAlerts`, `sosSent`,
  `handymenAdded`, `handymanReviews`, `packRows30d`, `errors7d`.
- `lookupsByDay`: the last 14 days (UTC), oldest first, zero days included.
- `devices`: `{ "installId", "appVersion", "device", "os", "lastSeenAt" }` per install in telemetry, newest first.

The lookup log is kept only 2 days (it exists for `callsToday`), so `lookups7d`, `lookups30d` and
`lookupsByDay` only ever count the last 2 days: days before that show 0. Telemetry is kept
`TELEMETRY_RETENTION_DAYS`, so older activity is not counted either.
`404` for an unknown id.

## Health
- `GET /health` → `{ "ok": true, "version": "1.0.0" }`, plus `"signupProof": "email" | "google"`
  when the server sets `SIGNUP_PROOF` (absent = `none`). The app reads it before sign-up.
