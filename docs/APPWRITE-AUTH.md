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

## Required before public signup

Public signup must remain disabled until all cloud reads and writes are scoped
by verified authenticated owner identity. Existing cloud routes currently use
shared state and are not safe for multiple owners. The TUI must also gain
explicit account commands and authenticated error handling before it exposes
these helpers. Add durable server-side session storage with encrypted Appwrite
session secrets, rate limits, and endpoint integration tests before mounting
public auth routes.
