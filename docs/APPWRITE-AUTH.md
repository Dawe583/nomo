# Appwrite hosted web auth

`cloud/appwrite.mjs` is a manual provisioner. It reads Appwrite values only
from `.env.local` or the process environment. It verifies the existing
`void_control_plane` TablesDB, creates the empty-permission `void_documents` bucket, named `VOID Documents`, and creates only these web platforms:

- `void_web`, named `VOID Production`, for `https://void-tui.vercel.app`
- `void_local_web`, named `VOID Local Development`, for `http://localhost`

`APPWRITE_WEB_ORIGINS` can select only those exact origins. The localhost
exception is limited to that configured web platform. The Appwrite endpoint is
always HTTPS, so no server credential travels over HTTP.

Required local provisioner variables:

- `APPWRITE_ENDPOINT`
- `APPWRITE_PROJECT_ID`
- `APPWRITE_PROVISION_KEY`
- `APPWRITE_DATABASE_ID`, optional and defaults to `void_control_plane`
- `APPWRITE_WEB_ORIGINS`, optional exact manifest origins

Required runtime variables:

- `APPWRITE_ENDPOINT`
- `APPWRITE_PROJECT_ID`
- `APPWRITE_RUNTIME_KEY`
- `VOID_AUTH_SEAL_KEY`, 32 random bytes as 64 hexadecimal characters
- `VOID_PUBLIC_ORIGIN`, exact HTTPS public origin

The elevated provision key is only for the manual provisioner. Do not add it
to runtime or deployment configuration. Run `node cloud/appwrite.mjs` only
against a disposable project until a human reviews the manifest. Do not put
any value in source, test data, logs, browser storage, URLs, or commits.

`cloud/auth.mjs` provides server-only signup, email-password login, logout,
account lookup, and password recovery helpers. Its `__Host-void-auth` cookie
contains an encrypted and authenticated local session ID and expiry. It
contains neither an Appwrite API key nor an Appwrite session secret. The caller
must provide an atomic create-if-absent server session store. `create` must
return the created record, and `read` must return validated `id`, `userId`,
`secret`, expiry, and revocation fields. The recovery helper ignores caller
URLs and derives `/reset-password` from `VOID_PUBLIC_ORIGIN`.

The deployment does not use it. The identity provider for the chat origin is
Supabase Auth, reached only from `cloud/account.mjs`, and `cloud/auth.mjs`
remains unmounted with its own test as its only importer. Choosing one provider
over the other is a decision the operator has not yet made, and the material
below is kept because it records what the other option would need.

## Required before public signup

Public signup must remain disabled until all cloud reads and writes are scoped
by verified authenticated owner identity. That condition is now met and is
enforced rather than reviewed: every table carries an owner, the owner is the
first column of every primary key, the owner is the first parameter of every
store function, and `cloud/owner.test.mjs` parses every statement under
`cloud/` and fails if one has no owner. What is still missing is the rest: a
Supabase project to sign in against, an endpoint suite that proves two accounts
cannot reach each other's rows against an isolated database, and a decision
about the Prime bridge, which is a machine credential bound to the operator's
namespace and is refused to accounts for now. `docs/ACCOUNT-OWNERSHIP.md`
carries the list and the reasoning. Signup stays off, and the switch that
would turn it on is `VOID_ACCOUNT_SIGNUP`.

## Account deletion

There is no account-deletion route, because no account can be created through
any mounted route. No route on the chat origin creates one: `cloud/auth.mjs` is
not imported by any application, its only importer is `cloud/auth.test.mjs`,
and the mounted broker refuses to sign anybody up while `VOID_ACCOUNT_SIGNUP`
is unset. Its signup, login, logout, account lookup and password recovery
helpers are therefore not reachable from `cloud/server.mjs`, `cloud/demo.mjs` or
`cloud/prime.mjs`.

Neither module has a deletion method of its own. `createAuth` exposes exactly
signup, login, logout, account lookup and password recovery, and the one
`DELETE` it issues is against the current session during logout, which ends a
session and does not remove an account. `cloud/schema.sql` defines three
tables and none of them holds an account, so there is no local account record
to remove either.

Mounting account creation is what makes account deletion real work, and it
becomes real work at that moment rather than later. There is no deletion method
to hang a route on, so one has to be added first, and it has to remove that
account's own rows and not only the provider account. The cloud tables are now
scoped by owner, so that removal is scoped too; see
`docs/ACCOUNT-OWNERSHIP.md`. Until the prerequisites above are met, an
account-deletion route would protect nothing, which is why this is recorded as
a statement rather than left as an open task.
