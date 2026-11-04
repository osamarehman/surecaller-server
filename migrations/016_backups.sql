-- One cloud backup per member of the app's local data (block rules, notes, favourites,
-- settings), so a reinstall or a move to the Play build can restore it. Sealed with the vault.
CREATE TABLE backups (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data_enc   bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
