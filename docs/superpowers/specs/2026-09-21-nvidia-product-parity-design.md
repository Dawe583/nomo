# NVIDIA model and product parity design

## Goal

Make NOMO a coherent coding workspace across web, packaged desktop, and TUI, with NVIDIA NIM `z-ai/glm-5.3-flash` as the default for new sessions when configured, and add the highest-value Claude Code-like workflows without weakening NOMO's approval, ledger, and recovery guarantees.

## Current facts

- The workbench currently defaults to OpenCode Zen and Muse Spark.
- The provider seam is OpenAI-compatible and already supports streaming, tool calls, provider model catalogs, and server-side credentials.
- The web UI and desktop package share the control-plane web surface.
- The TUI has independent navigation and safety tests.
- Existing sessions must retain their provider and model.
- NVIDIA documents `https://integrate.api.nvidia.com/v1` and model `z-ai/glm-5.3-flash` as an OpenAI-compatible chat-completions endpoint.

## Decisions

### Provider

Add an NVIDIA preset with:

- id: `nvidia`
- display name: `NVIDIA NIM`
- base URL: `https://integrate.api.nvidia.com/v1`
- credential: server-side `NVIDIA_API_KEY`
- default model: `z-ai/glm-5.3-flash`
- display name: `GLM 5.3 Flash`

New sessions use NVIDIA when `NVIDIA_API_KEY` is available. Without it, the UI reports an explicit provider setup state; it does not silently select a paid provider. Existing sessions and saved provider profiles are not rewritten.

The provider adapter sends NVIDIA-compatible request fields only when supported by the existing contract. Reasoning controls stay optional and are not shown unless the provider catalog or contract exposes them. Provider responses remain untrusted data and are validated before use.

### Product slices

1. **Provider slice:** preset, default selection, environment setup, catalog and error states, streaming/tool-call tests.
2. **Workspace slice:** project/workspace context, persistent session grouping, background run status, resume/cancel semantics using the existing runtime.
3. **Agent slice:** custom agent profiles and hooks as allowlisted configuration, never prompt-only permissions.
4. **Context slice:** bounded context compaction with explicit status and no silent deletion of audit records.
5. **Recovery slice:** approval cards, document diff, current-state revalidation, and multi-operation rewind using existing server/runtime authority.
6. **Parity slice:** identical information architecture and state language across web, desktop, and TUI; shared contracts where possible, platform-specific rendering where necessary.

### Safety

- Model output never becomes shell, SQL, filesystem, or HTML authority without typed validation and policy checks.
- Destructive tools remain approval-gated.
- Background runs remain bounded by runtime capacity and durable unknown/reconciliation states.
- API keys remain server-side and are redacted from errors, events, and UI payloads.
- No automatic paid fallback is added.

## Acceptance criteria

- New sessions select NVIDIA NIM and GLM 5.3 Flash when `NVIDIA_API_KEY` is configured.
- Missing credentials produce a clear setup state and do not claim that a request ran.
- Existing sessions preserve their original provider/model.
- Real and fixture tests cover model catalog, streaming, tool-call parsing, provider failure, credential redaction, and model selection.
- Web, desktop, and TUI expose the same core pages and state vocabulary: chat, sessions, runs, documents, approvals, ledger, tools, and models.
- Background runs can be observed, stopped, resumed, and reconciled without duplicate tool dispatch.
- Context compaction is bounded, visible, reversible at the audit level, and never deletes signed ledger history.
- Custom agents and hooks are explicit, scoped, and policy-checked.
- Document diff/Undo and multi-operation rewind revalidate current state before mutation.
- Browser checks cover 320, 768, 1280, and 1440 pixel widths; PTY checks cover the TUI; packaged desktop smoke covers the shared web asset and runtime.
- Full typecheck, focused tests, build, and relevant regression suites pass before push.

## Non-goals

- Claiming full Claude Code or ChatGPT feature parity in one change.
- Publishing or notarizing a desktop installer without signing credentials.
- Treating NVIDIA trial quotas as a permanent free-service guarantee.
- Adding a paid fallback that can surprise users.
- Replacing the existing NOMO runtime, policy engine, ledger, or recovery authority.

## Official provider reference

- https://docs.api.nvidia.com/nim/reference/z-ai-glm-5-3-flash-infer
- https://build.nvidia.com/z-ai/glm-5-3-flash/playground
