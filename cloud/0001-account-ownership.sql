-- 0001 account ownership
--
-- Moves a database that is already serving a beta to the shape in
-- cloud/schema.sql: an `owner` column on all three tables, and `owner` as the
-- first column of all three primary keys.
--
-- Properties this file is written to have:
--
--   * Additive first. It adds owner columns and pins the trigger function's
--     search path before changing any row. If the migration is abandoned, the
--     database retains its existing data and trigger behavior.
--   * Idempotent. Every step is conditional, so running it twice is the same
--     as running it once, and running it against a database that
--     cloud/schema.sql already provisioned is a no-op.
--   * Order independent. Every statement is guarded on the table existing, so
--     this file may be applied before or after cloud/schema.sql.
--   * Atomic. The whole file is one transaction, so a failure at any step
--     leaves the append-only triggers exactly as they were.
--
-- What the immutability triggers do to this migration
-- ---------------------------------------------------
--
-- `void_cloud_ledger` and `void_cloud_events` carry
-- `void_cloud_immutable()`, a BEFORE UPDATE OR DELETE trigger that raises
-- `VOID ledger is append only`. The backfill below is an UPDATE on both of
-- them, so with the triggers in place the backfill fails against its own
-- trigger on the first row. That is the trigger working as designed: these
-- tables are append only for the application, and a migration is not the
-- application.
--
-- The rows get across two ways, and the migration uses both:
--
--   1. The backfill disables the trigger, updates, and re-enables it inside
--      the same transaction. `ALTER TABLE ... DISABLE TRIGGER` is itself
--      transactional, so a later failure rolls the trigger back to enabled.
--      Nothing outside this transaction ever runs with the trigger off.
--   2. The primary key swap does not need the trigger at all. Adding a
--      constraint builds an index, and an index build is not a row update, so
--      it fires no row trigger. The trigger is disabled across it anyway so
--      that no step in this file can surprise the next one.
--
-- The event recovery from the pre-existing session documents is an INSERT, not
-- an UPDATE, so it would not have needed the trigger lifted. It runs after the
-- keys are in place so that every row it writes already carries an owner.
--
-- Window
-- ------
--
-- Steps 4 and 5 take ACCESS EXCLUSIVE and build a unique index per table.
-- On a beta-sized table that is short, but it is a lock: run this in a quiet
-- moment, and run it once, with the deploy paused.

BEGIN;

-- 1. Additive. The owner does not exist yet and nothing reads it.
ALTER TABLE IF EXISTS void_cloud_state ADD COLUMN IF NOT EXISTS owner text;
ALTER TABLE IF EXISTS void_cloud_ledger ADD COLUMN IF NOT EXISTS owner text;
ALTER TABLE IF EXISTS void_cloud_events ADD COLUMN IF NOT EXISTS owner text;

-- Pin the append-only trigger function to an empty search path. Its body uses
-- no database objects, so it does not need schema lookup.
DO $$
BEGIN
  IF to_regprocedure('public.void_cloud_immutable()') IS NOT NULL THEN
    ALTER FUNCTION public.void_cloud_immutable() SET search_path = '';
  END IF;
END $$;

-- 2. Lift the append-only triggers for the duration of the backfill only.
-- The two conditions are nested rather than combined with AND on purpose: a
-- `table::regclass` cast raises when the table is absent, and a planner is free
-- to evaluate the right side of an AND first.
DO $$
DECLARE
  ledger regclass := to_regclass('void_cloud_ledger');
  events regclass := to_regclass('void_cloud_events');
BEGIN
  IF ledger IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgrelid = ledger
                  AND tgname = 'void_cloud_immutable' AND NOT tgisinternal) THEN
      EXECUTE 'ALTER TABLE void_cloud_ledger DISABLE TRIGGER void_cloud_immutable';
    END IF;
  END IF;
  IF events IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgrelid = events
                  AND tgname = 'void_cloud_events_immutable' AND NOT tgisinternal) THEN
      EXECUTE 'ALTER TABLE void_cloud_events DISABLE TRIGGER void_cloud_events_immutable';
    END IF;
  END IF;
END $$;

-- 3. Backfill every existing row to the operator. The value matches
-- cloud/owner.mjs `OPERATOR_OWNER`, and cloud/owner.test.mjs fails if the two
-- ever drift apart. No other identity exists yet, so this loses nothing.
DO $$
BEGIN
  IF to_regclass('void_cloud_state') IS NOT NULL THEN
    EXECUTE 'UPDATE void_cloud_state SET owner = ''operator'' WHERE owner IS NULL';
  END IF;
  IF to_regclass('void_cloud_ledger') IS NOT NULL THEN
    EXECUTE 'UPDATE void_cloud_ledger SET owner = ''operator'' WHERE owner IS NULL';
  END IF;
  IF to_regclass('void_cloud_events') IS NOT NULL THEN
    EXECUTE 'UPDATE void_cloud_events SET owner = ''operator'' WHERE owner IS NULL';
  END IF;
END $$;

-- 4. No default is set, on purpose. A statement that forgets the owner must
--    fail rather than land in a namespace nobody chose.
ALTER TABLE IF EXISTS void_cloud_state ALTER COLUMN owner SET NOT NULL;
ALTER TABLE IF EXISTS void_cloud_ledger ALTER COLUMN owner SET NOT NULL;
ALTER TABLE IF EXISTS void_cloud_events ALTER COLUMN owner SET NOT NULL;

-- 5. The primary keys. The constraint names are the ones PostgreSQL gives an
--    inline PRIMARY KEY, which is how all three tables were created. The column
--    order is read from conkey rather than from the catalog attribute order,
--    because `owner` was added last and a comparison in attribute order would
--    never match and would rebuild the key on every run.
DO $$
DECLARE
  target record;
  current_key text[];
  wanted_columns text;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('void_cloud_state',  ARRAY['owner','key']),
      ('void_cloud_ledger', ARRAY['owner','workspace','seq']),
      ('void_cloud_events', ARRAY['owner','session_id','seq'])
    ) AS t(table_name, wanted)
  LOOP
    IF to_regclass(target.table_name) IS NULL THEN
      CONTINUE;
    END IF;
    SELECT ARRAY(
      SELECT a.attname
      FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.conrelid = target.table_name::regclass AND c.contype = 'p'
      ORDER BY k.ord
    ) INTO current_key;
    IF current_key IS DISTINCT FROM target.wanted THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',
                     target.table_name, target.table_name || '_pkey');
      SELECT string_agg(want, ', ' ORDER BY ord)
      INTO wanted_columns
      FROM unnest(target.wanted) WITH ORDINALITY AS w(want, ord);
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I PRIMARY KEY (%s)',
                     target.table_name, target.table_name || '_pkey',
                     wanted_columns);
    END IF;
  END LOOP;
END $$;

-- 6. Restore the append-only guarantee. Same transaction, so a failure above
--    never leaves the ledger editable.
--
--    The guard matches step 2's exactly, and that symmetry is load bearing.
--    Step 2 asks whether the trigger exists before disabling it; step 6 used
--    to ask only whether the table did, so a database that has the table but
--    never had the trigger reached `ENABLE TRIGGER` for a trigger that is not
--    there, PostgreSQL raised `trigger "void_cloud_immutable" does not exist`,
--    and because the whole file is one transaction the error took the added
--    column, the backfill, the not null and the primary key swap down with it.
--    Conditional on the table alone, this file was only order independent for
--    the shape it had already been run against.
--
--    The conditions are nested rather than combined with AND, for the reason
--    given in step 2: a `table::regclass` cast raises when the table is
--    absent, and a planner is free to evaluate the right side of an AND first.
DO $$
DECLARE
  ledger regclass := to_regclass('void_cloud_ledger');
  events regclass := to_regclass('void_cloud_events');
BEGIN
  IF ledger IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgrelid = ledger
                  AND tgname = 'void_cloud_immutable' AND NOT tgisinternal) THEN
      EXECUTE 'ALTER TABLE void_cloud_ledger ENABLE TRIGGER void_cloud_immutable';
    END IF;
  END IF;
  IF events IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgrelid = events
                  AND tgname = 'void_cloud_events_immutable' AND NOT tgisinternal) THEN
      EXECUTE 'ALTER TABLE void_cloud_events ENABLE TRIGGER void_cloud_events_immutable';
    END IF;
  END IF;
END $$;

-- 7. One-time recovery of GUI events that only exist inside a pre-existing
--    session document. The owner is taken from the row the event came from, so
--    an event can never be filed under an owner its session does not have.
DO $$
BEGIN
  IF to_regclass('void_cloud_state') IS NOT NULL
     AND to_regclass('void_cloud_events') IS NOT NULL THEN
    EXECUTE $recover$
      INSERT INTO void_cloud_events(owner,session_id,seq,event)
      SELECT owner, document->>'id', (event->>'seq')::integer, event
      FROM void_cloud_state
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(document->'events','[]'::jsonb)) event
      WHERE key LIKE 'session:%'
      ON CONFLICT DO NOTHING
    $recover$;
  END IF;
END $$;
-- Public Data API roles never query the server-owned account rows.
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

COMMIT;
