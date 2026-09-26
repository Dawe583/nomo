# Account ownership for the cloud

**Status: design, not implemented. Nothing in this document has been built.**

This is the plan for making `cloud.voidagent.tech` multi-tenant, so that an
account created on the marketing site sees only its own data. It exists because
`docs/APPWRITE-AUTH.md` forbids enabling public signup until every cloud read
and write is scoped by a verified owner, and that gate is the whole reason this
document was written rather than the code.

Read this before writing any of it. The refactor touches every query in the
cloud data layer, and a query that forgets its owner predicate is a cross
account read that no test in this repository would notice.

## What the data looks like today

Three tables, in `cloud/schema.sql`, and none of them has an owner:

| table | key today | written by |
| --- | --- | --- |
| `void_cloud_state` | `key`, which is `session:<id>`, `workspace:<id>` or `hold:<id>` | `cloud/store.mjs`, `cloud/demo.mjs` |
| `void_cloud_ledger` | `(workspace, seq)` | `cloud/store.mjs` `append` |
| `void_cloud_events` | `(session_id, seq)` | `cloud/store.mjs` `event` |

Seventeen statements read or write them, spread across `cloud/store.mjs` (fourteen),
`cloud/server.mjs` (two), `cloud/prime.mjs` (one) and three test files. There is
no other writer. In particular there is no bridge from the local control plane
into this database: the hosted web UI is the only thing that writes here, so
scoping the rows by account does not change what the local product does on a
visitor's own machine, and the local path keeps its `VOID_CONTROL_TOKEN` and its
loopback.

That fact is the reason this is tractable. If a local process pushed state here,
an account would have to be involved in a push it knows nothing about, and the
shape of the product would have to change first.

## The shape of the change

An `owner` column on all three tables, holding the provider's user id, and every
statement gains a predicate on it.

- `void_cloud_state`: add `owner text`, and change the key to `(owner, key)`.
  The two partial indexes on `void_cloud_state` already filter `key LIKE
  'session:%'` and are unaffected by an added column, but the primary key change
  is a rewrite of the table, so this is the one migration that needs a window.
- `void_cloud_ledger`: add `owner text` and move the primary key to
  `(owner, workspace, seq)`. The append only trigger stays as it is; it is about
  immutability, not identity.
- `void_cloud_events`: add `owner text` and move the primary key to
  `(owner, session_id, seq)`. Same trigger argument.

The owner value is never read from a request. It comes from the verified session
and nowhere else, and the rule that makes this reviewable is simple: **if you
cannot name the line that produces the owner, the statement does not get written.**
A header, a query parameter or a body field is not a source.

## Where the owner comes from

A new authenticated request carries two things: the `__Host-void-user` cookie
this repository already knows how to seal (`cloud/auth.mjs` does exactly this,
with `node:crypto` and no dependency), and the session it names. The middleware
resolves that cookie into an owner id before any route runs, and stores it on the
request. Routes read `req.owner`. A route that needs a session and has no owner
refuses, rather than falling back to a shared workspace.

`cloud/auth.mjs` is Appwrite backed and is currently imported by nothing but its
own test. Two honest options, and the choice is not yet made:

1. **Mount it** and keep Appwrite as this deployment's identity provider. The
   module, its sealed cookie and its tests already exist, so this is the smaller
   change, and it contradicts nothing in this repository.
2. **Replace it with Supabase Auth**, which is what the marketing site's accounts
   use, so one person has one account across both origins. That is a larger
   change: a new broker, and the module that exists is deleted rather than
   adapted.

Option 2 is the one the product wants, because a person who registers on the
marketing site and signs in at the chat origin should be the same person. Option 1
is the one that ships sooner. This is a decision for the operator, not for an
implementer.

## What must be true before signup is enabled

The gate in `docs/APPWRITE-AUTH.md` stands until all of these hold, and each one
is checkable:

1. Every statement in the list above carries an owner predicate, and a statement
   that cannot be scoped is deleted rather than left shared.
2. Two accounts exist in a test database, and no read or write issued for one can
   return the other's rows. This is a test, not a review, and it needs an
   isolated database: the suite already gates its database tests behind
   `VOID_GUI_DATABASE_TEST=1` and refuses to run them otherwise.
3. The operator's own access keeps working. That is a decision, not an
   assumption: either the operator is an account like anybody else and sees one
   workspace, or the operator gets a distinct scoped role with no implicit access
   to anybody's rows. There is no third option where a token reads everything,
   because that is the hole this document exists to close.
4. The demo namespace, which is mounted before the auth middleware today
   (`cloud/server.mjs` mounts it at line 78 and the gate at 85), is either moved
   behind the owner or explicitly documented as public shared state. It is
   currently reachable with no credential, and scoping everything else while
   leaving that open is the kind of half measure that reads as done.

## The order, because it is the only order that is safe

1. Add the column and the new primary keys, nullable, with no behaviour change.
2. Backfill every existing row to one owner, the operator's.
3. Add the owner to the session middleware and resolve it per request.
4. Add the predicate to every statement, one at a time, each with a test.
5. Only then enable an account on the chat origin.

Step 4 is the one that will take the longest and the one where a mistake is
silent. The mitigation is mechanical rather than clever: make the owner predicate
part of the signature of the store functions, so a statement that forgets it
does not compile.

## What this does not do

It does not make the local product multi user. VOID still runs on the
operator's machine, still talks to it over loopback, and still authenticates with
`VOID_CONTROL_TOKEN`. It does not give anybody a hosted VOID, and the marketing
site's copy says so on purpose.

It does not store a password anywhere in this database, and it will not: the
identity, including its hash, belongs to the provider.
