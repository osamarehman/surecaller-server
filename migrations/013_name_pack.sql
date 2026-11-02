-- Offline name pack (docs/NAME_PACK.md in the app repo; server side in src/pack.ts and
-- src/pack-build.ts). The server builds an encrypted copy of every caller-ID answer for phones to
-- download. To do that it needs the numbers back, so contact, suggestion and directory rows also
-- keep the number sealed under PACK_KEY (a key separate from CONTACTS_KEY). Null when PACK_KEY is
-- not set, or for rows written before this change: those stay out of the pack until they are
-- written again.
ALTER TABLE contacts ADD COLUMN phone_enc bytea;
ALTER TABLE name_suggestions ADD COLUMN phone_enc bytea;
ALTER TABLE directory ADD COLUMN phone_enc bytea;

-- One row per salt generation. The serving generation is the newest one with active_at set; a
-- row without active_at is being built by `node dist/cli/pack.js rotate` and is not served yet.
-- purge_seq: clients whose `since` is below it must wipe and refetch (tombstones up to it were
-- purged, or this generation replaced an older one).
-- canary: a fixed text sealed under PACK_KEY, to refuse to run with a different key.
CREATE TABLE pack_meta (
  salt_id    int PRIMARY KEY,
  salt       bytea NOT NULL,
  t          int NOT NULL,
  m_kib      int NOT NULL,
  p          int NOT NULL,
  purge_seq  bigint NOT NULL DEFAULT 0,
  canary     bytea NOT NULL,
  active_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE pack_seq;

-- One entry per (generation, number, scope). scope null = the answer everyone gets; a family id =
-- that family's own answer (members, family-only contacts). Deleting a family deletes its entries
-- outright, without tombstones: nobody is left in that family to download them.
-- ids and seqs come from shared sequences, so one viewer sees gaps (other families' rows).
CREATE TABLE pack_entries (
  id         bigserial PRIMARY KEY,
  salt_id    int NOT NULL REFERENCES pack_meta(salt_id) ON DELETE CASCADE,
  phone_hash bytea NOT NULL,
  scope      uuid REFERENCES families(id) ON DELETE CASCADE,
  tag        bytea,
  blob       bytea,
  fp         bytea,
  seq        bigint NOT NULL DEFAULT nextval('pack_seq'),
  deleted    boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pack_entries_key UNIQUE NULLS NOT DISTINCT (salt_id, phone_hash, scope)
);
CREATE INDEX pack_entries_seq_idx ON pack_entries (salt_id, seq);

-- Per-number Argon2 output for a generation's salt, sealed under PACK_KEY, so unchanged numbers
-- are not re-hashed on every rebuild.
CREATE TABLE pack_phone_keys (
  salt_id    int NOT NULL REFERENCES pack_meta(salt_id) ON DELETE CASCADE,
  phone_hash bytea NOT NULL,
  key_enc    bytea NOT NULL,
  PRIMARY KEY (salt_id, phone_hash)
);

-- Rows each member downloaded per UTC day (GET /v1/pack quota).
CREATE TABLE pack_usage (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     date NOT NULL,
  rows    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- The family whose entries this member's phone last downloaded: a change means start over.
ALTER TABLE users ADD COLUMN pack_family_id uuid;
