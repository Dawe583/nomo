# Account ownership for the cloud

**Status: the data layer is scoped and the identity path is mounted. Signup is
still off, and it is off by a variable that is not set.**

This is how `chat.voidagent.tech` becomes multi-tenant, so that an account
created on the marketing site sees only its own data. It exists because
`docs/APPWRITE-AUTH.md` forbids enabling public signup until every cloud read
and write is scoped by a verified owner.

## Supabase migration checkpoint

The empty `VOID` project in `eu-west-1` now has migration `20260926231124`
with the three tables below. Row Level Security is enabled. The `anon`,
`authenticated` and `PUBLIC` roles have no table privileges. A live Data API
request with the publishable key received HTTP 401. The application is not yet
connected to this database, no Neon data has been copied, and public signup
remains disabled.

The cloud server must use only a server-side PostgreSQL connection string.
Browser clients must never receive database credentials or use these tables
directly.

## What the data looks like

Three tables, in `cloud/schema.sql`, and all three have an owner that is the
first column of the primary key:

| table | key | written by |
| --- | --- | --- |
| `void_cloud_state` | `(owner, key)`, where `key` is `session:<id>`, `workspace:<id>` or `hold:<id>` | `cloud/store.mjs`, `cloud/demo.mjs` |
| `void_cloud_ledger` | `(owner, workspace, seq)` | `cloud/store.mjs` `append` |
| `void_cloud_events` | `(owner, session_id, seq)` | `cloud/store.mjs` `event` |

Sixteen statements in the shipped code read or write them: thirteen in
`cloud/store.mjs`, two in `cloud/server.mjs` and one in `cloud/prime.mjs`. Four
more sit in the test fixtures, so the scan sees twenty. Every one of them
carries an owner predicate or supplies the owner column, and
`cloud/owner.test.mjs` parses the queries in every file under `cloud/` and fails
if one does not. The owner is a bound parameter in all of them, never text
assembled into the statement, so the value cannot be altered by changing a
filter.

The rule is about a table reference rather than about a statement, because a
statement can name two tables and the outer predicate says nothing about the
inner one. The scan splits each statement into its query blocks, judges every
table reference only against predicates written in its own block, and reports
the text it judged. A block that names two cloud tables has to qualify the
owner for each of them, because an unqualified `owner=$1` there would be an
ambiguous column rather than an answer.

The two page functions compose their statements in JavaScript, so the one that
reaches `void_cloud_events` is not written down anywhere in the source and a
scan of the file cannot see it. `cloud/owner.test.mjs` therefore also runs the
same rule over the SQL `sessionPage` and `ledgerPage` actually hand to the
driver, captured with the driver stubbed and no database started. That is the
check that fails if `e.owner=$1` is removed from the event search; the text scan
alone passes with it gone, which is the defect it was rewritten to close.

The two keyset page queries bind the owner once as `$1` and write `owner=$1`
into every statement they build rather than appending it to a condition list,
so a caller cannot remove the predicate by manipulating a filter. The event
search inside the session page reuses the same `$1`, so the correlated subquery
cannot widen itself past the caller's namespace. Both page cursors hash the
owner into their signature, so a cursor minted for one account is rejected by
another rather than paging through a namespace it was never issued for.

The owner is the first argument of every store function, and each one calls
`assertOwner` before it resolves a database client. A caller that forgets the
owner gets a throw, not a query against a shared workspace. `owner` deliberately
has no default in the schema, so a statement that forgot the column would fail
loudly rather than land quietly in a namespace nobody chose.

There is no bridge from the local control plane into this database: the hosted
web UI is the only thing that writes here, so scoping the rows by account does
not change what the local product does on a visitor's own machine, and the
local path keeps its `VOID_CONTROL_TOKEN` and its loopback.

## Where the owner comes from

The middleware in `cloud/server.mjs` resolves `req.owner` before any owner
bearing route runs, from a verified session and from nowhere else. There are two
sources and only two:

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

### The account HTTP surface

The broker has three routes of its own. All three answer inside the middleware
before an owner is resolved, because a caller with no credential yet is exactly
who they are for. They sit below the origin and `sec-fetch-site` checks, so a
cross-site sign in is refused even though the route itself demands no
credential.

| route | answer |
| --- | --- |
| `GET /api/account` | `{ configured, signedIn, email? }`. The only way the interface learns which of the two gates to draw. A session the store would refuse is reported as signed out, so the screen never claims a person is in and then answers 401. |
| `POST /api/account/signin` | Body is `{ email, password }` and nothing else. The method is named in the route, not read from the body, so this cannot be talked into a magic link or a signup. A success seals the session and returns `Set-Cookie: __Host-void-account`. |
| `DELETE /api/account` | Revokes at the provider and clears the cookie. Signing out with no cookie is a 200. |

The sign in surface over HTTP is password sign in and nothing else. A signup is
attempted only when the provider says the address holds no account, the switch
is on, and the request carried an invitation code, and no mounted route passes
an invitation code. So even a future operator who sets `VOID_ACCOUNT_SIGNUP`
does not open registration by doing so alone.

Two things about a refusal are worth knowing before reading one. A wrong
password and an address that holds no account are one answer, byte for byte,
and neither names the address; the collapse happens in this repository, not in
the provider's good behaviour. And with the switch unset, a well formed attempt
the provider does not confirm arrives as `invite_required`, which is why that
sentence says the sign in was not accepted and then says what is true about
this server. A malformed body, an address without an `@` or an empty password
is answered `invalid_credentials` before the provider is asked anything, so
`401` and `403` are both reachable codes. `502` is a provider outage and must
never be reported as a refused password.

`cloud/account-routes.test.mjs` drives all three routes over real HTTP against
a provider on loopback, and the two provider refusals it returns are
deliberately different, because the whole point is that the caller cannot tell
them apart. It needs no database and runs with the rest of the cloud unit
suites.

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

What the demo is not any more is shared state: every read, write and lock it
issues runs as the reserved owner `public-demo`, applied in `cloud/demo.mjs`
outside the dependency injection point, so an injected store is handed the
owner rather than trusted to choose one. A demo visitor can neither read nor
collide with a row belonging to the operator or to an account. The open
endpoint is no longer a window into anybody's namespace; it is a window into
its own.

## The migration

`cloud/0001-account-ownership.sql` is a separate file rather than an edit to
`cloud/schema.sql` because it is a table rewrite against a database that is
already serving a beta. `cloud/schema.sql` is the shape a new database gets; the
migration is what moves an existing one, and running it against a database
provisioned from the schema is a no-op.

The order inside it is additive first, then backfill, then `SET NOT NULL`, then
the primary key swap, and every step is conditional on the shape it needs, so
it is idempotent and order independent. The detail that is not guessable is
what the immutability triggers do to it. `void_cloud_ledger` and
`void_cloud_events` each carry a `BEFORE UPDATE OR DELETE` trigger that raises
`VOID ledger is append only`, and the backfill is an `UPDATE` on both. The
migration therefore disables those two triggers, updates, and re-enables them
inside one transaction. `ALTER TABLE ... DISABLE TRIGGER` is itself
transactional, so a failure anywhere in the file rolls the trigger back to
enabled and nothing outside that transaction ever runs with it off. The primary
key swap does not need the trigger lifted at all, because adding a constraint
builds an index and an index build is not a row update; it is disabled across
that step anyway so no step can surprise the next.

The last step is a one-time `INSERT`, not an `UPDATE`, so it never needed the
trigger lifted. It recovers GUI events that only exist inside pre-existing
session documents, takes the owner from the row the event came from, and runs
after the keys are in place so every row it writes already carries an owner.

Steps 4 and 5 take `ACCESS EXCLUSIVE` and build a unique index per table. On a
beta sized table that is short, but it is a lock: run it once, in a quiet
moment, with the deploy paused.

## What must be true before signup is enabled

Signup is off because `VOID_ACCOUNT_SIGNUP` is not set, and that variable is
the only thing standing between the beta and public registration. The gate in
`docs/APPWRITE-AUTH.md` is what it may not be turned on against. Of its four
conditions:

1. **Done, and enforced by a test rather than by review.** Every statement
   carries an owner, `cloud/owner.test.mjs` parses them, and a statement that
   cannot be scoped was deleted rather than left shared.
2. **Proved at the HTTP boundary against real rows.**
   `cloud/account-isolation.test.mjs` sends requests as two provider confirmed
   users against a disposable PostgreSQL and verifies separate session pages,
   events, ledger pages and preference writes, and that a cross owner session
   edit returns 404 without changing the other account's row. It is one of the
   five SQL scenarios `check-cloud-integration.mjs` runs and fails on a skip.
   The repository does not commit a captured run of that gate, so no claim is
   made here about a particular run having passed; what is verifiable from the
   tree is that the suite exists, is wired into the gate, and is run by
   `.github/workflows/cloud-integration.yml` against a job scoped PostgreSQL 17.
3. **Done, as a decision.** The operator is a distinct scoped role with no
   implicit access to anybody's rows, as described above.
4. **Done, as a decision.** The demo namespace is owned.

Two further conditions are not in that list and have to hold anyway:

- **A Supabase project exists.** With no `SUPABASE_URL`, `SUPABASE_ANON_KEY`
  and `VOID_ACCOUNT_SEAL_KEY` set, `accounts.isConfigured()` is false, the
  account routes report themselves unconfigured, and every request has to
  present the control token. Nothing has been signed in against a real identity
  provider, so the sealed cookie path and the provider round trip have not been
  proven against Supabase itself.
- **The Prime bridge is either given a per owner credential or refused to
  accounts.** It authenticates with a machine token and is bound to the
  operator's namespace, and `POST /api/sessions` refuses `prime-agent` for any
  owner that is not the operator. That is a deliberate refusal rather than a
  queued run no worker may claim.

Two things are true of the migration and are not claimed here. It has not been
recorded in this repository as applied to the live beta database, and no
captured output of a run against a real PostgreSQL 17 instance is committed, so
the claim that it was verified against a 17.11 instance is unverified from the
tree. `cloud/owner.test.mjs` proves the shape of the file, its conditional
steps and the trigger ordering, and the CI workflow provisions a PostgreSQL 17
service, but neither is a record of a completed run against the beta.

The owner is threaded through the workflow as a durable argument rather than
re-derived inside a step: `cloud/workflow.mjs` takes the owner the launching
request was verified to be and passes it to every `advance` and `fail` call, so
a step that resumes an hour later reads the same rows it was authorised to read
when it began. The recovery routes refuse a request with no owner before they
plan anything, because a recovery plan is a write against somebody's session.

## What this does not do

It does not make the local product multi user. VOID still runs on the
operator's machine, still talks to it over loopback, and still authenticates
with `VOID_CONTROL_TOKEN`. It does not give anybody a hosted VOID, and the
marketing site's copy says so on purpose.

It does not store a password anywhere in this database, and it will not: the
identity, including its hash, belongs to the provider.
