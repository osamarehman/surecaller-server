-- Logs and crash reports sent by phones (POST /v1/telemetry). Pruned after
-- TELEMETRY_RETENTION_DAYS. user_id is null for phones that are not signed in.
CREATE TABLE telemetry (
  id          bigserial PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  at          timestamptz NOT NULL,
  install_id  text NOT NULL,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  app_version text,
  device      text,
  os          text,
  level       text NOT NULL,
  source      text NOT NULL,
  tag         text NOT NULL DEFAULT '',
  message     text NOT NULL DEFAULT '',
  details     jsonb
);

CREATE INDEX telemetry_received_idx ON telemetry (received_at);
-- Per-install 24h counts (ingest cap).
CREATE INDEX telemetry_install_idx ON telemetry (install_id, received_at);
-- Latest row / latest signed-in user per install (installs summary, CLI --install).
CREATE INDEX telemetry_install_id_idx ON telemetry (install_id, id);
CREATE INDEX telemetry_level_idx ON telemetry (level, received_at);