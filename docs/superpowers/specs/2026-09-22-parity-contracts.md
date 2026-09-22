# VOID parity contracts, frozen 2026-09-22

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
