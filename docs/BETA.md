# VOID 0.1 beta

Current capability summary (14 September 2026):

| Surface | Supported recovery | Boundary |
| --- | --- | --- |
| Managed documents | Captured, signed Undo with explicit confirmation | Managed storage only; drift and missing/modified evidence are refused |
| Managed PostgreSQL | One configured row identified by primary key | Requires the revision trigger and managed adapter contract |
| Managed filesystem | Cooperative single-file recovery | No arbitrary directory or cross-process transaction guarantee |
| Legacy PostgreSQL/S3 connectors | Guarded replay of captured operations | Host capture required; S3 writes a new version |
| Arbitrary remote MCP tools | Policy and execution evidence | No automatic inverse without a capture integration |
| Cross-system time rewind | Planned | Illustrations are not a shipped universal recovery feature |

See [recovery coverage](RECOVERY-COVERAGE.md) for exact adapter requirements.
The [public demo](https://void-tui.vercel.app/) operates only on isolated demo
documents, with no access to the visitor's computer or connected accounts.

## Desktop and web workspace

The shared agent application includes provider presets (compatible-provider APIs
and native Anthropic), model search, reusable encrypted provider connections,
multiple HTTP MCP connectors, persistent conversation history, export, approval
links and a built-in managed document workspace. GUI, desktop and CLI use the
same local agent implementation; Vercel runs durable cloud agent turns.

Start locally with Node.js 24 or newer, `pnpm install --frozen-lockfile`, then
`pnpm gui`. No MCP command or policy environment variable is needed for the
built-in documents. Open Settings, connect a provider and select a model. Local
Ollama and LM Studio endpoints work from the desktop/local app. The hosted app
requires a publicly accessible HTTPS provider and cannot reach your localhost.

For the native macOS application use `pnpm desktop:setup`, `pnpm desktop`, or
`pnpm desktop:build`. The package includes Node and the backend. See
[desktop packaging](../apps/desktop/README.md) for artifacts, native smoke checks,
Keychain migration and signing requirements. macOS 13.5 or newer is required.

Local sessions, provider profiles, connector credentials, documents and signed
history persist in an atomic AES-256-GCM snapshot under `VOID_DATA_DIR` (default
`~/.void/workbench`). The desktop keeps its encryption key in macOS Keychain;
standalone CLI/GUI uses a mode-0600 key file. A conflicting writer is rejected.

The document connector automatically captures before and after content. Every
mutation and its signed evidence commit together. Open Documents & Undo, preview
the restored content and explicitly confirm. Signatures and the complete capture
digest are verified before undo. Newer changes, already-undone operations and
modified captures are refused. Limits are 100 documents, 256 KB per document,
2 MB total and 250 mutations, with another 250 history slots reserved for undo.
Documents are managed storage, not arbitrary files on the host computer.

Add external HTTP MCP servers in Settings. VOID discovers their tools and applies
the configured policy and registry mapping. Unknown tools fail closed. External
MCP has no automatic inverse unless a specific capture integration exists. A
legacy stdio upstream can still be supplied with `VOID_UPSTREAM_COMMAND` (JSON
array), `VOID_POLICY_PATH`, optional `VOID_FACTS_PATH` and `VOID_LEDGER_DIR`.
`OPENROUTER_API_KEY` and `VOID_PROVIDER_URL` remain optional bootstrap settings.
The provider catalog validates before a session starts. Live generation also
requires provider authorization, model access and an available balance.

For terminal agents run `node packages/cli/bin/void.mjs agent --model <id>`.
For the live operator interface run `node packages/cli/bin/void.mjs watch` with
its ledger options. Press `h` for holds, select with arrows, then `a` or `d` and
`y` to confirm. Noninteractive agent execution denies holds.

## Web deployment on Vercel

The web application and backend run in the existing `void-tui` Vercel project,
team `sitespot`. No Mac, Raspberry Pi or separate VOID server is required.
Nitro builds the HTTP API into Vercel Functions. Vercel Workflow runs agent
turns and durable approval waits. Neon, provisioned through Vercel Marketplace,
stores sessions, transcripts, configuration and the signed ledger.

The `void` project is the separate reference landing site and is untouched.

Server environment variables:

- `DATABASE_URL`: supplied by the Neon integration.
- `VOID_CONTROL_TOKEN`: single-operator access token, at least 32 characters.
- `VOID_SECRET_KEY`: 32 random bytes, base64, for AES-256-GCM secret encryption.
- `VOID_SIGNING_KEY`: Ed25519 PKCS8 DER, base64, stable across deployments.
- Optional `AI_GATEWAY_API_KEY`: otherwise Vercel OIDC authenticates AI Gateway.

`node --env-file=.env.local scripts/src/provision-cloud.mjs` installs the schema
and sets the server secrets using Vercel environment management. Its local secret
files are ignored and private. The operator access token is in `.env.void-access`;
never share the signing or encryption keys. Enter the access token in the web
connection form. Authentication uses Secure, HttpOnly, SameSiteStrict cookies.
This beta is a single-operator workspace, not a multiuser RBAC product.

New conversations default to NVIDIA NIM / GLM 5.3 Flash
(`z-ai/glm-5.3-flash`). Existing conversations retain their saved provider and
model. The NVIDIA hosted API may expose an account-scoped trial/free quota; this
is not a promise of unlimited free usage. Add `NVIDIA_API_KEY` through Provider
settings or the local runtime environment. A model catalog can be available
before the account is authorized to generate. Custom keys and tool-server
credentials are encrypted before database storage. Prompts and tool results are
sent to the selected provider.

Connect an HTTPS MCP server in Tool server and policy. It is the system the
agent operates on, not an external VOID runtime. Without tools, sessions support
chat only. Tool names can map explicitly to VOID registry IDs; unknown or
unclassified tools are denied. Target facts are operator declarations, never
invented measurements. Policy changes apply to new sessions.

One model session runs at a time, bounded to 20 model turns per message and 32
tools per batch. Session lists and retained history use server pagination.
The session record caches 200 events; the separate append-only event table
retains history for paging and export. Approvals survive function restarts. A dispatched tool is
never retried after an ambiguous interruption. Cancellation stops further calls;
an already dispatched mutation may finish and is recorded. Signed ledger rows
are protected from updates/deletes by a database trigger and verified on read.

Cloud API records actual `execute:completed` / `execute:failed` outcomes in
addition to authorization. Arbitrary remote MCP servers do not provide before
images, so their replay action explicitly refuses an uncaptured inverse. Local
connector replay remains available as described below.

## Replay boundaries

Postgres replay uses `VOID_PG_URL`, a serializable transaction, drift checks and
parent-before-child restoration. The cascade walker follows real foreign keys,
including nested and composite references; cycles are refused. S3 replay uses
`VOID_S3_ENABLED=1`, standard AWS credentials and `AWS_REGION`; an optional
`VOID_S3_ENDPOINT` supports compatible hosts. Conditional writes refuse races.
S3 restoration writes a new version and does not reverse object history.

A host must capture snapshots and produce a manifest through the connector API.
Automatic snapshot capture is not wired into arbitrary MCP upstreams. Legacy
CLI apply requires a trusted public key and a signed `execute:completed` entry
whose `captureDigest` matches the manifest capture. Ambiguous matches are refused.
Preview first and restrict snapshot write access. Snapshots are content checked
and written with private file permissions. GUI apply requires explicit
confirmation and signed-ledger validation. See [manifest durability](MANIFEST-DURABILITY.md)
for filesystem persistence guarantees, including the Windows power-loss limitation.

An `allow:resolved` ledger event records authorization, not proof that an upstream
mutation completed successfully. Taint edges describe recorded dependencies,
not a demonstrated causal effect in the external system.

## Review and evidence, 2026-09-11

Review covered registry, ledger, policy, proxy, SDK, connectors, CLI, browser API
and the new workbench. Fixes include missing CLI command handlers, standalone GUI
approval wiring, session hold workspace identity, recursive Postgres capture and
restore ordering, S3 captures surviving restart, conditional S3 writes, private
snapshot permissions, and authenticated remote API forwarding.

Verification includes the full `pnpm check` (487 tests passing), whole-product approval arc, final
stdio/HTTP product sweep and connector replay sweep. PostgreSQL cascade behavior
also runs on PGlite's actual SQL engine with foreign-key constraints and unrelated
rows. Browser QA covers 320, 375, 390, 430, 768 and 1280 pixel widths, both themes,
a real SDK session behind an explicitly labeled local model test double, signed
ledger detail, dependency tracing and unavailable snapshot refusal. The cloud safety sweep additionally uses the real provisioned Neon database and
disposable HTTP tool/provider services. Both approval outcomes, immutable signed
rows and interruption refusal pass. Vercel Workflow dispatch was exercised on
deployed Vercel Functions; live generation encountered Gateway account verification.
It does not claim a completed paid-model run or validation of customer buckets.

## Remaining roadmap

This is not completion of every work package in the master plan. Native Codex,
Claude Code and OpenCode process adapters, PTY embedding, direct host-project
editing, product multi-agent orchestration and production KMS
remain open. Desktop signing/notarization requires a paid Apple Developer
identity (Developer ID, hardened runtime, `notarytool`; free accounts cannot
notarize); the local build is ad-hoc signed only, which is bundle integrity,
not Apple notarization (see `docs/RELEASE.md` blocker 8). Token streaming is implemented; see
[GUI delivery evidence](GUI-UPGRADE-DELIVERY.md). Windows beta 4 packaging and
installed WebView smoke passed on 14 September 2026, as recorded in
[Windows desktop verification](WINDOWS-DESKTOP.md). Linux native packaging (`deb`, `rpm`, `AppImage`) and the installed-app
smoke check remain unverified (see `docs/RELEASE.md` blocker 9). Physical
mobile keyboards, VoiceOver/TalkBack and true 200% browser zoom acceptance
remain pending; the 640x450 reflow check is explicitly not a zoom test;
see [the acceptance matrix](MOBILE-ACCESSIBILITY-ACCEPTANCE.md) and
`docs/RELEASE.md` blocker 10.
Only one model session runs at a time. Speculative execution is not supported.

## Desktop and managed-workspace verification

`pnpm check` passes all 500 shared-runtime tests. The added default-agent integration test
runs a real built-in tool through a deterministic provider, restarts twice,
verifies encrypted persistence and Ed25519 capture binding, rejects a forged
capture, and applies an explicit inverse. The Anthropic adapter test covers
native tool_use/tool_result conversion and usage accounting.

`check-managed-cloud.mjs` ran successfully against a newly created disposable
Neon database, then that database was removed. It exercised real HTTP cloud
routes, two model turns, signed encrypted capture, authentication, confirmation,
drift and forgery refusal, and idempotent undo. Production data was untouched.
For repeat runs supply `VOID_TEST_DATABASE_URL` and
`VOID_TEST_DATABASE_ISOLATED=1`; the script refuses the deployment database by
default. No real paid model was used by this deterministic integration test.

Browser QA exercised create, captured history, preview and explicit Undo, with
no horizontal overflow at 320, 375, 430, 768 and 1280 pixels. Provider and
connector settings were inspected on mobile, in both shared themes. Desktop
verification includes Rust Keychain migration tests, source and bundled backend
lifecycle checks, and the packaged native executable's `--smoke-test`.
