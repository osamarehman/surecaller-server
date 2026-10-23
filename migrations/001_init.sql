-- SureCaller initial schema. One database = one private circle.

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone          text NOT NULL UNIQUE,
  name           text NOT NULL,
  is_admin       boolean NOT NULL DEFAULT false,
  status         text,
  share_contacts boolean NOT NULL DEFAULT true,
  protection     jsonb NOT NULL DEFAULT '{}'::jsonb,
  watched        boolean NOT NULL DEFAULT false,
  fcm_token      text,
  device_name    text,
  token_hash     text UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz
);

CREATE TABLE invites (
  code        text PRIMARY KEY,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  used_by     uuid REFERENCES users(id) ON DELETE SET NULL
);

-- Each member's shared address book (replaced wholesale on sync).
CREATE TABLE contacts (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone      text NOT NULL,
  name       text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, phone)
);
CREATE INDEX contacts_phone_idx ON contacts (phone);

-- One active spam report (or not-spam vote) per (user, phone).
CREATE TABLE reports (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone      text NOT NULL,
  category   text,
  comment    text,
  not_spam   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, phone)
);
CREATE INDEX reports_phone_idx ON reports (phone);

-- Suggested names: one per user per phone.
CREATE TABLE name_suggestions (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone      text NOT NULL,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, phone)
);
CREATE INDEX name_suggestions_phone_idx ON name_suggestions (phone);

-- Lookup log for callsToday. Pruned after 30 days.
CREATE TABLE lookups (
  id         bigserial PRIMARY KEY,
  phone      text NOT NULL,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lookups_phone_time_idx ON lookups (phone, created_at);
CREATE INDEX lookups_time_idx ON lookups (created_at);

-- Materialized spam state per phone, used for /v1/sync deltas.
CREATE TABLE spam_state (
  phone        text PRIMARY KEY,
  label        text NOT NULL,
  score        integer NOT NULL,
  reports      integer NOT NULL,
  top_category text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX spam_state_updated_idx ON spam_state (updated_at);

-- Circle block list. Deleted rows stay as tombstones for sync.
CREATE TABLE blocks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL CHECK (type IN ('number', 'prefix', 'country')),
  value         text NOT NULL,
  label         text,
  added_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  added_by_name text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX blocks_updated_idx ON blocks (updated_at);
CREATE UNIQUE INDEX blocks_active_unique ON blocks (type, value) WHERE deleted_at IS NULL;

CREATE TABLE events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type       text NOT NULL CHECK (type IN ('spam_call', 'sos', 'scam_sms')),
  from_user  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone      text,
  message    text,
  lat        double precision,
  lng        double precision,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_time_idx ON events (created_at);

-- Reported scam links: one per (user, url).
CREATE TABLE url_reports (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, url)
);
CREATE INDEX url_reports_url_idx ON url_reports (url);
