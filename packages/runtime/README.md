# @void/runtime

Shared managed execution and recovery, currently local and experimental.

The runtime records a signed lifecycle, encrypts before images, binds requests
and plans to digests, and refuses silent retries after uncertain outcomes.
Adapters own transaction/CAS protection and durable reconciliation evidence.

Entry point: `src/index.ts`. Executable adapter contract:
`../connectors/src/recovery.ts`. CLI: `void recovery`.

Read `../../docs/RECOVERY-CONTRACT.md`, `../../docs/RECOVERY-COVERAGE.md` and
`../../docs/MANAGED-RECOVERY.md` before configuring a target. This package does
not turn arbitrary tools, shell commands or OAuth connections into reversible
operations.

Run `pnpm --filter @void/runtime test` and `pnpm --filter @void/runtime typecheck`.

`reservedRecoveryVault` is the CLI default. It atomically stores encrypted
artifacts and quota reservations in SQLite. `localRecoveryVault` remains the
legacy file implementation; callers choosing it do not gain total capacity
reservation. Both implement the same runtime vault interface.

`runAdapterConformance` runs eight common boundary checks using independently
allocated disposable fixtures. The CLI applies them to filesystem create, write
and delete via `void recovery conformance`. See
`../../docs/ADAPTER-CONFORMANCE.md` for the fixture API and evidence limits.

## Recovery jobs

`planRecoveryJob` persists a signed plan for an exact run or explicit operation
selection. The plan binds the full signed journal boundary, reverse sequence
order, each single-operation plan and every known residual to one digest.
`runRecoveryJob` loads that stored plan by job ID and checkpoints each result.
It reuses single-operation recovery, so restart and checkpoint loss do not
authorize a second inverse.

This first local slice stops all remaining operations on conflict or unknown.
A deterministic step setup failure persists `paused` with only a redacted error
code and operation ID. The workspace remains blocked until the missing adapter
version or local state is repaired and the same job resumes to a safe terminal.
Any new forward operation after preview makes the boundary stale. It does not
provide dependency ordering, branch continuation, leases, fencing, scheduling,
time selection, MCP job tools or cloud jobs.
