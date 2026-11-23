-- Incremental name pack builds (src/pack-build.ts drainDirty, run by src/pack-runner.ts):
-- triggers queue every number whose pack answer may have changed, and the pack worker rebuilds
-- only those. The full build stays as a nightly safety pass.

-- users.phone_hash: vault index of users.phone, written on register and backfilled by the pack
-- worker, so triggers can queue a member's number without CONTACTS_KEY.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_hash bytea;
CREATE INDEX IF NOT EXISTS users_phone_hash_idx ON users (phone_hash);

-- Numbers whose pack answer may have changed. priority 0 = removal (opt-out), 1 = normal.
CREATE TABLE pack_dirty (
  phone_hash bytea PRIMARY KEY,
  priority   smallint NOT NULL DEFAULT 1,
  queued_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX pack_dirty_order_idx ON pack_dirty (priority, queued_at);

-- A number queued again moves to the back with its new time (the drain only deletes rows it saw),
-- and keeps the more urgent priority.
--
-- Queuing locks the queue rows until commit, so two transactions that queue overlapping numbers
-- in different orders would deadlock (two members syncing address books that share numbers).
-- So: duplicates and nulls are dropped (ON CONFLICT DO UPDATE refuses to touch a row twice in one
-- statement), rows are written in phone_hash order, and a transaction-level advisory lock lets
-- one transaction queue at a time. The lock is what covers a transaction that queues in several
-- statements (a sync is a DELETE, then an INSERT). The drain takes no such lock: it skips queue
-- rows a writer holds (src/pack-build.ts drainStep).
CREATE FUNCTION pack_queue_many(hs bytea[], prio smallint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF hs IS NULL OR cardinality(hs) = 0 THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(737374);
  INSERT INTO pack_dirty (phone_hash, priority)
    SELECT h, prio FROM (SELECT DISTINCT h FROM unnest(hs) AS t(h) WHERE h IS NOT NULL) d ORDER BY h
  ON CONFLICT (phone_hash) DO UPDATE
    SET queued_at = clock_timestamp(), priority = least(pack_dirty.priority, EXCLUDED.priority);
  PERFORM pg_notify('pack_dirty', '');   -- folded to one per transaction
END $$;

CREATE FUNCTION pack_queue(h bytea, prio smallint) RETURNS void LANGUAGE sql AS $$
  SELECT pack_queue_many(ARRAY[h], prio);
$$;

-- Contacts, suggestions, the directory and opt-outs: statement triggers that read the changed
-- rows from transition tables, so a 20,000-contact sync queues its numbers in one sorted INSERT.
-- One trigger per event: a transition-table trigger can't name several. Rows removed by
-- ON DELETE CASCADE (a deleted member's contacts) arrive the same way.
CREATE FUNCTION pack_mark_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prio smallint := CASE WHEN TG_TABLE_NAME = 'opt_outs' THEN 0 ELSE 1 END;
  hs bytea[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(phone_hash) INTO hs FROM new_rows;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(phone_hash) INTO hs FROM old_rows;
  ELSE
    SELECT array_agg(h) INTO hs FROM (SELECT phone_hash AS h FROM old_rows UNION ALL SELECT phone_hash FROM new_rows) u;
  END IF;
  PERFORM pack_queue_many(hs, prio);
  RETURN NULL;
END $$;

-- Members: their own number (member entries), and on a family move the family_only contacts
-- they uploaded, which answer the uploader's family.
CREATE FUNCTION pack_mark_user_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE hs bytea[] := '{}';
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN hs := hs || OLD.phone_hash; END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN hs := hs || NEW.phone_hash; END IF;
  IF TG_OP = 'UPDATE' AND OLD.family_id IS DISTINCT FROM NEW.family_id THEN
    hs := hs || coalesce((SELECT array_agg(c.phone_hash) FROM contacts c WHERE c.user_id = NEW.id AND c.family_only), '{}');
  END IF;
  PERFORM pack_queue_many(hs, 1::smallint);
  RETURN NULL;
END $$;

CREATE TRIGGER pack_dirty_contacts_ins AFTER INSERT ON contacts
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION pack_mark_dirty();
CREATE TRIGGER pack_dirty_contacts_upd AFTER UPDATE ON contacts
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION pack_mark_dirty();
CREATE TRIGGER pack_dirty_contacts_del AFTER DELETE ON contacts
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION pack_mark_dirty();
CREATE TRIGGER pack_dirty_suggestions_ins AFTER INSERT ON name_suggestions
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION pack_mark_dirty();
CREATE TRIGGER pack_dirty_suggestions_upd AFTER UPDATE ON name_suggestions
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION pack_mark_dirty();
CREATE TRIGGER pack_dirty_suggestions_del AFTER DELETE ON name_suggestions
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION pack_mark_dirty();
CREATE TRIGGER pack_dirty_directory_ins AFTER INSERT ON directory
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION pack_mark_dirty();
CREATE TRIGGER pack_dirty_directory_upd AFTER UPDATE ON directory
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION pack_mark_dirty();
CREATE TRIGGER pack_dirty_directory_del AFTER DELETE ON directory
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION pack_mark_dirty();
CREATE TRIGGER pack_dirty_optouts_ins AFTER INSERT ON opt_outs
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION pack_mark_dirty();
CREATE TRIGGER pack_dirty_optouts_del AFTER DELETE ON opt_outs
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION pack_mark_dirty();
CREATE TRIGGER pack_dirty_users AFTER INSERT OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION pack_mark_user_dirty();
-- Only real changes: every request's last_seen_at write and a re-register that keeps the name
-- queue nothing. A row trigger: a statement trigger would fire on each of those writes.
CREATE TRIGGER pack_dirty_users_update AFTER UPDATE OF phone_hash, name, family_id, photo_url ON users
  FOR EACH ROW WHEN (OLD.phone_hash IS DISTINCT FROM NEW.phone_hash OR OLD.name IS DISTINCT FROM NEW.name
    OR OLD.family_id IS DISTINCT FROM NEW.family_id OR OLD.photo_url IS DISTINCT FROM NEW.photo_url)
  EXECUTE FUNCTION pack_mark_user_dirty();

-- TRUNCATE fires none of the triggers above (directory import): ask for one full reconcile.
ALTER TABLE pack_meta ADD COLUMN IF NOT EXISTS full_requested_at timestamptz;
CREATE FUNCTION pack_request_full() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE pack_meta SET full_requested_at = now() WHERE active_at IS NOT NULL;
  PERFORM pg_notify('pack_dirty', '');
  RETURN NULL;
END $$;
CREATE TRIGGER pack_full_directory AFTER TRUNCATE ON directory
  FOR EACH STATEMENT EXECUTE FUNCTION pack_request_full();
