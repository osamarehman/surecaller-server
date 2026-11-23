-- Google identity for sign-up proof (SIGNUP_PROOF=google) and spam votes (SPAM_REPORTERS=google).
-- Additive only: nothing here changes how the server behaves while those settings are off.

-- The Google account (the ID token's `sub`) an account is linked to, and when it was last proven.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_verified_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique ON users (google_sub);

-- The address an email reaches, for "one account per email": lowercase, and for Gmail the local
-- part without dots or a +tag, at gmail.com (Gmail ignores both). Mirrored by canonicalEmail()
-- in src/email.ts; a test keeps the two in step.
CREATE OR REPLACE FUNCTION email_canonical(e text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN lower(e) ~ '@(gmail|googlemail)\.com$'
      THEN replace(split_part(split_part(lower(e), '@', 1), '+', 1), '.', '') || '@gmail.com'
    ELSE lower(e)
  END
$$;

-- One account per canonical email. Accounts made before this may already collide (a.b@gmail.com
-- and ab@gmail.com): then only a plain index is made, with a warning, so the server still starts
-- (it also logs a warning on every start until the duplicates are merged and this is re-created).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM users WHERE email IS NOT NULL GROUP BY email_canonical(email) HAVING count(*) > 1
  ) THEN
    RAISE WARNING 'users has emails that are the same address (email_canonical); made a plain index, not a unique one';
    CREATE INDEX IF NOT EXISTS users_email_canonical_idx ON users (email_canonical(email));
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_canonical_unique ON users (email_canonical(email));
  END IF;
END $$;

-- Small server-wide facts that must survive restarts, e.g. the SPAM_REPORTERS rule spam_state
-- was last computed with (src/lookup.ts syncSpamRules).
CREATE TABLE IF NOT EXISTS server_state (
  key   text PRIMARY KEY,
  value text NOT NULL
);
