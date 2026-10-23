-- Encryption at rest (see src/vault.ts). Phone numbers become HMAC indexes and names become
-- AES-GCM blobs. SQL can't do this (the key lives in CONTACTS_KEY, not the database), so the
-- old tables are renamed *_plain here and src/migrate.ts encrypts and drops them right after.

ALTER TABLE contacts RENAME TO contacts_plain;
ALTER INDEX contacts_pkey RENAME TO contacts_plain_pkey;
ALTER INDEX contacts_phone_idx RENAME TO contacts_plain_phone_idx;

-- family_only: shared before open sign-up, so only family (trusted) lookups may use it.
CREATE TABLE contacts (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone_hash  bytea NOT NULL,
  name_enc    bytea NOT NULL,
  family_only boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, phone_hash)
);
CREATE INDEX contacts_phone_hash_idx ON contacts (phone_hash);

ALTER TABLE name_suggestions RENAME TO name_suggestions_plain;
ALTER INDEX name_suggestions_pkey RENAME TO name_suggestions_plain_pkey;
ALTER INDEX name_suggestions_phone_idx RENAME TO name_suggestions_plain_phone_idx;

CREATE TABLE name_suggestions (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone_hash bytea NOT NULL,
  name_enc   bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, phone_hash)
);
CREATE INDEX name_suggestions_phone_hash_idx ON name_suggestions (phone_hash);

-- The lookup log only feeds 24h call counts (pruned after 2 days): start it over, hashed.
DELETE FROM lookups;
ALTER TABLE lookups RENAME COLUMN phone TO phone_hash;
ALTER TABLE lookups ALTER COLUMN phone_hash TYPE bytea USING phone_hash::bytea;
