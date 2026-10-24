-- Numbers whose owners asked to be left out of caller ID. Uploads of these numbers are ignored.
CREATE TABLE opt_outs (
  phone_hash bytea PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Deletion and removal requests sent from the website, kept only until handled
-- (src/cli/privacy.ts deletes the row once it's applied or rejected).
CREATE TABLE privacy_requests (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('account', 'remove')),
  phone      text NOT NULL,
  email      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, phone)
);
