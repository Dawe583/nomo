# Executable recovery contract

NOMO can restore only the scope captured and verified by the selected executable
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
redacted `step-unavailable` code and operation ID. A worker that takes over a
job whose lease expired records `paused` with `lease-expired` and the operation
ID it stopped at. Both codes validate, and both are readable after a restart.
New forward operations remain blocked. Restore the exact adapter version and
required local state, then run the same job ID again. Compensation makes the job
partial, never restored.

Cloud managed documents use the same signing, boundary, digest-matched single-job
planner and durable job runner as a limited retained surface: one exact run or an
explicit operation list, `planned → approved → applying → checkpoint → restored /
partial / conflict / unknown / paused`, resumable steps, blocked forward writes and
digest-bound approval/apply. That surface is still one exact run or an
explicit operation list, in descending journal-sequence order. The existing taint
graph stays an inspection-only neighborhood around signed records; the local and
cloud retained planners never consume it. The retained local MCP job tools are
available on the same constrained runner. There is still no cloud MCP job surface.

Planner selectors exist as pure functions in
`packages/runtime/src/recovery/plan.ts`. `resolveRecoverySelection` takes a
journal state and resolves a `run`, `operations`, `dependencies`, `time` or
`checkpoint` selector to the exact operation IDs the plan shape above already
stores, so a signed plan still records the steps it undoes rather than the rule
that chose them, and its digest still binds that list.
`independentBranches` reports the branches that stay selectable while another
operation is stopped, conflicting or in progress, holds the ones a proven
dependency edge reaches in either direction, and reports a step that recorded no
reads as unproven rather than as independent. Both read their dependencies from
the one edge list `provenanceEdges` returns, the same list `orderRecoverySteps`
proves an order from, so selection and ordering cannot hold two opinions about
what depends on what. Every malformed, unresolvable or unprovable claim is refused
with the valid values named: an unknown or malformed kind, an unexpected key, a
non-UTC or unparseable instant, an inverted window, a checkpoint past the signed
boundary, a dependency root the journal does not contain, a root that recorded no
read set, and a branch whose order cannot be proven. Nothing falls back to
journal order, and a selector that resolves to nothing is a zero-step plan rather
than a refusal.

The selectors are wired. `planRecoveryJob` in `packages/runtime/src/execute.ts`
builds a `RecoveryJournalState` from the retained records and their prepared
captures in one pass, resolves the selector once against it, and feeds the
resolved operation IDs into the existing step loop. Every selector still lands
on the two recorded `RecoverySelection` kinds, so a signed plan keeps naming
the steps it undoes rather than the rule that chose them and its digest, and
every consumer of a plan, is unchanged. Two refusals are specific to that
boundary: a rule that reaches nothing has no list to record and is refused as
the empty window it is, and a job identity that is already planned cannot be
re-planned through a rule the plan does not store, because re-resolving it later
may reach different operations. A `run` selector is recorded verbatim, so a run
that has done nothing is still the zero-step plan it always was.

A blocked step is visible in a plan rather than assumed away: a job that is
applying, paused or in conflict holds the step at its checkpoint, and anything a
recorded read connects to it is returned as a `blocked-by-conflict` residual
instead of a step.

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
Streaming, pin release, retention-index backup and administrative quota
migration are implemented and described under "File recovery vault retention"
below. Automatic collection remains unfinished: collection for the legacy file
vault is operator-driven. Capacity settings persist and mismatching workers are
rejected.

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
"unpinned".

`releaseVaultPin` is the supported way to remove a pin. The caller names the pin
it believes is recorded, and the release is refused unless the recorded owner
and kind match it exactly, so a stale operator view cannot release a pin that
has since changed. A release against an artifact with no evidence refuses, and
against an artifact with no recorded pin refuses: absent evidence means
"protect", and converting unknown into collectable is the one inference
retention must not make. The release is recorded as a `release` field naming
the operator, the time and the pin it removed, not as an absent pin, so an
artifact an operator released stays distinguishable from one nobody reviewed.
It takes the same `.retention.lock` the collector holds, so it cannot land in
the gap between a collector's scan and its unlink. It never touches the
artifact; only the record protecting it changes. Marking and releasing share
one sidecar writer, so both land as a synced temporary renamed into place.

The report is the connector `GarbageReport` shape
(`skippedPinned`/`retained`/`deleted`/`freedBytes`), where `retained +
skippedPinned + deleted` equals the artifact count seen at the start. Every run
is a signed `void.operation.v1` journal chain under `adapterId
"vault.retention"`, bound to the policy digest, ending in `succeeded` with the
report: a delete is never silent. Runs serialize on `.retention.lock` in the
index directory. A competing lock refuses the run. A lock left behind by a
process that died is reclaimed only when both of these hold: its recorded lease
has passed, and its recorded owner is provably gone. Either check being
uncertain keeps the refusal, so a lock that cannot be read, parsed, or attributed
never becomes a second collector.

### Retention index backup

The index is authoritative state, not derived state: it is the only record of
which artifacts are pinned, and a lost sidecar is indistinguishable from an
artifact nobody ever reviewed, so it cannot be rebuilt from the artifact tree.
`backupRetentionIndex` therefore copies every evidence sidecar and writes a
`void.retention.index.v1` manifest naming each with its byte count and SHA-256.
A file in the index that is not a digest-named `.meta` sidecar refuses the
backup rather than being skipped, because a backup that quietly omitted one
would restore an index that no longer protects what it used to. `.retention.lock`
is excluded: it is live coordination, and restoring a stale lock would freeze
collection on the next run. The manifest is written last, so a backup
interrupted before it lands has no manifest and cannot be mistaken for a
complete one.

`restoreRetentionIndex` reads and verifies every manifest entry before
installing any of it, and refuses the whole restore when a file's digest or
byte count disagrees, when the manifest is missing or malformed, or when the
backup holds a file its manifest does not list. A partial restore would leave
the index asserting protection it no longer holds, so nothing is installed
until everything verifies. A restored pin protects its artifact and a restored
release does not, which is what a test asserts by collecting after a restore.
Both a backup and a restore target are refused inside the artifact root, for
the same reason evidence is.

### Managed vault streaming

`putStream` and `getStream` are the chunked surfaces of `reservedRecoveryVault`.
A streamed write declares its exact plaintext length; that declaration is proved
against the artifact quota before the source is read at all, and a source that
delivers more or fewer bytes than it declared is refused with nothing stored.
Encryption is GCM with fixed expansion, so the ciphertext length is known from
the declaration and the payload is one buffer filled in place, rather than a
chunk list plus a concatenation. A streamed read verifies size and digest, then
yields bounded plaintext chunks.

Measured in a fresh process, because a process that already holds other
artifacts cannot report a meaningful high-water mark. On a 32 MiB artifact the
value path (`put` then `get`) peaks at about 360 MB of resident memory, roughly
eleven times the artifact; the streamed round trip peaks at about 70 MB. The
gap is the copies: `put` built a full canonical JSON string, a `Buffer.concat`
copy, and a base64 string four thirds the artifact's size, and `get` still adds
a `Buffer.from` copy, a `Buffer.concat`, a string and a parse. `getStream` is
the surface that removes the read-side copies, and `putStream` the one that
removes the write-side ones; a caller that keeps using the value path keeps
paying for them.

The remaining cost is the SQLite blob binding: the stored payload is one `BLOB`
column, so it is materialised once no matter how it is written. That sets the
floor at about two full-size buffers, and the measurement bears it out, a
64 MiB artifact peaks at about 141 MB, still linear in artifact size and still
far below the value path. Streaming also removes the base64 string entirely, by
hashing the base64 preimage in three-byte-aligned slices; that is exact because
the base64 alphabet contains nothing `JSON.stringify` escapes, so the
concatenation is byte-identical to the one-shot encoding. Reading a legacy file
artifact through `getStream` refuses with a named message, because
`localRecoveryVault` has no chunked reader. `put` and `putStream` are one
statement, so they cannot diverge, and both store the same content digest for
the same plaintext.

### Administrative quota migration

`migrateCapacity` is the only way the persisted capacity changes. It is
compare-and-swap: the operator states the capacity the vault is expected to hold
now, and the move is refused unless the vault holds exactly that, so a second
operator, a worker that already migrated, or a stale decision cannot apply it.
The move, its new capacity and a `capacity_migrations` row recording the
operator, the from and to capacities, the bytes in force and the reservation
count all commit in one transaction, so an operator who cannot read back the row
has no evidence the move happened. Lowering the total below the bytes already
stored is refused with the byte count named, because that would leave artifacts
no writer can place again. Ordinary `put`, `reserve` and `release` never
migrate, and no collection path calls it: capacity never follows from ordinary
use. A worker whose configured capacity disagrees with the persisted one is
still rejected on every operation, which is what makes the migration the
visible way out rather than a bypass.

The SQLite vault now carries its own retention under schema 2: a `retention`
evidence table and a per-artifact write time added to `artifacts`. The file
vault's invariants hold verbatim: absent or conflicting evidence protects, a
pin is released only by a named operator with a recorded `release` field, an
unreadable or invalid record refuses the whole collection before any delete,
and `collectReservedVaultGarbage` runs the same signed journal chain under
`adapterId "vault.retention"`, so a delete is never silent. A schema 1
database moves to schema 2 on the next open, and its existing artifacts carry
no write time, which keeps them protected: an unknown age is not a passed
age. An older binary reading a schema 2 vault refuses on the version, the
same stop-old-writers rule the capacity migration already established. The
collector is the operator's `nomo recovery collect` command, which takes the
workspace's recovery configuration file and an optional `--retention-policy`
JSON file; its shipped default policy is `manual` and collects nothing. An
optional `--dry-run` predicts the report without deleting, opening a journal
chain or writing a signature. The
collector still does not read
`getStream`, and there is no streaming reader
for a legacy file artifact, and no partial-restore path: a restore that
cannot verify every entry refuses everything.

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

A decision record written by the proxy carries the reason it
exists: `attribution.policyDigest`, the digest of the policy content the call
was decided under, and `attribution.rule` with the index of the rule that fired
and the rationale that rule states. Both live in the signed body, so the entry
hash already covers them. This is additive: a record written before the field
existed has no `attribution`, keeps verifying, and needs no migration, because
the hash is over the body that was actually written. A record that carries a
malformed `attribution` is a named verification finding, not a record to
repair. Readers must keep "this record names no policy" apart from "this
record names a policy and no rule"; see `readLedgerReason` in
`packages/ledger/src/attribution.ts`.

With every executor stopped, create a new empty backup directory from the
repository root:

```sh
node scripts/src/recovery-backup.mjs create \
  --state /path/to/recovery-state \
  --backup /path/to/new-backup \
  --encryption-key-env NOMO_RECOVERY_KEY \
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

### The server budget ledger is on a dispatch path

`serverBudgetLedger` in `packages/runtime/src/budget.ts` is no longer a tested
library with no host. `recoveryRuntime` takes it as the optional
`budgetLedger`, and an irreversible operation dispatched through that runtime
reserves a unit against it.

The shape is deliberate, and it is the shape that survives. A host supplies a
`BudgetStore` whose scope is `host` or `cluster`, a `session` store is refused
outright, because per-process counting hands every worker the full limit and so
authorises N times the irreversible work the cap exists to prevent, plus the
account name and the same limits the local derivation uses. The reservation
happens in three places, and each one is where it has to be:

1. A short read of the account's prior records runs **before** the journal
   transaction opens, so it is never waiting on a lock the whole workspace
   shares. It decides nothing. It cannot refuse on an exhausted account, because
   only the fenced read that would have committed the hold can also prove that
   this operation was not already charged by a process that died mid-dispatch,
   and a record that reads as a different operation is not the same record. What
   it does do is surface an unreadable or self-contradictory account as an
   incident before the writer lock is taken, rather than absorbing a broken
   budget into a `failed` operation.
2. The reservation itself is inside the existing transaction, at the same point
   as authorization, and it is the authority: one compare-and-swap against a
   version fence, so two workers cannot both receive the full limit. A
   reservation commits before dispatch, so a process that dies in between leaves
   a durable `reserved` hold rather than a silent gap.
3. The hold is settled or released after the transaction returns, never inside
   it. A failure before dispatch is the only thing that hands a unit back, and
   it says so in writing; unknown and unfinished stay spent, because a process
   that cannot prove it never ran has not earned a refund.

One detail is the whole reason this is not the obvious wiring. The journal's
writer lock is held for the entire transaction and is shared by every workspace
in the journal directory, so anything slow inside it stalls unrelated work. An
earlier attempt acquired the budget lock there and was reverted: the ledger
retries a lost fence up to its configured attempt count, each attempt able to
wait out the store's own lock deadline, and multiplying those while holding the
journal lock is precisely the stall. So the in-transaction reservation takes a
**single** fenced attempt (`attempts: 1`) and reports a lost race as
`reason: "contended"` instead of spinning. A contended worker fails its
operation before dispatch rather than making every other workspace wait, and
the caller retries with a fresh operation id. The prior-record read exists for
the same reason: it keeps the common exhausted case from reaching the store at
all.

A restarted executor does not re-observe an already-dispatched charge. It sees
the `dispatched` journal record and records `unknown` before the budget gate, so
it never reserves a second time, and it leaves the dead process's hold alone:
`expireStale` makes it visible and still counts it as spent. A host that
configures both the local cap and the ledger has to clear both, because the
journal derivation can only see the events its own process wrote; a host that
configures neither is denied exactly as before.

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
transaction: one exact run, one journal checkpoint, or explicit operation ID
list, plan by stable job ID,
digest-bound approval before application, signed planned/approved/applying/
checkpoint/restored/partial/conflict/unknown/paused events, and blocked forward
writes while an active job is unterminal. The HTTP surface exposes only
`/api/sessions/:id/recovery-jobs/plan`, `/apply` and `/:job`; it projects plan
digests, step operation IDs/sequences and operation residuals/statuses
without operation payloads, captures or provider receipts. A checkpoint
selector resolves once through the shared resolver and is recorded as the
steps it reached; planning it again under the same job ID is refused, so a
second look needs a new job ID. There is no
dependency closure or time selection, scheduler, lease, fencing or
cloud MCP job surface. The retained local MCP host is the only MCP job surface.
