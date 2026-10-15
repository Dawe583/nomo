# NOMO parity contracts, frozen 2026-09-22

These are the interfaces four parallel lanes build against. Any lane that needs a
different shape must ask the orchestrator to update this file first; the lanes do
not negotiate with each other directly. Existing exported fields are additive:
a new field may be added, an existing field may not be renamed or removed.

Source plan: `docs/superpowers/plans/2026-09-21-nvidia-product-parity.md`.

## Lane ownership, disjoint by path

| Lane | Role                                 | Owns (write)                            | May read            |
| ---- | ------------------------------------ | --------------------------------------- | ------------------- |
| A    | workbench provider and agent runtime | `packages/workbench/src/**`             | everything          |
| B    | web GUI                              | `apps/control-plane/ui/src/**`          | workbench contracts |
| C    | terminal UI                          | `packages/cli/src/tui/**`               | workbench contracts |
| D    | host API and integration             | `apps/control-plane/api/**`, `cloud/**` | all lanes           |

No lane writes another lane's path. `packages/workbench/src/index.ts` has one
writer (lane A) so the shared runtime is never edited by two agents at once.

## 1. ProviderState

`Workbench.providerState()` returns the existing fields plus a discriminated
`status`. The label never guesses a price or quota; a missing value is `null`.

```ts
type ProviderStatus =
  "ready" | "setup-required" | "rate-limited" | "unavailable";

type ProviderState = {
  // existing fields kept verbatim
  connected: boolean;
  setupRequired: boolean;
  models: readonly Model[];
  keyStorage: string;
  baseUrl?: string;
  kind?: string;
  profiles: string[];
  presets: readonly unknown[];
  providerId: string;
  defaultModel: string;
  upstreamConfigured: boolean;
  // additive
  status: ProviderStatus;
  detail: string | null; // redacted, human readable
  retryAt: string | null; // ISO, only for rate-limited
};
```

Rules: `ready` means a validated provider is loaded. `setup-required` means no
credential for the default provider. `rate-limited` requires an observed 429
with `retryAt`. `unavailable` is any other validated-but-unusable case. No
`NVIDIA_API_KEY` value ever appears in any field.

## 2. Shared view vocabulary

One set of view names for web, desktop and terminal. Terminal tabs map onto it
(additive, existing tab ids stay).

```ts
type ViewName =
  | "chat"
  | "sessions"
  | "runs"
  | "documents"
  | "approvals"
  | "ledger"
  | "tools"
  | "models";
```

Existing terminal tabs keep their ids; `overview` maps to `runs`, `policy`
stays a terminal extra, `usage` maps to `models`.

## 3. Run lifecycle state

```ts
type RunState =
  | "idle"
  | "running"
  | "awaiting-approval"
  | "stopping"
  | "stopped"
  | "failed"
  | "unknown"
  | "paused";
```

`activity().runs[]` keeps its current fields and adds:

```ts
type RunView = {
  // existing: id, runId, sessionId, model, provider, status, createdAt,
  // updatedAt, durationMs, steps, legacy
  state: RunState; // derived, status kept for compatibility
  progress: number | null; // 0..1 or null when unknown
  reconcileRequired: boolean; // true when the outcome is unknown
};
```

`unknown` must never be rendered as a completed or failed run. A run whose
outcome is not durably confirmed sets `reconcileRequired: true`.

## 4. Project and background run

```ts
type Project = {
  id: string;
  name: string;
  root: string;
  updatedAt: string; // ISO
};
```

A project is workspace scoped. Validation: `name` 1..160 chars, `root` a
non-empty string, `id` a UUID or slug. `Workbench.projects()` lists them,
`Workbench.upsertProject(input)` validates and persists through existing
`LocalStorage`.

A background run reuses the durable session state. `Workbench.runs()` returns
`RunView[]`. `Workbench.stopRun(sessionId)` is a real request, not a UI flag.
A stopped or unknown run never auto-dispatches again.

## 5. Agent profile, hook and compaction

```ts
type AgentProfile = {
  id: string;
  name: string;
  systemPrompt: string;
  allowedTools: string[]; // explicit allowlist, may be empty
  policyProfile: string; // named policy, not inline permissions
  maxTurns: number; // positive integer
  maxContextTokens: number; // positive integer
};

type Hook = {
  id: string;
  event: "before-run" | "after-tool" | "after-run";
  command: string; // must pass an explicit operator allowlist
  enabled: boolean;
};

type CompactionResult = {
  summary: string;
  retainedMessageIds: string[];
  omittedMessageCount: number;
  createdAt: string;
};
```

Rules: a profile never grants permission by prompt text alone; `allowedTools`
and `policyProfile` are checked by the existing policy path. A hook whose
`command` is not on the operator allowlist is refused at validation time, never
executed. Compaction returns the retained ids and never deletes or rewrites a
signed ledger entry. The existing `context.compacted` event shape is preserved.

## 6. Integration points

- Lane D exposes `GET /api/provider` returning `ProviderState` unchanged, plus
  additive `GET /api/projects`, `GET /api/runs`, `POST /api/runs/:id/stop`,
  `GET /api/agents`, `POST /api/agents` behind the same loopback and origin
  rules already in `apps/control-plane/api/server.ts`.
- Lanes B and C consume only these HTTP shapes or the workbench methods above.
- No new dependency. Tests are `node:test`. No em or en dash anywhere.

## 7. Completion integration, 2026-09-22

The current completion pass keeps the existing catalog shapes. `agents()` returns
`{supported, agents}` and adds `profiles`, `hooks`, `policyProfiles`,
`hookCommands` and `hooksSupported`. `upsertAgent(input)` validates before
persistence. Hook mutation is refused while `hooksSupported:false`; no executor
is installed in this slice. Profiles are snapshotted at session creation and
cannot grant tool or policy authority through their prompts.

`GET /api/projects` returns `items` and the `projects` alias. `POST /api/projects`
accepts `{id?, name, root}` and returns `{project}`. Sessions retain the project
ID in their existing `project` string. A project root grants no filesystem rights.
`POST /api/agents` returns `{agent}`. Hook execution, when supported, requires an
explicit operator full-command allowlist, no shell and bounded execution.
`POST /api/runs/:id/stop` takes a session ID and returns `{ok:true}`.

`POST /api/sessions/:id/compact` returns `{session, compaction}`. Compaction must
preserve complete assistant/tool result groups and must not promote untrusted
history into system authority or rewrite ledger records.

Recovery routes are shared with the existing cloud implementation:

- `POST /api/sessions/:id/recovery-jobs/plan`: `{jobId, selection}`.
- `POST /api/sessions/:id/recovery-jobs/apply`: `{jobId, planDigest, approved:true}`.
- `GET /api/sessions/:id/recovery-jobs/:job`: immutable preview or job result.

A selection is one exact run ID or an explicit operation ID list. A preview is
`{jobId, planDigest, selection, boundary, steps, residuals}`. Steps carry
`operationId`, `sequence`, `resources:string[]` and `scope:string`. A result
carries `jobId`, `status`, `checkpoint`, `outcomes`, `residuals` and optional
`pause`. No capture payload or credential belongs in these responses. The server
binds approval to the stored digest, validates current state and serializes
against forward writes. Explicit refresh creates a new job ID. Conflict and
unknown outcomes never trigger an automatic apply retry.

After admitted apply, the public session retains `lastRecoveryJob:{jobId}`.
If recovery currently blocks the session, that field names its owning job.
Only the job ID is public, never the private prior status or capture contents.
Branches clear this reference because they create a different workspace. GUI
status inspection after reload uses only GET for that existing ID. This metadata
is not approval and must never generate a new plan or trigger recovery apply.

Capabilities report `projects`, `customAgents`, `hooks`, `contextCompaction` and
`recoveryJobs` per host. A false flag is a visible unsupported feature, not a
control that produces a missing route error. Cloud profile and hook execution
remain unsupported until the same enforcement exists in the cloud runner.
