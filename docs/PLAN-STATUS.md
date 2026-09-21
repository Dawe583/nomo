# VOID plan status

Date: 2026-09-16. Baseline: local `main` at `4c82c37`.
Rule used: `partial` appears only with positive evidence of a real
implemented subset. TUI and GUI rows are summary level; sibling lanes own
that depth. R05 commit work runs in the sibling lane.

## EXECUTION-PLAN.md

| Work package                                       | Status  | Evidence pointer                                                                                                                                                                                       |
| -------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WP-00 context pack and scaffold                    | done    | `docs/CONTEXT.md`, `docs/DECISIONS.md`, `docs/STANDARDS.md` exist and are read as authoritative                                                                                                        |
| WP-01 proxy stdio core messages                    | done    | `packages/proxy/src`, proxy suites green per `docs/PRIME-HANDOFF.md` table                                                                                                                             |
| WP-02 streamable HTTP, progress, cancel, reconnect | partial | `packages/sdk/src/client.ts` supports an HTTP upstream, but reconnect and progress guarantees have no release evidence                                                                                 |
| WP-03 ledger                                       | done    | `packages/ledger/src`, chain, signing, verification and attestation tested                                                                                                                             |
| WP-04a registry runtime and evaluator              | done    | `packages/registry/src/evaluate.ts`, `precondition.ts`, `facts.ts` with tests                                                                                                                          |
| WP-04b registry expansion by batch                 | partial | 270 entries in `packages/registry/src/registry.ts`, no batch pipeline, goal is 500                                                                                                                     |
| WP-05 policy and blocking hold                     | done    | `packages/policy/src/hold.ts`, approvals broker, 75 policy tests per handoff table; staged hold is separate R11 work                                                                                   |
| WP-06 connector Postgres                           | partial | Legacy capture and inverse plus restricted managed R1 in `packages/connectors/src/postgres/managed.ts`; cascade, tenant, migration, kill and partition gates open                                      |
| WP-07 connector S3                                 | partial | Legacy byte snapshot path in `packages/connectors/src/s3/` only, fake clients in tests                                                                                                                 |
| WP-08 probes and blast radius                      | partial | `packages/connectors/src/probes/postgres.ts` and `s3.ts` exist, provider specific certification open                                                                                                   |
| WP-09 CLI                                          | partial | `packages/cli/src` covers classify, feed, replay, attest, taint, verify, doctor, init and recovery, but `docs/RELEASE.md` still requires real end to end verification of the approve and replay wiring |
| WP-09b terminal interface                          | partial | `packages/cli/src/tui/` exists with tests; `node packages/cli/bin/void.mjs tui --help` currently prints a parse error, needs sibling lane check                                                        |
| WP-10 control plane API                            | partial | `apps/control-plane/api` plus `cloud/server.mjs` serve a single operator workspace; no multitenancy, no SSO                                                                                            |
| WP-11 control plane UI                             | partial | `apps/control-plane/ui/src` is usable and deployed; parity and acceptance tail open, sibling lane owns depth                                                                                           |
| WP-12 taint graph                                  | partial | `packages/ledger/src/taint/` helpers tested, product integration missing                                                                                                                               |
| WP-13 attestation                                  | partial | `packages/ledger/src/attest.ts` plus `void attest` exist, no standalone verifier artifact                                                                                                              |
| WP-14 SDK wrap                                     | partial | `packages/sdk/src/client.ts` and `managed.ts` exist, no framework `wrap` module                                                                                                                        |
| WP-15 hardening, docs, release                     | partial | Docs and guides exist, publish CI, installable artifacts, signing and KMS open per `docs/RELEASE.md`                                                                                                   |

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
| R01 journal and identity          | partial     | Signed local journal and recovery jobs in `packages/runtime/src`; cloud journal and full fault matrix open                                                    |
| R02 shared runtime adoption       | partial     | Managed CLI, MCP and TS SDK use the runtime; legacy proxy binding and external tool conformance open                                                          |
| R03 snapshots and quota           | partial     | `packages/runtime/src/reserved-vault.ts` with quota enforced; streaming, pins, GC and retention open                                                          |
| R04 PostgreSQL end to end         | partial     | `packages/connectors/src/postgres/managed.ts` with adversarial tests; cascade, tenant, migration, kill and partition gates open                               |
| R05 filesystem and Git            | partial     | `packages/connectors/src/filesystem/managed.ts` and `git/managed.ts` with conformance; commit, remote, Windows Git and rename gates open, sibling lane active |
| R06 persistent planner and runner | partial     | `packages/runtime/src/recovery/plan.ts` and `run.ts` with job tests; selection, leases, fencing and remote surfaces open                                      |
| R07 provenance and dependencies   | not started | Only retained legacy helpers in `packages/ledger/src/taint/`, no runtime integration                                                                          |
| R08 S3 and Supabase               | not started | Only legacy S3 and OAuth connections, no managed adapters                                                                                                     |
| R09 GitHub and Vercel recovery    | not started | Only OAuth plus read tools, no executable recovery adapters                                                                                                   |
| R10 budgets and modes             | partial     | `packages/runtime/src/budget.ts` local accounting with tests; cloud accounting, modes and approval integration open                                           |
| R11 staged hold and cancel        | not started | Zero provisional receipt code, blocking hold only                                                                                                             |
| R12 adapter SDK and services      | partial     | `packages/runtime/src/conformance.ts` runner plus managed TS SDK; Python transport and provider fixtures open                                                 |
| R13 boundary and host setup       | partial     | `void doctor` and `void init` as read only CLI plus local MCP serve; remote auth and egress open                                                              |
| R14 evidence and operations       | partial     | Coverage and runbook exist; bundles, metrics and certification open                                                                                           |

## GUI-UPGRADE-PLAN.md, status only

| Stage                       | Status  | Evidence pointer                                                                                                |
| --------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| E0 fixtures                 | done    | Delivery report documents reproducible fixtures                                                                 |
| E1 default model            | done    | NVIDIA NIM / GLM 5.3 Flash default, setupRequired state and migration tests                                      |
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
| A4 pairing                 | not started | No pairing implementation in the tree                                              |
| A5 native release          | blocked     | Needs Developer ID identity, provisioning, hardware; machine has CLT only          |

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
| `docs/GO-TO-MARKET.md`                    | not started | Business execution not started; file is confidential and must leave the tree before open sourcing         |

## Living status records, current as of the dates inside them

| Record                             | Status | Evidence pointer                                                |
| ---------------------------------- | ------ | --------------------------------------------------------------- |
| `docs/REVERSE-UPGRADE-PROGRESS.md` | done   | Record current, 2026-09-15 adapter and Windows followup         |
| `docs/RECOVERY-COVERAGE.md`        | done   | Record current, 2026-09-13 capability inventory                 |
| `docs/UPGRADE-CHECKPOINT.md`       | done   | Record current, latest increment with fresh verification counts |
