# Supabase/cloud Postgres RLS audit

Status: static audit complete. Base: `7a242d56b0035ff7bc5c4fefd9d89a94af052c9a`.
Scope: the account-ownership and row-level-security posture of the three
tables behind `cloud/`, per the checklist in the `nomo-development` skill.
Authority for this audit's own evidence is the command output below, not
the source comments alone, although the source comments turned out to
match what the tests actually check.

## Zero architecture correction before anything else

"Supabase" in this codebase is **the auth provider only**. `cloud/account.mjs`
is explicitly "the only code in this repository that talks to Supabase
Auth" (its own header comment), and it talks to Supabase exclusively over
`/auth/v1/*` REST endpoints to resolve an identity (`whoIs`) and to
sign in, refresh and sign out. It never queries a Supabase-hosted Postgres
table.

The actual multi-tenant data store (`void_cloud_state`, `void_cloud_ledger`,
`void_cloud_events`) is a separate Postgres reached through `pg.Pool` in
`cloud/store.mjs`, configured by `NOMO_DATABASE_URL`/`DATABASE_URL`
(`@neondatabase/serverless` is also a dependency, consistent with a
Neon-hosted Postgres rather than Supabase's own database). There is no
`@supabase/supabase-js` dependency anywhere, and no PostgREST auto-API sits
in front of these three tables. Practically: a Supabase dashboard toggle
such as "expose this table via the Data API" cannot apply here, because
these tables are not Supabase's tables.

This matters for how to read the RLS migration below: the `anon`/
`authenticated` revokes in `cloud/schema.sql` and
`cloud/0001-account-ownership.sql` are written conditionally
(`IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name)`) precisely
because those roles may not even exist on this database. They are defence
in depth for a Supabase-style deployment, not a description of how this
one is actually reached today.

## What the schema does

`cloud/schema.sql` and `cloud/0001-account-ownership.sql`:

- `owner` is the first column of the primary key on all three tables, with
  **no `DEFAULT`**: a statement that forgets the owner column fails loudly
  instead of landing in `NULL`'s namespace.
- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on all three, `REVOKE ALL ...
  FROM PUBLIC`, and a conditional revoke from `anon`/`authenticated` if
  those roles exist.
- **No `CREATE POLICY` anywhere.** With RLS enabled and zero policies,
  Postgres denies every row to every role except the table owner and a
  role with `BYPASSRLS`. Combined with the revokes, the real access
  boundary is binary: the role the application connects as (which the
  schema comment says is the database owner) can reach every row, and
  every other role reaches none. There is no per-row Postgres policy doing
  owner-based filtering; **all owner-based filtering is enforced by the
  application**, not by a database policy.
- The append-only ledger/events triggers (`void_cloud_immutable`) are
  `SECURITY INVOKER` by default (no `SECURITY DEFINER` in the
  `CREATE FUNCTION`), touch no database objects, and `0002-immutable-
  function-search-path.sql` additionally pins the function's
  `search_path` to `''` as a second, independent hardening pass for
  databases migrated before that pin existed. Low risk either way: an
  invoker-rights function with an empty body has no search-path
  injection surface to begin with.

## What the application enforces, and how rigorously it is already tested

`cloud/owner.mjs` and `cloud/store.mjs` carry the real boundary:

- Every exported store function (`read`, `write`, `transaction`,
  `sessions`, `append`, `ledger`, `eventsAfter`, `sessionPage`,
  `ledgerPage`, `allEvents`) takes `owner` as its first argument and calls
  `assertOwner(owner)` before it resolves a database client.
- `req.owner` is assigned in **exactly two places** in the entire
  codebase, both in `cloud/server.mjs`'s session middleware: the
  operator's control token resolves to `OPERATOR_OWNER` (compared with
  `timingSafeEqual`, minimum 32 characters), and a verified Supabase
  session resolves to `live.user.id`, where `live` only exists after a
  fresh round trip to the provider's `/auth/v1/user` (never a decoded
  JWT claim).
- `cloud/owner.test.mjs` already proves this structurally rather than
  just behaviourally: it greps every `.mjs` file for `req.query.owner`,
  `req.body.owner`, `req.headers["x-nomo-owner"]` and `req.headers.owner`
  and fails if any appear; it asserts the only two `*.owner =`
  assignments in the whole tree are the two lines in `server.mjs` named
  above; and it runs a purpose-built block-structured SQL scanner
  (`unscopedTables`) over every `.query(...)` literal in `cloud/*.mjs`
  that correctly distinguishes an outer `WHERE owner=$1` from an inner,
  unscoped subquery or join, which a naive whole-statement regex would
  miss. It also captures the two dynamically composed statements in
  `sessionPage`/`ledgerPage` at the `pg.Pool.prototype.query` driver
  (stubbed, no socket opened) because those are assembled in JavaScript
  and never appear as a literal in the source.
- The owner value shape (`OWNER_SHAPE`) is validated before it is ever
  used as a SQL parameter, and `isOwner`/`assertOwner` reject anything
  that is not `operator`, `public-demo`, or a narrow identifier shape
  (rejecting empty strings, leading/trailing whitespace, `owner;drop`,
  quote characters, and over-length values).
- The public demo (`DEMO_OWNER = "public-demo"`) is its own namespace,
  distinct from `OPERATOR_OWNER`, rate limited to 50 runs and 6 unique
  visitors per day in `cloud/demo.mjs`, and `owner.test.mjs` asserts the
  demo router only ever calls the store with `DEMO_OWNER`.

## Evidence actually run

On the Linux verifier checkout at the base commit above, Node
v24.14.1:

```
node --test cloud/owner.test.mjs cloud/account.test.mjs \
  cloud/account-isolation.test.mjs cloud/account-routes.test.mjs \
  cloud/capability-gate.test.mjs
# tests 62, pass 61, fail 0, skipped 1

node --test cloud/schema.test.mjs
# tests 2, pass 2, fail 0
```

The one skip is `cloud/account-isolation.test.mjs`'s
`"two verified accounts cannot read or change each other's cloud rows"`,
guarded by `skip: process.env.NOMO_GUI_DATABASE_TEST !== "1"`. It opens a
real `server.mjs` HTTP listener and runs real SQL against a disposable
Postgres, asserting two live accounts, the operator token, and an
anonymous caller all get the expected 200/404/401 against each other's
rows. No Postgres server is available in this environment (`psql` and
`pg_ctlcluster` are both absent, and installing one is out of scope
without authorization), so this one test could not be executed here.

## Gaps this audit did not and could not close

1. **The one live, cross-account HTTP test is unexecuted here.** It is
   the single piece of evidence that would observe the whole stack (HTTP,
   session, store, real RLS-enabled Postgres) together rather than each
   layer in isolation. This is the same `isolated-postgres` CI job already
   reported blocked under issue 110's GitHub Actions billing hold, so this
   is not a new, separate gap: it is the same account-level blocker,
   observed from a different angle.
2. **No tool here can confirm the live deployed database actually has
   this migration applied.** The migration file is additive, idempotent
   and atomic, and is tested as a file (`owner.test.mjs`'s migration
   tests), but whether `cloud/0001-account-ownership.sql` and
   `cloud/0002-immutable-function-search-path.sql` were ever run against
   the production database is a fact about the deployment, not about the
   source tree, and needs the operator to confirm it from their own
   database console or a `psql` session with real credentials. Nothing
   here should be read as having checked that.
3. **No other table in the repository carries cloud multi-tenant data.**
   Every other `CREATE TABLE` in the tree belongs to the Postgres
   *connector* (`packages/connectors/src/postgres/*`, which manages a
   customer's own database as a product feature, not NOMO's data) or to
   local SQLite-backed runtime stores, neither of which is in scope for
   this audit.

## Verdict

No defect found. The ownership boundary is enforced at the application
layer, is unusually thoroughly self-tested already (structural source
scanning, not just behavioural assertions), and the schema-level RLS/
REVOKE statements are correct defence in depth for a boundary that does
not structurally depend on them given how the database is actually
reached. The two residual gaps are both about verifying live,
deployed state, which static review of the source tree cannot do and
which is blocked by the same GitHub Actions billing hold already
recorded against issue 110.
