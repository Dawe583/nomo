# NOMO interface contract, v0 (spike draft)

Status: **draft for review, 2026-10-07.** Nothing in this file is implemented
unless the "Status" column says so. Owners confirm the sections marked
**[DAVID]** or **[MAX]** before Thursday's integration.

NOMO is this repository: VOID, reworked and to be renamed, not a new codebase.
What VOID already has stays and is reused: the registry and its R0 to R3
classes, the class policy (`policy/default.yaml`, `@void/policy`), fail-closed
and observe postures, the proxy, the signed ledger, holds and approvals, and
Max's fleet view (`origin/max-spike`). The rework adds the question VOID
deliberately did not ask (`docs/DECISIONS.md`, WP-05: no identity "beyond the
workspace"): **which agent is asking, with which token, for which scope on
which target, and is that agent still allowed to run.**

## 0. The one flow the spike must prove

```
agent ──1 token request──▶ NOMO issuer ──2 policy check──▶ engine (allow/deny/hold)
                                │ allow
                                ▼
                          3 mint 60 s token (jti, agent, tool, target, scope)
agent ──4 tools/call + token──▶ VOID proxy ──5 re-check (token + engine + VOID class policy)
                                │ allow
                                ▼
                          6 MCP connector ──▶ fake/test data only
                                │
                          7 ledger append (signed, hash chained)  +  fleet feed event
operator ──8 kill-switch──▶ revocation store ──▶ next check denies, tokens dead, holds denied
```

## 1. Decision on layering (needs [DAVID])

The agent policy does **not** replace `@void/policy`. A call passes three gates in order,
and the most restrictive answer wins (`deny > hold > allow`):

| Gate | Owner | Input | Source of rules |
| ---- | ----- | ----- | --------------- |
| 0. Kill-switch and token | Oliver, token runtime (David) | agent id, token claims | revocation store |
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
  readonly agent: {
    /** Stable agent identity, ^[a-z0-9][a-z0-9._-]{0,63}$. Declared in agents.yaml. */
    readonly id: string;
    /** Optional run or conversation id, for the dashboard only; never matched on. */
    readonly sessionId?: string;
  };
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
  /** VOID workspace tag the proxy runs with. */
  readonly workspace: string;
  /** Present on the call-time check (step 5), absent on the issuance check (step 2). */
  readonly token?: TokenClaims;
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
   * nomo:kill-switch, nomo:unknown-agent, nomo:token-invalid, nomo:token-expired,
   * nomo:token-mismatch, nomo:engine-error, nomo:default-deny.
   */
  readonly ruleId: string;
  /** Which gate produced the decision. */
  readonly layer: "kill-switch" | "token" | "agent-policy" | "class-policy" | "engine";
  /** Present only on hold; the smaller of the two layers' timers, max 900. */
  readonly holdSeconds?: number;
  /** Every gate that was evaluated, in order, for the audit view. */
  readonly trace: readonly {
    readonly layer: PolicyCheckResult["layer"];
    readonly decision: "allow" | "deny" | "hold" | "skipped";
    readonly ruleId: string;
  }[];
  /** sha256 of agents.yaml content and of the VOID policy content, as VOID's policyDigest. */
  readonly agentPolicyDigest: string;
  readonly classPolicyDigest: string;
};
```

Determinism: same request, same `agents.yaml`, same VOID policy, same facts,
same revocation store state and same clock second give the same result. No
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

## 5. Ephemeral token (needs [DAVID])

NOMO defines the claims and the checks. David's runtime defines the encoding
and the signature (ed25519 via the existing `KeyProvider` is the obvious fit).

```ts
export type TokenClaims = {
  readonly jti: string;          // unique token id; the only thing ever logged
  readonly agentId: string;
  readonly tool: string;
  readonly target: string;
  readonly scope: "read" | "write" | "delete" | "admin";
  readonly workspace: string;
  readonly iat: number;          // unix seconds
  readonly exp: number;          // iat + 60, never more
  readonly agentPolicyDigest: string; // policy the token was issued under
};
```

- TTL is 60 seconds and not renewable. A new action needs a new request.
- Issued only on `allow`. On `hold` the issuer waits for the human; approval
  issues the token, deny or expiry issues nothing.
- At call time (step 5) the proxy checks, in this order: signature, `exp`
  against its own clock (no skew allowance in the spike), kill-switch, that
  `agentId/tool/target/scope/workspace` equal the call, then runs the engine
  again. A policy file that changed after issuance is fine as long as the
  re-check still allows.
- The token value is never written to the ledger, the fleet feed, stderr or
  an error body. Only `jti`.

## 6. How the proxy calls the engine, and failure (needs [DAVID])

The engine is an in-process function, not a service, for the spike:

```ts
export function checkPolicy(
  request: PolicyCheckRequest,
  deps: {
    readonly agentPolicy: LoadedAgentPolicy;  // from loadAgentPolicy(text)
    readonly classPolicy: LoadedPolicy;       // VOID loadPolicy, unchanged
    readonly classify: () => EvaluationResult; // VOID registry, unchanged
    readonly revocations: RevocationView;      // kill-switch state
    readonly now: () => Date;
    readonly blastRadius?: number;             // from a connector probe, when measured
    readonly requireToken: boolean;            // true in the proxy, false at issuance
  },
): PolicyCheckResult;
```

The natural hook is the existing `policy` dependency of `interceptCall` in
`packages/proxy/src/forward/tools.ts`: today it calls `decide(policy, call)`;
under NOMO it calls `checkPolicy` and maps the result back to the
`PolicyDecision` the proxy already understands, so holds, ledger writes and
error bodies keep working unchanged. The proxy must additionally pass the agent
id and token, which today it does not receive: **David picks where the agent
identity enters the proxy** (MCP `_meta` on `tools/call`, a per-session
`initialize` claim, or a proxy started per agent).

Fail-closed, always, including in VOID `observe` posture for gate 0:

| Failure | Result |
| ------- | ------ |
| `agents.yaml` missing, unreadable, invalid | deny, `nomo:engine-error`, proxy refuses startup |
| revocation store unreadable | deny every call, `nomo:engine-error` |
| engine throws | deny, `nomo:engine-error` |
| agent not declared | deny, `nomo:unknown-agent` |
| tool unknown to the registry | class `unknown`; deny unless a rule lists `class: unknown` |
| token missing, bad signature, expired, mismatched | deny, `nomo:token-*` |
| ledger append fails | deny (existing VOID behavior) |
| fleet feed unavailable | **call proceeds**; the ledger is the record, the feed is a view, and a stderr line says events were dropped |

Proposal for [DAVID]: VOID `observe` posture may forward class-policy
non-allows as it does today, but **must never forward a kill-switch or token
denial**. A trial mode that runs revoked agents is not a trial of NOMO.

## 7. Kill-switch

```ts
export type Revocation = {
  readonly agentId: string;
  readonly at: string;       // ISO 8601 UTC
  readonly by: string;       // the operator
  readonly reason: string;
};
```

Calling `kill(agentId, by, reason)`:

1. Appends a `Revocation` to the revocation store (append-only JSONL for the
   spike) and a signed ledger entry `decision: "agent:killed"`.
2. From that moment every `checkPolicy` for that agent returns
   `deny / nomo:kill-switch / layer kill-switch`, before any rule is read.
3. Every outstanding token dies without enumerating them: a token is invalid
   when its agent has a revocation whose `at` is at or after the token's
   `iat`. Nothing has to track `jti` lists. `iat` is in whole seconds, so a
   token issued in the same second as a kill is treated as killed too.
4. Every pending hold for that agent resolves as denied
   (`by: "nomo:kill-switch"`), through the existing VOID `HoldQueue`.
5. A call already forwarded upstream before the kill **cannot be recalled**.
   The proxy sends `notifications/cancelled` for it where the session still
   maps it; whether the upstream honors that is up to the upstream. The ledger
   shows that call as allowed before the kill; replay is the recovery path.
6. Emits `agent.killed` to the fleet feed.

Reinstating is a separate explicit act (`reinstate(agentId, by, reason)`),
appended the same way. Tokens issued before the kill stay dead after a
reinstate, because their `iat` precedes the revocation.

Target, to be measured in the demo, not promised: the next call after `kill`
returns deny, i.e. latency is one store read, no polling interval.

Implemented so far (`packages/agent-policy/src/kill.ts`, `packages/cli/src/kill.ts`):

- `killAgent` covers steps 1 to 4 without the ledger entry. It is never
  blocked: a corrupt store, an unseen agent, a repeated kill or a store lock
  that stays held (reported as `lockTimedOut`) still appends. A hold whose
  denier throws does not stop the sweep: it is returned in `failedHolds`, stays
  in the index, and the next kill retries it. An invalid clock is a
  `KillSwitchError` and writes nothing.
  `reinstateAgent` is strict: it refuses a corrupt store, an agent that is not
  killed, an empty reason, a time earlier than the agent's last record, and a
  kill that landed while it waited for the lock.
- Kill and reinstate write under `<store>.lock` (exclusive create, broken after
  10 s as left by a dead writer), so a reinstate cannot read the store, miss a
  concurrent kill and append after it.
- `at` in the store is accepted only as an ISO 8601 UTC instant ending in `Z`;
  a zoneless time, an offset or a calendar overflow (02-30) is a corrupt store.
- Pending holds: VOID's `HeldCall` has no agent, so the proxy records
  hold id to agent in an `AgentHoldIndex` when it parks a call, and passes
  `HoldQueue.resolve` (or `ApprovalBroker.decide`) as the denier. VOID's hold
  code stays unchanged. Until the proxy is wired, nothing fills the index.
- `void kill <agent> --by <actor> [--reason]` and
  `void reinstate <agent> --by <actor> --reason <text>` append to the store.
  They refuse an id that `policy/agents.yaml` does not declare unless
  `--force` is given, so a typo cannot read as a stopped agent. The CLI is a
  separate process and denies no hold itself.
- Store location, provisional until David answers item 7: `--store`, else
  `VOID_REVOCATIONS`, else `~/.void/nomo/<workspace>/revocations.jsonl`.
  Whoever can write that file can reinstate an agent, so it needs the same
  operator-only protection as the approvals directory; the spike does not
  enforce it yet.
- Open for the proxy wiring: re-check the kill-switch when a hold is
  approved, as a second guard alongside the sweep.

## 8. Events: extend Max's fleet feed (needs [MAX])

Max's fleet feed already exists on `origin/max-spike`
(`packages/workbench/src/fleet.ts`, decision "Fleet is a view of the host's own
runs", 2026-10-07). NOMO does not define a second stream. It proposes additive
types and fields on his `FleetEvent`, under his rules: each event is built
field by field from a closed set, never spread from a source event; the feed
is an in-memory ring of 500 with an epoch, not a store; **the ledger is the
audit record**, the feed is a view.

His shape today: `cursor, at, type, sessionId, runId?, agent?, model, state?,
tool?, outcome?, totalTokens?`, with types `run.state, tool.started,
tool.finished, approval.held, usage.reported`.

Proposed additions:

```ts
// new FLEET_EVENT_TYPES
| "policy.decided"     // every non-allow, and allows only if Max wants volume
| "token.issued"
| "agent.killed"
| "agent.reinstated"

// new optional FleetEvent fields
readonly requestId?: string;          // joins token request, call, ledger entry
readonly decision?: "allow" | "deny" | "hold";
readonly ruleId?: string;             // e.g. support-bot-writes-drafts, void:rule[3], nomo:kill-switch
readonly layer?: "kill-switch" | "token" | "agent-policy" | "class-policy" | "engine";
readonly class?: "r0" | "r1" | "r2" | "r3" | "unknown";
readonly scope?: "read" | "write" | "delete" | "admin";
readonly tokenId?: string;            // jti only, never the token value
readonly ledger?: { readonly seq: number; readonly hash: string };
```

`agent` in his event should carry the NOMO agent id from `agents.yaml`.

Deliberately **not** in the feed, following his threat-model note (section
3.4): `target`, `reason` text and argument digests. A target is a path or a
table name taken from the arguments, and a reason can quote an operator's
rationale. Both stay in the policy result and the ledger, where access is
already controlled.

Implemented without touching the workbench (`packages/agent-policy/src/fleet.ts`):
`projectPolicyDecision(request, result, { ledger? })`, `projectTokenIssued(claims,
requestId)` and `projectRevocation(record)` return only the fields above plus
`type`, `agent` and `tool`, built field by field from a closed list. Values that
fail their shape check are dropped. Cursor, `at`, `sessionId` and `model` stay
Max's to add. The operator (`by`) and the revocation reason are not projected
either. A test plants markers in the target, the rationale, the arguments, the
operator and the reason, and fails if any reaches an output.

Open for [MAX]: whether `policy.decided` is sent for allows too, whether the
projection lives next to `projectFleetEvent` or the proxy emits these directly,
and whether the Fleet page shows a killed agent as its own state.

## 9. Ledger (needs [DAVID])

The VOID ledger body today has `at, tool, klass, decision, argsDigest,
attribution, workspace` and no agent. Proposal: add an optional
`agent: { id, tokenId? }` object to the body. `packages/ledger/src/attribution.ts`
documents why an additive body field keeps old entries verifying. Plus two new
`decision` strings: `agent:killed`, `agent:reinstated`.

## 10. Confirm list

**David**
1. Layering (section 1) or new match keys in `@void/policy`.
2. Where agent id and token enter the proxy (section 6).
3. Token encoding and signing, TTL 60 s non-renewable (section 5).
4. Kill-switch and token denials bypass `observe` never (section 6).
5. Optional `agent` field in the ledger body and the two new decisions (section 9).
6. Package name: `@void/agent-policy` now, rename with the repo later?
7. Who owns the revocation store file, and its location.

**Max**
1. The additive fleet types and fields (section 8), especially `requestId`.
2. Volume: `policy.decided` for every call or only non-allows.
3. Where the projection lives, and how the Fleet page shows a killed agent.

## Status

| Item | Status |
| ---- | ------ |
| This contract | draft, not confirmed |
| Agent policy loader and evaluation | implemented in `packages/agent-policy`, not wired into the proxy |
| Kill-switch check, revocation JSONL store, token claim check | implemented in the same package |
| `killAgent` / `reinstateAgent`, hold sweep via `AgentHoldIndex` | implemented, store lock against the reinstate race, 55 package tests; the index is not filled until the proxy is wired; no ledger entry yet (section 9) |
| `void kill` / `void reinstate` CLI | implemented, 7 tests; store location provisional (item 7) |
| Token minting and signing | not started (David) |
| Proxy wiring | not started (David) |
| Fleet feed | exists on `origin/max-spike` (Max); NOMO projection implemented in `packages/agent-policy` (7 tests), not joined to his feed |
| MCP connector for the demo | not chosen yet |
| Default `policy/agents.yaml` generator (T2) | `writeDefaultAgentPolicy` in `packages/agent-policy`: one agent, terminal deny, never overwrites an existing file, 12 tests; not called from `void init` until the T1 package is agreed |
