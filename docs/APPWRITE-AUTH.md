# Appwrite hosted web auth

`cloud/appwrite.mjs` is a manual provisioner. It reads Appwrite values only
from `.env.local` or the process environment. It verifies the existing
`void_control_plane` TablesDB, creates the empty-permission `void_documents`
bucket, named `NOMO Documents`, creates only these web platforms:

- `void_web`, named `NOMO Production`, for `https://void-tui.vercel.app`
- `void_local_web`, named `NOMO Local Development`, for `http://localhost`

and creates the hosted NOMO MCP function described below.

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
- `NOMO_AUTH_SEAL_KEY`, 32 random bytes as 64 hexadecimal characters
- `NOMO_PUBLIC_ORIGIN`, exact HTTPS public origin

The elevated provision key is only for the manual provisioner. Do not add it
to runtime or deployment configuration. Run `node cloud/appwrite.mjs` only
against a disposable project until a human reviews the manifest. Do not put
any value in source, test data, logs, browser storage, URLs, or commits.

## Provisioning limits and approval gate

The provisioner checks that the supplied `APPWRITE_PROJECT_ID` contains the
supplied `APPWRITE_DATABASE_ID`. It does not pin the project ID or region to an
approved target. If resources are missing, it creates the declared bucket, the
selected platforms, and the hosted MCP function. It does not create or verify
tables inside the database, copy rows, files, or sessions, or define a data
migration. It has no automatic rollback for a partially completed additive run.

The manifest labels `https://void-tui.vercel.app` as production. The current
chat origin defaults to `https://chat.voidagent.tech` in `cloud/account.mjs`.
Reconcile the origin before provisioning.

Before any run, record and verify the endpoint and region, project ID, existing
database and table schema, exact resources and origins to create, and a rollback
procedure. Do not run against a shared or production project until a human
approves that exact target and scope. This script does not perform a production
cutover.

## Hosted MCP function

`cloud/appwrite.mjs` also declares the hosted NOMO reference MCP, function id
`6abbae3e000f6f24ce2a`, named `MCP server`. It runs Python 3.14 with
entrypoint `src/main.py` under root directory `apps/appwrite-mcp`, build
command `pip install -r requirements.txt`, a 30 second timeout, and execution
permission for `any` with no API scopes. The function exists on the live
project, its latest deployment built successfully, and it reads
`MCP_SERVER_NAME`, `MCP_AUTH_MODE`, `MCP_AUTH_TOKEN`, and `MCP_TOOL_TIMEOUT`,
whose values are the operator's to set and are never written here.

It serves public NOMO project information and the catalogue of local recovery
tools, read only. It holds no credential and performs no writes, and it serves
no repository file. The provisioner creates the function when it is absent and
refuses a project whose existing function disagrees with the manifest, naming
the field. A deployment id changes on every redeployment and is not compared.

The database tables and the `void_documents` bucket are provisioned, and every
table is empty. The account route on the live deployment answers that the
account feature is not configured, because the broker has no Supabase
credentials, so no part of this Appwrite project serves a user yet.

One console action is still missing: the function has no public domain, so it
has no URL and nothing is reachable at it. A person has to register one in the
Appwrite console, under the project's `Functions`, on `MCP server`, in its
`Domains` tab. The domain routes answer the project service key this
repository holds with `general_access_forbidden`, and the console-scoped
credential that could add one is deliberately not held here, so the
provisioner reports the missing domain instead of failing on it. The endpoint
is not live and must not be described as live until that domain exists and
answers an MCP `initialize` and a `tools/list` over it. The elevated provision
key stays out of runtime and deployment configuration, which includes this
function.

The endpoint's own code path is covered offline, by a suite that runs the
real adapter against a fake Appwrite function context. It lives at
`apps/appwrite-mcp/tests` and runs under
`python -m unittest discover -s apps/appwrite-mcp/tests -t apps/appwrite-mcp`.
That needs an interpreter with the `mcp` SDK importable, and the system
interpreter does not have it: `mcp` is a build requirement of the function,
not a test-only dependency, so an ordinary developer cannot run this suite
from the workspace as it stands. Create a virtual environment outside the
repository, install the function's requirements into it, and run the suite
with that interpreter:

```bash
python3 -m venv /tmp/nomo-mcp-venv
/tmp/nomo-mcp-venv/bin/python -m pip install \
  -r apps/appwrite-mcp/requirements.txt
/tmp/nomo-mcp-venv/bin/python -m unittest discover \
  -s apps/appwrite-mcp/tests -t apps/appwrite-mcp
```

`scripts/src/check-tests.mjs` now runs both Python suites. It looks for an
interpreter that can import what each suite needs, tries `NOMO_PYTHON`, then
`/tmp/nomo-mcp-venv/bin/python`, then the system `python3`, and reports which
one it used. A suite that runs appears in the summary with its passing count,
and a suite that cannot run is reported as `UNRUN` with the interpreters it
tried and the commands to run it, and is excluded from the total rather than
counted as a pass. The summary line reads `N suites, M tests, K could not run`
whenever anything was skipped, so a quoted test count cannot silently include
a suite nobody executed.

`python/nomo-transport` runs under the system interpreter with no SDK, so it
executes on an ordinary checkout. `apps/appwrite-mcp` needs the `mcp` SDK and
is `UNRUN` until the virtual environment above exists; on a machine without
it, that suite is a named warning and does not fail the gate, because the SDK
is a build requirement of the hosted function rather than a test dependency.
Both suites are verified locally only. The former hosted workflow was removed; no hosted job is required for acceptance. Local results do not certify a clean-machine or deployment run.

`cloud/auth.mjs` provides server-only signup, email-password login, logout,
account lookup, and password recovery helpers. Its `__Host-void-auth` cookie
contains an encrypted and authenticated local session ID and expiry. It
contains neither an Appwrite API key nor an Appwrite session secret. The caller
must provide an atomic create-if-absent server session store. `create` must
return the created record, and `read` must return validated `id`, `userId`,
`secret`, expiry, and revocation fields. The recovery helper ignores caller
URLs and derives `/reset-password` from `NOMO_PUBLIC_ORIGIN`.

This is not what the deployment uses. The live identity path for the chat
origin is `cloud/account.mjs`, which talks to Supabase Auth, and it is wired
into the middleware in `cloud/server.mjs` and behind three routes of its own.
`cloud/auth.mjs` is still unmounted, with `cloud/auth.test.mjs` as its only
importer, so nothing in the deployment reaches Appwrite at runtime. A reader
who arrives here from a question about accounts in the chat origin wants
`cloud/account.mjs`; a reader who wants the Appwrite option kept on paper is
reading the right section.

## Data migration status

The current cloud data model is the owner-scoped PostgreSQL schema in
`cloud/schema.sql`:

| PostgreSQL table | Primary key | Payload |
| --- | --- | --- |
| `void_cloud_state` | `(owner, key)` | `document` JSONB |
| `void_cloud_ledger` | `(owner, workspace, seq)` | `entry` JSONB |
| `void_cloud_events` | `(owner, session_id, seq)` | `event` JSONB |

A read-only metadata audit of the existing Appwrite TablesDB
`void_control_plane` found these tables:

| Appwrite table | Metadata fields |
| --- | --- |
| `profiles` | `user_id`, `display_name`, `email` |
| `workspaces` | `name`, `owner_id` |
| `workspace_members` | `workspace_id`, `user_id`, `role` |
| `user_preferences` | `user_id`, `locale`, `theme` |
| `appwrite_links` | `workspace_id`, `postgres_workspace`, `document_bucket` |

The audit read schema metadata only. It did not read table rows, file contents,
sessions, or keys. The two data models do not define a one-to-one migration
mapping. Account-owned rows use the verified Supabase user ID. Legacy rows and the
public demo use the reserved owners `operator` and `public-demo`. Appwrite
`userId` has no approved mapping to an owner. Do not infer identity from email
or copy JSONB payloads into normalized tables without an approved mapping.

No Appwrite data migration or rollback implementation exists. Source, target,
entity scope, identity mapping, and rollback require explicit approval before a
migration plan can become executable. Keep staging validation separate from
any production cutover.

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
`NOMO_ACCOUNT_SIGNUP`, which is not set. Two things are still missing. A real
Supabase project: without `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
`NOMO_ACCOUNT_SEAL_KEY` the broker is unconfigured, the account routes say so,
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
will not sign anybody up while `NOMO_ACCOUNT_SIGNUP` is unset. The one
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
