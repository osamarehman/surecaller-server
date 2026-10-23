-- /v1/stats counts spam_call events; avoid scanning the whole events table.
CREATE INDEX events_type_idx ON events (type);
