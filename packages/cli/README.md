# @void/cli

The development `void` command. It runs locally with no production account.
Packages remain private workspace packages, so use the repository binary:

```sh
node packages/cli/bin/void.mjs --help
```

## Runnable surfaces

- `tui`: live local terminal workspace.
- `agent`: bounded model and tool session.
- `run`: launch the MCP proxy through the same arguments as `void-proxy`.
- `classify`: classify a captured transcript from declared facts, or one
  named call with `void classify --tool <id> [--facts <file>] [--fact k=v]
  [--args <json>]`. The single call form prints the tone that tool would get,
  and says whether it came from declared facts or from the entry's
  fail-closed fallback.
- `feed` and `watch`: verify and inspect ledger activity.
- `approvals` and `approve`: inspect and decide durable holds.
- `ledger verify` and `verify`: verify ledger integrity and signatures.
- `doctor [--recovery-config PATH]`: read-only environment and local storage
  permission checks. Passing a recovery config audits its state tree without
  printing its contents or any secrets.
- `--version`: print the workspace version without touching any data.
- `config`: print resolved paths and flags with their source. Secret values
  never print, only whether a key is set.
- `init [--data-dir PATH]`: create the local encrypted storage layout. Contacts
  no provider and prints no key. Running it twice changes nothing.
- `replay`: preview or apply one captured connector inverse by ledger sequence.
- `recovery`: inspect, execute, plan, apply or reconcile managed filesystem and
  PostgreSQL operations. Its `plan-job`, `apply-job`, and `status-job` actions
  persist local recovery jobs for one exact run or an explicit operation list.
  Its `serve` action exposes the single-operation managed contract over stdio
  MCP. Its `conformance` action runs the disposable filesystem checks.
- `taint`: query recorded resource and digest relationships.
- `policy`: list, show or validate bundled policy packs.
- `export` and `attest`: export local evidence and create an attestation.

Run a command without its required arguments to print its current usage. See
`../../README.md`, `../../docs/BETA.md`, and `../../docs/ADAPTER-CONFORMANCE.md`
for supported examples.

## Boundaries

The CLI does not implement the pinned marketing examples `void report`,
`void rewind`, `void budget`, Python wrapping, or
`--format aiact-a12 --since 30d`. Current replay selects one signed captured
operation. It is not a cross-system time scrubber.

A connector name or registry classification is not recovery evidence. Managed
recovery works only through registered executable adapters. Legacy PostgreSQL
and S3 replay preview requires matching host capture. Apply additionally
requires a trusted verification key, signed `execute:completed` evidence, and
capture binding. Missing executors, captures, signatures, policy, or encryption
keys fail closed.

Recovery jobs use reverse ledger order and stop on conflict or unknown. Any new
forward operation after preview invalidates the job. They do not yet provide
dependency ordering, branch continuation, leases, scheduling, time selection,
MCP job tools, or cloud jobs.

The CLI must never print credentials. Recovery and replay errors redact provider
payloads that can contain credentials or customer data. Interactive `agent` and
`tui` commands display user and model content by design, and `export` prints the
stored ledger bodies selected by the operator. A development signing key is
reported as a development key, not production identity.

## Public TypeScript surface

`src/index.ts` exports the invocation parser and command names, terminal render
models, and the classify, feed, replay, taint, verify, approval, doctor, config,
and init handlers.
The binary imports agent, recovery, watch, and local operation handlers directly;
those modules are not exported by the package barrel. The binary owns process
exit behavior and command dispatch. Domain logic remains in the registry,
ledger, policy, proxy, connector, runtime, SDK, and workbench packages. The CLI
does not import `@workspace/*` or site code.
