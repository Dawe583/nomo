# Executable recovery contract

VOID can restore only the scope captured and verified by the selected executable
adapter. A registry entry, OAuth connection, snapshot or generated inverse name
alone is not proof of recoverability.

Three independent observations describe each call:

| Axis          | Values                                                                 | Meaning                                                                  |
| ------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Effect        | read, write, external-disclosure, mixed, unknown                       | Observable action                                                        |
| Reversibility | r0, r1, r2, r3, unknown                                                | Exact restore, restore with trace, compensation, no inverse, or unproven |
| Readiness     | verified, conditional, expired, unsupported, unknown-outcome, conflict | Current availability of that recovery                                    |

R0 is not a synonym for GET. A read can disclose information irreversibly. R1
restores declared state but does not erase logs, observations or transaction
history. Every adapter supplies a scope and a resource set. Unknown blast radius
cannot pass an exact count limit.

## Managed execution

`RecoveryAdapter` in `packages/connectors/src/recovery.ts` is the executable
contract. The root `ConnectorDescriptor` is metadata; the older `registry.ts`
Connector retains compatibility for legacy capture/apply integrations. Neither
is implicitly promoted to a managed adapter.

The runtime records received, authorized, prepared, dispatched and outcome in a
signed journal. Arguments and before images go into authenticated encrypted
artifacts. Durable capture precedes dispatch. The adapter must revalidate
observations and provide atomicity or compare-and-swap at the actual write.

Workspace and operation ID identify one immutable request. Reusing the ID with
another request or adapter version is refused. An interrupted dispatch is
unknown, never automatically repeated. Reconciliation reads durable evidence.
An absent receipt is not proof that nothing happened.

Recovery requires the exact plan digest and separate operator authorization.
A changed plan is refused. Human drift is a conflict. Recovery writes a new
signed event linked by `reverses`; it never deletes original evidence. Unknown
recovery results can be reconciled when the adapter supports durable receipts.
Reconciliation never repeats the inverse.

## Persistent recovery jobs

The local runtime and cloud managed documents can persist a recovery plan for one exact run or an
explicit list of operation IDs. The signed plan includes a full ledger sequence and hash boundary, every
selected single-operation plan in reverse success order, and known residuals. Its digest covers the
complete plan except the digest field. Approval binds that digest. Apply loads the stored plan by job
ID rather than trusting plan bytes supplied again by a caller.

The runner records approval, application, each completed step, and the terminal
result in the same signed workspace journal. Each step uses the existing
single-operation recovery path. A restart after an inverse but before the job
checkpoint therefore reads the operation receipt and does not authorize another
inverse. Conflict stops the remaining steps and records them as blocked. Unknown
stops without retry; after explicit operation reconciliation, the same job can
resume. A deterministic setup failure after approval records `paused` with a
redacted `step-unavailable` code and operation ID. New forward operations remain
blocked. Restore the exact adapter version and required local state, then run the
same job ID again. Compensation makes the job partial, never restored.

Cloud managed documents use the same signing, boundary, digest-matched single-job
planner and durable job runner as a limited retained surface: one exact run or an
explicit operation list, `planned → approved → applying → checkpoint → restored /
partial / conflict / unknown / paused`, resumable steps, blocked forward writes and
digest-bound approval/apply. The slice remains descending journal-sequence order only
and has no cross-agent dependency closure, time or checkpoint selection, independent
branch continuation, scheduler, lease or external fencing. The existing taint
graph stays an inspection-only neighborhood around signed records; the local and
cloud retained planners never consume it. The retained local MCP job tools are
available on the same constrained runner. There is still no cloud MCP job surface.

## Trust boundary

Current local mode is cooperative. It does not intercept arbitrary shell,
network, browser or third-party tool actions outside the managed executor.
The operator controls credentials, configured tables, policy and local keys.
An agent may not supply its own workspace, adapter identity or approval grant
to the managed MCP server. The local policy is reloaded for each request.

The local journal serializes a directory using a SQLite transaction as an OS-backed
writer mutex. Signed JSONL remains the operation source of truth. Process death
releases the mutex; a SIGKILL regression verifies that the next executor reads
`dispatched` as unknown without repeating the write. This requires a local disk,
not NFS or a distributed filesystem. A separate in-workspace single active job
check refuses new forward writes while one retained job is unterminal, but it is
not a durable worker lease and offers no fencing: two local writers obey the same
SQLite mutex, while concurrent cloud writers rely on the outer session advisory
lock rather than a lease. A legacy `.runtime.lock` blocks startup until the old
executor has been stopped and the operator has reviewed migration.

The CLI uses `reservedRecoveryVault`: encrypted payloads and reservation changes
commit in one local SQLite transaction. Before preparation the runtime reserves
three bounded slots for capture, outcome and recovery evidence. Default limits
are 64 MiB per plaintext artifact and 1 GiB total encrypted payload plus unused
reservations. Successful writes replace their reservation with actual byte use.
Confirmed failures release unused slots; unknown results retain them. Stored
artifacts are never implicitly deleted.

This is a logical payload quota, not physical disk preallocation. SQLite pages,
journals and filesystem overhead require extra free space. Real disk exhaustion
still fails closed before dispatch, or leaves an uncertain result after dispatch.
Streaming, automatic collection and administrative quota migration remain
unfinished. Collection for the legacy file vault is operator-driven and is
described under "File recovery vault retention" below. Capacity settings
persist and mismatching workers are rejected.

## File recovery vault retention

`collectVaultGarbage` is the explicit, operator-driven collector for the legacy
file vault. The shipped default `MANUAL_RETENTION_POLICY` is `mode: "manual"`
with no TTL, so collection deletes nothing until an operator selects an age
policy. Nothing is collected implicitly.

Retention evidence is a per-artifact record kept in a separate index
directory, never inside an artifact workspace directory:
`reservedRecoveryVault` reads every file there as a legacy artifact, so a
sidecar in that directory risks "Recovery artifact cannot be verified". An
artifact with no record is protected, because its pin state is unknown. A
record naming a `recovery` or `operator` pin is protected, and a policy that
gives a pinned kind a TTL is refused as a contradiction. Unreadable or invalid
evidence refuses the whole run before any delete; it is never read as
"unpinned". There is no unpin operation: a pinned artifact stays retained until
an operator reviews it out of band.

The report is the connector `GarbageReport` shape
(`skippedPinned`/`retained`/`deleted`/`freedBytes`), where `retained +
skippedPinned + deleted` equals the artifact count seen at the start. Every run
is a signed `void.operation.v1` journal chain under `adapterId
"vault.retention"`, bound to the policy digest, ending in `succeeded` with the
report: a delete is never silent. Runs serialize on `.retention.lock` in the
index directory, and a competing or stale lock refuses the run.

This does not cover the reserved SQLite vault, pin release, index backup, or
administrative quota migration.

The older `localRecoveryVault` remains compatible but offers only an individual
artifact limit. `reservedRecoveryVault` reads its existing files and counts them
against the shared quota. Stop old writers before migration; mixed writer
versions are not supported.

A complete retained-state set is the signing key, every signed JSONL journal,
the non-secret adapter/encryption-key configuration, the encryption key retained
separately in the operator's secret store, the SQLite-consistent vault snapshot,
and every legacy vault artifact. The encryption key value is never written to
the backup manifest or a plaintext diagnostic. The managed target and its
non-secret configuration are retained separately.

With every executor stopped, create a new empty backup directory from the
repository root:

```sh
node scripts/src/recovery-backup.mjs create \
  --state /path/to/recovery-state \
  --backup /path/to/new-backup \
  --encryption-key-env VOID_RECOVERY_KEY \
  --executor-stopped
```

The helper copies the signing key, journals and legacy artifacts. It uses the
SQLite online backup API for `vault/vault.sqlite`, so committed WAL pages are
part of the destination snapshot without copying live `-wal` or `-shm` files.
The destination manifest inventories those files and records each journal's
entry count, last sequence and head digest. Retain the printed manifest digest
outside the backup directory as the completeness anchor, then verify before
restoring:

```sh
node scripts/src/recovery-backup.mjs verify \
  --backup /path/to/backup \
  --anchor MANIFEST_SHA256
```

Verification categories fail closed. `history_unanchored` means the manifest
or trusted expected anchor is absent or changed. `history_incomplete` covers
a missing, changed or validly signed truncated journal prefix;
`history_invalid` covers a journal signature or ledger hash-chain failure. A
missing signing key, a wrong encryption key, and missing operation evidence
remain the runtime's `key_unavailable` and `missing_artifact` categories.
`backup_incomplete` or `vault_unverifiable` covers other inventory or snapshot
mismatches. No category is repaired automatically.

This restores retained state, not path identity. `filesystem.managed` binds an
old operation to the original absolute root and its inode/ctime revision. Copy
or move that managed root and Undo returns `status: "conflict"` with
`evidence: null`; the recovery state must not silently rebind the operation.
A real old-operation Undo is supported only when the managed target remains at
the original path/volume/revision while the complete recovery state is restored.
Signature and hash verification establish retained history integrity, not
completeness of an unanchored truncated history.

See `RECOVERY-COVERAGE.md` for the supported subset and evidence.

## Legacy connector snapshot retention

`LocalSnapshotStore` is separate from the encrypted managed recovery vault.
Its namespace byte budget still evicts oldest unpinned snapshots. Recovery and
operator pins survive budget eviction, age-based retention and explicit garbage
collection. Admission that cannot fit alongside protected snapshots refuses
before writing or evicting anything. Invalid cutoffs and missing, unreadable or
invalid sidecar metadata refuse cleanup instead of treating evidence as unpinned.

Every new legacy capture writes a metadata sidecar, including `{}` for unpinned
bytes. Repeated captures preserve existing metadata and reject conflicting pin,
key or expiry bindings. Older bytes without a sidecar remain directly readable,
but retention and further admission in that namespace require operator review.
Do not manufacture empty metadata for an old snapshot whose pin state is unknown.

Cooperating mutations are serialized per namespace and use an exclusive
`.retention.lock`, following the manifest writer's locking model. A competing or
stale lock refuses mutation. After a crash, stop writers and inspect retained
bytes and metadata before removing a stale lock. Never clear another live
writer's lock. Do not mix older writers that ignore this protocol. This is a
local-filesystem boundary, not a distributed lease or protection against writers
that bypass the store. Partial publication failures may leave evidence for review.
There is no automatic unpinning, administrative quota migration or key rotation.

## Irreversibility budget

Managed runtime defaults to requiring verified R0/R1 recovery. A host that
explicitly disables that requirement must configure `irreversibilityBudget`
before R3, unknown or currently unverified recovery operations can execute. The local implementation reserves
one unit per operation in the same signed workspace transaction as authorization.
`dailyLimit` caps a UTC authorization day; optional `perAgentDailyLimit` narrows
it further. Unknown and unfinished operations retain their units. Only a
confirmed failed operation releases a reservation. Host time defines the day;
this is not a distributed-clock accounting service.

The budget does not grant permission: the host authorization callback must
still allow the call. It does not make R3 reversible; a successful R3 operation
cannot produce a verified recovery plan. Cloud/distributed budgets, mode
rollout, weighted costs and staged reservations remain future work.

## Local managed documents

Local Workbench uses the shared runtime for model and operator document writes,
deletes, branch copies and Undo. Its host lock serializes edits; its existing
encrypted workspace snapshot atomically stores document transitions and signed
legacy evidence. The new runtime journal and encrypted artifacts add lifecycle
and capacity protection. Read tools remain on the existing lightweight path.

New signed document entries identify the managed runtime operation. Missing
runtime evidence refuses recovery; it cannot masquerade as an old operation.
Unmarked historical operations still require their original signature/capture
verification.

## Cloud managed documents

Cloud managed documents run the same local planner/runner inside one outer SQL
transaction: one exact run or explicit operation ID list, plan by stable job ID,
digest-bound approval before application, signed planned/approved/applying/
checkpoint/restored/partial/conflict/unknown/paused events, and blocked forward
writes while an active job is unterminal. The HTTP surface exposes only
`/api/sessions/:id/recovery-jobs/plan`, `/apply` and `/:job`; it projects plan
digests, step operation IDs/sequences and operation residuals/statuses
without operation payloads, captures or provider receipts. There is no
dependency closure, time or checkpoint selection, scheduler, lease, fencing or
cloud MCP job surface. The retained local MCP host is the only MCP job surface.
