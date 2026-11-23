-- Name pack format 2 (docs/API.md, "Offline name pack, format 2"): a generation keyed with a
-- secret pack key (PACK_APP_KEYS) and split into parts by tag. Additive only: without
-- PACK_APP_KEYS nothing here is written and the server behaves as before. Every new index below
-- is partial on format-2 rows (tag16 set), so this migration builds them over no rows: the
-- format-2 entries are written later by the pack worker, in batches.

-- format: 1 = GET /v1/pack (Argon2 of the number only), 2 = keyed and in parts.
ALTER TABLE pack_meta ADD COLUMN IF NOT EXISTS format smallint NOT NULL DEFAULT 1;
-- Format 2 only: the PACK_APP_KEYS id the generation is built under, and
-- HMAC-SHA256(that key, "surecaller/pack/app/check") to catch a changed env value.
ALTER TABLE pack_meta ADD COLUMN IF NOT EXISTS app_key_id int;
ALTER TABLE pack_meta ADD COLUMN IF NOT EXISTS app_key_check bytea;
-- Global part id = tag16 >> (16 - part_bits); only grows.
ALTER TABLE pack_meta ADD COLUMN IF NOT EXISTS part_bits smallint NOT NULL DEFAULT 6;
-- A replaced format-2 generation: still served (deletes only) until then, then dropped.
ALTER TABLE pack_meta ADD COLUMN IF NOT EXISTS retire_after timestamptz;

-- Format-2 rows: tag16 = tag[0] << 8 | tag[1] (the part), h8 = sha256(tag || blob)[0..8) (the
-- part digest; live rows only). Tombstones of every format keep their tag (and tag16), so a
-- delete can be filed under its part. Format-1 rows leave both null.
ALTER TABLE pack_entries ADD COLUMN IF NOT EXISTS tag16 int;
ALTER TABLE pack_entries ADD COLUMN IF NOT EXISTS h8 bytea;
CREATE INDEX IF NOT EXISTS pack_entries_part_idx ON pack_entries (salt_id, tag16, seq)
  WHERE scope IS NULL AND tag16 IS NOT NULL;
CREATE INDEX IF NOT EXISTS pack_entries_family_seq_idx ON pack_entries (salt_id, scope, seq)
  WHERE scope IS NOT NULL AND tag16 IS NOT NULL;
-- Tag collisions (two numbers, one 8-byte tag) are skipped and logged.
CREATE INDEX IF NOT EXISTS pack_entries_tag_idx ON pack_entries (salt_id, tag)
  WHERE tag16 IS NOT NULL AND NOT deleted;

-- One row per format-2 part, kept by the pack worker in the same transaction as the entries.
CREATE TABLE IF NOT EXISTS pack_parts (
  salt_id int NOT NULL REFERENCES pack_meta(salt_id) ON DELETE CASCADE,
  scope   uuid REFERENCES families(id) ON DELETE CASCADE,   -- null = global
  part    int NOT NULL,                                       -- global: tag16 >> (16 - part_bits); family: 0
  version bigint NOT NULL DEFAULT 0,                          -- highest seq of any row in it (deletes included)
  floor   bigint NOT NULL DEFAULT 0,                          -- a delta can't start below this (purged deletes)
  live    int NOT NULL DEFAULT 0,
  bytes   bigint NOT NULL DEFAULT 0,                          -- the rows of a full section
  digest  bytea NOT NULL DEFAULT '\x0000000000000000',        -- XOR of h8 over live rows
  removal bigint NOT NULL DEFAULT 0,                          -- highest seq of a delete in it
  CONSTRAINT pack_parts_key UNIQUE NULLS NOT DISTINCT (salt_id, scope, part)
);
CREATE INDEX IF NOT EXISTS pack_parts_version_idx ON pack_parts (salt_id, version);

-- Bytes of format-2 pack data each member downloaded per UTC day (manifest, changes, parts).
ALTER TABLE pack_usage ADD COLUMN IF NOT EXISTS bytes bigint NOT NULL DEFAULT 0;

-- Per-account revocation (node dist/cli/pack.js revoke), and every key handout.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pack_revoked_at timestamptz;
-- The family whose format-2 family part this member was last sent (a change sends it whole).
ALTER TABLE users ADD COLUMN IF NOT EXISTS pack2_family_id uuid;
CREATE TABLE IF NOT EXISTS pack_key_grants (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id  int NOT NULL,
  at      timestamptz NOT NULL DEFAULT now(),
  ip      inet
);
CREATE INDEX IF NOT EXISTS pack_key_grants_user_idx ON pack_key_grants (user_id, at);

-- What a lookup on the phone needs that /v1/sync didn't carry (sent with /v1/sync?v=2). Changes
-- to these bump detail_updated_at, not updated_at, so callers without ?v=2 get the old answer.
ALTER TABLE spam_state ADD COLUMN IF NOT EXISTS not_spam int NOT NULL DEFAULT 0;
ALTER TABLE spam_state ADD COLUMN IF NOT EXISTS last_comment text;
ALTER TABLE spam_state ADD COLUMN IF NOT EXISTS calls int NOT NULL DEFAULT 0;
ALTER TABLE spam_state ADD COLUMN IF NOT EXISTS detail_updated_at timestamptz;
