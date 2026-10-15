# NOMO interface contract, v0 (spike draft)

Status: **draft for review, 2026-10-07; identity sections revised 2026-10-11.**
Nothing in this file is implemented unless the "Status" column says so. Owners confirm the sections marked
**[DAVID]** or **[MAX]** before Thursday's integration.

NOMO is this repository: VOID, reworked and to be renamed, not a new codebase.
What VOID already has stays and is reused: the registry and its R0 to R3
classes, the class policy (`policy/default.yaml`, `@void/policy`), fail-closed
and observe postures, the proxy, the signed ledger, holds and approvals, and
Max's fleet view (`origin/max-spike`). The rework adds the question VOID
deliberately did not ask (`docs/DECISIONS.md`, WP-05: no identity "beyond the
workspace"): **which agent is asking, with which token, for which scope on
which target, and is that agent still allowed to run.**

Revision 2026-10-11: identity is David's, not this package's. The Workbench
local agent grant (`packages/workbench/src/agent-identity.ts`,
`LocalAgentIdentityIssuer`) issues the token, binds it to principal,
workspace, agent, run, upstream and tool scope, and is validated by the
inbound proxy per call. Stopping a run revokes its grant. The earlier NOMO
proposals for a signed token, a revocation store, a kill-switch CLI and a
fleet projection were removed from `packages/agent-policy`; the agent policy
now takes the identity a verified grant carries and decides what that agent
may do with it.

## 0. The one flow the spike must prove

```
run start ──1──▶ Workbench LocalAgentIdentityIssuer.issue (agent, run, workspace, upstream, tool scope, 60 s)
agent ──2 tools/call + grant──▶ inbound proxy ──3 validate(token, audience, upstream, tool)
                                │ identity (or null)
                                ▼
                          4 checkPolicy: grant gate, agents.yaml, VOID class policy
                                │ allow
                                ▼
                          5 MCP connector ──▶ fake/test data only
                                │
                          6 ledger append (signed, hash chained)
run stop ──7 issuer.revoke(runId)──▶ next validate returns null ──▶ deny nomo:no-grant
```

## 1. Decision on layering (needs [DAVID])

The agent policy does **not** replace `@void/policy`. A call passes three gates in order,
and the most restrictive answer wins (`deny > hold > allow`):

| Gate | Owner | Input | Source of rules |
| ---- | ----- | ----- | --------------- |
| 0. Grant | David (issuer, proxy validation, stop) | identity from `validate`, tool | Workbench local agent grant |
| 1. Agent policy | Oliver | agent, tool, target, scope, class | `policy/agents.yaml` (new) |
| 2. Class policy | David, existing code unchanged | tool, connector, workspace, class, blast radius | `policy/default.yaml` (existing) |

Why layered rather than a sixth match key in `@void/policy`: the VOID grammar
and its loader are frozen by WP-05, the proxy, SDK and workbench already depend
on them, and a separate file keeps "who may act" reviewable apart from "how
dangerous is the act". The alternative (adding `agent`, `target`, `scope` keys
to `MATCH_KEYS`) is possible because the grammar is additive by design.
**David decides which one.** This draft assumes layering.

## 2. Policy check input

```ts
/** One request to the engine. Never contains a token value or a secret. */
export type PolicyCheckRequest = {
  readonly contract: "nomo.policy-check.v0";
  /** Correlates token request, call, ledger entry and every event. ULID or UUID. */
  readonly requestId: string;
  /**
   * What `LocalAgentIdentityIssuer.validate` returned for this call, never an
   * agent id from the request body. Null when the grant is missing, expired or
   * revoked. agentId must match ^[a-z0-9][a-z0-9._-]{0,63}$ and be declared in
   * agents.yaml; workspaceId is the workspace rules match on.
   */
  readonly identity: {
    readonly agentId: string;
    readonly runId: string;
    readonly workspaceId: string;
    readonly toolScope: readonly string[];
  } | null;
  /** VOID registry entry id, for example fs.file.write or postgres.row.delete. Unregistered tools are class unknown. */
  readonly tool: string;
  /** Connector of the upstream, for example fs or postgres. Same as PolicyCall.connector. */
  readonly connector: string;
  /** Tool arguments. In memory only, used for classification; the ledger stores a digest. */
  readonly args: Readonly<Record<string, unknown>>;
  /**
   * The resource the call acts on, as a URI-like string the connector derives,
   * for example fs:sandbox/notes/todo.md or postgres:demo/public.orders.
   * Derived by the connector from args, never trusted from the agent directly.
   */
  readonly target: string;
  /** What the agent asks to be allowed to do. Closed set; unknown value = deny. */
  readonly scope: "read" | "write" | "delete" | "admin";
};
```

Classification (`class`, `blastRadius`) is **not** an input from the caller.
The engine obtains it from `@void/registry` exactly as the proxy does today
(`classifyTool` + declared facts + probe), so an agent cannot claim its own
class.

## 3. Policy check output

```ts
export type PolicyCheckResult = {
  readonly contract: "nomo.policy-check.v0";
  readonly requestId: string;
  readonly decision: "allow" | "deny" | "hold";
  /** Human and model readable. Names what would have to change. */
  readonly reason: string;
  /** VOID class of the call; "unknown" when the registry could not classify it. */
  readonly class: "r0" | "r1" | "r2" | "r3" | "unknown";
  /**
   * The rule that decided. Agent-policy rules carry their own id, for example
   * support-bot-read-notes. VOID class-policy rules have no id field today, so
   * they are named void:rule[<index>]. Built-in outcomes use the nomo: prefix:
   * nomo:no-grant, nomo:outside-grant, nomo:unknown-agent,
   * nomo:invalid-request, nomo:engine-error, nomo:default-deny.
   */
  readonly ruleId: string;
  /** Which gate produced the decision. */
  readonly layer: "grant" | "agent-policy" | "class-policy" | "engine";
  /** Present only on hold; the smaller of the two layers' timers, max 900. */
  readonly holdSeconds?: number;
  /** Every gate that was evaluated, in order, for the audit view. */
  readonly trace: readonly {
    readonly layer: PolicyCheckResult["layer"];
    readonly decision: "allow" | "deny" | "hold" | "skipped";
    readonly ruleId: string;
  }[];
  /** sha256 of agents.yaml content and of the VOID policy content, as VOID's policyDigest; null when a policy did not load. */
  readonly agentPolicyDigest: string | null;
  readonly classPolicyDigest: string | null;
};
```

Determinism: same request (including the identity), same `agents.yaml`, same
VOID policy and same facts give the same result. Time lives in the issuer:
expiry and revocation reach the check as a null identity. No
randomness, no network calls inside the engine, first match wins by file order.

## 4. Agent policy file (`policy/agents.yaml`)

Same posture as VOID's file: declarative, no expressions, no regex, unknown key
or value is a load error, the last rule must be `match: {}` and **must deny**.

```yaml
version: 1
agents:
  - id: demo-support-bot
    owner: oliver           # who answers for it; free text
rules:
  - id: support-bot-reads-notes
    match:
      agent: demo-support-bot
      tool: notes.read
      target_prefix: fs:sandbox/notes/
      scope: read
      class: unknown        # the VOID registry classifies writes; a read tool is unknown
    decision: allow
    rationale: the support bot may read the shared notes folder
  - id: support-bot-writes-drafts
    match:
      agent: demo-support-bot
      tool: fs.file.write
      target_prefix: fs:sandbox/drafts/
      scope: write
      class: [r0, r1]
    decision: allow
    rationale: drafts are reversible, the ledger keeps the inverse
  - id: support-bot-deletes-need-a-human
    match:
      agent: demo-support-bot
      scope: delete
    decision: hold
    seconds: 120
    rationale: deleting anything waits for a person
  - id: default-deny
    match: {}
    decision: deny
    rationale: no rule grants this agent this action
```

Match keys: `agent`, `tool`, `connector`, `target`, `target_prefix`, `scope`,
`class`, `workspace`. Keys AND together, list values OR. `class: unknown` must
be listed explicitly for an allow to cover an unclassified call (same rule as
VOID). A rule naming an agent that is not declared under `agents` is a load
error. An agent id not declared at all is denied with `nomo:unknown-agent`
before any rule is read.

## 5. The grant (David's, on main)

The token is the Workbench local agent grant, not a NOMO format:

- `LocalAgentIdentityIssuer.issue(binding)` returns an opaque 32 byte
  base64url token, stored only as a sha256 digest, valid 60 seconds on both a
  monotonic and a wall clock, one live grant per run.
- `validate(token, { audience, upstreamId, toolName })` returns the
  `LocalAgentIdentity` (principal, workspace, agent, run, upstream, sorted
  tool scope, issuer, audience, issuedAt, expiresAt) or null: wrong audience,
  wrong upstream, a tool outside the scope, expiry, revocation or a clock that
  went backwards are all null.
- `revoke(runId)` drops the run's grant. The Workbench calls it when a run
  ends or is stopped, so a stopped agent's next call validates to null.

`checkPolicy` takes that identity as given. It checks its shape again and
that the tool is in its scope (`nomo:outside-grant`), as a second guard for a
caller that passed `authenticate` output instead of `validate` output. The
grant names the tool, not the target or the scope; those are what
`agents.yaml` decides.

Open for [DAVID]: the Workbench grant today names one agent per principal
(`workbench-local-agent`). Per agent rules in `agents.yaml` need the grant to
carry the NOMO agent id the operator declared.

## 6. How the proxy calls the engine, and failure (needs [DAVID])

The engine is an in-process function, not a service, for the spike:

```ts
export function checkPolicy(
  request: PolicyCheckRequest,
  deps: {
    readonly agentPolicy: LoadedAgentPolicy;  // from loadAgentPolicy(text)
    readonly classPolicy: LoadedPolicy;       // VOID loadPolicy, unchanged
    readonly classify: () => EvaluationResult; // VOID registry, unchanged
    readonly blastRadius?: number;             // from a connector probe, when measured
  },
): PolicyCheckResult;
```

The natural hook is the existing `policy` dependency of `interceptCall` in
`packages/proxy/src/forward/tools.ts`: today it calls `decide(policy, call)`;
under NOMO it calls `checkPolicy` and maps the result back to the
`PolicyDecision` the proxy already understands, so holds, ledger writes and
error bodies keep working unchanged. The inbound proxy already validates the
grant per call (`validateGrant` in `startLocalMcpHttpServer`); the identity it
gets back is what it passes as `identity`.

Fail-closed, always, including in VOID `observe` posture for gate 0:

| Failure | Result |
| ------- | ------ |
| `agents.yaml` missing, unreadable, invalid | deny, `nomo:engine-error`, proxy refuses startup |
| engine throws | deny, `nomo:engine-error` |
| agent not declared | deny, `nomo:unknown-agent` |
| tool unknown to the registry | class `unknown`; deny unless a rule lists `class: unknown` |
| grant missing, expired, revoked, wrong audience or upstream | deny, `nomo:no-grant` |
| tool outside the grant's scope | deny, `nomo:outside-grant` (or `nomo:no-grant` when `validate` already refused it) |
| ledger append fails | deny (existing VOID behavior) |
| fleet feed unavailable | **call proceeds**; the ledger is the record, the feed is a view, and a stderr line says events were dropped |

Proposal for [DAVID]: VOID `observe` posture may forward class-policy
non-allows as it does today, but **must never forward a grant denial**. A
trial mode that runs stopped agents is not a trial of NOMO.

## 7. Stopping an agent

David's stop path on main is the kill-switch: when a run ends or is stopped,
the Workbench calls `LocalAgentIdentityIssuer.revoke(runId)`, and every later
call with that grant validates to null and is denied as `nomo:no-grant`
before any rule is read. A call already forwarded upstream cannot be
recalled; `docs/NOMO-LOCAL-IDENTITY-DEMO.md` covers stop acknowledgement and
in-flight calls.

The earlier NOMO proposal (an append-only revocation store, `void kill` and
`void reinstate`, an agent hold index) was removed so there is one stop path.
Stopping every run of one agent at once, across runs, is not covered by a
per-run revoke; open for [DAVID] if the demo needs it.

## 8. Events (needs [MAX])

The fleet projection proposed here earlier was removed with the token and
kill-switch code. David's control plane emits run, agent and approval fleet
events on main. Open for [MAX] and [DAVID]: whether a `policy.decided` event
with `ruleId`, `layer` and `class` joins those, under the same rule that a
target, a reason text and argument digests never reach the feed.

## 9. Ledger (needs [DAVID])

The VOID ledger body today has `at, tool, klass, decision, argsDigest,
attribution, workspace` and no agent. Proposal: add an optional
`agent: { id, runId? }` object to the body. `packages/ledger/src/attribution.ts`
documents why an additive body field keeps old entries verifying.

## 10. Confirm list

**David**
1. Layering (section 1) or new match keys in `@void/policy`.
2. The grant carrying the declared NOMO agent id instead of `workbench-local-agent` (section 5).
3. Grant denials never bypassed by `observe` (section 6).
4. Optional `agent` field in the ledger body (section 9).
5. Package name: `@void/agent-policy` now, rename with the repo later?
6. Stopping all runs of one agent at once, if the demo needs it (section 7).

**Max**
1. Whether `policy.decided` joins the fleet events, and for allows too (section 8).

## Status

| Item | Status |
| ---- | ------ |
| This contract | draft, not confirmed |
| Agent policy loader and evaluation | implemented in `packages/agent-policy`, not wired into the proxy |
| Grant gate (`nomo:no-grant`, `nomo:outside-grant`) over the Workbench grant identity | implemented in `checkPolicy` |
| Token, revocation store, kill-switch, `void kill` / `void reinstate`, fleet projection | removed 2026-10-11 in favour of David's grant and stop path on main |
| Section 0 flow end to end | one in-process test (`spike.test.ts`) through David's real `LocalAgentIdentityIssuer`: issue, validate per call, agents.yaml, fake connector, stop, expiry; no proxy |
| Proxy wiring of `checkPolicy` | not started (David) |
| MCP connector for the demo | not chosen yet |
| Default `policy/agents.yaml` generator (T2) | `writeDefaultAgentPolicy` in `packages/agent-policy`: one agent, terminal deny, never overwrites an existing file, 12 tests; not called from `void init` until the T1 package is agreed |
