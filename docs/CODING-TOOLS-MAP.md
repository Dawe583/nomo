# Coding tools map — evidence for "add coding tools (read, write, search, run)"

Reconnaissance only. Every claim carries a `file.ts:line` citation. Where a claim
could not be verified from the source it is marked **unverified** rather than
reasoned out. Where a comment and the code disagree, both are quoted.

Scope note: `packages/workbench/src/` was being edited concurrently while this
was written. Line numbers are from the working tree as read; a concurrent
unrelated edit may shift them.

---

## 1. The tool catalogue

### The type

```ts
// packages/workbench/src/mcp.ts:23
export type McpTool = { name: string; description?: string; inputSchema?: unknown; connectorId?: string };
```

`connectorId` is the only discriminator: it is `undefined` for managed workspace
tools, the connector's own id for remote MCP connectors, and the literal
`"stdio"` for tools proxied through the NOMO SDK. Every dispatch decision in
`executeTool` keys off it (`packages/workbench/src/index.ts:2474`, `:2487`,
`:2520`, `:2544`).

`McpConfig` (`packages/workbench/src/mcp.ts:22`) carries the per-connector
policy, facts and mapping. `catalog()` (`packages/workbench/src/mcp.ts:98-109`)
does initialize + `tools/list` and caps the catalogue at 100 tools.

### The three sources of tools

| Source | Assembled at | How `connectorId` is set |
| --- | --- | --- |
| Workspace tools | `packages/workbench/src/index.ts:1082` — `const tools: McpTool[] = [...workspaceTools]` | left `undefined` |
| Confirmed connectors | `packages/workbench/src/index.ts:1086-1093` | `connectorId: connector.id` |
| SDK/stdio upstream | `packages/workbench/src/index.ts:1094-1101` | `connectorId: "stdio"` |

The workspace set is defined once, in `packages/workbench/src/workspace.ts:25-30`:

```
nomo_workspace_list, nomo_workspace_read, nomo_workspace_write, nomo_workspace_delete
```

Connector tools are added only when `connector.consentState === "confirmed"`
(`packages/workbench/src/index.ts:1087`); the consent state machine is set by
`probeConnector`/consent endpoints, and the connector's own policy string is
validated at add/edit time (`packages/workbench/src/index.ts:1680-1681`,
`:1706-1707`).

`availableTools()` is the read-only view of the same three sources
(`packages/workbench/src/index.ts:944-968`), then filtered by
`toolAllowedInMode` (`:957`) and rendered by `toolCatalog`
(`packages/workbench/src/tool-catalog.ts:4-18`).

### What the provider actually sees

Tool names are replaced by positional aliases before the provider is called:

```ts
// packages/workbench/src/index.ts:2650-2660
const mapping = new Map(listed.tools.map((tool, index) => [`tool_${index}`, tool]));
const tools = listed.tools.map((tool, index) => ({
  type: "function",
  function: { name: `tool_${index}`, ... },
}));
```

A returned call name that is not in `mapping` is refused outright:

```ts
// packages/workbench/src/index.ts:2739-2744
const tool = mapping.get(call.function.name);
const name = tool?.name;
if (!name) throw new Error("Provider requested a tool outside the approved MCP catalog.");
```

This is the load-bearing gate for question 2. See below.

### Two filters sit between the catalogue and the model

- `toolAllowedInMode` (`packages/workbench/src/index.ts:1420-1422`) — outside
  `normal` mode, only `nomo_workspace_list` and `nomo_workspace_read` survive,
  and only when `connectorId` is unset.
- The agent-profile allowlist, applied at session construction
  (`packages/workbench/src/index.ts:1148`) and re-checked at dispatch
  (`:2472-2473`). An allowlist name that is not in the currently available set
  is refused at profile-save time (`:769-770`).

`PermissionMode` is `"plan" | "read-only" | "normal"`
(`packages/workbench/src/gui.ts:180`); malformed or absent config resolves to
`read-only` on the server (`:200-203`), while the local default is `normal`
(`:195-196`).

---

## 2. The deliberate absence

The comment in full (`packages/workbench/src/index.ts:337-338`):

> `/** Model tools always cross the existing NOMO SDK. A provider has no shell or`
> ` * filesystem authority; operators configure the MCP upstream on the runtime. */`

It sits directly above `export class Workbench` (`:339`).

### What actually enforces it

**There is no allow/deny mechanism for the host filesystem.** Nothing in the
workbench, policy package or registry inspects a path and refuses it because it
is on the host. What enforces the property is three structural facts:

1. **The catalogue simply does not contain such a tool.** The workspace set is
   a frozen four-element literal (`packages/workbench/src/workspace.ts:25-30`)
   and the managed store is a `Record<string, string>` keyed by an opaque
   workspace-relative path (`workspace.ts:15-19`), never a host path. There is
   no code path from a tool argument to `node:fs` for a model-initiated call.
2. **The provider can only name a tool that was already in the mapping**
   (`packages/workbench/src/index.ts:2739-2744`, quoted above). A fabricated
   name cannot reach any executor.
3. **The permission mode and agent allowlist** narrow further
   (`:1420-1422`, `:2472-2473`).

**So: host filesystem access is structurally impossible for the *model*, and
merely absent-from-the-catalogue for everything else.** The distinction matters
because the catalogue is assembled in one place (`:1082-1101`) from three
sources, and an operator-configured MCP upstream is one of them. If the operator
configures an upstream that itself touches the host, the model gets that tool —
NOMO proxies it (`:2487-2519`) but does not remove its capability. The
security review already states this in the open:

> `packages/security-notes.md:12-14` — "A local upstream running as the proxy OS
> user is not sandboxed. It can read that user's files."

The comment's phrasing "no shell or filesystem authority" is therefore accurate
about NOMO's own tool surface and *not* accurate as a statement about the
process: `NOMO_UPSTREAM_COMMAND` (`:1051`) spawns an arbitrary operator-named
command (`packages/sdk/src/client.ts:272-278`), and `NOMO_HOOK_COMMANDS`
spawns hook processes (`packages/workbench/src/agents.ts:237`), both as the
host user.

---

## 3. Classification

### The scale

`RegistryTone = "r0" | "r1" | "r2" | "r3"` (`packages/registry/src/registry.ts:24`),
ranked r0 best to r3 worst (`packages/registry/src/evaluate.ts:53-54`).

Prose definition, from `docs/CONTEXT.md:47-48`:

> **Class R0 to R3**: fully reversible, reversible with trace, mitigable only,
> irreversible. A class belongs to a call, never to a tool.

Per-class policy posture, `docs/HANDBOOK.md:118-123`:

| Class | Meaning | Default posture |
| --- | --- | --- |
| r0 | Fully reversible with a direct inverse. | Allow |
| r1 | Reversible with a trace or a before image. | Allow for small blast radius, hold for large |
| r2 | Mitigable only. | Hold or deny |
| r3 | Irreversible. | Hold or deny |

### The helper

```ts
// packages/workbench/src/workspace.ts:34-38
export function workspaceToolClass(name: string): 'r0' | 'r1' | undefined {
  if (name === 'nomo_workspace_list' || name === 'nomo_workspace_read') return 'r0';
  if (name === 'nomo_workspace_write' || name === 'nomo_workspace_delete') return 'r1';
  return undefined;
}
```

**The real scale for workspace tools is three classes: r0, r1, and r3.** There
is no r2 workspace tool. `undefined` is coerced to `r3` at three call sites:
`packages/workbench/src/index.ts:2233-2235` (ledger body), `:2477` (agent-profile
policy call), and `packages/workbench/src/tool-catalog.ts:12` (display). The
`?? "r3"` fallbacks are the fail-closed posture stated in
`packages/policy/src/grammar.ts:45-46`.

`nomo_workspace_undo` is classified `r1` at `:2235` but is explicitly **not a
model tool**: `packages/workbench/src/workspace.ts:73` says "Do not expose this
as a model tool. The operator explicitly approves undo." It is reachable only
through the operator surface.

### Connector classification

Connector tools go through the registry, not `workspaceToolClass`:
`classifyTool` (`packages/registry/src/evaluate.ts:113-121`), called at
`packages/workbench/src/index.ts:2547-2550` with connector facts and the real
arguments. Unknown tool → `unknown-tool` outcome → the workbench substitutes
`{ kind: "deny" }` outright (`packages/workbench/src/index.ts:2571-2574`),
a stricter posture than the policy package's `unknown`-class opt-in
(`packages/policy/src/decide.ts:170-177`).

**A hypothetical `read`/`search` coding tool would need a decision the existing
scale does not make for it.** Under `workspaceToolClass`'s shape it would be
r0 (read) and r1 (write) — but r0 is *allowed with no hold at all* under
`DEFAULT_POLICY`:

```
// packages/workbench/src/index.ts:215-216
version: 1 / rules: / class: r0 → allow / {} → hold, seconds: 300, notify: [cli]
```

So a `read`/`search` tool at r0 would bypass the hold path entirely, and a
`write`/`run` tool at r1 would be held only because the catch-all holds
everything non-r0, not because any rule names writes. **`blast_radius` is the
only lever that separates small from large within a class** — and the workbench
hardcodes `blastRadius: 1` for workspace calls
(`packages/workbench/src/index.ts:2477`), so that lever is inert for workspace
tools today.

---

## 4. The hold path

Two independent implementations exist. They share `decide` and `ApprovalBroker`
but have separate ledgers, separate storage and separate entry points.

### A. Workbench-local holds (workspace tools, and connector holds made locally)

| Step | Where |
| --- | --- |
| Decision becomes a hold | `decide()` returns `{ kind: "hold", seconds, notify, ruleIndex, rationale }` — `packages/policy/src/decide.ts:183-189` |
| The pre-decision record is written first | `packages/workbench/src/index.ts:2332-2344` (`commitWorkspace` with `decision.kind`) |
| Hold object created, keyed `${sessionId}:${uuid}` | `packages/workbench/src/index.ts:2346-2362` |
| Session event + persisted state | `:2363-2364` |
| The model turn blocks on a 100 ms poll loop until approved/denied/expired | `:2365-2372` |
| Cancellation converts a pending hold to denied by `"runtime"` | `:2373-2377` |
| The outcome is committed as `hold:approved` or `hold:denied` with `approvedBy`/`approvalReason` | `:2378-2390` |
| Hold moved to `approvalHistory` and removed from live map | `:2391-2392` |
| Return value gates execution | `:2394`, consumed at `:2575-2583` and `:2479-2484` |

`HoldDeniedError` is **not** used on this path. It belongs to the SDK/proxy path
below. The workbench returns `isError` content with `denialText`
(`packages/workbench/src/index.ts:249-266`).

### B. SDK/proxy holds (tools with `connectorId === "stdio"`)

| Step | Where |
| --- | --- |
| Workbench forwards `tools/call` over the SDK and does **not** decide | `packages/workbench/src/index.ts:2487-2500` |
| Ledger is re-synced from the proxy's own signed file | `syncStdio`, `packages/workbench/src/index.ts:2279-2329` |
| Proxy classifies and decides | `packages/proxy/src/bin.ts:701-704`, `packages/proxy/src/forward/tools.ts:105-110` |
| Decision record written **before** the verdict | `packages/proxy/src/forward/tools.ts:112-122` |
| Hold parks the call; capture gate runs on approval | `:179-236` |
| `hold:approved` / `hold:denied` / `hold:expired` written to the proxy ledger | `:207-215`, `:224-232` |
| `HoldQueue.hold` — the blocking primitive | `packages/policy/src/hold.ts:112-139` |
| `HoldQueue.resolve` | `packages/policy/src/hold.ts:142-147` |
| Broker registration + notification fan-out | `packages/policy/src/approvals.ts:214-234` |
| Broker `decide` resolves the queue and persists | `packages/policy/src/approvals.ts:236-257` |
| `HoldDeniedError` constructed by the SDK client | `packages/sdk/src/client.ts:566-567` |
| The class itself | `packages/sdk/src/errors.ts:10-21`, `code = "NOMO_HOLD_DENIED"` |

`HoldDeniedError` is only thrown when the upstream reports `result: "denied"` or
`"expired"` (`packages/sdk/src/client.ts:566`). The workbench deliberately does
**not** trust that typed error on its own — it requires fresh, verified,
digest-matching proxy evidence:

```ts
// packages/workbench/src/index.ts:2502-2518
// A typed denial alone can be forged by an upstream. Require fresh,
// verified proxy evidence for this exact tool and argument digest.
...
if (outcome.error instanceof HoldDeniedError && (receipt?.decision === "hold:denied" || receipt?.decision === "hold:expired")) {
  return { isError: true, content: [{ type: "text", text: outcome.error.message }] };
}
throw new UnknownToolOutcome();
```

### C. Where the operator decides

- `Workbench.decide(id, { kind: "approved" | "denied", by, reason })` —
  `packages/workbench/src/index.ts:1334-1363`. Mutates the in-memory hold,
  persists, and on failure rolls the status back (`:1350-1355`). Falls through
  to the SDK client for proxy holds (`:1358-1362`).
- `Workbench.pending()` lists live holds across both surfaces
  (`packages/workbench/src/index.ts:1315-1332`).
- TUI caller: `packages/cli/src/tui/workspace.ts:1433-1438` passes
  `by: "tui-operator"`.
- Cloud caller: `cloud/steps.mjs:210-213` mints a `decisionToken` per hold.
- The broker's out-of-band decision-file path (a second process approving):
  `packages/policy/src/approvals.ts:324-328`.

### D. Where the decision reaches the ledger

Every decision is written by `commitWorkspace`
(`packages/workbench/src/index.ts:2210-2278`): body assembled at `:2227-2254`,
`argsDigest` at `:2237`, `approval.by`/`approval.reason` at `:2228-2229`,
chained at `:2255-2267`, and applied with rollback-on-persist-failure at
`:2268-2277`. The stdio path writes into the same chain via `syncStdio`
(`:2317-2326`) with `source: "stdio-proxy"` metadata.

---

## 5. Policy matching

`RuleMatch` is an open index signature, but the grammar is closed at five keys:

```ts
// packages/policy/src/grammar.ts:16-23
/** The whole grammar. Five keys, and every one of them is used. */
export const MATCH_KEYS = ["class", "tool", "connector", "workspace", "blast_radius"] as const;
```

A test pins the count and the exact set
(`packages/policy/src/index.test.ts:13-16`), and a near-miss key name is not a
match key (`:18-24`). `isMatchKey` is the only gate (`grammar.ts:55-57`).

| Field | Matches on | Comparison |
| --- | --- | --- |
| `class` | `PolicyCall.klass` — "the reversibility class the evaluator decided, or the assumed worst" (`decide.ts:24`) | `r0\|r1\|r2\|r3\|unknown`, or a list = any of (`rules.ts:144-146`) |
| `tool` | registry entry id, e.g. `aws.s3.object.delete` (`decide.ts:18`) | exact string, list = any of |
| `connector` | "the connector of the intercepted server, for example s3 or postgres" (`decide.ts:20`) | exact string, list = any of |
| `workspace` | "the workspace tag the proxy was started with, if any" (`decide.ts:22`) | exact string; `undefined` never matches (`decide.ts:87`) |
| `blast_radius` | rows/files/objects the call would touch (`decide.ts:26`) | **only** `{ lt: number }` — `rules.ts:23-26`, `decide.ts:90-95`; `gt` is rejected by the validator (`rules.ts:114-133`) |

Matcher: `matchesOne` (`packages/policy/src/decide.ts:69-99`), first match wins
(`:163-191`). Keys AND together (`:35` comment on `RuleMatch`); an undefined
call-side value is a non-match, not a match-all (`:73-75`).

### Can a policy express "read is fine but write needs an operator"?

**Yes, on tool name or class — but not on argument paths.**

- By tool name: `match: { tool: fs_file_read }` → `allow`, plus a catch-all
  `hold`. This is expressible today.
- By class: `match: { class: r0 }` → `allow`, catch-all `hold`. Also expressible,
  and is what `DEFAULT_POLICY` does.
- **By argument path: not expressible.** No match key reads `call.arguments`.
  `PolicyCall` (`packages/policy/src/decide.ts:16-34`) carries no arguments at
  all — they exist on `HeldCall` (`packages/policy/src/hold.ts:30`), which is
  built *after* the decision, only so the operator and the model can read them.
  The class note at `decide.ts:17` is explicit that a class is an *evaluation
  result*, so any path-dependent distinction has to be expressed as distinct
  tool ids or distinct registry entries, not as a rule over arguments.

The `unknown` class (`grammar.ts:48-53`) is the explicit opt-in that lets an
allow rule match an unclassified call; without naming it, a broad allow cannot
authorize what classification could not prove (`decide.ts:170-177`).

**Unverified:** whether `docs/DECISIONS.md:506-511` (which discusses a sixth
match key and cross-tool rules) reflects a decision that has landed or is
prospective. Not checked against code.

---

## 6. Precedent for host access

| Mechanism | Exists | Scope | Reachable by a model? |
| --- | --- | --- | --- |
| Managed workspace documents | `packages/workbench/src/workspace.ts`, adapter `packages/workbench/src/managed-documents.ts:25-29` | In-memory/`workspace.enc` string map, 256 kB/doc, 100 files (`workspace.ts:24`) | **Yes** — `nomo_workspace_*` |
| Managed documents recovery runtime | `packages/workbench/src/index.ts:1875-1932` (`documentRuntime`) | Journal + vault under the data dir | Operator-only (`planRecoveryJob`/`applyRecoveryJob`/`undo`) |
| `NOMO_LEDGER_DIR` | `packages/workbench/src/index.ts:1074`, `:2282` | Ledger JSONL path; read at `:2287`, verified at `:2305` | No — NOMO reads its own ledger |
| `homedir()` uses | `:435` (data dir default), `:1074` (ledger default), `:2282` (ledger default), `:2303` (key dir) | Path defaults only | No |
| `NOMO_UPSTREAM_COMMAND` | Parsed `:1049-1065`, requires `NOMO_POLICY_PATH` `:1064-1065`, spawned via `packages/sdk/src/client.ts:272-278` | Arbitrary operator-named MCP server command, run as the host user | Its tools reach the model as `connectorId: "stdio"` |
| `NOMO_HOOK_COMMANDS` | `packages/workbench/src/index.ts:637-655`, spawn at `packages/workbench/src/agents.ts:237` | Exact-command-string allowlist from the launcher; comment at `:626-636` explains why it is env-only | Hooks observe; `before-run` can refuse a run (`:2644-2648`) |
| `filesystem.managed` adapter | `packages/connectors/src/filesystem/managed.ts:41-51` | Real host filesystem, but confined to one `realpath`'d root with a directory identity check (`:47-51`, `:76-86`) | **No** — CLI `nomo recovery` only |
| `git.managed` adapter | `packages/connectors/src/git/managed.ts`, capability `packages/cli/src/conformance.ts:201-216` | One cooperative POSIX repo; explicitly excludes remotes, hooks, arbitrary git, history rewriting | **No** — CLI `nomo recovery` only |
| Recovery MCP server | `packages/cli/src/recovery-mcp.ts:313-440`, launched by `nomo recovery serve` (`packages/cli/src/recovery.ts:316-332`) | `nomo_execute`, `nomo_recovery_plan`, `nomo_reconcile`, and the job tools — this *is* a host-filesystem tool surface, and it is model-shaped | **No** — a separately launched stdio MCP server, not in `Workbench`'s catalogue |
| Self-update via git | `packages/cli/src/update.ts:186-198` | `NOMO_HOME` clone, argument-array git only | No |

The recovery path is the closest precedent and it is instructive: `nomo recovery
serve` publishes `nomo_execute` with a closed mutation union
(`packages/cli/src/recovery-mcp.ts:332-390`), policy-checked through
`allowed()` (`packages/cli/src/recovery.ts:272-292`), with `blastRadius: 0` for
plan and `1` otherwise (`:324-329`), and mode gating that refuses dispatch
*before* the policy is consulted so that widening the policy cannot widen the
mode (`:302-307`). It is a separate binary, reached by an operator who
configures it, and it is deliberately **not** wired into the workbench's model
tool surface.

### The registry already has host-shaped entries

```ts
// packages/registry/src/registry.ts:1812-1868 (localEntries)
fs.file.write           // r0 if fs.shadow.captured, r0 if untracked+git clean, else r3
fs.path.remove_recursive // r0 if the tree is git clean, else r3
git.branch.delete       // r0 if tip merged or recorded, else r3
git.history.rewrite     // r0 if unpushed, else r2
shell.command.exec      // r0 if the command matches a read-only allowlist, else r3
```

These are in the exported registry (`:3011-3014`), so `classifyTool("fs.file.write", …)`
already resolves. The `shell.command.exec` note at `:1866` is the sharpest
statement in the codebase on this question:

> "an arbitrary command cannot be classified before it runs, so it is the worst
> case by definition, and this is why NOMO intercepts at the tool boundary
> rather than the shell"

Classification knowledge for host operations exists. Execution surface does not.

---

## Comment vs. code

1. **`packages/workbench/src/index.ts:337-338`** — "Model tools always cross the
   existing NOMO SDK." Only `connectorId === "stdio"` tools cross the SDK
   (`:2487`). Workspace tools execute in-process (`:2520-2543`); connector tools
   go over plain HTTPS via `rpc` (`:2588`). "A provider has no shell or
   filesystem authority" is true of the model's *tool surface* and false of the
   *process* — `NOMO_UPSTREAM_COMMAND` (`:1051`) and `NOMO_HOOK_COMMANDS`
   (`:637`) both spawn host processes as the operator's user, which
   `packages/security-notes.md:12-14` already concedes.

2. **`packages/workbench/src/index.ts:1125`** — the system instruction tells the
   model "These tools do not access the host filesystem." True for
   `nomo_workspace_*`. It is the *only* statement of the property the model
   receives, and it is a prompt, not an enforced invariant. The enforced
   invariant is the positional-name mapping (`:2739-2744`).

3. **`packages/workbench/src/index.ts:2477`** — workspace calls are given
   `blastRadius: 1` unconditionally, so the `blast_radius` match key
   (`packages/policy/src/grammar.ts:22`) can never discriminate a workspace
   call by size. The key is documented as usable
   (`docs/HANDBOOK.md:120`) and is inert on this path.

4. **`packages/workbench/src/tool-catalog.ts:12`** — external tools are
   displayed with `klass: 'policy'` rather than a measured class, because
   classification happens at execution time (comment at `:11`). The UI therefore
   cannot show a class for a connector or stdio tool before it runs, while
   `docs/APPLE-DESIGN-SYSTEM.md:297-298` requires a reversibility class to be
   "always written as text".

5. **`packages/workbench/src/index.ts:2571-2574`** vs
   **`cloud/steps.mjs:36-39`** — both deny unclassifiable tools, and
   `cloud/steps.mjs:31-34` explains why built-in workspace tools get no
   exemption. Consistent. Noted because the *reason* given in that comment
   ("returning `allow` for built-ins would let the agent write managed documents
   with no human in the loop") describes a bug that is already absent in the
   workbench: `decide` at `:2571` only runs for connector tools, and the
   agent-profile path at `:2477-2479` classifies built-ins rather than exempting
   them.

6. **`packages/workbench/src/index.ts:2547-2550` vs `:1807-1810`** — connector
   classification is run twice, once with empty arguments for the preview and
   once with real arguments for execution. Where arguments change the class, the
   preview and the decision disagree. Unverified whether any connector's registry
   cases actually branch on arguments in a way that changes the tone.

---

## Gaps that are facts, not opinions

- No match key can see a tool argument (`packages/policy/src/decide.ts:16-34`).
- `DEFAULT_POLICY` allows r0 with no hold (`packages/workbench/src/index.ts:215-216`),
  so any tool classified r0 needs no operator at all.
- Workspace `blastRadius` is a constant (`:2477`).
- `blastRadius` is `undefined` for every connector call in the workbench
  (`:2565`), so `blast_radius` rules never match there either. The proxy does
  compute it from probes (`packages/proxy/src/forward/tools.ts:105-109`,
  `:286`).
- `workspaceToolClass` returns only `r0 | r1 | undefined`
  (`packages/workbench/src/workspace.ts:34`); r2 is unreachable for workspace
  tools.

---

# Appendix: is the structural property guarded by a test?

Read-only recon, second pass. **Line numbers in this appendix were re-verified
against the working tree after the concurrent `packages/workbench/src/` edit;
the numbers in sections 1–6 above predate it and have drifted by roughly +9
lines in `index.ts`.** See the drift table at the end of this appendix.

Short answer: **no.** The no-host-filesystem property is guarded by one
behavioural test that asserts a *different* property, and by nothing else. The
membership of `workspaceTools` is not pinned by any test. The alias invariant is
pinned by exactly one test.

## 1. Tests that would fail if a filesystem-touching tool entered the managed set

### `safety-boundaries.test.ts` — asserts nothing about the tool set

Four tests, none of which mentions a tool, a catalogue, a path, or a filesystem.
What they actually assert:

| Test | Assertion |
| --- | --- |
| `:31-47` "unknown single Undo blocks same-document writes…" | after a failed undo receipt, session status is `unknown`; `editDocument`, `send` reject; document content unchanged; status survives `shutdown()`+restart; provider called exactly once (`:46`) |
| `:48-56` "single Undo and writes cannot bypass the owning paused job…" | undo and `editDocument` both reject while a recovery job is paused; content is `"one"`; `applyRecoveryJob` then returns `"restored"` |
| `:57-65` "an independent branch does not inherit its parent recovery owner…" | child session has `recoveryBlock: undefined` and `queuedPrompt: undefined` in the persisted snapshot |
| `:66-80` "Stop projects stopping on every live surface…" | `running()`, `runs()`, `activity()`, `get()`, `list()` all project `stopping`, then `stopped` |

This file is about **recovery and lifecycle state machines**. A fifth workspace
tool, or a workspace tool that touches the host, would not fail any of these.
The file name over-promises relative to its contents.

### `permission-authority.test.ts` — the closest thing, and it is about *mode*, not *filesystem*

Five tests. The two that touch the tool catalogue:

```ts
// packages/workbench/src/permission-authority.test.ts:29-40
test("read-only tool catalog exposes only read tools for plan and read-only modes", async (t) => {
  for (const mode of ["plan", "read-only"] as const) {
    ...
    const names = app.availableTools().tools.map((tool) => tool.name);
    assert.deepEqual(names, ["nomo_workspace_list", "nomo_workspace_read"]);
    assert.deepEqual(app.availableTools(session.id).tools.map((tool) => tool.name), ["nomo_workspace_list", "nomo_workspace_read"]);
  }
});
```

and:

```ts
// packages/workbench/src/permission-authority.test.ts:42-61
test("a crafted model write call is refused before dispatch in read-only mode", ...)
// asserts only: session exists, app.workspace(session.id).files deepEqual {}, turn >= 1
```

The remaining three: read-only/plan blocks `editDocument`
(`:18-28`); read-only blocks `applyRecoveryJob` and `undo` (`:63-76`); branch
snapshot obeys mode (`:78-107`); the two defaults are explicit and differ
(`:109-125`).

**The distinction that matters:** `:37-38` is an *exact-membership* assertion on
the filtered catalogue, and it is the only one in the package. But it is scoped
to `permissionMode !== "normal"`, where `toolAllowedInMode`
(`packages/workbench/src/index.ts:1425-1427`) already hardcodes
`tool.name === "nomo_workspace_list" || tool.name === "nomo_workspace_read"`.
The test is asserting the output of a name allowlist, and would fail if that
allowlist changed. It says nothing about whether those tools touch the host — a
host-touching `nomo_workspace_read` would sail through it. The model-call test
at `:42-61` asserts only that the managed document map is still empty; it does
not assert that any file outside the data directory is untouched.

### The connector-consent tests — adjacent and weaker, exactly as suspected

```ts
// packages/workbench/src/connector.test.ts:80-83
assert.ok(
  !app.availableTools().tools.some((tool) => tool.name === "test-tool"),
  "a staged connector offers no tools",
);
```

`connector.test.ts:85-92` proves a probed-but-unconfirmed connector offers
nothing; `:94-104` proves a confirmed one does and that a new conversation
reloads it. These guard *consent*, not *capability*. A confirmed connector
serving `fs.file.write` is fully reachable, and this test asserts that it
should be.

### The one test that actually probes path shape

```ts
// packages/workbench/src/workspace.test.ts:53-61
test('document namespace rejects traversal, prototype paths and oversized content', () => {
  const state = createWorkspace();
  for (const path of ['../secrets', '/etc/passwd', 'x/../../bad', '__proto__', 'a/constructor', 'a\\b', 'a//b', 'a\0b']) {
    const response = write(state, 'one', 'text', path);
    assert.equal(response.result.isError, true, path);
    assert.equal(response.state, state);
  }
  assert.equal(write(state, 'too-large', 'ü'.repeat(128001)).result.isError, true);
});
```

This is the strongest existing guard, and it is a *unit* test of
`validPath` (`packages/workbench/src/workspace.ts:106-109`) via `write`, which
is `executeWorkspaceTool(..., name: 'nomo_workspace_write')`
(`workspace.test.ts:5-7`). It proves `/etc/passwd` and `../secrets` are refused
**as document names inside the managed map**. It does not prove that
`nomo_workspace_read` — or any other tool in the set — goes through `validPath`.
`validPath` is called once, unconditionally, at
`packages/workbench/src/workspace.ts:44`, before the read/write/delete branch —
so today every path-taking workspace tool shares it. That sharing is structural,
not tested.

### `connector.test.ts` supplies the loopback-server harness that would be needed

`packages/workbench/src/connector.test.ts:13-14` and
`packages/workbench/src/policy-review.test.ts:11-38` both build an
`http.createServer` MCP fixture that records every method it is asked for
(`methods.push(body.method)`). The assertion pattern for "this never left the
process" already exists and is reused:

```ts
// packages/workbench/src/policy-review.test.ts:104-107
assert.ok(
  !server.methods.includes("tools/call"),
  "the connector is never asked to run a tool NOMO does not know",
);
```

The *host filesystem* equivalent of that harness does not exist. No workbench
test creates a canary file outside its temp directory and asserts it is
unmodified after a model tool call.

## 2. Is the count or membership of `workspaceTools` asserted?

**No.** Nothing asserts `workspaceTools.length === 4`, and nothing asserts the
exact four names as a set. The frozen `as const` (`workspace.ts:30`) is a
TypeScript type-level guarantee, not a runtime one.

The four assertions that touch the set are all *relative* — they compare the set
against itself, so they hold for any membership:

| Assertion | Why it does not pin membership |
| --- | --- |
| `tool-catalog.test.ts:39` — `assert.deepEqual(snapshot.tools.map(t => t.name), workspaceTools.map(t => t.name))` | compares the runtime catalogue to `workspaceTools` itself; true for 4 tools or 40 |
| `tool-catalog.test.ts:8-10` — indexes `tools[2]` and `tools[4]` | a *fifth* tool would still be `tools[4]`; the impersonation fixture appends one entry and this passes |
| `tool-catalog.test.ts:17` — `assert.equal(filterCommands(tools, '/').length, 4)` | this is a count, but it counts `filterCommands(workspaceTools, '/')` — i.e. the literal — **not** the dispatched catalogue. Adding a fifth workspace tool *would* fail this one line. It is an incidental count inside a slash-search test (`tool-catalog.test.ts:15-23`) whose subject is the filter, not the set. |
| `apps/control-plane/api/parity.test.ts:66` — `assert.deepEqual(tools.tools.map(t => t.name), ["nomo_workspace_list", "nomo_workspace_read"])` | pinned, but only in read-only mode, i.e. the output of the same `toolAllowedInMode` name allowlist as `permission-authority.test.ts:37` |
| `agents.test.ts:38` and `:42` — `assert.equal(tools.length, 1)` | a profile whose `allowedTools` is `["nomo_workspace_list"]` (`agents.test.ts:12`) filters the set down to one. True for any set size |
| `workspace.test.ts:70-72` — `assert.equal(workspaceToolClass('shell'), undefined)` | the only negative class assertion, and it uses a name that is not in the set |

So the accurate statement is: **`workspaceTools` is frozen only in the type
system. One line — `tool-catalog.test.ts:17` — would incidentally fail on a
fifth tool, and it would fail for the wrong reason** (a slash-filter count), with
no message about tool membership.

## 3. Is the alias invariant tested?

**Yes — one test, and it is a good one.**

```ts
// packages/workbench/src/policy-review.test.ts:89-113
test("a tool the provider invented never reaches the connector", async (t) => {
  ...
  const app = new Workbench({ NOMO_DATA_DIR: directory }, callingProvider(() => "not_in_catalog"));
  ...
  await confirmedConnector(app, server.url, "Fixture", allowAll);
  const session = await app.start("Delete it", "fixture");
  await app.settled();
  assert.equal(app.get(session.id)?.status, "failed");
  assert.ok(
    !server.methods.includes("tools/call"),
    "the connector is never asked to run a tool NOMO does not know",
  );
  assert.ok(
    app.get(session.id)?.events.some((event) => /outside the approved MCP catalog/.test(event.text)),
  );
});
```

Three assertions: the session fails, the connector is never asked to run
anything, and the refusal names itself. `callingProvider`
(`policy-review.test.ts:42-67`) lets the fixture pick the name to return, and
the test picks the literal `"not_in_catalog"` — a name no `tool_${index}` alias
can produce. The alias mapping it exercises is
`packages/workbench/src/index.ts:2663-2665`; the refusal is
`packages/workbench/src/index.ts:2752-2757`.

Two limits worth stating:

- It runs with a **confirmed connector** in the fixture, so the proved path is
  "an invented name never reaches an external connector." It does not prove the
  invented name cannot reach the **in-process** workspace executor — that branch
  is structurally unreachable because the `mapping.get` failure throws before
  `executeTool` is called (`index.ts:2752-2757` precedes `:2771`), but no test
  drives a workspace-only session with a fabricated name.
- It does not test that a **valid-looking** alias (`tool_7`) cannot be used to
  index past the end of the catalogue. `mapping.get("tool_7")` returns
  `undefined` for a four-tool catalogue, so it is refused, but only by the same
  `if (!name)` check — **unverified** whether any test exercises an
  in-range-but-wrong alias.

`packages/workbench/src/provider-native.test.ts:12` and `:17-19` use `tool_0`
in fixture messages, but as a *protocol* fixture for the Anthropic-shaped
provider adapter, not as a test of the alias gate.

## The question behind all of it

> What is the cheapest test that would fail the day someone gives a model a host
> filesystem path, and does not merely fail the day someone adds a fifth
> workspace tool?

The property to assert is **not** membership, it is **reachability**: after a
model-driven tool call, nothing outside the workbench's own data directory has
changed. The shape that satisfies both halves of the question:

1. **Drive the real dispatch path, not `executeWorkspaceTool` directly.** Use the
   existing `Workbench` fixture with a `callingProvider`-style fetcher
   (`policy-review.test.ts:42-67`) that emits the write tool with a **host path**
   as its argument — `/etc/passwd`, `../../.ssh/id_rsa`, `~/Library/...` — the
   argument a real host-touching tool would receive.
2. **Canary the host, don't assert on the error.** Plant marker files at those
   paths (or under a temp root standing in for `/etc`) before the call, then
   assert the markers are byte-identical afterwards. This passes today *because*
   `validPath` refuses the path (`workspace.ts:106-109`) and fails on the day a
   tool reaches past that check.
3. **Enumerate the set rather than hardcoding it.** `for (const tool of
   workspaceTools)` — a fifth tool is simply covered, not failed. The test then
   passes the day a coding tool is added and keeps passing the day one is
   removed, which is the whole point of the question.
4. **Include the connector and stdio sources in the same canary**, using the
   `methods` recording already built at `connector.test.ts:13-14`, because those
   are the two ways a host path reaches a model today without any edit to
   `workspace.ts`.

The existing `permission-authority.test.ts:42-61` is the closest prior art and
shows exactly the weakness: it asserts `app.workspace(session.id).files` is
`{}` — the managed map, which a host-touching tool would leave empty too. The
assertion has to be on something the tool *could* have modified outside that map.

**Cheapest form that is still discriminating:** extend the loopback fixture at
`policy-review.test.ts:11-38` to also record any request NOMO's own process
makes to a path outside `NOMO_DATA_DIR` — or, simpler and with no new harness,
assert on the *return shape*: that a host-shaped path argument produces an
`isError` result whose text is `validPath`'s message
(`workspace.ts:107`), for **every** tool in the enumerated set. That fails the
day any tool accepts a host path, passes the day a fifth tool is added, and
needs no filesystem canary at all.

## Drift: `index.ts` line numbers, before and after the concurrent edit

Sections 1–6 of this document were written against the pre-edit tree. The
concurrent change to `packages/workbench/src/` shifted `index.ts` by +5 to +9.
`workspace.ts`, `mcp.ts`, and all test files cited here are unchanged.

| Symbol | Earlier citation | Current |
| --- | --- | --- |
| `McpTool` | `mcp.ts:23` | `mcp.ts:23` (unchanged) |
| `workspaceTools` | `workspace.ts:25-30` | `workspace.ts:25-30` (unchanged) |
| `workspaceToolClass` | `workspace.ts:34-38` | `workspace.ts:34-38` (unchanged) |
| Class doc comment | `index.ts:337-338` | `index.ts:341` |
| Catalogue assembly | `index.ts:1082` | `index.ts:1087` |
| Connector tools push | `index.ts:1090-1092` | `index.ts:1095-1096` |
| stdio tools push | `index.ts:1098-1100` | `index.ts:1103-1104` |
| `toolAllowedInMode` | `index.ts:1420-1422` | `index.ts:1425-1427` |
| Workspace policy call | `index.ts:2474-2484` | `index.ts:2485-2495` |
| stdio dispatch | `index.ts:2487` | `index.ts:2496` |
| Workspace execution | `index.ts:2520-2543` | `index.ts:2529-2552` |
| Alias mapping | `index.ts:2650-2652` | `index.ts:2663-2665` |
| Alias refusal | `index.ts:2739-2744` | `index.ts:2752-2757` |

---

# Appendix 2: the guard, and what it found

## What was built

`packages/workbench/src/workspace-tools-guard.test.ts` — option (A) only, and
only for the source NOMO owns.

It drives the real `executeWorkspaceTool`, enumerates `workspaceTools` rather
than asserting a count or a membership list, exempts `nomo_workspace_list`
explicitly on the basis of its own `inputSchema` having no `path` property, and
asserts the refusal text is `validPath`'s exact string rather than merely
`isError`.

Option (B), the host canary, was deliberately **not** implemented.
`packages/security-notes.md:12-14` already concedes that a local upstream
running as the proxy OS user is not sandboxed and can read that user's files.
NOMO proxies stdio tools (`connectorId === "stdio"`, `index.ts:2496`) and removes
nothing. A canary asserting "the host is untouched after a model tool call"
would therefore fail by design against an operator-configured upstream, and
encoding a guarantee the product does not make is worse than having no test.

**The connector and stdio surfaces remain unguarded and un-promised.** That is
an owner decision, not an oversight, and it is not settled by this work.

## Finding: two host-shaped names are accepted, and that is currently correct

The guard's first draft asserted that `validPath` refuses every host-shaped
name. **It does not.** Two cases failed against the unmodified source:

| Name | Refused? | Why |
| --- | --- | --- |
| `~/.ssh/id_rsa` | **accepted** | `~` is not in `validPath`'s rule set (`workspace.ts:107`) |
| `C:/Windows/System32` | **accepted** | the check refuses a leading `/` and any `\`, but `C:` followed by a forward slash is neither |

Probed directly against the current source:

```
$ node -e "…executeWorkspaceTool(createWorkspace(),{id:'probe',name:'nomo_workspace_write',arguments:{path:'~/.ssh/id_rsa',content:'c'}})"
write "~/.ssh/id_rsa" ACCEPTED stored=["~/.ssh/id_rsa"]
write "C:/Windows/System32" ACCEPTED stored=["C:/Windows/System32"]
```

This is **not** a traversal. The managed store is
`Readonly<Record<string, string>>` (`workspace.ts:16-19`); the name is a map
key, never a location, and nothing resolves it against `node:fs`. Refusing `~`
and `C:` would be a rule about shell expansion and Windows path roots rather
than about the document namespace, and `validPath`'s own error message — "Use a
relative document path without traversal or reserved segments" — does not claim
to cover them.

So the honest statement is two-part, and the guard now asserts both halves
rather than only the convenient one: the namespace check refuses the nine
classes it is written for, and the two names it does not refuse stay inert
because they are opaque keys. The second half is now a test, not a comment.

**Verdict on the question asked:** no workspace tool validates fewer inputs
than `validPath` does. All three path-taking tools — `nomo_workspace_read`,
`nomo_workspace_write`, `nomo_workspace_delete` — refuse all nine hostile
classes identically, because `validPath` is called once, unconditionally, at
`workspace.ts:44`, ahead of every branch. The gap was in the *premise* of the
first draft, not in the source.

## Non-vacuity proof

A guard that has never failed is decoration. The probe was made with a
reversible edit to `packages/workbench/src/workspace.ts`, reverted by hand. No
`git stash`, `git checkout` or `git clean` was used at any point.

**First attempt was a false pass, and the reason is worth recording.** Adding a
fifth tool to the `workspaceTools` literal alone did **not** fail the path
assertions — only the class assertion fired:

```
✔ nomo_workspace_read_host refuses parent segments escape the document namespace (0.032125ms)
✔ nomo_workspace_read_host refuses traversal can hide behind a plausible first segment (0.041291ms)
✔ nomo_workspace_read_host refuses a backslash separator is a separator on Windows (0.035875ms)
✔ nomo_workspace_read_host refuses __proto__ is a reserved segment, not a document name (0.034555ms)
…
✖ every workspace tool is classified, so none of them falls back to r3 (0.370583ms)
  AssertionError [ERR_ASSERTION]: nomo_workspace_read_host has no class; it would be recorded as r3
ℹ tests 42
ℹ pass 41
ℹ fail 1
```

Adding a name to the literal does not bypass the check: `validPath` runs at
`workspace.ts:44` before any branch on `input.name`, so a new name is still
validated. Membership in the literal and passage through `validPath` are two
independent facts, and only the second one is the property.

**Second attempt put the branch ahead of `validPath`, which is what actually
bypasses it:**

```
✖ nomo_workspace_read_host refuses a leading slash is an absolute host path (0.619041ms)
✖ nomo_workspace_read_host refuses parent segments escape the document namespace (0.093083ms)
✖ nomo_workspace_read_host refuses traversal can hide behind a plausible first segment (0.076875ms)
✖ nomo_workspace_read_host refuses a backslash separator is a separator on Windows (0.060083ms)
✖ nomo_workspace_read_host refuses __proto__ is a reserved segment, not a document name (0.055625ms)
✖ nomo_workspace_read_host refuses a reserved segment can hide mid-path (0.079375ms)
✖ nomo_workspace_read_host refuses a NUL byte truncates the name at the syscall boundary (0.058416ms)
✖ nomo_workspace_read_host refuses an empty segment is not a name (0.05925ms)
✖ nomo_workspace_read_host refuses the current directory is not a document name (0.08825ms)
✖ every workspace tool is classified, so none of them falls back to r3 (0.110959ms)
ℹ tests 42
ℹ pass 32
ℹ fail 10
```

First failure, unedited:

```
✖ nomo_workspace_read_host refuses a leading slash is an absolute host path
  AssertionError [ERR_ASSERTION]: nomo_workspace_read_host accepted "/etc/passwd"
  + actual - expected
  + undefined
  - true
```

Reverted, and `git diff packages/workbench/src/workspace.ts` is empty — an exact
revert, confirmed byte-for-byte rather than by inspection. Guard green again at
33 tests, 0 failures.