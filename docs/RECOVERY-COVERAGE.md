# Recovery coverage

Status: implementation in progress, 2026-09-26. This is a capability inventory,
not a declaration that all work packages in REVERSE-TOOL-UPGRADE-PLAN are done.
The date records the last reconciliation against the tree rather than the last
edit. On 2026-09-26 the Managed Git row and the metadata migration section were
corrected against `packages/connectors/src/git/managed.ts`,
`packages/connectors/src/git/managed-commit.ts`,
`packages/connectors/src/postgres/managed.ts` and
`packages/cli/src/recovery.ts`.

| Surface                                                     | Managed support             | Scope / constraints                                                                                                                                                                                                           | Evidence                                                                             |
| ----------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| PostgreSQL INSERT/UPDATE/DELETE                             | Implemented, restricted R1  | One explicitly configured primary-key row; configured writable columns; exact row values restored                                                                                                                             | `packages/connectors/src/postgres/managed.test.ts`, `managed-adversarial.test.ts`    |
| PostgreSQL human ABA                                        | Detected                    | Installed revision trigger and relation identity; disabled/replaced trigger refuses execution                                                                                                                                 | Same suites                                                                          |
| Lost mutation/recovery response                             | Reconciliation              | Durable transaction receipt bound to capture and outcome; no automatic second dispatch                                                                                                                                        | Same suites; runtime tests                                                           |
| Local encrypted snapshots                                   | Implemented subset          | AES-256-GCM, workspace AAD, digest, durable reserved slots, shared 1 GiB logical quota; legacy reads                                                                                                                          | `packages/runtime/src/{runtime,adversarial,reserved-vault}.test.ts`                  |
| Local vault retention                                       | Implemented, operator-driven | Reserved vault schema 2 carries the evidence table and the artifact write time; a pin is released only by a named operator; collection refuses on unprovable evidence and deletes only unpinned artifacts provably past the policy TTL, under the signed journal chain, driven by `nomo recovery collect`; no automatic collection | `packages/runtime/src/reserved-retention.test.ts`, `packages/cli/src/recovery-collect.test.ts` |
| Signed lifecycle / idempotence                              | Implemented subset          | Local single writer; corruption fails closed; OS-backed local writer mutex, SIGKILL recovery                                                                                                                                  | Same suites                                                                          |
| Managed MCP tools                                           | Implemented subset          | Local stdio, operator policy, configured workspace and agent identity                                                                                                                                                         | `packages/cli/src/recovery-mcp.test.ts` uses official MCP client/in-memory transport |
| Real PostgreSQL                                             | Verified subset             | Isolated Neon database; separate connections, ABA, restart, terminated backend sessions, managed deadlock, client SIGKILL after forward/recovery COMMIT, fresh metadata install, and cascade and tenant paths against a PGlite fixture. Version 1 metadata migration is not exercised against this server | `scripts/src/verify-managed-postgres.mjs`, `packages/connectors/src/postgres/managed.test.ts` |
| Legacy PostgreSQL/S3 replay                                 | Existing separate path      | Earlier capture/apply contract; no automatic managed-runtime guarantees                                                                                                                                                       | `REVERSE-ENGINE-VALIDATION.md`                                                       |
| Legacy proxy `postgres.row.update` binding                  | Verified injected subset    | `runProxy` host binding captures a real PGlite before-image before dispatch, records a digest-bound signed outcome, and permits restart recovery only for completed evidence. Standalone `nomo-proxy`, other tools and distributed atomicity are not certified | `packages/proxy/src/bin.test.ts`, `packages/connectors/src/reverse-engine.test.ts`   |
| Local workbench documents                                   | Shared runtime integrated   | Writes, deletes, branch copies and operator Undo; legacy signed history preserved                                                                                                                                             | `packages/workbench/src/managed-documents.test.ts`                                   |
| Cloud workbench documents                                   | Shared runtime integrated   | Atomic SQL document/evidence transaction, reserved encrypted artifacts, one retained run, journal checkpoint or explicit operation-list job with digest-bound approval/apply, signed plan/checkpoint history and blocked forward writes; resource/provenance ordering, scheduler/leases/fencing/MCP surfaces and external effects remain excluded | `cloud/recovery.test.mjs`, `cloud/gui.test.mjs`                                      |
| Local Prime web bridge                                      | Separate execution boundary | Signed R3 run, no automatic local-tool Undo; private outbound worker                                                                                                                                                          | `cloud/prime.test.mjs`, `scripts/src/prime-bridge.test.mjs`                          |
| Filesystem managed execution                                | Cooperative subset          | Single regular file create/write/delete, plus POSIX two-path rename, bytes and mode, conflict checks; destinations observed before dispatch are refused, with no concurrent external writer guarantee; Windows rename refused | `MANAGED-FILESYSTEM.md`, filesystem and CLI tests                                    |
| Managed Git                                                 | Cooperative POSIX subset    | One structured worktree or logical index target, one staged path carried through a full commit lifecycle, or one published managed commit recovered over a real remote. The worktree and index actions have no operation-specific durable execution or recovery receipt and both reconciliation methods return unknown. `commit` alone writes atomic receipts under `refs/void/operations/` and `refs/void/recoveries/` and reconciles a restart by validating that receipt, the commit, its parent, tree, metadata and repository binding. `recoverRemote` fetches the named remote branch, re-derives the undone operation from its own receipt, and publishes one new `refs/heads/void/recovery/<digest>` branch carrying the inverse plus a digest-bound proposal body naming the operation it undoes. It never resets and never force-pushes, no existing ref on either side moves, a remote that advances between capture and apply is refused rather than rebased, a refused push reconciles to `failed`, and a branch found at another commit reconciles to `unknown` with no second push. It is implemented and tested but is not in the published profile, it opens no pull request, it deletes no remote ref, and it has no managed inverse of its own: the observation is R3, so the default runtime denies the dispatch. There is no directory mutation or full repository recovery | `MANAGED-GIT.md`, `packages/connectors/src/git/managed.ts`, `packages/connectors/src/git/managed-commit.ts`, `packages/connectors/src/git/managed-remote.ts`, `packages/connectors/src/git/managed-remote.test.ts` |
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
Fresh installation writes metadata version 2. Metadata contains before images
and outcomes in PostgreSQL; protect its privileges and backups as sensitive
data. Local artifact encryption does not encrypt this transactional database
evidence. Migration of existing version 1 metadata is an operator action, and
the section below is its whole documented path.

## Managed PostgreSQL metadata migration

The command is `nomo recovery migrate --config <file>`, the same config file
and the same `urlEnv` variable that `nomo recovery install` uses. It prints
`{"fromVersion":1,"metadataVersion":2}` and exits zero. On a filesystem or Git
configuration it refuses with "Filesystem and Git do not use PostgreSQL
metadata migration." The dispatch is in `packages/cli/src/recovery.ts`; the
migration itself is `migrateManagedPostgres` in
`packages/connectors/src/postgres/managed.ts`.

The migration only accepts the exact released version 1 layout or an already
migrated version 2 layout. It reads the metadata identity, inspects the version
and reads the identity again, refusing if it moved; it refuses a missing or
legacy version row, any other version number, and a structure that does not
match that version exactly. Inside one transaction it takes the
`nomo-managed-metadata:<schema>` advisory lock and access-exclusive locks on
the metadata, revisions, operations and recoveries tables, rechecks identity,
version and structure, adds a `format_version` column to operations and
recoveries, moves that column's default to 2, validates the result, and updates
the version row from 1 to 2. Any failure rolls the whole transaction back.

It is additive and idempotent. Receipts written before the migration keep
`format_version` 1 and still verify; only rows written afterwards carry 2, and
running the command again against version 2 changes nothing. Both properties
are covered by `packages/connectors/src/postgres/managed-install.test.ts`, and
the version 1 refusal, the migration and the repeat run are covered by
`packages/connectors/src/postgres/managed.test.ts`.

Tool execution never performs this migration, and the refusal is deliberate
rather than a missing feature. `preflight` and `prepare` both check the
metadata version before they read a row, and `recover` checks it before it
writes the inverse. A version that is not the current one throws "Recovery
metadata migration is required before execution."; a version 2 row whose
`format_version` columns are absent throws "Recovery metadata migration is
incomplete." `execute` inherits the check from the `prepare` transaction it
continues, and `reconcile` and `reconcileRecovery` read an existing receipt
without re-checking, because a receipt written under a known version is
evidence in its own right.

The reason for refusing is structural. A managed mutation is authorized as a
reversible change to one configured primary-key row. The metadata migration is
schema DDL over the evidence store that records those mutations, so running it
inside an authorized tool call would make an irreversible change to the very
mechanism that proves reversibility, and would let a call rewrite the version
its own verification depends on. The adapter refuses instead of repairing.
`nomo recovery install` refuses the same way: it will not overwrite version 1
metadata, and reports that version 1 requires explicit migration.

The limit worth stating is what is not covered here. These are PGlite and
fault-injection tests over the exported function.
`scripts/src/verify-managed-postgres.mjs` installs fresh metadata against a real
server repeatedly and never migrates version 1 metadata, and the migrate
command is not executed end to end in any test. The reason is structural
rather than an oversight: version 1 metadata only exists on a
database that an earlier release installed, and nothing in this repository
creates one. That is why real-server migration certification belongs to the
remaining PostgreSQL gap rather than being closed by this document.

## Verification interpretation

The focused evidence includes runtime, managed SQL, MCP, managed SDK, local
document, filesystem, CLI and conformance tests. These are in addition to
earlier tests. Run the suites rather than trusting a count in this table; the
rows that carry numbers were each read against the source on 2026-09-26. The
1 GiB logical quota is the `maxTotalBytes` default in
`packages/runtime/src/reserved-vault.ts`, the 100-request contention figure is
the test at `packages/runtime/src/budget.test.ts`, and the counts this document
deliberately avoids are the ones that change with the tree.
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
