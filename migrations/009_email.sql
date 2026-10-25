-- A verified email per account: proves a real inbox at sign-up and lets a member get back in
-- on a new phone without an admin. One account per email.
ALTER TABLE users ADD COLUMN email text;
CREATE UNIQUE INDEX users_email_unique ON users (email);

-- One pending code per email, sent by POST /v1/email-codes. Stored hashed.
CREATE TABLE email_codes (
  email      text PRIMARY KEY,
  code_hash  text NOT NULL,
  attempts   int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now()
);
