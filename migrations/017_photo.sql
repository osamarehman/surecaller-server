-- The member's Google profile picture (a googleusercontent.com link), taken from a verified
-- Google ID token. Shown next to their name when they call another SureCaller user.
-- NULL = no photo (never signed in with Google, or removed it).
ALTER TABLE users ADD COLUMN photo_url text;
