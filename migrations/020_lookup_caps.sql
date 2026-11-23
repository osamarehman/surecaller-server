-- Daily budget on caller-ID names from the server (LOOKUP_DAILY_LIMIT, LOOKUP_DAILY_ENFORCE) and
-- which app builds still call the old routes. Additive only: nothing is refused until
-- LOOKUP_DAILY_ENFORCE=true.

-- X-SureCaller-Build of the member's last request that carried one, and when that was.
-- Null: the member's app never sent it (builds up to 1.0.47).
ALTER TABLE users ADD COLUMN IF NOT EXISTS app_build int;
ALTER TABLE users ADD COLUMN IF NOT EXISTS app_seen_at timestamptz;

-- Online answers (a name from the server) per member per UTC day, all routes together.
CREATE TABLE IF NOT EXISTS lookup_usage (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     date NOT NULL,
  n       int NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS lookup_usage_day_idx ON lookup_usage (day);

-- Calls to routes that old builds use, per day: decides when they can be retired.
CREATE TABLE IF NOT EXISTS legacy_usage (
  day     date NOT NULL,
  route   text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  calls   int NOT NULL DEFAULT 0,
  PRIMARY KEY (day, route, user_id)
);
CREATE INDEX IF NOT EXISTS legacy_usage_user_idx ON legacy_usage (user_id);
