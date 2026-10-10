# NOMO local identity demo

Rehearsal runbook for the one-process local demo: identity, policy, evidence,
harness and stop paths against the disposable MCP fixture. No production
account, no live secret, no fleet claim beyond this process.

## Prerequisites

- Node 24+ (the repo's `engines` requirement) and pnpm. A clean checkout of this repository.
- No network access needed: every call targets the local fixture.

## Setup

```sh
pnpm install
```

## The demo flow

Run the deterministic end-to-end script, which drives the proxy against
`fixtures/e2e-server.mjs` under the policy in `fixtures/e2e-policy.yaml`:

```sh
node scripts/src/e2e.mjs
```

Expected output: every check prints `PASS`, including:

1. `api initialize version` — the proxy and fixture negotiate MCP.
2. `api echo forwards result` — the low-risk allowed call forwards.
3. `api orders_delete parks without response` — the destructive tool is held.
4. `api hold approval releases upstream result` — approving the hold lets the
   original call resolve; the ledger records `hold:approved`.
5. `api ledger recorded every decided call` — one signed entry per decision,
   metadata only (`tool`, `klass`, `decision`, `argsDigest`); raw arguments are
   digest-hashed, never stored.
6. `binary observe ...` — `--posture observe` forwards held calls and says so,
   the observe path is explicit, never a silent bypass.
7. `fail-closed startup refuses to run without a ledger directory` — a missing
   evidence store is a refusal, not a degraded run.

## What the policy demonstrates

`fixtures/e2e-policy.yaml` holds three rules: `echo` allowed, `orders_delete`
held (5 s expiry, operator approval), everything else denied. That is one
low-risk call, one held destructive write, one denied unknown tool — the exact
scenarios from the spec.

## Identity path (separate from the fixture proxy)

The workbench identity path runs the same proxy in-process with an in-memory
issuer. See `packages/proxy/src/transport/http-server.test.ts` for the
verified behavior: grants fail closed on wrong audience, expiry, revocation;
scope is enforced per call; the grant token never reaches upstream requests,
responses, the error log or durable storage. The harness wiring test
(`packages/workbench/src/harness-wiring.test.ts`) proves a run crosses the
inbound proxy, policy and ledger with learning disabled.

## Stop acknowledgement and in-flight calls

The control plane stop route (`POST /api/runs/:id/stop`) returns
`{ ok: true, ack: "acknowledged", scope: "this process only" }`. The
acknowledgement means this process stopped accepting calls; a call already
dispatched upstream stays unknown until its result confirms. The UI renders
this scope note and never claims success before the server responds. Fleet
events (stop request, stop acknowledgement, run start, agent start, approval)
are metadata-only in `/api/fleet/events`.

## Full gate

```sh
pnpm run check        # typecheck + tests
pnpm run build
node --test scripts/src/doc-truth.test.mjs
```

## Boundaries

- Learning is disabled on the identity path: enabling it there is refused, not
  degraded.
- Tool decisions and dispatch results are not yet mirrored into the fleet feed;
  `/api/fleet/events` carries run, approval, agent and stop events only.
- The fixture server simulates a destructive tool; nothing here touches real
  infrastructure.
- `orders_delete` hold expires after 5 s: expiry and approval are both honest
  outcomes, and the ledger records which one happened.
- GitLab push of this branch remains blocked on credentials; GitHub
  (`Dawe583/void`, branch `docs/nomo-agent-identity-fleet-2026-10-08`) is the
  synced remote.
