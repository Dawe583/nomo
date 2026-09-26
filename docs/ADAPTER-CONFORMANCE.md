# Adapter conformance

Apple 1.0.1 release evidence distinguishes source inspection, these disposable
fixtures, signed sandbox installs and physical-device checks in
`RELEASE-1.0.1-MATRIX.md`. A passing conformance report does not change
`certification:false` or imply a native-app store capability.

Run the built-in disposable filesystem checks from the checkout:

```sh
node packages/cli/bin/void.mjs recovery conformance
node packages/cli/bin/void.mjs recovery conformance --adapter filesystem.managed
node packages/cli/bin/void.mjs recovery conformance --adapter git.managed
node packages/cli/bin/void.mjs recovery conformance --adapter managed-documents
node packages/cli/bin/void.mjs recovery conformance --adapter postgres-managed-conformance
```

The command creates its own temporary directories, signing key and encryption
key. It does not read recovery configuration, use provider credentials, contact
services or edit the current project. Each case gets independent resources and
cleanup. Unknown adapters and configuration arguments are refused. Exit 0 means all checks passed; exit 1 means a case or its cleanup failed.
POSIX runs 32 checks across create, write, delete and rename. Windows runs the
existing 24 create, write and delete checks because rename remains refused
until separate Windows evidence exists.

## Evidence and scope

The JSON `void.adapter-conformance-run.v1` report contains one versioned
`void.adapter-capability.v2` profile for the selected provider (see Capability
profile below) and three Windows scenarios or four POSIX
scenarios: create, write, delete and, on POSIX, rename. Each scenario includes the adapter ID/version, Node version, platform,
and eight named pass/fail checks:

| Check                   | Required behavior                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| Restart and idempotence | Reopen journal/vault and adapter; one forward call and one inverse; rejected approval leaves the file intact |
| Changed request         | Reusing an operation ID for different arguments refuses dispatch                                             |
| Authorization refusal   | Denial preserves target state without calling adapter execution                                              |
| Capture failure         | Failed artifact storage releases preparation without dispatch                                                |
| Human drift             | Recovery reports conflict and preserves the independently edited file                                        |
| Changed plan            | Altered resources cannot reuse an approved plan digest                                                       |
| Lost execution response | Mutation followed by a thrown response remains unknown; reopened runtime does not redispatch                 |
| Lost recovery response  | Inverse followed by a thrown response remains unknown; reopened runtime does not repeat the inverse          |

The target is inspected independently of the adapter result. The binary sample
includes zero and non-UTF-8 bytes. Failure reports contain check identifiers,
not provider exceptions, captured bytes, keys or temporary paths. Investigate
failures with the adapter tests in a disposable environment. Automated tests
also verify that false success and destructive inverses fail conformance.

This is a repeatable runtime/adapter boundary check, not a signed independent
certification. The capability profile describes supported scope; it is not
authority to execute production requests. The report does not certify OS
process death, network partitions, power loss, every permission model,
hostile concurrent writers, or another adapter. The restart check recreates
runtime objects and reopens persisted state in the same process; separate
runtime subprocess tests cover specific process-death boundaries.

The Windows/Linux Node 24/26 persistence workflow runs this command and its
negative tests, alongside the filesystem CLI and adapter regressions.

## Capability profile

The report carries one `void.adapter-capability.v2` profile per provider, not
one global flag set. The schema, the validator and the per-provider set live
in `packages/connectors/src/capability.ts` and
`packages/connectors/src/capability-profiles.ts`; the shipped profiles live
next to their fixtures in `packages/cli/src/conformance.ts`.

The profile is a scope statement, never an authorization. `authority` is the
literal `scope-only`, and `certification` is `false` for every shipped
provider: passing the cases below certifies nothing. A profile becomes
certified only with an evidence object naming the checks, the ISO run
timestamp and the exact `adapter.version` behind the claim, and no shipped
profile carries one.

What the schema requires: `adapter.id`/`adapter.version`, `authority`,
`operations`, `boundary`, `maxDecodedBytes`, a non-empty `recovery` map,
explicit `durableExecutionReceipt`/`durableRecoveryReceipt`, a non-empty
`excluded` list, and a `conformance` block with `schema`, `runtime`,
`fixture`, non-empty `checks` and `sharedRuntimeChecksOnly`. Unknown fields
are refused rather than ignored, and a `void.adapter-capability.v1` report is
rejected, never coerced. An empty `operations` list is only accepted when
`recovery` names a platform as `unsupported`, which is how the Git profile
reads on Windows.

The four shipped profiles, each with its own scope and its own exclusions:

| Profile                     | Operations (POSIX)                | Boundary                                  | Certification |
| --------------------------- | --------------------------------- | ----------------------------------------- | ------------- |
| `filesystem.managed` v1     | create, write, delete, rename      | cooperative regular file paths            | `false`       |
| `git.managed` v1            | create, write, delete, rename, stage, unstage, commit | cooperative POSIX single Git surface | `false`       |
| `managed-documents` v1      | write, delete                      | managed text documents, no host filesystem | `false`       |
| `postgres-managed-conformance` v2 | insert, update, delete, delete-cascade, tenant-update | cooperative configured tables, in-process PGlite with row-level security | `false`       |

`filesystem.managed` carries `certification: false` explicitly; before the
versioned schema it was the one profile that left the field out.

### The shared runtime is a binding, not a constant

All four providers really do run on one runtime: the case list belongs to
`runAdapterConformance` in `packages/runtime/src/conformance.ts`, so the
eight cases are the same for every provider. The profile states that as
`conformance.runtime: "void-recovery-runtime"` and
`conformance.sharedRuntimeChecksOnly: true` per provider, and
`declareProviderProfiles` refuses a set whose profiles disagree on either. A
provider with its own runtime therefore shows up as a different
`conformance.runtime` instead of silently inheriting the shared-runtime
claim, and a declared `sharedRuntimeChecksOnly` that contradicts the derived
certification status is a declaration error.

### Fail-closed resolution

`providerProfiles` is declared and validated at import. `runConformanceCommand`
resolves an adapter id through that set only: an id no profile publishes is
refused with the ids that do, and there is no fallback profile and no
"run it and see" path. The PostgreSQL profile binds the id the adapter factory
derives for the conformance workspace, `postgres-managed-conformance`, by calling
that factory at import rather than writing the id out by hand, so the profile
cannot claim an id no adapter reports. Its scenarios need PGlite, which is a
dev dependency, so the import is dynamic and its absence is a named refusal
rather than a load failure for `void.mjs`. The fixture lives in
`packages/connectors/src/postgres/conformance-fixture.ts`; the profile itself
stays in `packages/cli/src/conformance.ts`.

### Release gate

`scripts/src/capability-profile-gate.test.mjs` loads the shipped profiles,
re-validates them against the schema instead of trusting the import-time
declaration, refuses any certified claim or `authority` drift, and refuses a
run for an adapter without a published profile. It runs as part of the
`scripts` suite in `pnpm test`, and standalone:

```sh
node --test scripts/src/capability-profile-gate.test.mjs
```

The gate covers profile shape, not the runs themselves; the fixtures and
their failures are covered by the adapter tests below.

## Adding an adapter fixture

`packages/runtime/src/index.ts` exports `runAdapterConformance`,
`ConformanceFixture` and `CONFORMANCE_CASES`. A fixture factory allocates a fresh
isolated target for every case, exposes a new adapter instance and reopened
journal/vault, supplies distinct before/after/human states and changed arguments,
and independently reads and edits its target. It must clean up on partial setup
failure; the runner calls `dispose()` for every returned fixture, including failed
cases. Cleanup failure makes that case fail.

```ts
const report = await runAdapterConformance(
  { id: "my.adapter", version: "1" },
  createDisposableFixture,
);
if (!report.passed) process.exitCode = 1;
```

Use `packages/cli/src/conformance.ts` as the concrete fixture example. A new
provider adds its profile to that file and to the `providerProfiles`
declaration; a profile that does not fit the schema stops the command at
import, and the release gate re-checks it independently. Runtime
requests use workspace `conformance`; fixtures must match it.
Fixtures and adapters are trusted code, not plugins loaded by this command. External
providers still need isolated target identity, receipt, conflict, permission
and crash tests. Python transport and general provider certification remain
outstanding R12 work.

## Managed documents profile

The `managed-documents` command runs 16 shared runtime checks across write
and delete in a disposable in-memory workspace with a reopened journal and
vault. This is the adapter behind TUI chat edits: per-call preflight states
R1, verified readiness and exact radius 1, and human drift reports conflict
instead of overwriting. `certification: false` and
`sharedRuntimeChecksOnly: true` are explicit in the report. Text documents
only, 256 kB per document, no host filesystem. Process death, power loss
and concurrent external writers stay excluded.

## Managed Git profile

The POSIX Git command runs 48 shared runtime checks across create-by-write,
write, delete, rename, stage and unstage in disposable repositories with no
remote and local-only identity. Each Git fixture independently reads HEAD, the
normalized full index manifest, selected endpoints, and byte/mode sentinels for
unrelated staged, unstaged and untracked worktree state. `certification: false` and
`sharedRuntimeChecksOnly: true` are explicit in the report. See
`MANAGED-GIT.md` for the dangling blob, reconciliation, platform and process
death limits. Windows reports the POSIX exclusion and does not mutate.
