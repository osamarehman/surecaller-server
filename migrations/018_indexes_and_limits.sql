-- Per-user scans: the operator's user list (latest telemetry row per user) and the
-- ON DELETE SET NULL cascades when a member is deleted (under the circle lock).
CREATE INDEX IF NOT EXISTS telemetry_user_id_idx ON telemetry (user_id, id);
CREATE INDEX IF NOT EXISTS lookups_user_time_idx ON lookups (user_id, created_at);

-- Live global entries of a pack generation, counted once per rebuild, so GET /v1/pack does not
-- count the whole generation on every call. NULL until the first rebuild after this migration.
ALTER TABLE pack_meta ADD COLUMN IF NOT EXISTS live_global bigint;
-- A family's own live entries, counted per GET /v1/pack for its quota.
CREATE INDEX IF NOT EXISTS pack_entries_family_live_idx ON pack_entries (salt_id, scope)
  WHERE scope IS NOT NULL AND NOT deleted;

-- Email codes issued and wrong codes tried, per address per UTC day, whatever IP asks
-- (src/email.ts). Kept past the code itself; pruned after a day.
CREATE TABLE IF NOT EXISTS email_code_limits (
  email  text NOT NULL,
  day    date NOT NULL,
  sent   int NOT NULL DEFAULT 0,
  failed int NOT NULL DEFAULT 0,
  PRIMARY KEY (email, day)
);
