-- Business names from open data (Overture Maps places), for caller ID on numbers no user has
-- saved. Same encryption as contacts: keyed by vault index, name sealed to the number.
-- Replaced as a whole by `node dist/cli/directory.js import`.
CREATE TABLE directory (
  phone_hash bytea PRIMARY KEY,
  name_enc   bytea NOT NULL,
  category   text
);
