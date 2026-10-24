-- Many families on one server. Every user belongs to exactly one family. Family data (members,
-- invites, alerts, SOS, the block list, member badges) never crosses families. Caller-ID names
-- and spam labels stay shared by everyone, and only trusted families add to them.
-- The trusted family is the operator's: the one ADMIN_CODE set up.
CREATE TABLE families (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trusted    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN family_id uuid REFERENCES families(id);

-- Everyone trusted today is the original family.
WITH f AS (
  INSERT INTO families (trusted) SELECT true WHERE EXISTS (SELECT 1 FROM users WHERE trusted) RETURNING id
)
UPDATE users SET family_id = f.id FROM f WHERE users.trusted;

-- Each open sign-up gets a family of their own (reusing their id), as its admin.
INSERT INTO families (id) SELECT id FROM users WHERE family_id IS NULL;
UPDATE users SET family_id = id, is_admin = true WHERE family_id IS NULL;

ALTER TABLE users ALTER COLUMN family_id SET NOT NULL;
CREATE INDEX users_family_idx ON users (family_id);
-- Trust now lives on the family.
ALTER TABLE users DROP COLUMN trusted;

-- An invite joins the inviter's family.
ALTER TABLE invites ADD COLUMN family_id uuid REFERENCES families(id) ON DELETE CASCADE;
UPDATE invites i SET family_id = u.family_id FROM users u WHERE u.id = i.created_by;
UPDATE invites SET family_id = (SELECT id FROM families WHERE trusted LIMIT 1) WHERE family_id IS NULL;
DELETE FROM invites WHERE family_id IS NULL;
ALTER TABLE invites ALTER COLUMN family_id SET NOT NULL;

-- Each family has its own block list.
ALTER TABLE blocks ADD COLUMN family_id uuid REFERENCES families(id) ON DELETE CASCADE;
UPDATE blocks b SET family_id = u.family_id FROM users u WHERE u.id = b.added_by;
UPDATE blocks SET family_id = (SELECT id FROM families WHERE trusted LIMIT 1) WHERE family_id IS NULL;
DELETE FROM blocks WHERE family_id IS NULL;
ALTER TABLE blocks ALTER COLUMN family_id SET NOT NULL;
DROP INDEX blocks_active_unique;
CREATE UNIQUE INDEX blocks_active_unique ON blocks (family_id, type, value) WHERE deleted_at IS NULL;
CREATE INDEX blocks_family_updated_idx ON blocks (family_id, updated_at);
