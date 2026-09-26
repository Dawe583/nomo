-- The shape a new database gets. A database that already exists is moved to
-- this shape by cloud/0001-account-ownership.sql, which is additive and can be
-- run more than once.
--
-- `owner` is the verified identity a row belongs to, and it is the first column
-- of every primary key. That is the whole isolation story: one account cannot
-- read another's rows because their keys are not in the same keyspace, and the
-- two partial indexes below stay valid because adding a column does not change
-- what they filter on.
--
-- `owner` deliberately has no DEFAULT. A statement that forgot the owner column
-- would then fail loudly instead of landing quietly in a namespace it was never
-- meant to reach.
CREATE TABLE IF NOT EXISTS void_cloud_state (owner text NOT NULL, key text NOT NULL, document jsonb NOT NULL, PRIMARY KEY(owner,key));
CREATE TABLE IF NOT EXISTS void_cloud_ledger (owner text NOT NULL, workspace text NOT NULL, seq integer NOT NULL, entry jsonb NOT NULL, PRIMARY KEY(owner,workspace,seq));
CREATE OR REPLACE FUNCTION void_cloud_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'VOID ledger is append only'; END $$;
DROP TRIGGER IF EXISTS void_cloud_immutable ON void_cloud_ledger;
CREATE TRIGGER void_cloud_immutable BEFORE UPDATE OR DELETE ON void_cloud_ledger FOR EACH ROW EXECUTE FUNCTION void_cloud_immutable();

-- GUI history is additive. Existing retained events are recovered from the
-- pre-existing session documents by the migration, which is where that one-time
-- backfill belongs: a fresh database has no session documents to recover from.
CREATE TABLE IF NOT EXISTS void_cloud_events (owner text NOT NULL, session_id text NOT NULL, seq integer NOT NULL, event jsonb NOT NULL, PRIMARY KEY(owner,session_id,seq));
CREATE INDEX IF NOT EXISTS void_cloud_session_created ON void_cloud_state ((document->>'createdAt') DESC, key) WHERE key LIKE 'session:%';
CREATE INDEX IF NOT EXISTS void_cloud_session_status ON void_cloud_state ((document->>'status')) WHERE key LIKE 'session:%';
CREATE INDEX IF NOT EXISTS void_cloud_events_type ON void_cloud_events ((event->>'type'),session_id,seq);
DROP TRIGGER IF EXISTS void_cloud_events_immutable ON void_cloud_events;
CREATE TRIGGER void_cloud_events_immutable BEFORE UPDATE OR DELETE ON void_cloud_events FOR EACH ROW EXECUTE FUNCTION void_cloud_immutable();

-- The server connects as the database owner. Public API roles get no table access.
ALTER TABLE void_cloud_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE void_cloud_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE void_cloud_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE void_cloud_state, void_cloud_ledger, void_cloud_events FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE public.void_cloud_state, public.void_cloud_ledger, public.void_cloud_events FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END $$;
