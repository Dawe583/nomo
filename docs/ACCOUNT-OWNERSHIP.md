# Account ownership for the cloud

**Status: the data layer is scoped. Accounts are not enabled and signup is
still off.** Everything below that says "must" is a condition on enabling
signup, not a description of what exists.

This is how `chat.voidagent.tech` becomes multi-tenant, so that an account
created on the marketing site sees only its own data. It exists because
`docs/APPWRITE-AUTH.md` forbids enabling public signup until every cloud read
and write is scoped by a verified owner.

## What the data looks like now

Three tables, in `cloud/schema.sql`, and all three have an owner that is the
first column of the primary key:

| table | key | written by |
| --- | --- | --- |
| `void_cloud_state` | `(owner, key)`, where `key` is `session:<id>`, `workspace:<id>` or `hold:<id>` | `cloud/store.mjs`, `cloud/demo.mjs` |
| `void_cloud_ledger` | `(owner, workspace, seq)` | `cloud/store.mjs` `append` |
| `void_cloud_events` | `(owner, session_id, seq)` | `cloud/store.mjs` `event` |

Seventeen statements read or write them, spread across `cloud/store.mjs`
(fourteen), `cloud/server.mjs` (two) and `cloud/prime.mjs` (one). Four more
sit in the test fixtures. Every one of them now carries an owner predicate or
supplies the owner column, and `cloud/owner.test.mjs` parses the queries in
every file under `cloud/` and fails if one does not.

There is still no bridge from the local control plane into this database: the
hosted web UI is the only thing that writes here, so scoping the rows by
account does not change what the local product does on a visitor's own machine,
and the local path keeps its `VOID_CONTROL_TOKEN` and its loopback.

## Where the owner comes from

The middleware in `cloud/server.mjs` resolves `req.owner` before any route
runs, from a verified session and from nowhere else. There are two sources and
only two:

- The operator's control token, cookie or bearer header, resolves to
  `OPERATOR_OWNER`.
- A sealed `__Host-void-account` cookie, opened with
  `VOID_ACCOUNT_SEAL_KEY` and then confirmed against the provider over TLS,
  resolves to the provider's user id.

A request that presents neither is refused. It is not served from a shared
workspace and it is not served an empty result, because an empty result reads
as "you have nothing" and hides the refusal.

The second source is `cloud/account.mjs`: the same design the marketing site
already uses for its accounts, and it is server side only, so `vercel.json`
keeps `connect-src 'self'` and the browser never holds a provider token. Sign up
is refused unless `VOID_ACCOUNT_SIGNUP` is `1`, and it is not set.

`cloud/owner.mjs` holds the reserved owners and the one validation every store
function applies first. `cloud/owner.test.mjs` reads the signatures and fails
if a store function stops taking the owner, and reads every source file and
fails if an owner is put on a request anywhere but the middleware.

## The operator's own rows

The operator is a distinct scoped role, not an account, and not a token that
reads everything.

`VOID_CONTROL_TOKEN` resolves to one reserved owner, `operator`. It reads
exactly the rows owned by `operator`, which is one namespace and not the union
of the others. `cloud/0001-account-ownership.sql` moves every row that existed
before this change into that namespace, so the beta the operator is using today
keeps working unchanged.

There is no third option where a token reads every account's rows. That is the
hole this whole change exists to close, and `cloud/owner.test.mjs` fails if
anything else is introduced.

## The public demo

`cloud/server.mjs` still mounts the demo before the session gate, and the demo
is still reachable with no credential. That is its purpose and it is not
changing.

What has changed is that the demo is not shared state any more: every read,
write and lock it issues runs as the reserved owner `public-demo`, applied in
`cloud/demo.mjs` outside the dependency injection point, so an injected store is
handed the owner rather than trusted to choose one. A demo visitor can neither
read nor collide with a row belonging to the operator or to an account. The
open endpoint is no longer a window into anybody's namespace; it is a window
into its own.

## What still has to be true before signup is enabled

The gate in `docs/APPWRITE-AUTH.md` stands. Of its four conditions:

1. **Done, and enforced by a test rather than by review.** Every statement
   carries an owner, `cloud/owner.test.mjs` parses them, and a statement that
   cannot be scoped was deleted rather than left shared.
2. **Not done.** Two accounts in a test database with no read or write issued
   for one able to return the other's rows. The suite gates its database tests
   behind `VOID_GUI_DATABASE_TEST=1` and refuses to run them without an
   explicitly supplied isolated database, so the row-level isolation proved so
   far is a migration proof against a local PostgreSQL, not a test in this
   repository. Write it before the switch.
3. **Done, as a decision.** The operator is a distinct scoped role with no
   implicit access to anybody's rows, as described above.
4. **Done, as a decision.** The demo namespace is owned.

Two further conditions are not in that list and have to hold anyway:

- **A Supabase project exists.** There is none on the operator's side, so
  nothing can be signed in against. Until there is, the broker is inert and
  every request must present the control token.
- **The Prime bridge is either given a per-owner credential or refused to
  accounts.** It authenticates with a machine token and is bound to the
  operator's namespace, and `POST /api/sessions` refuses `prime-agent` for any
  owner that is not the operator. That is a deliberate refusal rather than a
  queued run no worker may claim.

## The order it was done in

1. `cloud/0001-account-ownership.sql`: the column and the new primary keys,
   additive and idempotent, with every existing row backfilled to `operator`.
2. The owner in the middleware.
3. The owner on every statement, with the owner as the first parameter of
   every store function.
4. Sign up left off.

The migration is a separate file rather than an edit to `cloud/schema.sql`
because it is a table rewrite against a database that is already serving a
beta. `cloud/schema.sql` is the shape a new database gets; the migration is
what moves an existing one, and running it against a database provisioned from
the schema is a no-op.

## What this does not do

It does not make the local product multi user. VOID still runs on the
operator's machine, still talks to it over loopback, and still authenticates
with `VOID_CONTROL_TOKEN`. It does not give anybody a hosted VOID, and the
marketing site's copy says so on purpose.

It does not store a password anywhere in this database, and it will not: the
identity, including its hash, belongs to the provider.
