# Spec: Inbound OpenAI-Compatible Chat Completions

## Objective

Let local clients that speak a bounded OpenAI Chat Completions API subset use the NOMO Control Plane as their base URL. This is an inbound facade over the existing Workbench agent runtime, not outbound provider support, an OpenAI service, or OpenAI OAuth.

## Contract

- `GET /v1/models`: list only the stored Workbench catalog; disable ambient environment probing for this route. OpenAI model objects use `created: 0` as an explicit unknown-timestamp sentinel because Workbench does not store upstream model creation dates.
- `POST /v1/chat/completions`: one choice, text-only `system`, `developer`, `user`, and `assistant` messages; optional exact catalog `model`; boolean `stream`. An absent or null `stream_options` is treated as omitted. A non-null `stream_options` object with optional boolean `include_usage` is supported only when `stream: true`; other nested options are rejected. Preserve client messages as caller-supplied context in one Workbench run. Client `system`/`developer` content must not replace NOMO's mandatory system policy.
- Reuse the existing Control Plane `Authorization: Bearer <NOMO_CONTROL_TOKEN>` and origin/remote-access rules; do not add API-key storage or a second auth system.
- JSON response follows Chat Completion object shape. SSE uses OpenAI chunk framing, emits role/content/finish chunks after the Workbench run settles, then `[DONE]`; it is protocol-streamed but does not promise token-by-token live output. With `stream_options.include_usage: true`, each normal chunk includes `usage: null`, then a final chunk has `choices: []` and exact Workbench provider usage or `null`; never estimate usage. Output comes only from Workbench's already-redacted and bounded session events.
- Reject client `tools`/`tool_choice`, tool-role messages, multimodal content, multiple choices, unsupported generation parameters and nested stream options, malformed roles, and oversized bodies with structured 4xx errors. Non-null `stream_options` requires `stream: true`. Internal NOMO tools remain controlled and executed by Workbench; never expose them as client-callable tools.
- Client disconnect cancels only the run created for that request; existing consent, approval, ledger, revocation, workspace, and cancellation semantics remain authoritative.
- No Responses API, embeddings, images/audio, OAuth, browser, GUI, TUI, desktop, Docker, SWE-bench, provider credentials or live-provider tests.

## Tech Stack and Structure

Existing Node 24+ TypeScript Control Plane (`apps/control-plane/api/server.ts`) and Workbench runtime (`packages/workbench/src/index.ts`); Node test runner fixtures in `apps/control-plane/api/server.test.ts` and `packages/workbench/src/workbench.test.ts`. No new dependencies.

## Commands

- Focused API: `node --test apps/control-plane/api/server.test.ts`
- Workbench: `pnpm --filter @nomo/workbench test`
- Types: `pnpm --filter @nomo/workbench run typecheck` and `pnpm run typecheck`

## Boundaries

- Always validate request shape, selected model, content size, and authorization at the HTTP boundary; keep the provider/auth secrets out of all responses and logs.
- Preserve existing Control Plane body limits, origin rules, Workbench session policy, and per-run tool authorization. Reject unsupported semantics rather than silently ignoring them.
- No dependency, auth lifecycle, permission, storage schema, UI/TUI/desktop, or remote network changes.
- OpenAI contract source: https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create and https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events.

## Success Criteria

- Existing OpenAI SDK-compatible clients can list configured model IDs and create a normal text Chat Completion using the same Control Plane bearer credential.
- JSON and SSE return the same final, redacted assistant text; SSE uses OpenAI chunk framing and ends with `[DONE]`.
- Unsupported tools/roles/modalities/parameters fail closed before a Workbench run is created; invalid models never trigger a provider completion.
- Disconnect cancels the owned run; errors do not expose internal secrets or stack traces.
- Focused and full relevant tests, typechecks, and docs-truth pass; existing Harness tests remain green; no TUI paths are edited.

## Open Questions

None after the user's selection of inbound `/v1/models` and `/v1/chat/completions`, JSON/SSE, no client tools, and reuse of existing Control Plane authentication.