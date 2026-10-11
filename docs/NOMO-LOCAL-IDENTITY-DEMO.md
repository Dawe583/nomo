# NOMO local identity demo

Rehearsal runbook for the one-process local demo: identity, policy, evidence,
harness and stop paths against the disposable MCP fixture. No production
account, no live secret, no fleet claim beyond this process.

## Prerequisites

- Node 24+ (the repo's `engines` requirement) and pnpm. A clean checkout of this repository.
- Demo calls use local fixtures only. `pnpm install` may need package registry access if dependencies are not cached.

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

Expected output: all 19 checks print `PASS` in this order:

In-process proxy pass (`runProxy` API):

1. `api initialize version`: the proxy and fixture negotiate MCP.
2. `api tools/list fixture tools`: the fixture exposes `echo`, `orders_delete`
   and `orders_update`.
3. `api echo forwards result`: the low-risk call is allowed and forwarded.
4. `api orders_delete parks without response`: the destructive fixture write
   is held before dispatch (the script prints `held h0001` on stderr between
   checks 3 and 4).
5. `api direct test queue releases held fixture result`: this resolves the
   queue directly as a proxy test seam. It is not operator approval evidence.
6. `api orders_update is denied before dispatch`: the fixture does not classify
   this write-shaped tool as write-risk; the catch-all deny rejects it.
7. `api no unexpected stderr`: nothing noisy leaked from the run.
8. `api ledger recorded every decided call`: signed entries correlate each
   input call by argument digest and operation id. Raw arguments are not stored.

Binary pass (spawned `packages/proxy/bin/void-proxy.mjs --posture observe`;
every forwarded call needs a ledger directory for its pre-dispatch evidence
record, so the script passes `--ledger-dir` here too):

9. `binary observe initialize`: the binary negotiates MCP.
10. `binary observe echo`: observe forwards the allowed call with its result.
11. `binary observe orders_delete forwards`: observe forwards the held call
    with its upstream result and says so on stderr
    (`observe: hold verdict for orders_delete forwarded`): explicit, never a
    silent bypass.
12. `binary observe exits zero`: the binary run exits 0.

Integrated local identity rehearsal:

13. `Workbench hold pauses bucket delete before proxy approval`: the Workbench
    policy pauses the call before it reaches the proxy. This first approval is
    not identity-bound.
14. `proxy hold binds operation to the active Workbench run`: after the first
    hold is approved through the local API, the proxy creates a second hold.
    Its binding includes the run, workspace, upstream, principal, agent, policy,
    operation, schema and the local broker process OS account ID.
15. `control-plane approval dispatches the identity-bound write`: the local API
    approves the proxy hold. The disposable target records the bucket deletion.
16. `proxy ledger correlates allowed, approved and denied calls`: the signed
    proxy ledger links each call to its argument digest and distinct operation
    id. It records the fast-path write, approved hold and denied write.
17. `local grant is scoped and absent from model, approval and proxy ledger`:
    the grant covers only fixture tools and does not appear in the checked data.
18. `identity Workbench approval rehearsal completes`: all integrated identity
    assertions passed.

Fail-closed startup:

19. `fail-closed startup refuses to run without a ledger directory`: a missing
    evidence store is a refusal, not a degraded run.

Observed Task 8 rehearsal: `node scripts/src/e2e.mjs` exited 0 with all 19
checks printing `PASS`.

## What the policy demonstrates

`fixtures/e2e-policy.yaml` holds three rules: `echo` allowed, `orders_delete`
held (5 s expiry), and a catch-all deny. The fixture also exposes
`orders_update`, a write-shaped but unclassified tool. The catch-all deny rejects
it before dispatch and records `decision: deny` in the signed ledger. This proves
default-deny behavior, not explicit write-risk classification.
`orders_delete` is the destructive fixture write: it is held before dispatch,
then the script resolves the queue directly as a proxy test seam and checks the
upstream result and `hold:approved` ledger entry. This is not operator approval
evidence.

The identity rehearsal uses a separate temporary policy and the tools in
`fixtures/identity-e2e-tools.mjs`. An exact schema-bound operation profile marks
only the fixture object put as a low-risk write for the fast path. The bucket
delete is held by the proxy policy. The object delete is denied by the proxy
policy and does not reach the target. The target trace and signed proxy ledger
check these outcomes by tool, argument digest and operation id.

## Integrated local identity path

The E2E script runs one Workbench task through its loopback inbound MCP endpoint,
the disposable fixture, the local control plane, `ApprovalBroker`, the proxy
policy and the signed proxy ledger. It uses a temporary data directory, a
process-local grant, and a generated signing key. It does not contact a live
upstream.

The bucket deletion passes through two separate approval layers. First, the
Workbench policy pauses the call before the connector forwards it. That hold is
not identity-bound. The script approves it through the local control plane API.
The call then reaches the proxy, which creates a second hold bound to the exact
operation, policy, schema, principal, agent, run, workspace, upstream and local
broker process OS account ID. The script approves this proxy hold through the
same API and checks that the fixture receives the write. The submitted `by`
label is not caller identity evidence. The broker derives the recorded identity
from its own OS account, not the HTTP caller's OS identity. In this demo, loopback
and Origin checks do not authenticate the caller. Without a shared control token,
any local process that can reach the port can submit a decision. This does not
prove browser or human identity; only the second approval exercises the
process-account-bound proxy path.

The denied object delete reaches the proxy but never the fixture. The signed
proxy JSONL ledger records the fast-path object put, the approved bucket delete
and the denied object delete. The script correlates all three operations with
their argument digests and checks that the grant token is absent from the model
request, approval API payload, target trace and proxy ledger. The disposable
fixture trace records actual synthetic tool arguments, so the token assertion
checks real forwarded inputs rather than an empty trace. This is a local
process-account binding, not independent browser, API-caller or human
authentication.

The identity-path tests also use an in-memory issuer and local or mocked
upstreams. Run them from the repository root:

```sh
node --test --test-reporter=tap packages/proxy/src/transport/http-server.test.ts
node --test --test-reporter=tap packages/workbench/src/harness-wiring.test.ts
```

The fast-path unit fixture calls `fixture.lookup` with `{ key: "known" }` for a
read and `{ key: "write" }` for a low-risk write; both return `found` and the
signed ledger records their distinct phases. The focused tests passed 4/4 proxy
HTTP tests and 18/18 Workbench wiring tests. They cover grant scope, expiry and
revocation checks before dispatch, token absence from upstream and the ledger,
and the Workbench run identity binding.

## Stop acknowledgement and in-flight calls

The control plane stop route (`POST /api/runs/:id/stop`) returns
`{ ok: true, ack: "acknowledged", scope: "this process only" }`. The API test
verifies the acknowledgement and metadata-only stop events. The UI reports
running or stopping run count, not a fabricated per-call count, and labels
already dispatched calls unknown until their result confirms. The proxy recovery
test verifies unresolved dispatch outcomes are recorded as unknown.

Run the local stop and unresolved-outcome checks with:

```sh
node --test --test-reporter=tap apps/control-plane/api/server.test.ts
node --test --test-reporter=tap apps/control-plane/ui/src/ui.test.ts
node --test --test-reporter=tap packages/proxy/src/bin.test.ts
```

The Task 8 rehearsal passed 22/22 control-plane API tests, 8/8 UI contract
tests and 36/36 proxy tests. The UI suite checks source contracts; it is not a
browser smoke test. Fleet events (stop request, stop acknowledgement, run start,
agent start, approval) are metadata-only in `/api/fleet/events`.

## Full gate

```sh
pnpm run check        # typecheck + tests
pnpm run build
node --test --test-reporter=tap scripts/src/doc-truth.test.mjs
```

## Boundaries

- Learning is disabled on the identity path: enabling it there is refused, not
  degraded.
- Tool decisions and dispatch results are not yet mirrored into the fleet feed;
  `/api/fleet/events` carries run, approval, agent and stop events only.
- The fixture server simulates a destructive tool; nothing here touches real
  infrastructure.
- The fixture `orders_delete` hold expires after 5 s. This demo approves it
  before expiry; it does not wait for hold expiry. Hold expiry is covered by the
  policy tests, and grant expiry after hold approval is covered by the proxy
  identity test.
- GitHub `Dawe583/nomo`, branch `docs/nomo-agent-identity-fleet-2026-10-08`, is
  the active push target. GitLab remains at `4b895bd` and is not synchronized.
