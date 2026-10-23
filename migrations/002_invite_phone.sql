-- Phone-bound invites: a code that only registers this exact phone. The only
-- invite that can re-register (reset the device of) an existing member.
ALTER TABLE invites ADD COLUMN phone text;
