# A recovery receipt, verified without VOID

This directory produces one receipt against a real PostgreSQL server and then
checks it with SQL that does not involve VOID at all.

The claim being demonstrated has two halves, and the second half is the one
that matters:

1. VOID reverses a single effect in a live system and does not disturb anything
   else.
2. A third party can confirm the reversal **from the database alone**, without
   trusting VOID, its signing key, or its ledger.

## What it does

`run.mjs` connects to a PostgreSQL database named by `VOID_PG_URL`, installs the
managed recovery schema, and then:

1. Creates a two-row table, `public.account`.
2. Dispatches one agent write through the runtime: `public.account` row 1,
   `balance` 10 to 0. The write succeeds.
3. **Outside VOID**, a finance approval writes to row 2: `balance` 90 to 75.
4. Plans the recovery and applies the inverse.
5. Prints the receipt from `void_recovery.recoveries`.

The result is that row 1 is back to 10 and row 2 keeps 75. A point-in-time
restore to the moment before step 2 would have destroyed row 2's legitimate
change; a per-effect inverse does not. That difference is the product.

## Run it

```sh
export VOID_PG_URL="postgres://void@127.0.0.1:5432/void_demo"
node --experimental-strip-types scripts/receipt-demo/run.mjs
```

Then, as anyone who can reach the database:

```sh
psql "$VOID_PG_URL" -f docs/RECEIPT-VERIFY.sql
```

`docs/RECEIPT-VERIFY.sql` prints three checks and a final verdict:

| check | question |
|---|---|
| 2 | does the row the receipt names equal the row the live table holds? |
| 3 | does the restored row differ from the row the agent wrote? |
| verdict | `PASS` only if every receipt is confirmed by the table |

## What was observed

Run against PostgreSQL 17.11 on 2026-10-04:

- agent write: `succeeded` (row 1 to `balance 0`, note "spent by agent")
- finance write, outside VOID: row 2 to `balance 75`
- inverse: `restored`
- after: row 1 is `balance 10`, row 2 is still `balance 75`
- `RECEIPT-VERIFY.sql`: `PASS`

The check was then made to fail on purpose, by editing row 1 by hand to
`balance 999` while the receipt still claimed `balance 10`:

```
MISMATCH: the live row differs from the row the receipt names
FAIL: a receipt claims a restoration the live table does not show
```

and returned to `PASS` once the row was restored. A verification that cannot
fail is not a verification, so the failure was produced deliberately and is
recorded here rather than omitted.

## Limits, stated rather than implied

- **One table.** The verification file carries a hand-written check for
  `public.account` and says so for any other table it meets. It reports
  `NO CHECK WRITTEN` rather than passing a table it cannot test. Adding a table
  means adding a check.
- **Two rows, one agent write.** This demonstrates the mechanism. It does not
  demonstrate concurrency at volume; `docs/RELEASE.md` blocker 4 still asks for a
  service machine with disposable Postgres and S3 for that.
- **Not a gate.** Nothing here runs in `pnpm test`. It needs a live database, so
  it is a demonstration that can be re-run, not a check that holds a build
  green.
- **The receipt is not signed in this demonstration.** The receipt row here is
  the durable record the managed adapter writes into the customer's schema. The
  signed, chain-verified reversal record is the local ledger's; see
  `packages/ledger/src/reversal.ts`. Neither is what check 3 above reads, because
  check 3 deliberately reads only what the database itself holds.

## The check is falsifiable, and that was tested

A verification file that cannot fail is a rubber stamp, so it was run against a
database that had been tampered with after the receipt was written.

```sh
# honest database
psql "$VOID_PG_URL" -f docs/RECEIPT-VERIFY.sql
#   PASS: every receipt claiming a restoration is one the live table confirms

# now change the row the receipt names, without touching VOID
psql "$VOID_PG_URL" -c "UPDATE public.account SET note='tampered after the receipt' WHERE id=1;"
psql "$VOID_PG_URL" -f docs/RECEIPT-VERIFY.sql
#   FAIL: a receipt claims a restoration the live table does not show
```

Both results were observed against PostgreSQL 17.11 on 2026-10-04. The verdict
changes because the table changed, which is the whole point: the answer comes
from the customer's database, not from VOID's word.
