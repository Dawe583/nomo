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

This is not what the deployment uses. The live identity path for the chat
origin is `cloud/account.mjs`, which talks to Supabase Auth, and it is wired
into the middleware in `cloud/server.mjs` and behind three routes of its own.
`cloud/auth.mjs` is still unmounted, with `cloud/auth.test.mjs` as its only
importer, so nothing in the deployment reaches Appwrite at runtime. A reader
who arrives here from a question about accounts in the chat origin wants
`cloud/account.mjs`; a reader who wants the Appwrite option kept on paper is
reading the right section.

## Required before public signup

Public signup must remain disabled until all cloud reads and writes are scoped
by verified authenticated owner identity. **That rule has been satisfied for
the cloud data layer.** Every table carries an owner, the owner is the first
column of every primary key, the owner is the first parameter of every store
function, and `cloud/owner.test.mjs` parses every statement under `cloud/` and
fails if one has no owner. `cloud/account-isolation.test.mjs` then proves the
same property at the HTTP boundary against a real database, as two
provider confirmed users.

Signup is nevertheless off, and the switch that would turn it on is
`VOID_ACCOUNT_SIGNUP`, which is not set. Two things are still missing. A real
Supabase project: without `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
`VOID_ACCOUNT_SEAL_KEY` the broker is unconfigured, the account routes say so,
and no sign in has ever been confirmed against a real provider. And a decision
about the Prime bridge, which is a machine credential bound to the operator's
namespace and is refused to accounts for now. Setting the variable on its own
would not open registration either, because a signup additionally requires an
invitation code and no mounted route accepts one. The full list and the
reasoning are in `docs/ACCOUNT-OWNERSHIP.md`.

## Account deletion

There is still no account deletion route, and there is still nothing to delete:
no mounted route creates an account. `cloud/auth.mjs` is not imported by any
application, its only importer is `cloud/auth.test.mjs`, and the live broker
will not sign anybody up while `VOID_ACCOUNT_SIGNUP` is unset. The one
deletion it can perform is a session revocation, not an account removal.

That said, the reason this section exists has changed. The claim it used to
rest on, that no person can hold an account here at all, is no longer safe: a
person whose account exists at the provider can sign in over
`POST /api/account/signin` and own rows, and nothing in this database records
that they did. Account deletion becomes real work the moment a real provider
account signs in, not the moment account creation is mounted, and the work is
the same either way: there is no deletion method to hang a route on, so one has
to be added, and it has to remove that account's own rows and not only the
provider account. The cloud tables are scoped by owner, so that removal is
scoped too. Until a real account can sign in, an account deletion route would
protect nothing, which is why this is recorded as a statement rather than left
as an open task.
