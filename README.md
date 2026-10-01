# VOID

VOID is an accountability and reversibility layer for AI agents.

**Start here: [the VOID handbook](docs/HANDBOOK.md).** It is the complete operator
guide, in English and in [Czech](docs/HANDBOOK.cs.md), and it is checked by a
test: every command, script, path and link in it is verified to exist, so it
cannot drift away from the product the way a README can.

[Download VOID](https://dawe583.github.io/void/): Windows and macOS desktop beta, TUI source download, and setup instructions.

It sits between an MCP capable agent and the tools the agent can write to. For each write, VOID classifies how reversible the call is, applies a policy, and appends a signed hash chained ledger entry. Later, operators can inspect the feed, verify the chain, attest a slice, trace taint, and replay true inverses when a connector has captured enough state.

## What VOID protects

VOID does not make an agent safe by trusting the model. It protects the write path.

1. Intercept the tool call.
2. Classify the call as R0, R1, R2, or R3 from registry cases and target facts.
3. Apply policy.
4. Allow, deny, or hold.
5. Record the decision in the ledger before the write proceeds in fail-closed posture.
6. Use connector snapshots and manifests for replay where a true inverse exists.

## Reversibility classes

| Class | Meaning | Usual posture |
| ----- | ------- | ------------- |
| R0 | Fully reversible with a direct inverse. | Allow with ledger. |
| R1 | Reversible with a trace or before image. | Allow for small blast radius, hold for large blast radius. |
| R2 | Mitigable only. | Hold or deny. |
| R3 | Irreversible. | Hold or deny. |

## Two operating postures

| Posture | Behavior |
| ------- | -------- |
| `fail-closed` | The default. Unknown tools, unclassified calls, invalid policy, ledger failure, and internal errors deny. Availability is traded for safety. |
| `observe` | Forward calls and record decisions where possible. Non-allow verdicts are printed to stderr. Use this only for trials and shadow runs. |

## Five-minute local path

Run the live local terminal workspace with `void`, `pnpm void`, or `pnpm tui`. From a checkout, `./void` works on macOS/Linux and `.\void.cmd` works on Windows. To make the bare `void` command available from any directory after cloning, install dependencies, run `pnpm setup` once if pnpm's global bin directory is not on PATH, open a new terminal, then run `pnpm link --global` from the checkout. This links the command to that checkout; repeat the link if you move it or switch to another clone. Chat, documents, reviewed Undo, signed ledgers, approvals, policy and tool controls use real local data. See [the TUI guide](docs/TUI-WORKSPACE.md) for setup and testing. `tui:preview` remains an illustrative renderer.

Use Node.js 24 or newer and `pnpm install --frozen-lockfile`. Packages are private and unpublished, and the version lives in the root manifest rather than in this file, so `void --version` is what a reader should trust for the number. Start the agent GUI with `pnpm gui`, or run the native macOS app with `pnpm desktop:setup` followed by `pnpm desktop`. Connect a provider in Settings; managed documents and captured Undo work without a separate tool server. Build the installer with `pnpm desktop:build`; see [the beta runbook](docs/BETA.md) for agent configuration, terminal controls, Vercel deployment and the reviewed feature boundaries.

The native iOS app under `apps/apple` is generated: `apps/apple/project.yml` is
the source of truth and `apps/apple/VOID.xcodeproj` is a build artifact. Run
`pnpm apple:project` from the repository root after changing the yml or adding or
removing a source file, and commit the regenerated project with the change. Run
`pnpm apple:project:check` to prove the committed project still matches the yml
without writing to the working tree. Never hand-edit `project.pbxproj`.

The GUI uses the shared React/TypeScript client in `apps/control-plane/ui`.
`pnpm gui` builds it before starting the local API. For frontend development,
run `node apps/control-plane/api/server.ts` and `pnpm dev:web` in separate
terminals. `pnpm build:web` creates the production assets used by Vercel and
the desktop bundle. VOID has no default provider and no default model: connect a
server-side provider key in Settings, or set `NVIDIA_API_KEY` to use NVIDIA NIM,
and the first conversation asks which model to use from the catalog that
provider returns. Existing conversations keep their original provider and model.
A workspace with no credential resolves reports **Setup required** and dispatches
nothing: VOID never silently falls back to a different provider.

From the repository root, start with the simulated hold moment:

```sh
node scripts/src/moment.mjs
```

You should see one denied Postgres delete, one approved Postgres delete, and the lines an agent would read after a hold resolves.

Run a real proxy process against the fixture MCP server:

```sh
node packages/proxy/bin/void-proxy.mjs --upstream node --args fixtures/e2e-server.mjs --policy fixtures/e2e-policy.yaml --ledger-dir /tmp/void-ledger --workspace demo
```

That command waits on stdin because it is an MCP stdio server. Put an MCP client in front of it. With the fixture policy, `echo` is allowed and `orders_delete` is held.

Classify a fixture transcript without running the proxy:

```sh
node packages/cli/bin/void.mjs classify --transcript fixtures/session.jsonl --facts fixtures/facts.json
```

Run the final local product sweep. It creates a temp ledger, reaches a hold, reads the feed, verifies the chain, checks taint, writes an attestation, detects tamper, and exercises the HTTP upstream path when the current wave exposes it:

```sh
node scripts/src/e2e-final.mjs all
```

For connector replay behavior, including drift refusal, run:

```sh
node scripts/src/e2e-connectors.mjs
```

The whole-product arc drives every surface in one story: the SDK client holds a destructive call, a control-plane operator approves it over HTTP, the upstream executes it, and the ledger arc closes through the void CLI:

```sh
node scripts/src/e2e-arc.mjs all
```

A local smoke benchmark of the proxy write path:

```sh
node scripts/src/bench.mjs --scale 200
```

## Operator commands

The development binary is `node packages/cli/bin/void.mjs`. Packaged releases will expose the same handlers as `void`.

| Need | Command surface | Current note |
| ---- | --------------- | ------------ |
| Live feed | `feed --ledger <ledger-file> [--json] [--follow]` | Verifies the chain before printing. |
| Approval status | `approvals [--dir <state-dir>]` | Reads pending holds from the approvals state directory. |
| Decide a hold | `approve <holdId> --by <actor> [--reason <text>] [--dir <state-dir>] [--deny] [--json]` | Queues a durable decision file the running proxy consumes. |
| Approvals overview | `approvals --dir <state-dir>` | Lists what the proxy surfaced in the state dir. |
| Replay | `replay --ledger <ledger-file> --snapshot-dir <dir> --seq <n> [--dry-run]`, `replay --list-connectors` | The binary loads the static connector set (postgres, s3). Executors come from host environment variables, so a dry-run plan works everywhere and apply fails with a typed error when an executor is absent. |
| Taint | `taint --ledger <dir-or-file> --seq <n> [--depth <n>] [--json]` | Builds graph edges from the verified ledger. |
| Verify | `verify --ledger <dir-or-file> [--attestation <path>]` | Recomputes body hashes, links, and signatures. |
| Policy packs | `packages/policy/packs/strict.yaml`, `balanced.yaml`, `dev.yaml` | Ready-made policies loaded through `loadPack` in the policy package. `strict` allows only R0, `balanced` holds R2 and denies R3, `dev` holds every R3. |

## Package map

| Package | Owns |
| ------- | ---- |
| `@void/registry` | Registry data, preconditions, evaluation, and declared facts. It imports nothing. |
| `@void/ledger` | Canonical JSON, entry hashes, JSONL store, signing, feed, taint, verification, and attestations. |
| `@void/policy` | YAML policy loading, decisions, holds, approval broker, and approval channels. |
| `@void/proxy` | MCP session plumbing, stdio and HTTP upstream transports, forwarding, interception, and approval pumping. |
| `@void/connectors` | Connector registry, Postgres logic, S3 logic, probes, snapshots, and manifests. |
| `@void/cli` | Development command handlers and terminal render models. |
| `@void/workbench` | Provider discovery, bounded agent sessions and the shared GUI/CLI model loop. |
| `@void/sdk` | In-process client wrapper for app builders: VoidClient, holdHandle, typed errors. |

## Beta scope

See [docs/BETA.md](docs/BETA.md) for supported features, verification evidence,
remote authentication, runtime configuration and remaining roadmap work.
The web app and backend run on Vercel, with Workflow and a Neon database.
Model generation requires an active Vercel AI Gateway account or a provider key.
Native agent adapters and automatic snapshot capture for arbitrary MCP tools
are not included in this beta.

## More docs

- `docs/CONTEXT.md`: authoritative product context and vocabulary.
- `docs/DECISIONS.md`: decision log.
- `docs/STANDARDS.md`: coding, test, safety, and repository rules.
- `docs/OPERATIONS.md`: operator runbook.
- `docs/PLAN-GAPS.md`: consolidated remaining work across active plans.
- `docs/SDK.md`: SDK release candidate surface.
- `docs/TESTING.md`: package test commands and test rules.
- `CONTRIBUTING.md`: how to contribute, and what gets declined.
- `packages/policy/README.md`: policy pack contents and loading rules.
- `packages/verifier/README.md`: the independent offline ledger verifier.
- `scripts/src/bench.mjs`: local smoke benchmark (forwarding, ledger append, classification).

## Licence

The interception spine is Apache 2.0, and that is the part you should be able to
read before putting it in a write path: the registry, the ledger, the proxy, the
policy engine, the CLI, the connectors, and the standalone verifier. Full text is
in `LICENSE`; the registry's own caveat travels in `NOTICE` and with the data
wherever the data goes.

`apps/control-plane` is the closed, paid part and is **not** covered by the root
licence; it carries its own `LICENSE`. The line is in `docs/DECISIONS.md`
section 5, along with the rule it exists to hold: **a feature never moves from
open to paid.** Approvals, budgets, multi-workspace, SSO and the taint graph are
on the paid side because they are organisational, not because they are
interesting.

`@void/verifier` is separately installable and depends on nothing at all, not
even on VOID. That is deliberate: an auditor who has to trust the vendor's
dependency tree is not getting an independent check.

## No support obligation

There is none on the open packages. VOID is maintained by one person. Issues are
read, a response time is not promised, and a bug is not guaranteed to be fixed.
Contributing is the reliable way to get a change made; `CONTRIBUTING.md` says
which contributions are easy and which need prior agreement.

One limitation belongs here rather than in a footnote, because it is where a
reader meets it: the ledger is tamper **evident**, not tamper proof. A database
superuser bypasses every grant and every trigger, which is exactly why entries
are signed. An entry signed by a compromised host key verifies, so past entries
are only as trustworthy as the key that signed them, and why a published
checkpoint matters.
