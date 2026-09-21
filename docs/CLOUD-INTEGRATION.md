# Cloud integration gate

`cloud integration / isolated-postgres` runs on main pushes, pull requests,
release-candidate tags and manual dispatch. It starts a job-scoped PostgreSQL 17
service and a pinned Neon WebSocket proxy, then executes the existing GUI and
recovery SQL suites, the deterministic managed-cloud HTTP/provider flow and the
managed PostgreSQL verifier. The verifier includes client SIGKILL after forward
and recovery COMMIT. It uses the production Neon driver and schema, with no paid
model or Neon account. Credentials and signing/encryption keys are disposable.

Run `node scripts/src/check-cloud-integration.mjs` with
`VOID_TEST_DATABASE_ISOLATED=1` and `VOID_TEST_DATABASE_URL` pointing to
`postgresql://void_test:<test-password>@127.0.0.1:5432/void_gui_upgrade_preview`.
The proxy listens at `127.0.0.1:5433/v1` by default and allows only
`127.0.0.1:5432`. A local port conflict may use `VOID_TEST_WS_PROXY` with an
explicit `127.0.0.1:<port>/v1` value. Remote proxy hosts and other paths are
rejected. The workflow contains the complete provisioning recipe. Never point this gate
at a persistent database: test ledger rows intentionally remain append-only.
The disposable service container is removed by GitHub on success or failure.

Configuration validation precedes schema mutation and rejects missing isolation,
remote hosts, other database names/users, URL options and a differing application
DATABASE_URL. Both named scenarios must pass with zero skips; subprocess errors,
timeouts and assertion failures fail the job. Output redacts generated secrets.
The managed-cloud fixture supplies its own local provider and checks auth,
confirmation, signed captures, refusal paths and restart-safe state.

This gate does not establish deployed Neon/Vercel networking, real-provider
availability or physical-device behavior. Existing isolated-Neon manual checks
remain useful for those deployment-specific boundaries.
