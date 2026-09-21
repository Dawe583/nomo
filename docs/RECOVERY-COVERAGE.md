# Recovery coverage

Status: implementation in progress, 2026-09-13. This is a capability inventory,
not a declaration that all work packages in REVERSE-TOOL-UPGRADE-PLAN are done.

| Surface                                                     | Managed support             | Scope / constraints                                                                                                                                                                                                           | Evidence                                                                             |
| ----------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| PostgreSQL INSERT/UPDATE/DELETE                             | Implemented, restricted R1  | One explicitly configured primary-key row; configured writable columns; exact row values restored                                                                                                                             | `packages/connectors/src/postgres/managed.test.ts`, `managed-adversarial.test.ts`    |
| PostgreSQL human ABA                                        | Detected                    | Installed revision trigger and relation identity; disabled/replaced trigger refuses execution                                                                                                                                 | Same suites                                                                          |
| Lost mutation/recovery response                             | Reconciliation              | Durable transaction receipt bound to capture and outcome; no automatic second dispatch                                                                                                                                        | Same suites; runtime tests                                                           |
| Local encrypted snapshots                                   | Implemented subset          | AES-256-GCM, workspace AAD, digest, durable reserved slots, shared 1 GiB logical quota; legacy reads                                                                                                                          | `packages/runtime/src/{runtime,adversarial,reserved-vault}.test.ts`                  |
| Signed lifecycle / idempotence                              | Implemented subset          | Local single writer; corruption fails closed; OS-backed local writer mutex, SIGKILL recovery                                                                                                                                  | Same suites                                                                          |
| Managed MCP tools                                           | Implemented subset          | Local stdio, operator policy, configured workspace and agent identity                                                                                                                                                         | `packages/cli/src/recovery-mcp.test.ts` uses official MCP client/in-memory transport |
| Real PostgreSQL                                             | Verified subset             | Isolated Neon database; separate connections, ABA, restart, terminated backend sessions, managed deadlock, client SIGKILL after forward/recovery COMMIT, and explicit migration/cascade/tenant fixture paths | `scripts/src/verify-managed-postgres.mjs`, `packages/connectors/src/postgres/managed.test.ts` |
| Legacy PostgreSQL/S3 replay                                 | Existing separate path      | Earlier capture/apply contract; no automatic managed-runtime guarantees                                                                                                                                                       | `REVERSE-ENGINE-VALIDATION.md`                                                       |
| Local workbench documents                                   | Shared runtime integrated   | Writes, deletes, branch copies and operator Undo; legacy signed history preserved                                                                                                                                             | `packages/workbench/src/managed-documents.test.ts`                                   |
| Cloud workbench documents                                   | Shared runtime integrated   | Atomic SQL document/evidence transaction, reserved encrypted artifacts, one retained run/explicit operation-list job with digest-bound approval/apply, signed plan/checkpoint history and blocked forward writes; resource/provenance ordering, scheduler/leases/fencing/MCP surfaces and external effects remain excluded | `cloud/recovery.test.mjs`, `cloud/gui.test.mjs`                                      |
| Local Prime web bridge                                      | Separate execution boundary | Signed R3 run, no automatic local-tool Undo; private outbound worker                                                                                                                                                          | `cloud/prime.test.mjs`, `scripts/src/prime-bridge.test.mjs`                          |
| Filesystem managed execution                                | Cooperative subset          | Single regular file create/write/delete, plus POSIX two-path rename, bytes and mode, conflict checks; destinations observed before dispatch are refused, with no concurrent external writer guarantee; Windows rename refused | `MANAGED-FILESYSTEM.md`, filesystem and CLI tests                                    |
| Managed Git                                                 | Cooperative POSIX subset    | One structured worktree or logical index target; no durable reconciliation receipt, commit, remote, directory or full repository recovery                                                                                       | `MANAGED-GIT.md`, Git adapter and CLI tests                                           |
| GitHub/Vercel/Supabase OAuth                                | Connection mechanism only   | Provider consent and service scopes do not certify recovery                                                                                                                                                                   | `OAUTH-INTEGRATIONS.md`                                                              |
| Local R3 budget                                             | Implemented subset          | UTC authorization-day, workspace and per-agent limits, durable reservations                                                                                                                                                   | `packages/runtime/src/budget.test.ts`, 100-request contention                        |
| Cross-system jobs, provenance, cloud budgets, staged cancel | Pending integration         | Retained cloud jobs reuse only the local same-order single-job runner. Existing taint/policy modules do not satisfy dependency closure, scheduling, leases, fencing, MCP surfaces, budgets or staged/cascading cancel | WP-R06 through R14                                                                   |

## PostgreSQL limitations

The adapter supports explicitly configured ordinary tables. It rejects
generated/identity columns, additional user triggers, rules, partitioned
relations and disabled or substituted revision triggers. Tenant-scoped tables
require server-bound RLS and a policy containing the configured setting and
column. Deletes with inbound foreign keys require every cascade table to be
configured and use `ON DELETE CASCADE`. These refusal paths and positive
cascade/tenant paths are covered by offline PGlite tests.

The adapter does not support arbitrary SQL, bulk predicates, DDL, sequence
restoration or external observers. Real SERIALIZABLE conflict during managed
prepare is tested. The isolated verifier includes a real lock cycle during
managed dispatch, terminates its own backend before/after execution COMMIT and
after Undo COMMIT, and kills a client worker after forward/recovery COMMIT.
Physical network partition and an in-flight client kill remain release gates.

Installation creates a configured metadata schema and row revision triggers.
Fresh installation writes metadata version 2. Existing version 1 metadata needs
an explicit reviewed `migrateManagedPostgres` call; tool execution never
performs migration. Metadata contains before images and outcomes in PostgreSQL;
protect its privileges and backups as sensitive data. Local artifact encryption
does not encrypt this transactional database evidence.

## Verification interpretation

The focused evidence includes runtime, managed SQL, MCP, managed SDK, local
document, filesystem, CLI and conformance tests. These are in addition to
earlier tests. Run the commands below instead of relying on a stale count.
The real PostgreSQL verification passed after the capture-binding and trigger
integrity fixes. It includes an injected lost response and actual backend termination at commit
boundaries. Neither is a physical network partition or killed client-worker test. A separate local
runtime test sends actual SIGKILL after dispatch. MCP integration uses the actual signed runtime with a test adapter; it is not a live OpenCode
session or cloud transport conformance test.

The focused suite also runs real local crash checks: SIGKILL during dispatch on
the local SQLite-mutex journal stays unknown without a second write, inverse
receipt and checkpoint boundaries survive a SIGKILL restart, and a full-disk
capture failure closes before dispatch. These cover the local transactional
fault surface only. Physical disk exhaustion behavior, PostgreSQL client process
death and physical network partitions remain open release gates.

Capacity verification includes an actual SIGKILL before the SQLite snapshot
commit: payload and quota roll back together, and a restarted writer retains
the original reservation. The opt-in real PostgreSQL script also runs using
the reservation-backed vault.

Public demo isolates each visitor and uses the same managed cloud document recovery. It does not expose the filesystem adapter, private workspace token, OAuth accounts or local Prime bridge. See `PUBLIC-DEMO.md`.
