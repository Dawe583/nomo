# NOMO 0.1 beta

> New here? Start with [the NOMO handbook](HANDBOOK.md), or its
> [Czech edition](HANDBOOK.cs.md). This document is the capability and boundary
> record; the handbook is the operating guide.

**Scope update (2026-10-27):** No desktop application is part of the current
Harness goal. Use the local web interface or CLI from a private source checkout.
Do not run historical desktop build or install steps below. Existing
`apps/desktop` files and historical evidence remain unchanged; they are not part
of the remaining acceptance plan. OpenAI compatibility means outbound provider
connections, not an inbound OpenAI API server.


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

## Installing and updating on a machine

For a fresh install, clone the private repository into the default install tree
and run its installer:

git clone --depth 1 https://github.com/Dawe583/void.git "$HOME/.local/share/nomo-cli" &&
bash "$HOME/.local/share/nomo-cli/scripts/install-nomo.sh"
```

This needs existing Git credentials and repository read access. The installer
reuses this checkout. `bash scripts/install-nomo.sh --help` prints its contract.

What it does, in order:

1. Checks prerequisites: `node` at major version 24 or newer, `git`, and
   `pnpm` (it falls back to enabling corepack when pnpm is absent).
2. Puts the tree at `$NOMO_HOME`, default `$HOME/.local/share/nomo-cli`. It
   clones shallowly only when no tree exists. An existing checkout is reused
   untouched, because fetching new commits is `nomo update`'s job, not the
   installer's. A directory that exists but is not a NOMO checkout is refused.
3. Runs `pnpm install --frozen-lockfile` inside the tree, but only when
   `node_modules` is missing or older than the lockfile.
4. Writes the launcher at `$HOME/.local/bin/nomo`, a small `sh` script that
   execs the CLI entry from `$NOMO_HOME` and passes every argument through. If
   something else already occupies that path, the installer refuses and tells
   you to move it aside; it never overwrites a file it did not write.

The installer does not change your shell profile. Add `$HOME/.local/bin` to
`PATH` yourself and open a new terminal. Run `nomo --help` to check the CLI
launcher without opening the TUI. `NOMO_HOME` is read by both installer and
launcher, so a custom tree needs no script edit.

The repository is private, so a first-run clone needs credentials the machine
already holds: a `gh auth login`, a git credential helper, or an SSH remote.
Verified 2026-10-02: the repository reports `private: true` over the GitHub
API. With no access, `git clone` prints its own refusal and the script stops
there under `set -e`, before the dependency install and before the launcher is
written, so nothing is left half-installed. The exit code on that path is
git's own rather than the installer's documented 1, because `set -e` propagates
whatever `git clone` returned; a caller branching on the installer's documented
codes should treat any nonzero value as failure.

There is no published tarball and no registry entry to install from. Every
workspace manifest is private, which is why the install is a clone plus a
launcher and why `nomo update` is a git move.

Verified 2026-10-02 against a real install in a scratch `HOME`: the install
reported the reused tree, skipped the dependency step as already current,
wrote the launcher, and exited 0; the launcher on PATH answered
`nomo --version` with `void 0.1.0` and reported a missing tree with exit 1. A
foreign file at the launcher path was refused with exit 1 and left byte for
byte as it was.

`nomo update` moves the installed tree onto the branch it tracks. It prints one
`key: value` line per fact (`installed`, `installed-commit`, `tracked-branch`,
`target-commit`) and then a verdict, and it runs the locked dependency install
after the move so the new source is runnable. Three forms:

| Command | Effect |
| --- | --- |
| `nomo update` | Move the tree onto the tracked ref and install dependencies. |
| `nomo update --check` | Report the verdict and move nothing. Exit 3 means an update exists. |
| `nomo update --force` | Permit a move that is not a fast-forward. Nothing else changes. |

What it refuses, and both refusals are deliberate:

- **A tracked file with uncommitted changes stops the update, including under
  `--force`.** No flag is a good enough reason to delete an edit made in the
  install directory.
- **Local commits the tracked branch does not have stop the update** until
  they are given a branch or `--force` is passed. `--force` moves history with
  `git reset --keep`, never `--hard`, so even then it stops at an uncommitted
  file instead of eating it. Untracked files never block a move and are never
  deleted.

A missing tree, a path that is not a git checkout, and a branch with no
upstream are each refused with the command that fixes them. Your ledger,
workspace data and pending approvals live outside the checkout, under
`~/.nomo/ledger`, `~/.nomo/workbench` and `~/.nomo/approvals`, so an update
cannot reach them.

Verified 2026-10-02 on real git trees, driving the shipped command: a tree
already on the tracked ref printed `up to date` and exited 0; a tree one commit
behind fast-forwarded onto the new commit and then reported the dependency
failure with the command to run by hand; a tree with an uncommitted edit was
refused with exit 1 both with and without `--force`, and the edit was still
there afterwards; a tree with a local commit was refused with the reason naming
the commit count, and `--check` reported the same situation as exit 3. With
`--force` on a clean tree that was one commit ahead, the move landed on the
tracked ref and the local commit was gone, while an untracked file beside it
survived. A missing tree and a non-checkout path each exited 1 naming the
installer.

**To roll back**, fetch the history first, because the installer clones with
`--depth 1` and a shallow tree has exactly one commit, so there is nothing to
roll back to until it is deepened. Then name the commit you want, move the tree
onto it, and reinstall dependencies so the older source is runnable again:

```sh
cd "$NOMO_HOME" || cd ~/.local/share/nomo-cli
git fetch --unshallow        # once; a full tree already reports nothing to do
git log --oneline -5
git reset --keep <commit>
pnpm install --frozen-lockfile
```

`--keep` refuses rather than overwrite an uncommitted file, so a rollback
cannot quietly discard local work either. Roll the data directories back from
your own backup: an update never writes them, so it also never restores them.

`nomo update` does not deepen the tree. A plain `git fetch` inside a shallow
clone leaves it shallow, so an operator who has only ever run `nomo update`
still has a single commit and still needs `git fetch --unshallow` before a
rollback is possible. Verified 2026-10-02 on a real install: a `--depth 1`
clone reported `git rev-list --count HEAD` as 1 and could not resolve `HEAD~1`;
after `git fetch --unshallow` the same tree reported 419 commits and
`git reset --keep HEAD~1` succeeded.

## Local web workspace

The local browser interface and CLI share the Workbench provider setup, model
search, encrypted provider connections, HTTP MCP connectors, conversation
history, approvals, and managed document workspace. Vercel runs durable cloud
agent turns.

For a fresh checkout, use Node.js 24 or newer, run
`pnpm install --frozen-lockfile`, then `pnpm gui`. After the source installer,
dependencies are already installed; start the local web interface with
`cd "${NOMO_HOME:-$HOME/.local/share/nomo-cli}" && pnpm gui`. Open Settings and
connect a provider only when needed. Environment provider checks remain
explicit. Local Ollama and LM Studio endpoints work from the local runtime. The
hosted app requires a public HTTPS provider and cannot reach localhost.

No desktop build or desktop install is part of the current beta path.

## Private web and CLI beta tester guide

This repository is private. Testers need repository read access from its owner.
There is no published package or desktop download. The supported test path uses
a source checkout and the local web interface or CLI.

### Supported install prerequisites

- Git access to the private repository, Node.js 24 or newer, and pnpm.
- `scripts/install-nomo.sh` installs the source-based CLI launcher and
  dependencies. It does not install a desktop app.
- To use the local browser interface, run `pnpm gui` from the checkout or
  installed source tree. Add `$HOME/.local/bin` to `PATH` for the CLI launcher.

### Safe first-run checklist

1. Use a fresh OS account or disposable test machine. Do not remove an existing
   NOMO installation or reuse a workspace with real data.
2. Clone the private repository with the command above after the owner grants
   read access; run the source installer.
3. Start the local web interface from the installed source tree with
   `cd "${NOMO_HOME:-$HOME/.local/share/nomo-cli}" && pnpm gui`. Open the local
   URL shown by the server. Do not configure a provider key, sign in, or connect
   an MCP server for the first check.
4. Confirm the local web interface and Settings open, the provider stays
   disconnected, and built-in local documents work.
5. Report only a reproducible, sanitized issue through the private form below.

### Private feedback process

Submit manually through the [private beta feedback issue form](https://github.com/Dawe583/void/issues/new?template=feedback.yml). The repository is private; submitted issues are visible to repository collaborators, and GitHub displays the reporter's account to them. The form does not ask for a name or email. Do not submit if that visibility is unsuitable.

This process adds no analytics, telemetry, automatic upload, diagnostic collection, or feedback server. A tester chooses what to type and submits it to the repository issue tracker. No other feedback address or private channel is documented. If GitHub does not let your role create an issue, do not send feedback or diagnostics elsewhere; request issue access through the same private repository access path that granted your repo access.

The form asks for:

- NOMO version, Node.js version, OS version and architecture, plus whether the
  tester used the local web interface or CLI;
- numbered reproduction steps using built-in local content;
- expected result, actual result, and how often it reproduces;
- an optional safe error category or short manually redacted excerpt.

Before submitting, remove API keys, passwords, OAuth tokens, provider URLs,
prompts, responses, conversation transcripts, project contents, raw logs,
screenshots, filesystem paths, IP addresses, user or device names, email
addresses, and all other personal information. Do not paste a raw log even if
the app produced it. Never add an attachment in a follow-up comment. The issue
template requires confirmation that the content is sanitized and that repository
collaborators can see the issue and GitHub account.

Local sessions, provider profiles, connector credentials, documents and signed
history persist in an atomic AES-256-GCM snapshot under `NOMO_DATA_DIR` (default
`~/.nomo/workbench`). The local CLI and web GUI use a mode-0600 key file. A
conflicting writer is rejected.
The local control-plane API caps JSON request bodies at 64 KiB and returns HTTP
413 (`body_too_large`) for larger bodies.

The document connector automatically captures before and after content. Every
mutation and its signed evidence commit together. Open Documents & Undo, preview
the restored content and explicitly confirm. Signatures and the complete capture
digest are verified before undo. Newer changes, already-undone operations and
modified captures are refused. Limits are 100 documents, 256 KB per document,
2 MB total and 250 mutations, with another 250 history slots reserved for undo.
Documents are managed storage, not arbitrary files on the host computer.

Add external HTTP MCP servers in Settings. NOMO discovers their tools and applies
the configured policy and registry mapping. Unknown tools fail closed. External
MCP has no automatic inverse unless a specific capture integration exists. A
legacy stdio upstream can still be supplied with `NOMO_UPSTREAM_COMMAND` (JSON
array), `NOMO_POLICY_PATH`, optional `NOMO_FACTS_PATH` and `NOMO_LEDGER_DIR`.
`OPENROUTER_API_KEY` and `NOMO_PROVIDER_URL` remain optional bootstrap settings.
The provider catalog validates before a session starts. Live generation also
requires provider authorization, model access and an available balance.

For terminal agents run `node packages/cli/bin/nomo.mjs agent --model <id>`.
For the live operator interface run `node packages/cli/bin/nomo.mjs watch` with
its ledger options. Press `h` for holds, select with arrows, then `a` or `d` and
`y` to confirm. Noninteractive agent execution denies holds.

## Web deployment on Vercel

The web application and backend run in the existing `nomo-tui` Vercel project,
team `sitespot`. No Mac, Raspberry Pi or separate NOMO server is required.
Nitro builds the HTTP API into Vercel Functions. Vercel Workflow runs agent
turns and durable approval waits. Neon, provisioned through Vercel Marketplace,
stores sessions, transcripts, configuration and the signed ledger.

The `nomo` project is the separate reference landing site and is untouched.

Server environment variables:

- `DATABASE_URL`: supplied by the Neon integration.
- `NOMO_CONTROL_TOKEN`: single-operator access token, at least 32 characters.
- `NOMO_SECRET_KEY`: 32 random bytes, base64, for AES-256-GCM secret encryption.
- `NOMO_SIGNING_KEY`: Ed25519 PKCS8 DER, base64, stable across deployments.
- Optional `AI_GATEWAY_API_KEY`: otherwise Vercel OIDC authenticates AI Gateway.

The hosted gateway limits JSON sign-in bodies to 4 KiB and forwarded POST
bodies to 64 KiB of UTF-8 JSON. The forwarding ceiling is fixed and may be
lower than the control plane's configurable `maxRequestBytes`.

The account identity layer reads four more, and none of them is set here:

- `SUPABASE_URL` and `SUPABASE_ANON_KEY`: the Supabase Auth project the chat
  origin signs in against.
- `NOMO_ACCOUNT_SEAL_KEY`: 64 hexadecimal characters, 32 bytes, the key the
  `__Host-void-account` cookie is sealed with.
- `NOMO_ACCOUNT_SIGNUP`: the signup switch. It is off, and setting it alone
  would not open registration, because a signup also needs an invitation code
  that no mounted route accepts.

With those three account values absent the broker reports itself
unconfigured, the account routes say so, and every request must present the
control token. The Prime bridge reads `NOMO_BRIDGE_TOKEN`, the public demo
reads `NOMO_PUBLIC_DEMO` and `NOMO_DEMO_NVIDIA_KEY`, and the OAuth callback
derives its base from `NOMO_PUBLIC_ORIGIN`. See
[account ownership](ACCOUNT-OWNERSHIP.md).

`node --env-file=.env.local scripts/src/provision-cloud.mjs` installs the schema
and sets the server secrets using Vercel environment management. Its local secret
files are ignored and private. The operator access token is in `.env.void-access`;
never share the signing or encryption keys. Enter the access token in the web
connection form. The workspace cookie is Secure, HttpOnly and SameSite Strict;
the account cookie, when one is ever issued, is Secure, HttpOnly and SameSite
Lax. This beta is a single-operator workspace, not a multiuser RBAC product.

Accounts are not on for this beta and the access token still means the
operator's own workspace. Before deploying a build that carries account
ownership, run `cloud/0001-account-ownership.sql` against the database. It is
additive, it is safe to run twice, it moves every existing row into the
operator's namespace so nothing changes for the token you already have, and it
takes a short exclusive lock while it swaps the primary keys, so run it once
with the deploy paused. It disables the two append-only triggers for the
backfill that would otherwise be refused by them, and re-enables them in the
same transaction. Skipping it leaves the server writing a column the database
does not have, and every cloud read fails until it is applied. See
[account ownership](ACCOUNT-OWNERSHIP.md).

NOMO has no default provider and no default model. Configure `NVIDIA_API_KEY`
or `DASHSCOPE_API_KEY` in the local runtime environment, then use the explicit
Settings check to validate the provider catalog, or connect another provider
from the preset list. `GET /api/provider` is passive. Clicking **Check
environment provider** can contact NVIDIA NIM and, if needed, DashScope through
the server; environment keys are never returned to the browser. The first
conversation asks which model to use from the validated catalog. Existing
conversations retain their saved provider and model. The NVIDIA hosted API may
expose an account-scoped trial/free quota; this is not a promise of unlimited
free usage.
A model catalog can be available before the account is authorized to generate.
Custom keys and tool-server credentials are encrypted before database storage.
Prompts and tool results are sent to the selected provider.

Connect an HTTPS MCP server in Tool server and policy. It is the system the
agent operates on, not an external NOMO runtime. Without tools, sessions support
chat only. Tool names can map explicitly to NOMO registry IDs; unknown or
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

Postgres replay uses `NOMO_PG_URL`, a serializable transaction, drift checks and
parent-before-child restoration. The cascade walker follows real foreign keys,
including nested and composite references; cycles are refused. S3 replay uses
`NOMO_S3_ENABLED=1`, standard AWS credentials and `AWS_REGION`; an optional
`NOMO_S3_ENDPOINT` supports compatible hosts. Conditional writes refuse races.
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

Verification includes the full `pnpm check` (487 tests passing, recorded 2026-09-11; the suite has since grown), whole-product approval arc, final
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
remain open.

Native desktop signing, Tauri packaging and installed-app smoke tests are
excluded from the current Harness scope. Do not run Xcode or treat platform
packaging as a remaining Harness task. Historical results remain in the
verification section below.
Token streaming is implemented; see
[GUI delivery evidence](GUI-UPGRADE-DELIVERY.md).

Physical mobile keyboards, VoiceOver/TalkBack and true 200% browser zoom acceptance
remain pending; the 640x450 reflow check is explicitly not a zoom test;
see [the acceptance matrix](MOBILE-ACCESSIBILITY-ACCEPTANCE.md) and
`docs/RELEASE.md` blocker 10.
Only one model session runs at a time. Speculative execution is not supported.

## Historical desktop and managed-workspace verification

`pnpm check` passes all 500 shared-runtime tests (recorded 2026-09-11; current suite is 22 suites / ~3060 tests). The added default-agent integration test
runs a real built-in tool through a deterministic provider, restarts twice,
verifies encrypted persistence and Ed25519 capture binding, rejects a forged
capture, and applies an explicit inverse. The Anthropic adapter test covers
native tool_use/tool_result conversion and usage accounting.

`check-managed-cloud.mjs` ran successfully against a newly created disposable
Neon database, then that database was removed. It exercised real HTTP cloud
routes, two model turns, signed encrypted capture, authentication, confirmation,
drift and forgery refusal, and idempotent undo. Production data was untouched.
For repeat runs supply `NOMO_TEST_DATABASE_URL` and
`NOMO_TEST_DATABASE_ISOLATED=1`; the script refuses the deployment database by
default. No real paid model was used by this deterministic integration test.

Browser QA exercised create, captured history, preview and explicit Undo, with
no horizontal overflow at 320, 375, 430, 768 and 1280 pixels. Provider and
connector settings were inspected on mobile, in both shared themes. Desktop
verification includes Rust Keychain migration tests, source and bundled backend
lifecycle checks, and the packaged native executable's `--smoke-test`.
