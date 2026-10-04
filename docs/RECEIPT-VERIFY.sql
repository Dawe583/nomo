-- Third-party verification of a VOID recovery receipt.
--
-- Run it with any PostgreSQL client against the database the agent wrote to:
--
--   psql "$DATABASE_URL" -f docs/RECEIPT-VERIFY.sql
--
-- VOID is not involved in producing this output, not even as a library: this is
-- SQL over two tables the customer already owns. That is the claim, and anyone
-- who can reach the database can check it.
--
-- The last statement prints PASS or FAIL.

\set ON_ERROR_STOP on

\echo '=== 1. receipts present, and what they claim ==='

select
  id as receipt_id,
  outcome->>'status' as claimed_status,
  format_version,
  jsonb_array_length(outcome->'evidence'->'rows') as rows_named
from void_recovery.recoveries
order by id;

\echo ''
\echo '=== 2. THE CHECK THAT MATTERS: does each restored row match the live table? ==='
\echo '--- A receipt alone proves nothing. It is a claim. This is the test of it. ---'

with claimed as (
  select
    r.id as receipt_id,
    e.value->>'table' as table_name,
    e.value->'key' as claimed_key,
    e.value->'row' as row_claimed
  from void_recovery.recoveries r,
       lateral jsonb_array_elements(r.outcome->'evidence'->'rows') as e(value)
)
select
  c.receipt_id,
  c.table_name,
  c.row_claimed as row_the_receipt_names,
  case
    when c.table_name = 'public.account' then (
      select case
               when to_jsonb(a) = c.row_claimed
                 then 'MATCH: the live row is exactly the row the receipt names'
               else 'MISMATCH: the live row differs from the row the receipt names'
             end
      from public.account a
      where (to_jsonb(a) -> 'id') = (c.claimed_key -> 'id')
    )
    else 'NO CHECK WRITTEN for this table: add one, or treat the receipt as unverified'
  end as verdict
from claimed c
order by c.receipt_id;

\echo ''
\echo '=== 3. did the receipt reverse something real, or is it a no-op claim? ==='
\echo '--- The row the agent wrote must differ from the row the receipt restores. ---'
\echo '--- Correlated on the table and key both records name, not on id text. ---'

with written as (
  select
    o.id as operation_id,
    o.outcome->'evidence'->'rows'->0->>'table' as table_name,
    o.outcome->'evidence'->'rows'->0->'key' as claimed_key,
    o.outcome->'result' as row_written,
    (o.outcome->'evidence'->'rows'->0->>'revision') as revision_after_write
  from void_recovery.operations o
),
restored as (
  select
    r.id as receipt_id,
    r.outcome->'evidence'->'rows'->0->>'table' as table_name,
    r.outcome->'evidence'->'rows'->0->'key' as claimed_key,
    r.outcome->'evidence'->'rows'->0->'row' as row_restored,
    (r.outcome->'evidence'->'rows'->0->>'revision') as revision_after_restore
  from void_recovery.recoveries r
)
select
  w.operation_id,
  w.revision_after_write,
  s.revision_after_restore,
  w.row_written as row_the_agent_wrote,
  s.row_restored as row_the_receipt_restores,
  case
    when w.row_written is distinct from s.row_restored
      then 'REVERSED: the two rows differ, so the receipt records a real change'
    else 'NO-OP: the receipt restores exactly what the agent wrote'
  end as verdict
from written w
join restored s
  on s.table_name = w.table_name
 and s.claimed_key = w.claimed_key
order by w.operation_id;

\echo ''
\echo '=== 4. the business table, as it stands now ==='

select * from public.account order by id;

\echo ''
\echo '=== VERDICT ==='

with claimed as (
  select
    r.outcome->>'status' as claimed_status,
    e.value->>'table' as table_name,
    e.value->'key' as claimed_key,
    e.value->'row' as row_claimed
  from void_recovery.recoveries r,
       lateral jsonb_array_elements(r.outcome->'evidence'->'rows') as e(value)
),
verdicts as (
  select
    c.claimed_status,
    case
      when c.table_name = 'public.account' then (
        select to_jsonb(a) = c.row_claimed
        from public.account a
        where (to_jsonb(a) -> 'id') = (c.claimed_key -> 'id')
      )
      else null
    end as row_matches_live_table
  from claimed c
)
select
  count(*) filter (where claimed_status = 'restored') as receipts_claiming_restored,
  count(*) filter (where row_matches_live_table) as rows_confirmed_by_the_table,
  count(*) filter (where row_matches_live_table is null) as rows_with_no_check_written,
  case
    when count(*) = 0 then 'NOTHING TO VERIFY: no receipt is present'
    when count(*) filter (where row_matches_live_table is null) > 0
      then 'FAIL: a receipt names a table this file has no check for'
    when count(*) filter (where row_matches_live_table is not true) > 0
      then 'FAIL: a receipt claims a restoration the live table does not show'
    else 'PASS: every receipt claiming a restoration is one the live table confirms'
  end as overall
from verdicts;
