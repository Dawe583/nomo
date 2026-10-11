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

Expected output: all 14 checks print `PASS`, in this order:

In-process proxy pass (`runProxy` API):

1. `api initialize version`: the proxy and fixture negotiate MCP.
2. `api tools/list fixture tools`: the fixture exposes `echo` and `orders_delete`.
3. `api echo forwards result`: the low-risk allowed call forwards.
4. `api orders_delete parks without response`: the destructive tool is held
   (the script prints `held h0001` on stderr between checks 3 and 4).
5. `api hold approval releases upstream result`: approving the hold lets the
   original call resolve; the ledger records `hold:approved`.
6. `api no unexpected stderr`: nothing noisy leaked from the run.
7. `api ledger recorded every decided call`: signed entries for every
   decision, metadata only (`tool`, `klass`, `decision`, `argsDigest`); raw
   arguments are digest-hashed, never stored.

Binary pass (spawned `packages/proxy/bin/void-proxy.mjs --posture observe`;
every forwarded call needs a ledger directory for its pre-dispatch evidence
record, so the script passes `--ledger-dir` here too):

8. `binary observe initialize`: the binary negotiates MCP.
9. `binary observe echo`: observe forwards the allowed call with its result.
10. `binary observe orders_delete forwards`: observe forwards the held call
    with its upstream result and says so on stderr
    (`observe: hold verdict for orders_delete forwarded`): explicit, never a
    silent bypass.
11. `binary observe exits zero`: the binary run exits 0.

Wiring checks:

12. `bin exposes the hold queue through the onHold hook`.
13. `bin wires a real ledger store into every decided call`.
14. `fail-closed startup refuses to run without a ledger directory`: a
    missing evidence store is a refusal, not a degraded run.

## What the policy demonstrates

`fixtures/e2e-policy.yaml` holds three rules: `echo` allowed, `orders_delete`
held (5 s expiry, operator approval), everything else denied. That is one
low-risk call, one held destructive write, one denied unknown tool — the exact
scenarios from the spec.

## Identity path (separate from the fixture proxy)

The workbench identity path runs the same proxy in-process with an in-memory
issuer. See `packages/proxy/src/transport/http-server.test.ts` for the
verified behavior: grants fail closed on wrong audience, expiry, revocation
(an expired token answers 401, and an expiry that lands mid-hold blocks the
recheck so the call never reaches upstream); a schema-bound low-risk read or
write may take the bounded fast path with identity metadata on the ledger
record, while high-risk or unknown operations always get full policy;
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
