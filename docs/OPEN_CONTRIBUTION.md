# Open contribution to all users — server-agent handoff

Decision (owner, 2026-10-26): the shared caller-ID database should be fed by **every registered
user**, not only the trusted family. This is how crowd caller ID is meant to work, and the
encryption model (HMAC-keyed numbers, names sealed to their number) already protects the data
regardless of which family a contributor is in.

## The problem this fixes

A user who registers with no invite code gets **their own new family, which is not trusted**.
Today the contribution routes return `403 forbidden` for non-trusted families, so those users
contribute nothing: their contacts never reach the shared DB, and caller ID stays empty for
everyone. During the closed test, each tester is their own untrusted family, so the crowd DB only
ever holds the operator's contacts.

## The change

Drop the trusted-family requirement (the `403 forbidden` for non-trusted) on these routes. Any
authenticated user (valid `Authorization: Bearer <token>`) may contribute:

- `POST /v1/contacts/sync` — upload contacts
- `POST /v1/names` — suggest a name
- `POST /v1/reports` and `DELETE /v1/reports/:phone` — spam report / withdraw
- `POST /v1/reports/url` — report a link

Leave everything else about these routes unchanged (payload shapes, the per-user dedupe, the
`sharing_off` behavior, the encryption, the `knownNumbers` count).

Keep untouched (still trusted-only / family-scoped):
- `GET /v1/telemetry` and any server-wide admin route.
- Family-scoped data (member roster, invites, SOS/alert events, the family block list, the
  `member` field on a lookup). None of that should cross families.

## Keep the anti-abuse that already exists, and tighten lightly

Opening contribution means strangers can now report spam and suggest names, so:

- Keep the spam rule as is: `likely_scam` needs distinct reporters minus not-spam votes ≥
  `SPAM_THRESHOLD` (default 2), `suspected` at ≥ 1. The ≥2-reporter floor already blunts a single
  bad actor. Consider raising the default to 3 once the tester base grows.
- Name suggestions are already one-per-user-per-phone and resolved by agreement (most-agreed
  wins). That stays fine with more contributors.
- Add basic rate limits per user on `contacts/sync`, `names`, `reports` (suggest: a few syncs/hour,
  tens of reports/hour) so one account can't flood the DB.
- An admin report still outweighs the threshold (keep that), but only **trusted** admins should
  carry that weight — don't let a self-registered user's own "admin of their own family" flag
  grant admin-weight spam labeling. Gate the admin-override on `isTrusted`, not just `isAdmin`.

## Update the contract

In `backend/docs/API.md`, replace the paragraph that begins "Only **trusted** families add to
what everyone sees…" with the new rule: any registered user contributes to the shared caller-ID
DB (contact sync, name suggestions, spam and link reports); `isTrusted` now only governs
server-wide admin routes and admin-weighted spam labeling, not whether a user may contribute.

## App side (already correct, no change needed)

- Contact sharing stays **opt-in** (`prefs.shareContacts`, default off), enabled when the user taps
  "Share contacts" in setup. Play policy requires that consent before any contact upload, so keep
  it opt-in — do not default it on. Testers must tap "Share contacts" for their contacts to upload.
- Once this server change ships, a tester who has opted in will start contributing on the next
  sync (the app re-syncs on resume, ~15-min gate + change hash).

## Verify

After deploying, confirm a non-trusted user's sync is accepted (HTTP 200 with a stored count,
not 403) and that `knownNumbers` in `GET /v1/stats` grows as testers sync.
