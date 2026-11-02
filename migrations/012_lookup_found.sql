-- Whether a logged lookup returned a caller ID name (null for rows logged before this).
ALTER TABLE lookups ADD COLUMN found boolean;
