# Adapter conformance

Run the built-in disposable filesystem checks from the checkout:

```sh
node packages/cli/bin/void.mjs recovery conformance
node packages/cli/bin/void.mjs recovery conformance --adapter filesystem.managed
```

The command creates its own temporary directories, signing key and encryption
key. It does not read recovery configuration, use provider credentials, contact
services or edit the current project. Each case gets independent resources and
cleanup. Unknown adapters and configuration arguments are refused. Exit 0 means
all 24 checks passed; exit 1 means a case or its cleanup failed.

## Evidence and scope

The JSON `void.adapter-conformance-run.v1` report contains a versioned
`void.adapter-capability.v1` profile and three scenarios: create, write and
delete. Each scenario includes the adapter ID/version, Node version, platform,
and eight named pass/fail checks:

| Check | Required behavior |
| --- | --- |
| Restart and idempotence | Reopen journal/vault and adapter; one forward call and one inverse; rejected approval leaves the file intact |
| Changed request | Reusing an operation ID for different arguments refuses dispatch |
| Authorization refusal | Denial preserves target state without calling adapter execution |
| Capture failure | Failed artifact storage releases preparation without dispatch |
| Human drift | Recovery reports conflict and preserves the independently edited file |
| Changed plan | Altered resources cannot reuse an approved plan digest |
| Lost execution response | Mutation followed by a thrown response remains unknown; reopened runtime does not redispatch |
| Lost recovery response | Inverse followed by a thrown response remains unknown; reopened runtime does not repeat the inverse |

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

Use `packages/cli/src/conformance.ts` as the concrete fixture example. Runtime
requests use workspace `conformance`; fixtures must match it. Fixtures and
adapters are trusted code, not plugins loaded by this command. External
providers still need isolated target identity, receipt, conflict, permission
and crash tests. Python transport and general provider certification remain
outstanding R12 work.
