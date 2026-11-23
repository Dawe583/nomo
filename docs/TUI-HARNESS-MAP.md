# TUI harness map, evidence for "Surface the harness in the TUI"

Reconnaissance only. Every claim carries a `file.ts:line` citation. Anything not
verifiable from the source is marked **unverified**. Where a comment, a doc or a
test contradicts the code, both are quoted.

Todo item under investigation: *"Surface the harness in the TUI: hooks editor,
per-agent profile, and the learning record on the ledger tab."*

Scope note: `packages/workbench/src/` was being edited concurrently while this
was written. Line numbers are from the working tree as read on 2026-10-05.

---

## 1. Where the TUI lives

Confirmed: `packages/cli/src/tui/`. Entry points are
`packages/cli/src/dispatch.ts:42-43` (dynamic `import("./tui/workspace-runner.ts")`)
and the barrel `packages/cli/src/tui/index.ts:1-11`.

| file | lines | what it is |
|---|---|---|
| `workspace.ts` | 3572 | `WorkspaceTui` class + `renderWorkspace`; tabs, slash commands, item models. The workspace TUI proper. |
| `workspace-runner.ts` | 1106 | `runWorkspaceTui` (`:308`); raw-mode key loop, 250 ms `ui.refresh()` poll (`:1092-1104`). |
| `workspace-proxy.ts` | 132 | `ProxyWorkspace` (`:25`); reads the proxy's own `.jsonl` ledgers and approval dir from disk. |
| `layout.ts` | 349 | `sanitizeText` (`:19`), `visibleLength` (`:77`), `fit` (`:83`), `unifiedDiff`, `renderHunkSelection`. |
| `theme.ts` | 126 | `NOMO_PALETTE` (`:7`), class/decision markers (`:27`, `:34`), `paint` (`:87`). |
| `types.ts` | 143 | `ReversibilityClass`, `CallDecision`, `PipelineStage`, the render model. |
| `caps.ts` | 71 | `detectCapabilities` (`:13`); the only TTY/env reader. |
| `brand.ts` | 28 | `brandHeader`; renders the six-by-six NOMO grid mark as terminal cells. |
| `watch.ts` | 424 | `renderWatchFrame` (`:284`), `DiffScreenWriter` (`:379`); the alternate-screen watch surface. |
| `views.ts` | 118 | `renderHelp` (`:9`), `renderReplayPreview` (`:38`), `renderLedgerVerification` (`:79`). |
| `modal.ts` | 182 | `renderHoldPrompt` (`:5`), `promptForHold` (`:79`); the blocking-hold keypress. |
| `live.ts` | 96 | `LiveView` (`:9`), `liveRecords` (`:33`), `renderLiveFeed` (`:37`). |
| `inline.ts` | 28 | `renderInlineCall` (`:5`); append-only line for a piped terminal. |
| `runtime.ts` | 103 | `WatchRuntime` (`:15`); drives the watch surface. |
| `approvals.ts` | 49 | `approvalsView` (`:28`). |
| `fixtures.ts` | 126 | `previewState` (`:5`), `previewHold` (`:121`); invented data for previews. |
| `preview.ts` | 39 | `tui:preview` entry; renders fixtures, stamps them `illustrative fixture, not a live session` (`:10`). |
| `README.md` | 122 | Design/visual/responsive contract for the three non-workspace surfaces. |
| tests |, | `tui.test.ts` (591), `workspace.test.ts` (962), `workspace-parity.test.ts` (1166), `workspace-controls.test.ts` (477), `workspace-mcp.test.ts` (320), `workspace-approval.test.ts` (172), `workspace-terminal.test.ts` (116), `workspace-proxy.test.ts` (77), `live.test.ts` (78), `visual-states.test.ts` (98). |

### TUI vs. web UI: two surfaces, one backend

They are different surfaces over the same `Workbench` class, and the code says so.

- TUI holds a `Workbench` instance in-process: `packages/cli/src/tui/workspace.ts:480`
  (`readonly workbench: Workbench`), assigned at `:523`. Its own doc comment at
  `:478`: *"Same persistent workbench as the web. Rendering never grants tool authority."*
- The web API is an HTTP server over the same class:
  `apps/control-plane/api/server.ts:308-310` calls `options.workbench.agents()`,
  `wb.upsertAgent(...)`, `wb.upsertHook(...)` directly.
- The React UI is a separate app: `apps/control-plane/ui/src/` (React 19, Vite , 
  `apps/control-plane/ui/package.json`), plus a server-rendered set of static
  pages in `apps/control-plane/web/` (`ledger.html`, `feed.html`, `approvals.html`).
- One cross-boundary import exists: the TUI imports `importDesktopProvider` and
  `desktopSetup` from `apps/control-plane/api/desktop-setup.ts`
  (`packages/cli/src/tui/workspace.ts:18-21`).

**The todo item says "the TUI" and names a ledger tab. That is ambiguous only
in one direction:** `apps/control-plane/ui/src/pages.tsx:399` exports a `Ledger()`
page too, and `apps/control-plane/web/ledger.html` is a ledger page. A "ledger
*tab*" with no other qualifier most likely means the TUI's `ledger` tab
(`packages/cli/src/tui/workspace.ts:44`), because the TUI is the only surface
that calls its navigation a tab bar, but this is **unverified**: no document in
the repo ties the todo item to either surface.

---

## 2. The tab structure

Tabs are a const tuple plus a parallel view-name map; there is no registry.

```ts
// packages/cli/src/tui/workspace.ts:39-51
export const WORKSPACE_TABS = [
  "overview", "chat", "sessions", "documents", "ledger",
  "approvals", "policy", "tools", "models", "usage", "help",
] as const;
// :52  export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
// :53-65 WORKSPACE_VIEWS: tab -> ViewName | null  (imported from workbench/src/gui.ts:13)
```

Render path:

1. `renderWorkspace(ui, columns, rows, …)`, `packages/cli/src/tui/workspace.ts:3075`.
2. Tab bar, which collapses to a 3-tab window on narrow terminals , 
   `packages/cli/src/tui/workspace.ts:3180-3199` (`TAB_ICONS`/`TAB_ICON_TONE` per tab).
3. Body from `lines()`, `packages/cli/src/tui/workspace.ts:2650`, which short-circuits on
   `confirmation` (`:2651`), then `detail` (`:2656`), then tab-specific branches.
4. Item rows from `items()`, `packages/cli/src/tui/workspace.ts:936`, one `if`
   block per tab; each tab with a list pushes `{id,label,lines}`.
5. `Enter` → `openSelected()` (`packages/cli/src/tui/workspace.ts:1090-1116`); most tabs
   set `this.detail = row.lines` (`:1115`), which takes over the whole body.
6. Tab switching: `choose(tab)` (`:572`) and `cycle(direction)` (`:579`).

### The ledger tab exists and is live

`ledger` is item 5 of 11 (`packages/cli/src/tui/workspace.ts:44`). What it renders:

- **Managed entries**: `packages/cli/src/tui/workspace.ts:968-989` iterates
  `this.proofs`, a `Map<sessionId, JsonlEntry[]>` (`:508`), filled in `refresh()`
  at `:552-559` from `await this.workbench.ledger(session.workspace)`
  (`packages/workbench/src/index.ts:2166`). One row per chain entry; label
  `` `${id.slice(0,8)} #${e.seq} [${klass}] ${decision} ${tool}` `` (`:978`).
- **Proxy entries**: `:990-1006`, from `this.proxy.entries`, loaded by
  `ProxyWorkspace.refresh` reading `*.jsonl` off disk
  (`packages/cli/src/tui/workspace-proxy.ts:99-114`).
- Rows are reversed at `:1007`, so newest first.
- The detail body is the raw JSON of the entry plus a verification line
  (`:979-987`), and the verification key is resolved through
  `Workbench.ledger` rather than asserted (`:510-517`, `:556-558`).

It is **live, not static**: `runWorkspaceTui` polls `ui.refresh()` every 250 ms
(`packages/cli/src/tui/workspace-runner.ts:1092-1104`), `refresh()` re-reads every
session's ledger (`:536-571`), and `r` forces a refresh
(`packages/cli/src/tui/workspace-runner.ts:1019`).
It is not a stream or a socket, it is a re-read.

Two things already hang off this tab:

- Errors replace the body with `proofErrors` + `proxy.errors` above the row list
  (`packages/cli/src/tui/workspace.ts:2656-2666`).
- `/export ledger` concatenates the same two maps into a JSONL bundle, and refuses
  if anything is unverified (`packages/cli/src/tui/workspace.ts:2597-2616`).
- `/undo` can start from a selected ledger row's `operationId` (`:1168-1170`).

---

## 3. What already exists for the three items

### 3a. Hooks editor

The type and the Workbench API exist (`packages/workbench/src/agents.ts:13-18`,
`Hook = {id, event, command, enabled}`; `packages/workbench/src/index.ts:788`
`upsertHook`, `:755-768` `agents()`).

**Hooks do reach the TUI, but as two slash commands and one JSON file, there is
no editor, no tab, no form, and no per-hook interactive field anywhere.**

| what | where | shape |
|---|---|---|
| `/hooks` | `packages/cli/src/tui/workspace.ts:2061-2076` | Prints a `detail` overlay: support sentence, `Allowed commands: …`, `json(catalog.hooks)`. Read-only. |
| `/hook-file path.json` | `:2028-2059` | Reads a JSON file from disk, shows a confirmation, then `this.workbench.upsertHook(input)` (`:2052`). |
| `/agent-file path.json` | `:2028, 2046-2050` | Same shape, `upsertAgent`. |
| help entries | `:2925-2926` | `["/hooks", …]`, `["/hook-file", …]`. |

Nothing in `WORKSPACE_TABS` (`:39-51`) concerns hooks, and `items()` (`:936`)
has no hooks branch, hooks appear only through `this.detail`, which
`lines()` returns before any tab branch (`:2656`).

The web has the API (`apps/control-plane/api/server.ts:308-310`) and a
**read-only** hooks section: `apps/control-plane/ui/src/workspace-controls.tsx:267-287`
renders `<details>` per hook and **no form**, while its adjacent paragraph
(`:275-280`) states unconditionally *"Hook execution is not supported on this
host. No command will execute."* So neither surface has a hooks editor; the web
has the POST endpoint and no UI for it.

#### Disagreements found (highest-value)

1. **A capability flag and a running feature contradict each other.**

   `packages/workbench/src/gui.ts:215,218`:
   ```ts
   hooks: false,
   limitations: ["Hooks are not executable on this host.", …],
   ```
   But hooks fire on the live dispatch path:
   `after-tool` at `packages/workbench/src/index.ts:2451`, `before-run` at
   `:2647`, `after-run` at `:2815` (all `fireHooks`, defined `:802`).

2. **A hardcoded `true` contradicts its own test, and the test currently fails.**

   `packages/workbench/src/index.ts:766`:
   ```ts
   hooksSupported: true,
   ```
   The TUI branches on it at `packages/cli/src/tui/workspace.ts:2030` and `:2065`,
   so with `hooksSupported: true` those branches are unreachable. The test
   `packages/cli/src/tui/workspace-controls.test.ts:280-288`, *"hook capability
   stays visibly unsupported without an operator allowlist"*, asserts the
   opposite. Run on this tree it fails:

   ```
   ✖ hook capability stays visibly unsupported without an operator allowlist
     AssertionError: The input did not match the regular expression /unsupported/i.
     Input: 'HOOKS\nHooks are validated against the runtime operator allowlist.\nAllowed commands: none\n[]\n/hook-file path.json reviews a hook before saving.'
   ```

3. **The web UI's hooks copy contradicts its own adjacent copy.**
   `apps/control-plane/ui/src/workspace-controls.tsx:271-273` says *"Only commands
   explicitly allowed by the operator"*; `:277-279` says *"Hook execution is not
   supported on this host."* Both are rendered unconditionally, every render.

4. **The TUI's `/hooks` and `/hook-file` help text is not shown when unsupported** , 
   `packages/cli/src/tui/workspace.ts:2070-2072` gates the `/hook-file` hint on
   `catalog.hooksSupported`, which `agents()` always sets to `true`, so the hint
   is always shown while `:2926` still advertises `/hook-file` as *"(if supported)"*.

The allowlist is the runtime env `NOMO_HOOK_COMMANDS`, deliberately not writable
through the API (`packages/workbench/src/index.ts:628-659`, comment at `:636-639`:
*"a hook author who could persist an allowlist entry could authorise the command
their own hook runs"*).

### 3b. Per-agent profile

`AgentProfile = {id, name, systemPrompt, allowedTools, policyProfile, maxTurns,
maxContextTokens}`, `packages/workbench/src/agents.ts:3-11`. Validator at `:29`,
`upsertAgent` at `packages/workbench/src/index.ts:769-781`, catalog at `:755-768`.

**Yes, the TUI surfaces it, read-only, plus `/agent-file` for writes.**

| what | where | shape |
|---|---|---|
| `/agents`, `/agent` | `packages/cli/src/tui/workspace.ts:2077-2088` | `/agent <id>` sets `this.agentId` (`:2083`); body is `agentsLines()`. |
| `agentsLines()` | `:881-899` | Lists preset ids, then `catalog.profiles` as two lines each: `Profile <id>: policy …, max turns …, max context tokens …` and `Allowed tools: …` (`:895-898`). **`systemPrompt` is never printed.** |
| `/agent-file path.json` | `:2028, 2046-2050` | Confirmation then `upsertAgent`. |
| no tab | `:39-51` | Not a tab. |

The web is the surface that actually edits profiles as a form:
`apps/control-plane/ui/src/workspace-controls.tsx:138-266`, a full `<form>` with
`systemPrompt` textarea (`:186-193`), `allowedTools` textarea (`:194-203`),
`policyProfile` select (`:210-223`), `maxTurns` (`:224-234`), `maxContextTokens`
(`:235-245`), saving via `save(event, "/api/agents", agentInput)` (`:166`).
Gated on `capabilities.data?.customAgents === true` (`:148`), which is
`mode === "local"` (`packages/workbench/src/gui.ts:214`).

`packages/cli/src/tui/workspace-controls.test.ts:237-278`, *"custom agent files
use Workbench validation and persist without broadening existing sessions"*, is
the only test of this path. What it pins down: `/agent-file` shows a
confirmation and writes nothing until confirmed (`:260-263`); a profile's
`policyProfile: "unrestricted"` is rejected and the stored profile is unchanged
(`:267-276`); the profile survives a `Workbench` restart (`:277`); and an existing
conversation keeps its agent (`:264`). It exercises the **file** path only, there
is no TUI test for an interactive profile editor, because none exists.

### 3c. Learning record on the ledger tab

**It cannot be surfaced, because there is no learning feature in this repository.**

`grep -rni "learning\|learned\|lesson"` over `packages/cli/src`,
`packages/workbench/src`, `packages/ledger/src` and `apps/control-plane` returns
**zero** matches. Repo-wide, `learning record`, `learningRecord` and `learn(` also
return zero. The only `learn` hits are unrelated English in comments (e.g.
`packages/registry/src/evaluate.ts:109`).

The concept exists only as prose. `docs/LEARNING-STEP-MAP.md:1-3` scopes a
*different, sibling* todo, *"after-tool hook mines recurring failures and promotes
them to signed, replayable policy rules"*, and states at `:6`: *"Nothing here is
wired."* Its "What does not exist" section (`docs/LEARNING-STEP-MAP.md:~28`)
already records that `Rule.rationale` (`packages/policy/src/rules.ts:43`) is the
existing field a learned rule's evidence would belong in.

The nearest real substrate is the hook `after-tool` payload the workbench already
emits (`packages/workbench/src/index.ts:2448-2459`: `{tool, decision, outcome,
callId, workspace, runId}`) and the chain entries the ledger tab already lists
(`packages/cli/src/tui/workspace.ts:968-989`). Neither carries a learning record,
a promotion, or a policy write.

---

## 4. How the TUI talks to the workbench

**Direct, synchronous, in-process method calls. No HTTP, no event stream, no IPC.**

- `grep -rn "fetch(\|http://\|127.0.0.1\|localhost"` over `packages/cli/src/tui/*.ts`
  (excluding tests) returns **zero** matches. The TUI holds the object.
- Constructor injection: `new WorkspaceTui(app, env)`
  (`packages/cli/src/tui/workspace.ts:519-526`), used by every test fixture, e.g.
  `packages/cli/src/tui/workspace-controls.test.ts:29`.
- Writes the commands make: `this.workbench.upsertHook(input)` (`:2052`),
  `this.workbench.upsertAgent(input)` (`:2047`), `this.workbench.upsertProject(input)`
  (`:2019`), `await this.workbench.ledger(workspace)` (`:554`),
  `this.workbench.undoPreview` / `.undo` (`:1189`, `:1222`).
- Reads: `this.workbench.runs()` (`:939`), `.list()` (`:953`), `.documentsList()`
  (`:961`), `.approvals()` (`:1010`), `.pending()` (`:873`), `.providerState()`
  (`:529`), `.agents()` (`:882`), `.connectionState()` (`:910`),
  `.allViews()` (`:538`).
- Update propagation: a 250 ms `setInterval` calling `ui.refresh()`
  (`packages/cli/src/tui/workspace-runner.ts:1092-1104`), guarded by a stamp
  built from `workbench.allViews()` (`packages/cli/src/tui/workspace.ts:538-543`).

The second boundary is the filesystem, for the proxy's own stores:
`ProxyWorkspace.refresh` `readdir`s `~/.nomo/…/ledger` and calls `readLedgerEntries`
+ `verifyChain` (`packages/cli/src/tui/workspace-proxy.ts:99-114`); `decide()` writes
an approval decision file (`:129-131`).

**The boundary an editor crosses to write a hook or a profile is therefore one
synchronous call into an already-constructed `Workbench`** , 
`upsertHook(input: unknown): Hook` (`packages/workbench/src/index.ts:788`) or
`upsertAgent(input: unknown): AgentProfile` (`packages/workbench/src/index.ts:769`).
Both take `unknown`, both run the validator internally (`validateHook`,
`packages/workbench/src/agents.ts:75`; `validateAgentProfile`, `:29`), both
re-persist, and both roll back in memory if `persist()` throws
(`:779`, `:793`). Both are already reachable from the TUI today at
`packages/cli/src/tui/workspace.ts:2047` and `:2052`, the only thing missing is
the UI in front of them.

The web crosses the same boundary over HTTP instead:
`POST /api/agents` and `POST /api/hooks` (`apps/control-plane/api/server.ts:309-310`),
`GET /api/agents` (`:308`), which `apps/control-plane/ui/src/workspace-controls.tsx:15`
reads via `useApi("/api/agents")`.

---

## Findings the owner needs before deciding

| todo sub-item | TUI surface today | what is missing |
|---|---|---|
| hooks editor | `/hooks` read overlay + `/hook-file <path>.json` write, `packages/cli/src/tui/workspace.ts:2061, 2028` | any interactive field; any tab. The web has `POST /api/hooks` (`apps/control-plane/api/server.ts:310`) with no UI form (`apps/control-plane/ui/src/workspace-controls.tsx:267-287` is read-only). |
| per-agent profile | `/agents` list (`:881-899`, `systemPrompt` not printed) + `/agent-file` (`:2046-2050`) | any interactive field; any tab. The web has a complete form (`apps/control-plane/ui/src/workspace-controls.tsx:138-266`). |
| learning record on the ledger tab | `ledger` tab exists and is live (`:968-989`, polled at `packages/cli/src/tui/workspace-runner.ts:1092`) | **the feature itself**, zero learning code in the repo (`docs/LEARNING-STEP-MAP.md:29`: *"There is no learning concept anywhere."*) |

### Three facts that contradict the code (two since fixed)

1. **Fixed in `9d6912c`.** `packages/workbench/src/gui.ts:220` declared
   `hooks: false` / *"Hooks are not executable on this host"* while hooks fire at
   `packages/workbench/src/index.ts:2451, 2647, 2815`. It now follows `mode`,
   like `customAgents` and `contextCompaction` already did.
2. **Fixed in `9d6912c`.** `packages/workbench/src/index.ts:771` hardcoded
   `hooksSupported: true`, which made the TUI's unsupported branches
   (`packages/cli/src/tui/workspace.ts:2030, 2065`) unreachable and failed
   `packages/cli/src/tui/workspace-controls.test.ts:280`. The flag is now derived
   from the operator allowlist, so with nothing allowlisted it is `false` again
   and that test passes **unmodified**, it was right and the constant was wrong.
3. **Still open.** `apps/control-plane/ui/src/workspace-controls.tsx:271-279`
   renders two contradictory hooks sentences unconditionally, on every render.
   It also has no form, though `POST /api/hooks` exists
   (`apps/control-plane/api/server.ts:310`), the listing is read-only.

The `ledger` tab in the todo item refers to something that **exists**, item 5 of
`WORKSPACE_TABS` (`packages/cli/src/tui/workspace.ts:44`), rendering live verified
chain entries (`:968-1006`), polled every 250 ms
(`packages/cli/src/tui/workspace-runner.ts:1092-1104`).
The learning record that would go on it does not exist anywhere in the repository.
