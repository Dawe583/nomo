# NOMO plan status

Date: 2026-09-16. Baseline: local `main` at `4c82c37`. Rows corrected
2026-10-01 against `main` where the tree had moved past them; each correction
names the file that contradicts the old cell. Everything not named here is
still the 2026-09-16 reading.
Rule used: `partial` appears only with positive evidence of a real
implemented subset. TUI and GUI rows are summary level; sibling lanes own
that depth. R05 commit work runs in the sibling lane.

Rows added 2026-10-02 for the local install, the `nomo update` command and the
versioning plan, and WP-09's evidence pointer corrected the same day.

The entry point for using the product is [the handbook](HANDBOOK.md), with a
[Czech edition](HANDBOOK.cs.md). Both are verified by
`scripts/src/handbook.test.mjs`, which fails when a command, script, path, link
or the stated default provider stops matching the tree.

## EXECUTION-PLAN.md

| Work package                                       | Status  | Evidence pointer                                                                                                                                                                                       |
| -------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WP-00 context pack and scaffold                    | done    | `docs/CONTEXT.md`, `docs/DECISIONS.md`, `docs/STANDARDS.md` exist and are read as authoritative                                                                                                        |
| WP-01 proxy stdio core messages                    | done    | `packages/proxy/src`, proxy suites green per `docs/PRIME-HANDOFF.md` table                                                                                                                             |
| WP-02 streamable HTTP, progress, cancel, reconnect | partial | `packages/sdk/src/client.ts` supports an HTTP upstream, but reconnect and progress guarantees have no release evidence                                                                                 |
| WP-03 ledger                                       | done    | `packages/ledger/src`, chain, signing, verification and attestation tested                                                                                                                             |
| WP-04a registry runtime and evaluator              | done    | `packages/registry/src/evaluate.ts`, `precondition.ts`, `facts.ts` with tests                                                                                                                          |
| WP-04b registry expansion by batch                 | partial | 268 entries and 48 vendors are pinned by name at lines 21 and 22 of `packages/registry/src/index.test.ts`, measured 2026-09-29, so the 500 goal is unmet. Two reviewed batches ship: `fixtures/registry/wp04b-batch2.json` carries 74 entries and no `sources` map and no `refuted` set, while `fixtures/registry/wp04b-batch3.json` carries 107 entries each mapped to an https source with six recorded refutations, asserted at line 18 of `packages/registry/src/batch3.test.ts`; `packages/cli/src/batch3.test.ts` classifies both fixtures with zero unknown tools |
| WP-05 policy and blocking hold                     | done    | `packages/policy/src/hold.ts`, approvals broker, 75 policy tests per handoff table; staged hold is separate R11 work                                                                                   |
| WP-06 connector Postgres                           | partial | Legacy capture and inverse plus restricted managed R1 in `packages/connectors/src/postgres/managed.ts`; cascade, tenant and migration paths in `managed.test.ts` at lines 679, 725 and 796, kill coverage by client SIGKILL after forward and recovery COMMIT and a blackhole partition probe with no partial commit in `scripts/src/verify-managed-postgres.mjs` at lines 300, 306 and 809; real-server certification of those paths stays open |
| WP-07 connector S3                                 | partial | Legacy byte snapshot path in `packages/connectors/src/s3/` only, fake clients in tests                                                                                                                 |
| WP-08 probes and blast radius                      | partial | `packages/connectors/src/probes/postgres.ts` and `s3.ts` exist, provider specific certification open                                                                                                   |
| WP-09 CLI                                          | partial | `packages/cli/src` covers classify, feed, replay, attest, taint, verify, doctor, init, update and recovery, but `docs/RELEASE.md` still requires real end to end verification of the approve and replay wiring |
| WP-09b terminal interface                          | partial | `packages/cli/src/tui/` exists with tests. `nomo tui --help` prints its usage line and exits 0; a sibling lane owns the depth |
| WP-10 control plane API                            | partial | `apps/control-plane/api` plus `cloud/server.mjs` serve a single operator workspace; no multitenancy, no SSO                                                                                            |
| WP-11 control plane UI                             | partial | `apps/control-plane/ui/src` is usable and deployed; parity and acceptance tail open, sibling lane owns depth                                                                                           |
| WP-12 taint graph                                  | partial | `packages/ledger/src/taint/` helpers tested; the product surface exists and is entitlement-gated at `cloud/server.mjs`, where `GET /api/records/:seq/taint` answers `402 capability_not_included` before reading a ledger row. Per `docs/DECISIONS.md` amendment six (2026-10-03) the builder stays Apache 2.0 and the hosted surface is the paid part, which is why the row is not "open core, ungated". Still open under it: G-19 records that no recovery planner consumes this graph |
| WP-13 attestation                                  | partial | `packages/ledger/src/attest.ts` plus `nomo attest` exist, and the standalone verifier artifact exists: `packages/verifier/package.json` ships `@nomo/verifier` as an installable package with a `nomo-verify` bin at line 16, no `private` flag and empty dependencies, so a reviewer can verify an export without this repository. It is the one package the release gate lists as publishable, at lines 42 to 47 of `scripts/src/release-packaging.test.mjs`, and the same facts are asserted at lines 239 to 247 of `scripts/src/licence-line.test.mjs`; publishing it stays open |
| WP-14 SDK wrap                                     | partial | `packages/sdk/src/client.ts` and `managed.ts` exist, no framework `wrap` module                                                                                                                        |
| WP-15 hardening, docs, release                     | partial | Docs and guides exist and `scripts/install-nomo.sh` gives a real local install, but publish CI, a distributable artifact, signing and KMS are open per `docs/RELEASE.md`                                              |

## Self-installation and self-update, `omp/selfupdate` branch, 2026-10-02

| Work item                                  | Status  | Evidence pointer                                                                                                                                       |
| ------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/install-nomo.sh` local install    | partial | The script exists and is the whole documented install path: prereq checks, a shallow clone or reuse into `$NOMO_HOME` default `~/.local/share/nomo-cli`, a locked dependency install and a launcher at `~/.local/bin/nomo`. `docs/BETA.md` documents it. Not `done`: the repository is private, so a first-run clone needs credentials and there is no public artifact, no signed release and no release tag, so the install path has been exercised from a maintainer checkout only |
| `nomo update` in-place update              | partial | `packages/cli/src/update.ts` implements the fetch, the fast-forward, the `reset --keep` move, `--check` and `--force`, with the dirty-worktree and local-commit refusals and exit codes 0 to 3. Not `done`: the tracked branch of a private clone is reachable only with credentials, and no update has been run and recorded against an install on a second machine, so the loop is proven on one host |
| `docs/VERSIONING-AND-UPDATE-PLAN.md`       | done    | The document is merged and is a plan of record, with its own dated claim about what it does not establish. `done` because the deliverable is the document; the single source of truth and the bump script it specifies are implementation, and are not in this tree |

The three are `partial` on the same evidence gap: each is a real implemented
subset with a recorded refusal path, and none has an install or an update
proven across two machines. Calling the first two `done` would claim a
distribution that does not exist yet; calling the third `partial` would
mistake a merged specification for an unfinished one.

The `partial` verdict rests on what was run, not on what the source reads like.
On 2026-10-02 the installer was executed in a scratch `HOME` and returned the
reused tree, wrote the launcher and exited 0, and the launcher on PATH answered
`nomo --version` with `void 0.1.0`. A foreign file at the launcher path was
refused with exit 1 and left untouched. The shipped `nomo update` was then
driven over real git trees: up to date exited 0, a tree one commit behind
fast-forwarded, an uncommitted edit was refused with exit 1 with and without
`--force` and survived both, a local commit was refused by name and `--check`
reported the same state as exit 3, and a clean `--force` move dropped the
local commit while leaving an untracked file alone. One gap the run exposed is
recorded in `docs/BETA.md`: the installer's `--depth 1` clone has a single
commit, so a rollback needs `git fetch --unshallow` first, and `nomo update`
does not deepen the tree by itself.

## BUILD-PLAN.md phases

| Phase                         | Status  | Evidence pointer                                       |
| ----------------------------- | ------- | ------------------------------------------------------ |
| Phase 0 scaffold and decide   | done    | WP-00 row above                                        |
| Phase 1 transparent proxy     | partial | WP-01 done, WP-02 reconnect and progress evidence open |
| Registry, ledger, policy core | done    | WP-03, WP-04a, WP-05 rows above                        |
| Postgres and S3 connectors    | partial | WP-06, WP-07 rows above                                |
| Probes                        | partial | WP-08 row above                                        |
| CLI and terminal              | partial | WP-09, WP-09b rows above                               |
| Control plane API and UI      | partial | WP-10, WP-11 rows above                                |
| Taint and attestation         | partial | WP-12, WP-13 rows above                                |
| SDK wrap                      | partial | WP-14 row above                                        |
| Hardening and release         | partial | WP-15 row above                                        |

## REVERSE-TOOL-UPGRADE-PLAN.md

| Work package                      | Status      | Evidence pointer                                                                                                                                              |
| --------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R00 contract and coverage setup   | partial     | `docs/ADAPTER-CONFORMANCE.md` runner exists, report states `certification: false`                                                                             |
| R01 journal and identity          | partial     | Signed local journal and recovery jobs in `packages/runtime/src`, plus a cloud journal: `cloud/store.mjs` `append` at line 137 signs and hash-chains each entry and inserts it into `void_cloud_ledger` at line 172, under the owner-and-workspace `pg_advisory_xact_lock` that `append` takes at line 149, inside the owner-scoped `pg_advisory_xact_lock` transaction at line 26, and `cloud/schema.sql` line 18 installs the append-only trigger that refuses UPDATE and DELETE on that table. `cloud/recovery-routes.mjs` mounts plan, apply and status at lines 49, 56 and 88 and runs each inside the transaction it opens at line 37. Kill faults and a partition probe are covered: `scripts/src/verify-managed-postgres.mjs` kills the client at lines 300 and 306, blackholes a held peer from line 775 and reports `networkPartitionTest: true` at line 874. Still open: disk exhaustion and the physical fault matrix, which `packages/runtime/src/persistence-fault.test.ts` line 1 scopes out and `docs/UPGRADE-CHECKPOINT.md` lines 60 to 62 record as unrun against a live cluster |
| R02 shared runtime adoption       | partial     | Managed CLI, MCP and TS SDK use the runtime; injected legacy proxy binding is verified for `postgres.row.update`; standalone host wiring and other external tools remain open                       |
| R03 snapshots and quota           | partial     | `packages/runtime/src/reserved-vault.ts` with quota enforced; streaming (`VaultPlaintext` at line 38, `getStream` at line 611) and capacity migration (`migrateCapacity` at line 662) are implemented there, and pin lifecycle, retention policy and pin-respecting GC are implemented in `packages/runtime/src/retention.ts`. None of it is operator reachable: `packages/runtime/src/index.ts` line 4 re-exports the retention module and no file under `packages/cli/src` or `cloud/` calls it |
| R04 PostgreSQL end to end         | partial     | `packages/connectors/src/postgres/managed.ts` with adversarial tests; cascade, tenant, migration, kill and partition gates open                               |
| R05 filesystem and Git            | partial     | `packages/connectors/src/filesystem/managed.ts` and `git/managed.ts` with conformance; commit and rename are published scenarios in `gitScenarios` at line 197 of `packages/cli/src/conformance.ts`, backed by `packages/connectors/src/git/managed-commit.ts` and wired in at line 26 of `packages/connectors/src/git/managed.ts`, and the managed Git adapter is registered in the CLI runtime at line 187 of `packages/cli/src/recovery.ts`. A remote surface exists in `packages/connectors/src/git/managed-remote.ts` and is parsed at line 248 of `git/managed.ts`, but `remotes` is named in the conformance `excluded` list at line 216 of `packages/cli/src/conformance.ts` and no CLI, MCP or cloud caller names it. Windows is refused by `git/managed.ts` line 54 |
| R06 persistent planner and runner | partial     | `packages/runtime/src/recovery/plan.ts` and `run.ts` with job tests; selection is `resolveRecoverySelection` and `independentBranches` at lines 253 and 415 of `plan.ts`, leases are `leaseVerdict` at line 41 of `recovery/lease.ts` claimed and renewed from `execute.ts`, the MCP job surface is `nomo_recovery_plan_job`, `nomo_recovery_status_job` and `nomo_recovery_apply_job` at lines 188 to 190 of `packages/cli/src/recovery-mcp.ts`, and the cloud job surface is `cloud/recovery-routes.mjs`. Cross-host fencing is the open half: line 99 of `packages/runtime/src/budget.ts` says the store fences one host only |
| R07 provenance and dependencies   | partial     | `packages/runtime/src/recovery/provenance.ts` is exported by the runtime and used by the recovery planner; legacy taint helpers remain in `packages/ledger/src/taint/` |
| R08 S3 and Supabase               | partial     | `packages/connectors/src/s3/` carries capture, classify, apply guards and inverse with tests; there is no Supabase adapter in `packages/connectors/src` |
| R09 GitHub and Vercel recovery    | not started | No `github` or `vercel` connector exists under `packages/connectors/src`; OAuth plus read tools only |
| R10 budgets and modes             | partial     | `packages/runtime/src/budget.ts` local accounting with tests; cloud accounting, modes and approval integration open                                           |
| R11 staged hold and cancel        | not started | Zero provisional receipt code, blocking hold only                                                                                                             |
| R12 adapter SDK and services      | partial     | `packages/runtime/src/conformance.ts` runner plus managed TS SDK, and the Python transport client now ships at `python/nomo-transport/src/nomo_transport/client.py` with four test modules gated by `scripts/src/check-tests.mjs` line 151. The runner still disclaims provider certification at line 39 of `packages/runtime/src/conformance.ts`, so no provider-specific suite is claimed |
| R13 boundary and host setup       | partial     | `nomo doctor` and `nomo init` as read only CLI plus local MCP serve; remote auth and egress open                                                              |
| R14 evidence and operations       | partial     | Coverage and runbook exist; bundles and metrics are user visible. `nomo export --bundle` and `nomo export verify` are dispatched from lines 166 and 117 of `packages/cli/src/operations.ts` over `void.export-bundle.v1`, whose manifest carries a `complete: true` completeness proof (`packages/cli/src/export-bundle.ts` lines 67, 338 and 863), and `nomo metrics` is dispatched from line 68 of the same file over `void.metrics.v1`; `packages/cli/src/dispatch.ts` line 56 routes both, and `packages/cli/src/argv.ts` lists them at lines 24 and 32. Certification is still open: `docs/UPGRADE-CHECKPOINT.md` line 8 says the recorded run is not a certification |

## GUI-UPGRADE-PLAN.md, status only

| Stage                       | Status  | Evidence pointer                                                                                                |
| --------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| E0 fixtures                 | done    | Delivery report documents reproducible fixtures                                                                 |
| E1 default model            | superseded | `packages/workbench/src/provider-defaults.ts` ships no default provider or model, the retired ids are refused on sight, and the workspace picks from its own validated catalog |
| E2 shell and routes         | done    | Shared React shell with login gate exists                                                                       |
| E3 chat composition         | partial | Markdown, composer, drafts, picker, tool cards, project workspace and context compaction exist; management parity continues |
| E4 streaming and reconnect  | partial | Streaming with deltas exists, long run production evidence open                                                 |
| E5 documents and Undo       | partial | Managed document Undo reviewed and tested, external tool Undo not implied                                       |
| E6 history scale            | partial | Server filters and pagination exist, scale evidence continues                                                   |
| E7 connectors and settings  | partial | Pages exist; NVIDIA NIM, built-in agent presets and provider price/quota unknown state are exposed                  |
| E8 mobile and accessibility | partial | Viewport checks pass, physical devices and screen readers pending per `docs/MOBILE-ACCESSIBILITY-ACCEPTANCE.md` |
| E9 production operation     | partial | Production shipped, rollback documented but not executed                                                        |

## APPLE-APPS-PLAN.md

| Work package               | Status      | Evidence pointer                                                                   |
| -------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| A1 distribution            | partial     | Tauri beta with ad hoc signature per `docs/UPGRADE-CHECKPOINT.md`, no notarization |
| A2 SwiftUI macOS client    | not started | Plan states Swift migration is not implemented                                     |
| A3 iOS local recovery core | not started | Plan marks iOS as deferred design                                                  |
| A4 pairing                 | partial     | `apps/control-plane/api/companion/` implements devices, invitations, idempotency, routes and operations with envelope tests |
| A5 native release          | blocked     | Xcode 27.0 (build 27A266a) is installed; the blockers are a Developer ID identity, provisioning and hardware |

## Capability and runbook docs

| Plan                                      | Status      | Evidence pointer                                                                                          |
| ----------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| `docs/BETA.md`                            | partial     | Single operator dev release coherent, production claims explicitly excluded                               |
| `docs/RELEASE.md`                         | partial     | Development surfaces listed, npm scope, publish CI and artifacts blocked                                  |
| `docs/OPERATIONS.md`                      | done        | Dev tier runbook complete for policy grammar, ledger layout, fail closed behavior and approvals           |
| `docs/MOBILE-ACCESSIBILITY-ACCEPTANCE.md` | partial     | Browser viewport checks pass, physical matrix pending                                                     |
| `docs/MANAGED-GIT.md`                     | partial     | Cooperative POSIX subset documented with refusal semantics, commit and remote open                        |
| `docs/MANAGED-RECOVERY.md`                | partial     | Managed Postgres operator flow documented and tested, migration path open                                 |
| `docs/MANAGED-FILESYSTEM.md`              | partial     | Cooperative create, write, delete and POSIX rename documented, Windows rename refused                     |
| `docs/ADAPTER-CONFORMANCE.md`             | partial     | Filesystem and Git conformance commands pass, certification flags false                                   |
| `docs/PRIME-HANDOFF.md`                   | partial     | S11 partial across relay paths, S13 and S15 scoped closures; S07 retained, S09, S10 and S14 followup open |
| `docs/GO-TO-MARKET.md`                    | absent by design | The document is confidential and is deliberately not in this repository. Nothing in the tree may depend on reading it, and business execution has not started |

## Living status records, current as of the dates inside them

| Record                             | Status | Evidence pointer                                                |
| ---------------------------------- | ------ | --------------------------------------------------------------- |
| `docs/REVERSE-UPGRADE-PROGRESS.md` | done   | Record current, 2026-09-15 adapter and Windows followup         |
| `docs/RECOVERY-COVERAGE.md`        | done   | Record current, its own status line 3 dated 2026-09-26              |
| `docs/UPGRADE-CHECKPOINT.md`       | done   | Record current, latest increment with fresh verification counts |
