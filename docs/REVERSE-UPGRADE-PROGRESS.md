# Reverse upgrade implementation progress

## Adapter conformance and Windows filesystem follow-up, 2026-09-15

`void recovery conformance` runs eight common runtime checks for each supported
filesystem operation. POSIX runs 32 checks across create, write, delete and
rename. Windows runs 24 checks across create, write and delete; rename is
explicitly refused until separate Windows evidence exists. Its JSON report
includes a versioned capability profile and platform/Node evidence. The reusable runner rejects
false-success fixtures, altered requests/plans and unsafe retries; failed fixture
cleanup also fails the report. See `ADAPTER-CONFORMANCE.md` for the exact limits.

Managed Windows filesystem operations now flush file contents without attempting
unsupported directory fsync. They support bytes recovery for writable files and
refuse unsupported mode requests before mutation. Portable path validation
rejects Windows aliases/streams, and CLI state containment resolves native paths
and symlink/junction ancestors. The real MCP subprocess fixture uses native
file URL conversion on Windows.

Local Windows validation: all 24 built-in conformance cases and 15 focused
adapter/CLI/MCP/negative-check tests passed. Runtime, connector and CLI typechecks
passed. The Windows/Linux Node 24/26 persistence workflow includes these checks.
This advances R05/R12 but does not complete those milestones or certify process
death, provider integrations, concurrent hostile writers or power loss.

A broader Windows CLI run also identified the persisted approval-state
limitation: twelve approval tests require Unix owner-only directory semantics.
Those checks stay fail-closed. Native Windows approval-directory ACL support
has since been added rather than left open: on POSIX the mode-bit and uid rule
is unchanged, and on Windows `inspectApprovalStateDirectory` reads the DACL
through the shipped icacls binary, because Node reports 0o666 for a directory
whatever chmod was asked for and `process.getuid` is absent, which made the old
predicate unsatisfiable there. A directory VOID can claim is narrowed to the
operator before it is accepted; a proven foreign write grant is refused and is
never acknowledgeable; anything unproven is reported as `unverifiable` and is
refused unless the host names the finding and accepts it. Refusals carry a fixed
code and never a path or an account name.

That Windows branch is written and reviewed but was not executed: the verification
below was run on macOS, where the DACL tests skip by construction, so no observed
run covers icacls parsing, DACL narrowing or the per-directory memo. A Windows host
run is still required before any claim about it. No claim of a full Windows CLI
suite pass is made either way.

### Python transport client, 2026-09-25

`python/void-transport` adds the standard library Python client WP-R12 asks
for. It speaks the same wire as `packages/proxy/src/transport/http.ts` --
JSON-RPC 2.0 over HTTP POST to one explicit `host:port` -- and refuses rather
than guesses: a response whose `id` is not the id that was sent, a body over
the configured limit, an unknown shape, a redirect, and a mutating
`tools/call` without an idempotency key are all declined, and there is no
silent retry. Its canonical JSON is checked against the repository's own
`packages/ledger/src/canonical.ts` running under `node`, comparing canonical
text, exact UTF-8 bytes and the `sha256:<hex>` digest over a shared corpus
that includes Unicode, empty containers and the JavaScript number
boundaries. The integration tests spawn the real relay: `createHttpRequestRelay`
from `packages/proxy/src/relay/http-requests.ts` bound to a loopback port, with
`void recovery serve` behind it as the real MCP server. The client has no TLS
or certificate pinning, verifies no ledger, runs no replay, and covers no
provider behaviour, so provider certification and the broader capability
profiles remain open R12 work.

This tracks REVERSE-TOOL-UPGRADE-PLAN.md. No full milestone is declared complete
by the existence of a prototype or a narrow passing test.

| Package | Current implementation                                                                                                                                                 | Remaining release gates                                                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| R00     | Contract, coverage, context corrections, descriptor vs executable adapter distinction                                                                                  | Machine-readable provider certification and public-site alignment                                                                      |
| R01     | Signed local journal, immutable operation identity, unknown results, adapter reconciliation                                                                            | Cloud transactional journal, full persistence fault matrix                                                                             |
| R02     | Shared runtime used by managed CLI/MCP, TS SDK and local workbench document writes/Undo, plus a production composition root at `packages/proxy/src/legacy-root.ts` with explicit operator selection, an unknown-name refusal, and three bound tools (`postgres.row.update`, `postgres.row.delete`, `aws.s3.object.delete`) each with a cross-layer fixture | Wiring the root into `void-proxy` and the SDK client, and S3 conformance against a real bucket rather than a modelled ETag client || R03     | Encrypted durable artifacts, reserved capture/outcome/recovery capacity, shared quota, legacy reads, key rotation, plus an explicit operator-driven file-vault collector with a manual-by-default policy, an external pin-evidence index and a journaled run report                                                                 | True streaming of a large artifact, pin lifecycle and release, reserved-vault GC, retention index backup, quota migration. A host that will not load that much now gets a refusal naming the size instead of an allocation it cannot satisfy; the read budget defaults to the write quota so nothing changes by default                                                                 |
| R04     | Structured row mutations, revision trigger, atomic outbox, verified restore, real prepare serialization conflict, managed deadlock, terminated sessions, client SIGKILL after COMMIT, cascade/tenant/migration fixture paths | Physical network partition, in-flight client kill, and real-server certification of cascade, tenant and migration                       |
| R06     | Persistent run and explicit-list plans, full boundary digest, checkpoints, paused/unknown/conflict states, one active workspace job, and a durable lease on that job that is reclaimed only when it expired and its holder is provably gone | Dependency/time selection, cluster-wide fencing across hosts, MCP/cloud job surfaces                                              |
| R07     | Existing taint modules retained, plus recovery provenance: the adapter's read and write sets are recorded in the durable capture, and a recovery plan whose undo order cannot be proven is refused rather than run | Cross-agent dependency closure, and read sets from the adapters that do not report one                             |
| R08     | Existing legacy S3 retained                                                                                                                                            | Managed S3/versioning, Supabase-specific capability tests                                                                              |
| R09     | Existing OAuth layer retained                                                                                                                                          | GitHub/Vercel executable recovery adapters and real sandbox conformance                                                                |
| R10     | Local daily workspace/per-agent reservations plus a shared, fenced server ledger in `packages/runtime/src/budget.ts`: reserve before dispatch, settle on a terminal result, release only on confirmed non-execution, and a crash between reserve and settle leaves a durable spend that expiry surfaces without refunding. Refuses session-scoped stores, unreadable account state, conflicting settles and exhausted limits. The crash case was proved with a real SIGKILLed child process, and cross-worker fencing with concurrently spawned processes | Cluster-scoped store, policy modes and approval integration. `execute.ts` wiring is deliberately not done yet: reserving before the journal transaction requires the preflight observation, and hoisting preflight out of the transaction breaks a real property that `crash.test.ts` pins, namely that a restarted executor reconciling a dispatched operation must not observe, prepare or execute it again. The lock-ordering constraint is the real remaining design work || R11     | Not started                                                                                                                                                            | Staged graph, cancellation, barriers and restart semantics                                                                             | Policy modes now exist on the recovery path: `audit` and `plan` refuse dispatch before the policy is consulted, `normal` is the unchanged default, and `recovery health` reports the effective mode. |
| R12     | Executable adapter interface, managed TS SDK, reusable conformance runner, filesystem command/profile, and a standard-library Python transport client whose canonical JSON is checked against the repository's own                                                     | Provider-specific fixtures and broader capability certification                                                                       |
| R13     | Local MCP entry point with operator identity/policy                                                                                                                    | OpenCode doctor/init, authenticated remote executor, managed egress boundary                                                           |
| R14     | Coverage, runbook, scoped validation evidence, a `void.export-bundle.v1` bundle whose manifest carries a completeness proof anchored out of band, and a dependency-free metrics surface recomputed from the existing ledger, journal and vault     | Operational certification, and any claim that the bundle or metrics constitute one                                                                          |

Retained job update: local MCP and cloud HTTP now expose plan/status/apply job
surfaces on the same constrained single-job runner. Run/explicit-list selection,
signed digest binding, checkpoints, terminal results and blocked forward writes
are shared. Dependency/time/checkpoint selection, scheduler, durable leases and
fencing, cloud MCP jobs and cross-agent provenance remain excluded.

## Verified foundation

- Actual managed PostgreSQL mutation and transactionally bound before/outcome evidence.
- Encrypted capture before dispatch and signed local lifecycle.
- Human drift and ABA conflict refusal, including substituted trigger and table identity.
- Restarted runtime recovery, idempotent repeated calls and lost-response reconciliation.
- MCP client integration and an actual stdio subprocess startup/deny test.
- SDK capture-failure refusal and recovery using the same runtime.
- Concurrent local irreversibility accounting with unknown outcomes retained.

## Next implementation sequence

1. Keep M1 at verified-subset status. The real verifier now covers backend
   termination at commit boundaries, client SIGKILL after forward/recovery
   COMMIT, and managed deadlock. Cascade, tenant and metadata migration have
   positive PGlite fixture coverage but are not real-server certification.
2. Cloud document integration now uses the shared runtime in one database
   transaction. Extend conformance before covering external cloud tools.

3. Design and verify an append-only managed commit/revert slice. It must not
   reset or force push shared history, and it needs separate remote and process
   failure evidence before any broader Git claim.
4. Extend persistent recovery planning with resource/provenance dependencies,
   time selection, leases and fencing.
5. Build provider adapters and cloud journal/transport, then budgets/staged work
   and operational evidence against the exit criteria in the original plan.

No production deployment, provider permission expansion or destructive production
operation is part of the verification reported here. Existing GUI and model
configuration remain separate from the reverse engine implementation.

## Verification checkpoint

Earlier local checkpoint, before managed Git and persistent recovery jobs:
`pnpm check` passed 579 package/application/script tests; nine OAuth tests
passed and two opt-in cloud integration tests were skipped. See
`UPGRADE-CHECKPOINT.md` and the current task evidence for later validation. The three isolated cloud GUI, recovery and Prime
protocol scenarios were subsequently run successfully. The real PostgreSQL verification was rerun successfully with the
OS-backed writer mutex and relation certification checks. Fifty-three tests cover
the newly added runtime, managed SQL, MCP and SDK paths, including three separate
process tests. This does not certify unfinished work packages or production
provider integrations.

### Capacity follow-up, 2026-09-12

The CLI now uses a durable reservation-backed encrypted SQLite vault. Runtime
reserves capture/outcome/recovery slots before preparation, releases unused
slots only on confirmed failure, and retains them for unknown outcomes. Legacy
file snapshots remain readable and count toward the logical shared quota.
The new six-test suite covers capacity contention, slot identity, key rotation,
legacy compatibility, corruption, runtime refusal and a killed snapshot writer.

The isolated PostgreSQL script passed with this vault, a real SQLSTATE 40001
conflict during managed preparation and SQLSTATE 40P01 in two disposable raw
transactions. The human change remained intact. This does not claim physical
disk preallocation, automatic retention/GC or complete managed deadlock coverage.

### Local document integration, 2026-09-12

Local workbench edits, model document mutations and branch document copies now
use the shared runtime and reserved encrypted vault. The existing encrypted
workspace commits document changes with their original signed evidence. New
signed entries carry a managed runtime marker; a missing new journal cannot
silently fall back to legacy recovery. Older unmarked signed operations retain
their original Undo path. Runtime artifacts use the existing workspace key.

Five new integration tests cover sequential/repeated Undo after restart, failed
capture with no document write, human conflicts, missing runtime evidence and
legacy compatibility. At this checkpoint cloud `server.mjs`/`steps.mjs` used their original transaction
path. The cloud follow-up below supersedes that limitation for managed documents. The production workspace login was separately verified with HTTP 200.

### PostgreSQL connection faults, 2026-09-12

The isolated verifier now terminates only its own acquired PostgreSQL backend
sessions at the COMMIT boundary. Before COMMIT, both row mutation and receipt
roll back; VOID keeps an unknown outcome and refuses automatic redispatch or
recovery without evidence. After COMMIT, a fresh adapter reconciles the durable
receipt and restores the row. A terminated recovery connection after COMMIT is
also reconciled without a second recovery receipt.

A real lock cycle now includes the managed executor during dispatch. The test
accepts PostgreSQL's victim selection and checks the corresponding safe result:
unknown without redispatch when the managed transaction loses, or successful
execution and verified Undo when the competing transaction loses. This does not
claim that both victim selections were observed in one run.

Validation: `scripts/src/verify-managed-postgres.mjs` covers the isolated
database scenarios recorded by its JSON report, including backend termination,
client SIGKILL after forward/recovery COMMIT, and managed deadlock. No
production data or credentials were used. This remains connection-fault
coverage, not physical network partition behavior, an in-flight client kill,
PostgreSQL server crash, or completion of M1. Shared-runtime cloud integration
remains separate feature work; the deployed web login is unchanged.

### Cloud documents and local Prime execution, 2026-09-12

Cloud editor writes, branch copies and agent document mutations now use the same
managed document adapter and recovery runtime as the local workbench. Encrypted
artifacts, capacity reservations, signed lifecycle events and document state share
one SQL transaction under the session lock. This is valid for managed documents
only: an external side effect must not use this transaction-bound journal. The
vault limits each artifact to 4 MiB and each session to 64 MiB of logical reserved
and retained encrypted storage; retention and key migration remain future work.
Legacy signed document Undo remains supported. A managed marker never silently
falls back to legacy recovery when artifacts or lifecycle evidence are missing.

The isolated cloud GUI and recovery tests passed, including atomic rollback,
capacity failure, missing artifacts, conflicting history, branch copies and
idempotent Undo. The local Prime worker protocol separately tests authentication,
single claim, stale-result refusal and no replay of a lost job. Prime tool calls
are outside captured document Undo; its outer run is signed as R3, and individual
tool notifications are informational rather than captured recovery receipts.

## Cooperative filesystem and public demo, 2026-09-13

The managed filesystem adapter and CLI/MCP configuration now support one regular file with bytes and mode recovery. Real filesystem tests cover binary data, restart, idempotence, human edits, ABA, permissions and unsafe paths. Missing atomic filesystem receipts leave uncertain outcomes unknown. This is not completion of R05.

The public demo uses visitor-scoped managed cloud documents and a fixed TokenRouter model, without exposing private workspace or Prime credentials. Mobile controls use consistent SVG dimensions and a named native dialog. Research and the larger design sequence are recorded in `GUI-DESIGN-RESEARCH.md`.

## Recovery process-death boundary, 2026-09-13

Two additional real subprocess tests kill the executor with SIGKILL after an
inverse commits, before the runtime receives its result. The signed journal
remains at `recovery-dispatched`; a restarted executor refuses to send a second
inverse. With a receipt atomically committed alongside the fixture value, explicit
reconciliation writes one restored outcome. Without that receipt, restoration
remains unknown even though the value matches the original. Repeated recovery
and reconciliation leave one forward mutation and one inverse.

The tests use a disposable SQLite adapter fixture, the actual local signed
journal and reservation-backed encrypted vault. All 32 runtime tests and runtime
TypeScript checks passed. This advances the process-crash portion of R01/R06; it
does not certify PostgreSQL client SIGKILL, network partitions, external provider
receipts, or the full M1 milestone.

## Persistence and interface recovery follow-up

Twenty additional before/after journal and vault failure cases now cover local
retry, reconciliation, signed evidence and retained capacity. The terminal fixes
verification exit status, selected-run cancellation and fatal-exit cleanup. The
shared GUI exposes retained operations for deleted-document recovery. See
[the checkpoint](UPGRADE-CHECKPOINT.md) for fresh verification and exact limits.
This does not close M1 or add multi-operation recovery/provider certification.

## Managed Git subset, 2026-09-15

The local `git.managed` adapter adds structured POSIX worktree and logical index
recovery for one selected target. It does not complete WP-R05 or add commit or
remote recovery. Both lost-response reconciliation paths remain unknown without
an operation-specific durable receipt. Stage can leave a dangling Git blob that
retains selected bytes until garbage collection. The disposable six-scenario,
48-check shared runtime profile is evidence for its named cases only, not full
Git or process-death certification. See `MANAGED-GIT.md`.
