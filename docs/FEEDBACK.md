# Feedback board API (v1)

The public feedback board at `site/feedback.html` (served at `/feedback`) calls the endpoints
below. **Implemented** in `src/routes/feedback.ts` (migration 010). Differences from the first
draft: ids are UUIDs; rate limits are per IP only (5 new items and 60 votes per hour), since the
voter id is the browser's to change; vote counts are counted on read.

The board lets testers **report bugs, suggest features, and upvote**. Owner triages status.

## Identity & auth

- The board is **public** (no login) during the closed test. Anyone with the link can read,
  vote and submit.
- Each browser generates a random **voter id** (UUID) and sends it as header **`X-Voter-Id`** on
  every request. It is opaque, not personal data. Use it only to dedupe votes and rate-limit
  submissions. Never expose it back to other viewers.
- **Admin** routes use the existing `Authorization: Bearer <token>` of a trusted-family admin
  (same auth as `GET /v1/telemetry`). Only admins may change status / reject / delete.
- Rate-limit public `POST`s by IP **and** `X-Voter-Id` (suggest: 5 new items / hour, 60 votes /
  hour). Reject over-limit with `429 rate_limited`.

## Data model (suggested)

`feedback`:
- `id` (string, e.g. short nanoid)
- `type` — `"bug" | "feature"`
- `title` (string, 3–120 chars, required)
- `description` (string, 0–2000 chars)
- `status` — `"open" | "planned" | "in_progress" | "shipped" | "rejected"` (default `"open"`)
- `rejectReason` (string, shown only when `status="rejected"`)
- `author` (string, optional display name; never an email)
- `votes` (int, denormalized count)
- `createdAt`, `updatedAt` (ISO-8601 UTC)

`feedback_vote`: `(feedbackId, voterId)` unique — one vote per voter per item.

Sanitize/escape nothing server-side beyond length limits; the page escapes all user text on
render. Do **not** store IPs long-term with the row (privacy).

## Public endpoints (no auth)

### `GET /v1/feedback?type=&status=&sort=`
Lists items. Query params all optional:
- `type` = `bug` | `feature` (omit = all)
- `status` = one of the status values (omit = all)
- `sort` = `top` (votes desc, then newest — default) | `new` (createdAt desc)

Reads `X-Voter-Id` if present to compute `voted` per item.
```json
{ "items": [
  { "id":"a1b2", "type":"feature", "title":"Dark mode for the dialer",
    "description":"…", "status":"planned", "rejectReason":null,
    "votes":12, "voted":true, "author":"Ali", "createdAt":"2026-10-26T19:00:00Z" }
] }
```

### `POST /v1/feedback`
Body (needs `X-Voter-Id`):
```json
{ "type":"bug", "title":"Call screen flickers", "description":"Steps…", "author":"Ali" }
```
→ `201 { "item": { …same shape… } }`. Server sets `status:"open"`, `votes:0`. `author` optional.
Errors: `400 invalid_request` (bad type / title too short), `429 rate_limited`.

### `POST /v1/feedback/:id/vote`  /  `DELETE /v1/feedback/:id/vote`
Needs `X-Voter-Id`. POST adds this voter's vote (idempotent — voting twice is a no-op), DELETE
removes it.
→ `200 { "votes": 13, "voted": true }` (or `voted:false` after DELETE).
Errors: `404 not_found`, `429 rate_limited`.

## Admin endpoints (Bearer, trusted-family admin)

### `PATCH /v1/feedback/:id`
```json
{ "status":"rejected", "rejectReason":"Android doesn't expose this API", "title":"…", "type":"…" }
```
All fields optional; only the sent ones change. → `200 { "item": {…} }`.
Setting `status` to anything other than `rejected` should clear `rejectReason`.
Errors: `403 forbidden` (not an admin), `404 not_found`.

### `DELETE /v1/feedback/:id`
Soft-delete (hide) is fine. → `200 {"ok":true}`. `403`/`404` as above.

## Notes for the implementer

- CORS: the page is same-origin (`surecaller.shipdeck.dev`), so no CORS headers needed. If you
  later embed the board in the app via a WebView on another origin, allow that origin explicitly.
- The page degrades gracefully if these routes 404 (shows "board is being set up"), so deploying
  the frontend before the backend is safe.
- Phase 2 (later): in-app Feedback button linking here. Phase 3 (later): audio note → transcription
  → extract a feature draft the tester approves → `POST /v1/feedback`. Not in scope now.
