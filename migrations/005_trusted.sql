-- Trusted ("family") members: admins and anyone who joined via an invite code. Open sign-ups
-- (no code) are untrusted and get caller-ID lookups only — never the member list, SOS events,
-- status, or the member field on a lookup. Everyone who registered before open sign-up joined
-- with a code, so they are trusted.
ALTER TABLE users ADD COLUMN trusted boolean NOT NULL DEFAULT false;
-- Backfill genuine family: admins (incl. the ADMIN_CODE bootstrap) and anyone who joined via an
-- invite code. Open sign-up ships in this same release, so when this migration runs there are no
-- open sign-ups yet and no untrusted-authored shared rows to clean up.
UPDATE users SET trusted = true
WHERE is_admin OR id IN (SELECT used_by FROM invites WHERE used_by IS NOT NULL);
