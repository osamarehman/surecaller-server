# Join a family after setup

Implemented. The contract is in `API.md` → Circle: `POST /v1/family/join { "code" }`, with
`POST /v1/join` as the same route (the app's first build calls it). Also `POST /v1/family/leave`.

Differences from the first draft of this file:
- Errors are `403 invalid_code` (unknown, used, expired, or bound to another phone),
  `409 already_member`, and `409 last_admin` (the caller is the only admin of a family that
  keeps other members). The app shows the server's `message`, so no mapping is required.
- Shared contacts and spam reports are not dropped: the caller-ID database is shared by every
  user, not per family. The user's own recent alerts and SOS are deleted instead, since those
  belonged to the old family.
