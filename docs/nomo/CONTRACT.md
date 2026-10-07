# NOMO interface contract, v0 (spike draft)

Status: **draft for review, 2026-10-07.** Nothing in this file is implemented
unless the "Status" column says so. Owners confirm the sections marked
**[DAVID]** or **[MAX]** before Thursday's integration.

NOMO is the agent identity and fleet control plane built on top of VOID. VOID
already answers "how reversible is this call and what does the class policy
say" (R0 to R3, fail-closed, signed ledger). NOMO adds the question VOID
deliberately does not ask (`docs/DECISIONS.md`, WP-05: no identity "beyond the
workspace"): **which agent is asking, with which token, for which scope on
which target, and is that agent still allowed to exist.**

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
                          7 ledger append (signed, hash chained)  +  event to stream
operator ──8 kill-switch──▶ revocation store ──▶ next check denies, tokens dead, holds denied
```

## 1. Decision on layering (needs [DAVID])

NOMO does **not** replace `@void/policy`. A call passes three gates in order,
and the most restrictive answer wins (`deny > hold > allow`):

| Gate | Owner | Input | Source of rules |
| ---- | ----- | ----- | --------------- |
| 0. Kill-switch and token | NOMO (Oliver), token runtime (David) | agent id, token claims | revocation store |
| 1. Agent policy | NOMO (Oliver) | agent, tool, target, scope, class | `policy/agents.yaml` (new) |
| 2. Class policy | VOID (David), unchanged | tool, connector, workspace, class, blast radius | `policy/default.yaml` (existing) |

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
- The token value is never written to the ledger, the event stream, stderr or
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
| event stream unavailable | **call proceeds**; the ledger is the record, events are best effort, and a stderr line says events were dropped |

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
   `iat`. Nothing has to track `jti` lists.
4. Every pending hold for that agent resolves as denied
   (`by: "nomo:kill-switch"`), through the existing VOID `HoldQueue`.
5. A call already forwarded upstream before the kill **cannot be recalled**.
   The proxy sends `notifications/cancelled` for it where the session still
   maps it; whether the upstream honors that is up to the upstream. The ledger
   shows that call as allowed before the kill; replay is the recovery path.
6. Emits `agent.killed` to the event stream.

Reinstating is a separate explicit act (`reinstate(agentId, by, reason)`),
appended the same way. Tokens issued before the kill stay dead after a
reinstate, because their `iat` precedes the revocation.

Target, to be measured in the demo, not promised: the next call after `kill`
returns deny, i.e. latency is one store read, no polling interval.

## 8. Event stream format (needs [MAX])

One JSON object per line. The event stream is for the dashboard and
telemetry; **the ledger is the audit record.** Events reference ledger entries
by `seq` and `hash`, never the other way around.

```ts
export type NomoEvent = {
  readonly schema: "nomo.event.v0";
  readonly eventId: string;    // ULID, sortable
  readonly seq: number;        // per emitting process, gap means a dropped event
  readonly at: string;         // ISO 8601 UTC, millisecond precision
  readonly type:
    | "token.requested" | "token.issued" | "token.denied"
    | "policy.decided"
    | "hold.created" | "hold.resolved"
    | "tool.called" | "tool.completed" | "tool.failed"
    | "agent.killed" | "agent.reinstated"
    | "engine.error";
  readonly workspace: string;
  readonly requestId: string;
  readonly agentId: string;
  readonly sessionId?: string;
  readonly tool?: string;
  readonly connector?: string;
  readonly target?: string;
  readonly scope?: string;
  readonly class?: string;
  readonly decision?: "allow" | "deny" | "hold";
  readonly ruleId?: string;
  readonly layer?: string;
  readonly reason?: string;
  readonly tokenId?: string;   // jti only
  readonly argsDigest?: string;
  readonly durationMs?: number;
  readonly ledger?: { readonly seq: number; readonly hash: string };
};
```

Never in an event: token values, raw arguments, tool results, credentials,
environment variables. `reason` is the policy rationale text, which the
operator writes and must keep free of secrets.

Open for [MAX]: transport (JSONL file tail, stdout, or HTTP POST), whether he
wants `policy.decided` for every call or only non-allows, and whether the
dashboard reads the existing `void feed --json` for ledger rows instead.

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
1. Event shape (section 8), especially `requestId` as the join key.
2. Transport and volume (section 8).
3. Dashboard source for the audit view: ledger feed or event stream.

## Status

| Item | Status |
| ---- | ------ |
| This contract | draft, not confirmed |
| Agent policy loader and evaluation | in progress, `packages/agent-policy` |
| Kill-switch revocation check | in progress, same package |
| Token minting and signing | not started (David) |
| Proxy wiring | not started (David) |
| Event emitter | not started (Max) |
| MCP connector for the demo | not chosen yet |
