# NOMO agent workbench

A compatible-provider model loop whose tools always go through the NOMO SDK and
its fail-closed MCP proxy. There is no direct shell or database tool bypass.

The runtime owns provider validation, model discovery, session state, cancellation
and the shared approval broker. GUI and `nomo agent` consume this domain.

Configure `NOMO_UPSTREAM_COMMAND` as a JSON array, `NOMO_POLICY_PATH` as a policy
file, and optionally `NOMO_FACTS_PATH` and `NOMO_LEDGER_DIR`. A missing upstream or
policy refuses the session. Each session has its own ledger workspace, avoiding
concurrent writers to the same JSONL chain.

Configure a provider through `/providers` and `/login` or `Workbench.configure`.
A successful model catalog request is required before showing connected.
`NVIDIA_API_KEY` can connect the NVIDIA preset. `OPENAI_API_KEY` can connect the
manifest-bound OpenAI Responses profile. Ollama and LM Studio presets can run
without a cloud key on loopback endpoints. Generic compatible-provider
configuration rejects direct `openai.com` URLs; use the typed OpenAI profile
instead. Model provider credentials and MCP OAuth are separate flows.
The Control Plane's `GET /api/provider` is passive. Settings can explicitly run
`POST /api/provider/probe-environment`; direct `Workbench.providerState()` and
session start keep their existing environment resolution behavior.
Prompts and tool results are sent to the selected model provider.

The local Control Plane also exposes an inbound OpenAI Chat Completions subset:
`GET /v1/models` and `POST /v1/chat/completions`, authenticated with the same
Control Plane bearer token and subject to its existing origin/remote-access
rules. It accepts one text-only choice and rejects client `tools`, unsupported
roles, modalities, and parameters. `stream: true` uses OpenAI SSE framing, but
the assistant content is emitted after the Workbench run settles rather than
token-by-token. Set `stream_options.include_usage: true` to receive `usage: null`
on normal chunks and a final empty-choice chunk with exact Workbench provider
usage, or `null` if unavailable. Non-null `stream_options` requires `stream: true`
and supports only `include_usage`.
Listed model objects use `created: 0` because upstream model creation timestamps
are unavailable. NOMO tools remain internal to Workbench and are never exposed
as client-callable tools.

## Filtered project workspace

The local API supports project access through `POST /api/project-workspace/access`
with `{"path":"/absolute/path/to/git-root"}`; it accepts local requests only.
The current Control Plane GUI does not expose the `/project-workspace` page.
Workbench stores a private filtered copy under `project-workspaces/<rootDigest>`
in its data directory. Only `source/` is available to the project sandbox; the
original repository is never mounted. The private `control/baseline/` retains
the confirmed snapshot for stable diffs and can use up to 1 GiB in addition to
the filtered copy.

The copy excludes VCS metadata, `.env*`, `.ssh`, `secrets` and `credentials`
directories, known key/certificate/token file patterns, Git-ignored files,
build/cache directories, and `packages/cli/src/tui/**`. Symlinks, hardlinks,
cross-filesystem files, and copies beyond 100,000 files, 32 MiB per file, or
1 GiB total are rejected. Name filtering cannot detect secrets embedded in
ordinary source files; those files may be sent to the selected model.

Project tools are absent by default. A custom agent profile must explicitly
allowlist `nomo_project_changes` for read-only status/diff and
`nomo_project_exec` for commands in the filtered copy. Allowlisting
`nomo_project_exec` alone does not enable review. Reconfirm the project after
a Workbench restart; the saved-workspace catalog exposes metadata only, never
the original path.

Review changes in the local Control Plane. The UI pages paths by 50, shows one
file diff and its exact digest, and requires a separate confirmation to apply
that one file. The API rejects stale digests or changed original files with
`409`; it makes a backup before an atomic single-file write. Apply does not
create commits, push, merge, or switch branches. Revoke removes agent access
without deleting the copy; deleting a saved copy is a separate confirmed
action and permanently loses its unapplied changes. An assistant text reply
alone is not proof that a requested file was created. Verify successful tool
execution and inspect project status or the file diff before treating a write
as complete.

## AgentRunner broker

Workbench accepts injected `AgentRunner` implementations. `prepareAgentRun()`
creates a consent preview bound to the task, runner description, profile,
filtered-project manifest and current changes; `startAgentRun()` requires the
single-use consent digest and revalidates that snapshot. Tool calls are
rechecked against the active grant, project binding, profile, runner
capabilities, allowlist and current policy before dispatch. Ambiguous outcomes
are recorded as unknown and are never retried automatically.

When emitted, status events may progress from `starting` to `running` but
cannot regress. Consent previews declare whether transfer is remote and list
data categories. Provider, endpoint, execution and transfer-scope values remain
adapter claims, not independently verified properties.

`@nomo/workbench/agent-runners/claude-agent-sdk` exports the optional
`ClaudeAgentSdkRunner`. Register it through Workbench's `agentRunners` option or
pass it in `createControlPlaneServer({ agentRunners: [runner] })`; supply the
API key from the application's approved secret source. It is not enabled by
default and adds no credential picker or UI.

The adapter uses only the selected Workbench MCP tools; Claude built-in tools,
tool search, user/project/local settings, external MCP configuration,
background agents and session persistence are disabled. Each run uses a
temporary home/config directory that is removed when it ends. Telemetry,
error-reporting, feedback and survey traffic are disabled. The runner accepts
only the Anthropic API host on its default HTTPS port or loopback endpoints
(HTTP is accepted only for local fixtures).
Cancellation confirms local SDK shutdown only; remote provider completion can
remain unknown.

The SDK sends the task, system prompt, tool arguments and tool results to
Anthropic; assistant output comes back from the provider. The outbound data
categories appear in the consent preview.

The adapter does not prove real-account auth, billing, remote retention or
provider-side cancellation. Local tests use a synthetic key and a loopback
fake Messages API server; no real provider request was made.

`@anthropic-ai/claude-agent-sdk@0.3.312` is governed by Anthropic Commercial
Terms, not an open-source license. Its use requires the operator to have
authority to accept those terms. SDK and provider data handling is subject to
Anthropic's [Commercial Terms](https://www.anthropic.com/legal/commercial-terms)
and [data usage policy](https://code.claude.com/docs/en/data-usage).

Every `/api/project-workspace` route is local-only, even when
`NOMO_CONTROL_TOKEN` is configured for other Control Plane routes. The typed
absolute path is sent in the local access request, not put in the browser URL
or saved browser storage. The local API is a same-user boundary, not
authentication between users of the same machine.

## Google Vertex AI Standard

The typed `google-vertex` transport supports the pinned Standard Vertex
`streamGenerateContent` route with an API key. Configure a Google Cloud project
and location; Workbench derives the HTTPS endpoint and sends the key only in
the `x-goog-api-key` header. Model selection comes from the pinned manifest,
not a live Vertex model-list request. The project must have Vertex AI enabled
and billing configured.

This does not implement Application Default Credentials, gcloud credential
discovery, or Vertex Express mode. API-key and project requirements follow
Google's [Standard Vertex API-key guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/api-keys?usertype=standard),
[API-key header guidance](https://docs.cloud.google.com/docs/authentication/api-keys-use),
and [streamGenerateContent REST reference](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/projects.locations.endpoints/streamGenerateContent).

Google GenAI and Standard Vertex user messages accept up to four JPEG, PNG, or
WebP images, with 1 MiB decoded bytes total. The Control Plane validates
canonical base64 and file signatures; session create/send routes allow 2 MiB
JSON while the general API body limit stays 64 KiB. Unsent browser drafts stay
in memory. Sent bytes live only in encrypted local `workspace.enc` history;
events and ledgers store image IDs and MIME metadata, not bytes. Other
providers reject image-bearing messages. See Google's
[image understanding guide](https://ai.google.dev/gemini-api/docs/image-understanding).

The typed `mistral-conversations` transport is Prime's stateless Mistral chat
completion API (`POST /v1/chat/completions` with SSE), not the separate
stateful Beta Conversations API; it uses the official
[Mistral chat](https://docs.mistral.ai/api/endpoint/chat) and
[models](https://docs.mistral.ai/api/endpoint/models) endpoints. The typed
`ollama-chat` transport uses Ollama's native `POST /api/chat` NDJSON stream and
`GET /api/tags` catalog over loopback HTTP, with no auth header or cloud key;
the native contracts are documented at
[Ollama chat](https://docs.ollama.com/api/chat) and
[Ollama tags](https://docs.ollama.com/api/tags). Ollama tags are returned as
local model identifiers without claiming a chat capability.

## Prime Inference

Prime Inference uses the existing `openai-completions` wire, not a separate
transport. For the explicit `providerId: "prime-inference"` only, Workbench
requires an API key and binds requests to the official HTTPS endpoint:
`GET https://api.pinference.ai/api/v1/models` and
`POST https://api.pinference.ai/api/v1/chat/completions`, with
`Authorization: Bearer <API key>`.

Completion is gated to model IDs returned by that key's successful live catalog
request. HTTP 404, empty or malformed catalogs, and IDs absent from the latest
catalog fail closed; additional entitled IDs remain runtime-only and are not
added to the shared manifest. The Prime usage extension is
`{"usage":{"include":true}}`. These catalog and usage rules do not apply to
custom compatible endpoints without that explicit provider identity. Workbench
does not read a shell/CLI key or send `X-Prime-Team-ID`.

Live models map a complete `specs` object to context window, output-token cap
(bounded by context), and text/image/reasoning capabilities. Declared tool
support is exposed independently; incomplete specs do not claim context,
image, or reasoning support.

Models with output modality `decisions`, or a non-empty well-formed output list
that does not contain `text`, are excluded from Chat Completions discovery:
Workbench's compatible adapter represents text replies only. Mixed text and
image output remains discoverable. Missing or malformed modality metadata is
not used to filter a model. Prime documents evaluation models with `decisions`
as requiring its Evaluations API instead.

Official contracts: [Prime chat completions](https://docs.primeintellect.ai/api-reference/inference-chat-completions)
and [Prime models](https://docs.primeintellect.ai/api-reference/inference-models).

## OpenAI Responses

The explicit `providerId: "openai"` and `transport: "openai-responses"`
descriptor uses `POST https://api.openai.com/v1/responses` with a Bearer API
key; custom hosts are rejected. This is a separate wire from Chat Completions.
SSE function-call argument chunks are finalized in output order from the
completed response; its `response_id` and usage are returned to the caller.
The text-only `onDelta` callback redacts API-key matches across SSE delta
boundaries; tool arguments and usage remain unchanged.
The in-progress ChatGPT account profile accepts only the official
`https://api.openai.com/v1` base and retains only safe error metadata
(`code`, `param` and request ID), not provider error messages or raw bodies.
Direct-admission `detail` errors retain their shape with the text redacted.
The profile requires a streamed inference response and rejects a JSON reply.
Its authentication lifecycle remains incomplete and is not ready for use.
Incomplete, truncated, malformed, and failed streams are rejected; the reader stops and is
cancelled after the terminal completion event. OpenAI API keys and Responses
contracts are documented in the official
[API key guidance](https://developers.openai.com/api/docs/guides/production-best-practices),
[create response reference](https://developers.openai.com/api/reference/resources/responses/methods/create),
[streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses),
and [function-call streaming guide](https://developers.openai.com/api/docs/guides/function-calling#streaming).

## Amazon Bedrock Mantle Responses

The typed `providerId: "bedrock-mantle"` and `transport: "openai-responses"`
descriptor accepts AWS credential-chain auth as well as the existing Bedrock
API-key profile. Example for the typed `/api/provider` configuration:

```json
{
  "providerId": "bedrock-mantle",
  "transport": "openai-responses",
  "baseUrl": "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
  "auth": { "kind": "aws-credential-chain" },
  "model": "openai.gpt-5.4"
}
```

The host-credential path resolves the AWS SDK's default credential chain only
for an explicit model completion, then signs `POST /openai/v1/responses` with
the SigV4 service name `bedrock-mantle`. Model listing stays local to the
configured manifest model; it neither probes `GET /models` nor resolves AWS
credentials. API-key auth remains a separate Bearer-token path. No Settings UI
selector or `AWS_BEARER_TOKEN_BEDROCK` token-provider flow is included.

AWS documents both SigV4 and Bedrock API-key auth on
[Bedrock Mantle endpoints](https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html),
the Mantle signing service name in its
[CountTokens endpoint guidance](https://docs.aws.amazon.com/bedrock/latest/userguide/count-tokens.html#count-tokens-mantle),
and AWS credentials for HTTP Responses requests in the
[Responses API prerequisites](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-responses-api.html#bedrock-mantle-prereq).


## OpenAI Codex Responses: blocked

The pinned OMP 18.6.2 and Prime 0.10.1 implementations identify this API as
ChatGPT-account Codex, not the public OpenAI Responses API: both target
`https://chatgpt.com/backend-api/codex/responses` with a Bearer access token
and account-routing metadata. OMP implements browser and device-code login;
Prime implements a browser/callback login and stores the resulting OAuth
credential. These are facts about those implementations, not a public
third-party OAuth contract.

OpenAI's [Codex authentication docs](https://developers.openai.com/codex/auth/)
describe ChatGPT sign-in for the Codex desktop app, CLI, and IDE extension,
with browser credentials returned to Codex; the
[app-server](https://learn.chatgpt.com/docs/app-server) is the documented
rich-client integration. Workbench has no provider OAuth lifecycle or
Codex app-server bridge. **Blocker inference:** without that consent,
credential storage/refresh/revocation path and a supported Codex request
endpoint, this harness cannot safely implement the account flow. An API key
is not an OAuth substitute. `openai-codex` and `openai-codex-responses` are
therefore fail-closed; generic Completions/Responses configurations cannot
target the Codex backend. The provider-availability UI shows the manifest
reason; no Codex adapter or login is implemented.

## Azure OpenAI Responses

The typed `azure-openai-responses` transport accepts the pinned OMP
`providerId: "azure"` and Prime `providerId: "azure-openai-responses"` identities.
The current Azure Responses v1 route is `POST https://{resource}.openai.azure.com/openai/v1/responses?api-version=v1`.
The configured `baseUrl` may be the Azure resource root or its `/openai/v1`
base; `model` is the Azure deployment name. `azureOptions.apiVersion` accepts
only `v1` or `preview` and defaults to `v1`. The adapter sends an API key only
as `api-key`, rejects other hosts/paths and redirects, and does not implement
Microsoft Entra authentication. The matching catalog request is
`GET /openai/v1/models` with the same API-version and key header.

This follows Microsoft's current v1 REST contract and OMP 18.6.2 Azure SDK
request shape; the pinned Prime 0.10.1 source constructs a
`/deployments/{name}/responses` path, which differs from Microsoft's current
documented v1 route and is not emitted by this adapter. Official references:
[Responses API](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses),
[Responses REST reference](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/responses?view=rest-microsoft-foundry-v1-preview),
[models list](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/models?view=rest-microsoft-foundry-v1-preview),
[endpoint and deployment routing](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints),
and [API version lifecycle](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle).

Gateway adapters keep each wire format and credential header bound to its
official HTTPS host. OpenRouter uses Chat Completions for OMP's `openrouter`
transport and Prime's `openai-completions` row. API-key auth is supported;
OAuth-code login is not implemented. OpenRouter and Vercel require a successful
`/models` request before returning pinned manifest models; Cloudflare returns
its pinned manifest list without a model-discovery request. Model metadata
preserves supported input, reasoning, tools, context-window and max-output-token
values. The Settings form accepts the optional `openrouter` object as JSON;
typed `/api/provider` validates and persists its attribution and routing
preferences, and the provider state returns them for editing. Gateway values
are bound to the OpenRouter descriptor and sent only to OpenRouter. See the official
OpenRouter references:
[OpenRouter API](https://openrouter.ai/docs/api_reference/overview) and
[provider routing](https://openrouter.ai/docs/guides/routing/provider-selection).

Cloudflare AI Gateway now has manifest-backed descriptors for the pinned OMP
and Prime chat rows. Workbench maps Anthropic Messages to `/anthropic`, OMP
OpenAI Chat Completions to `/compat`, and Prime OpenAI Responses to `/openai`;
the base URL must include the resolved account and gateway IDs. Its API-key
profile represents the gateway token only, sent as `cf-aig-authorization`.
Separate upstream-provider and gateway credentials are not represented; this
supports keys stored in Cloudflare. Cloudflare marks `/compat` deprecated for
new single-model calls but says existing integrations continue to work. New
integrations should use its REST `/ai/v1/chat/completions` route, which is not
declared by this pinned manifest. Official references: [Cloudflare Anthropic](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/),
[Cloudflare OpenAI](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/),
[Cloudflare compatibility](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/).

Vercel supports the pinned Anthropic Messages route with API-key auth and
optional attribution headers; OIDC is not implemented. Chat Completions
provider-routing options are not applied to Vercel's Anthropic route. See
[Vercel Anthropic Messages](https://vercel.com/docs/ai-gateway/sdks-and-apis/anthropic-messages-api).

## Pinned OMP agent APIs not implemented

The generated `apiTransports` table records `source`, `apiId`, `status`, `reason`,
and source evidence for every OMP 18.6.2 and Prime 0.10.1 API roster entry;
catalog model rows do not imply adapter support. OMP's Cursor, Factory Droid,
GitLab Duo Agent, and Devin model rows use distinct agent protocols, not generic
chat APIs. Their typed transport IDs fail closed with provider-specific reasons;
the factory never falls back to OpenAI Chat Completions or reads local CLI
credentials.

- `cursor-agent` uses Cursor-specific Connect/protobuf Run and RunSSE calls,
  plus Cursor OAuth. Cursor's public CLI API-key docs do not establish
  compatibility with that private wire: [Cursor CLI authentication](https://cursor.com/docs/cli/reference/authentication).
- `factory-droid-agent` uses a WorkOS access token and Factory identity headers;
  the pinned OMP source says Factory API keys are rejected by its LLM proxy.
  The official [Droid CLI reference](https://docs.factory.ai/reference/cli-reference)
  describes CLI authentication, not this proxy contract.
- `gitlab-duo-agent` creates and streams GitLab Duo workflows over REST and
  WebSocket rather than serving a model completion. Official docs describe the
  [multi-token authentication chain](https://docs.gitlab.com/user/duo_agent_platform/authentication/)
  and [workflow API](https://docs.gitlab.com/api/duo_agent_platform_flows/).
- `devin-agent` uses the Devin Cascade Connect/protobuf service and its OAuth
  session-token exchange. Devin's documented [API credentials](https://docs.devin.ai/api-reference/authentication)
  apply to its separate REST API, not this transport.
- `apple-foundation-models` requires OMP's native `pi-natives` bridge and
  runtime availability checks. Workbench does not link that bridge; upstream
  also gates availability on a built bridge, macOS 27+, and an
  Apple-Intelligence-eligible device. See Apple's
  [Foundation Models framework](https://developer.apple.com/documentation/foundationmodels).
The Workbench provider-state API returns unavailable API rows to the existing
Settings screen, which exposes disabled choices and an accessible status/reason
list. Apple Foundation Models is marked `platform-unavailable` with its missing
native bridge and upstream macOS/device requirements.

Pinned source review used OMP 18.6.2 `packages/ai/src/providers/{cursor.ts,
factory-droid.ts,gitlab-duo-workflow.ts,devin.ts,apple-foundation-models.ts}`
and `packages/catalog/src/compat/rules/auth/*.kdl`. Prime 0.10.1 has none of
these five API IDs. No provider requests or local credential reads are part of
this support boundary.

## Connectors and operator consent

An external MCP server is added, edited, loaded and removed without a single
network request. A new connector starts `staged`: it has a name, a URL and a
policy, and no tools. `probeConnector(id)` is the only outbound request, it is
reached only from an explicit operator command, and it fills the catalog and
moves the connector to `probed`. A failed probe writes nothing: the connector
stays staged with an empty catalog. `confirmConnector(id)` accepts only a probed
catalog, and only a confirmed connector contributes tools to a new
conversation. An edit returns the connector to staged and drops its catalog, so
tools a conversation may use are always ones the operator has seen.

A snapshot written before this gate carries no consent state. It loads as staged
with an empty catalog, which leaves an existing connector inert until the
operator probes and confirms it again. That is deliberate rather than
convenient: a server nobody confirmed is one whose tools nobody has read.

Local proxy connectors may set `connectionless: true` and provide a
process-local `tokenProvider`. The callback supplies a fresh token for each MCP
request; it is never serialized or exposed in connection state. A connector
whose callback is unavailable after restart loads staged with an empty catalog
and must be probed and confirmed again. A static `token` cannot be combined
with `tokenProvider`.

`policyPreview(id)` answers what a connector's policy would do to every tool it
lists: the registry classification, the mapped registry id, the decision, the
rule that produced it, and the blast radius, which stays `unknown` until a
measured probe produces one. It sends nothing and writes nothing. A tool the
registry cannot classify is shown as denied, which is what a conversation does
with it, and a tool the provider invents is refused before the connector is
contacted at all.

A provider that returns an exact configured connector mapping instead of the
positional function name is accepted only when one confirmed catalog entry
matches. Duplicate mappings remain ambiguous and fail closed.


Provider profiles and conversations are stored in the encrypted local workspace
snapshot. Session snapshots keep the provider endpoint and kind, not duplicate
API keys. By default, `workspace.enc` is encrypted with `workspace.key` in the
same owner-only directory. The host can provide `NOMO_WORKSPACE_KEY`; the
desktop shell can source it from OS credential storage. This protects stored
state from other accounts, not from the same user or copies of the directory.

Workbench refuses to remove a lock whose PID no longer has a live process. To
recover, stop every NOMO process that can write to this storage directory, then
remove the corresponding `.lock` file. Do not delete the lock while any NOMO
process may still be using the store. Older NOMO processes may still attempt
automatic stale-lock recovery, so do not run them alongside this recovery.

`/logout` removes saved provider profiles and any legacy API key copies from
session configuration while keeping conversation history readable. Continuing a
conversation requires reconnecting to its original provider endpoint and kind.
Legacy sessions without a stored provider kind remain readable but cannot be
resumed. Start a new conversation rather than guessing. Logout is refused while
a model run, provider catalog validation, or session tool catalog request is
active.
`/login nvidia` or `/connect` without an argument explicitly re-enables that
path. Logout does not revoke a key at the provider.

The beta supports one active model run, 20 model turns per user message, 4096
output tokens per turn and up to 100 retained sessions. Conversation messages and
events persist in encrypted local workspace storage. Session context is limited
to 200 messages. Signed tool ledgers remain on disk after runtime restart.
Assistant text streams to the UI. There is no claim of Codex, Claude Code or
OpenCode process adapters, PTY, or desktop packaging. Those are separate AW
work packages.

Validation: the test `packages/workbench/src/workbench.test.ts`, run with
`node --test`, drives real MCP fixture processes behind a local provider test
double, including approval denial. It does not spend credits or claim
external-provider account validation.

The test `packages/workbench/src/harness-dispose.test.ts` proves the shutdown
drain. `disposeReviews` serves each open session's dispose boundary while the
provider still answers, and `shutdown` awaits it before closing the transports.
A dispose review bypasses arming but not the gate facts the trigger keeps:
refinement disabled, a round in flight, and a cooldown a failed attempt just
stamped all still hold, so a drain twice in one tick pays once.

The test `packages/workbench/src/harness-rollback.test.ts` proves the operator
rollback. `rollbackHarnessProposal` takes the digest of an activated
refinement and writes one more signed record whose `harnessRefinement` carries
the state the view reads. The inverse edits are rebuilt from the activation
record's own before snapshots and go through the same apply machinery an
approval uses, so a rollback cannot invent an entry the chain does not carry.
Three digests are refused by name: one no activation carries, one a later
refinement has displaced, and one already rolled back. Displacing is refused
rather than reconstructed, because the view reads the latest refinement record
alone and replaying the activations after it would be a second history nobody
approved. The rollback record names what it undid in `rolledBackDigest` and
carries no `digest` of its own, which is what keeps it apart from an
activation in every reader of that body.

The record says `approvedBy: "rollback"`, not `"operator"`, and that is load
bearing. The label decides whether the harness shows a restored entry to the
model as an operator-approved instruction, and the operator rolled back a
digest without reading the restored text again. A mined lesson that was never
operator written must not become operator approved text because it came back.

The rollback re-scans what it writes with the same patterns the proposal path
uses, rather than trusting that the original write was scanned. A secret that
entered the environment after a proposal was written would otherwise travel
into the chain again through the rollback, and the guarantee has to be
re-established at the write rather than inherited.

The rollback restores the state the harness reads, and the state it restores
is named in the record. A rollback of the second refinement leaves the harness
reading the state of the first again, so the first can be rolled back too, and
each record says which state it holds in `restoresDigest`. The inverse edits
run backwards, because the inverse of two edits on one entry is those two
edits reversed, and applied forwards a rollback would restore an intermediate
state and still report success. A restored lesson keeps the tool, the class
and the records it was mined from, and an edit id that is present but empty
is refused, because the apply path would take it as the entry id and the
rollback would then look for a different entry.

The operator decides a proposal on the surface they are already on. The
terminal has had that path; the web control plane did not, so an operator who
works in the browser could not approve what the harness learned, which is the
one action the loop exists for. The control plane now serves
`GET /api/sessions/:id/harness/proposals` and
`POST /api/sessions/:id/harness/proposals/:digest/approve`, `.../reject` and
`.../rollback` for a live session. A decision binds to the exact digest the
operator was shown, a rejection carries its reason, an unknown session reads
404, and a digest nobody proposed is refused with the workbench's own sentence
rather than as a silent no-op.

Operator-tunable run limits live in one table (`packages/workbench/src/harness-settings.ts`,
23 numeric limits plus the `refinementModel` selection, documented with every
audited fixed literal in `docs/HARNESS-SETTINGS.md`). Every setting names its
consumer symbols and is pinned by `packages/workbench/src/harness-settings.test.ts`
and `packages/workbench/src/harness-wiring.test.ts`.

The recursive learning return path is verified in two slices without ever
reaching `decide`, policy or the agent's prompt:

- Proposal outcome feedback (`packages/workbench/src/refinement-outcomes.ts`,
  `Workbench.harnessOutcomes`, pinned by `refinement-outcomes.test.ts` and
  `harness-outcome-feedback.test.ts`) feeds settled proposal fates back to the
  reviewer within `maxPromptCharacters` and refuses an identical repeat of a
  rejected or rolled-back edit set unless it cites newer signed records.
- Descriptive refinement effect measurement (`measureRefinementEffect` in
  `packages/workbench/src/harness-scores.ts`, `mineRefinementEffects` and
  `formatEffectsForReview` in `packages/workbench/src/refinement-outcomes.ts`,
  `Workbench.harnessEffects`) compares strictly disjoint pre-activation and
  post-activation windows (`seq < activationSeq` vs `seq > activationSeq`,
  bounded by rollback if rolled back), labels every unmeasured guardrail, and
  reaches the reviewer and `nomo harness ratchet` as descriptive evidence only
  (decision D1).

End-to-end proof: `packages/workbench/src/harness-proof.test.ts` drives both a
loopback HTTP MCP connector (hold + operator denial) and the real stdio
`packages/proxy` transport (`fixtures/e2e-server.mjs`, direct policy denial)
through refusal, deterministic rule mining, digest-approved activation, bounded
retrieval (`contextEntryLimit`), H11 effect measurement, rollback, H10 repeat
refusal and standalone offline verification (`packages/verifier/verify-ledger.mjs`).
The observed transcript is recorded in
`docs/superpowers/evidence/2026-11-21-h7-harness-proof.md`. The proof uses a
local model test double and makes no claim about live third-party provider
quality or coding-benchmark parity.

The test `packages/workbench/src/compaction-summary.test.ts` proves the
compaction summary. The compaction dropped the middle of the conversation and
pasted the first three thousand characters of it back, so the turns nearest
the compaction were exactly the ones it lost. A summary written by the same
provider the conversation runs on covers the whole middle, and that provider
already had those turns, so nothing crosses a boundary the operator did not
choose. The quoted turns are marked as history, because a turn that said
"ignore your instructions" would otherwise be quoted back as an instruction.
A summary that fails is not a failed compaction: the raw extract is what the
compaction used before, and it still works. The summary is asked for
separately from the compaction, because the compaction is synchronous and the
terminal reads its result without awaiting; a host that wants the summary
asks for it first and passes it in.

No mined rule is merged into the policy a call is decided under. The policy
loader requires the terminal catch-all (`match: {}`) to be the last rule and
`decide` takes the first match, so a rule appended behind it can never fire,
and a merge that cannot bind would still tell a reader that learning governs
calls. Learning is evidence: `nomo harness entries` shows the rule and the
number of refusals behind it, and an operator who agrees writes it into their
own file, where it is reviewed and diffed like every other rule. The test
`packages/workbench/src/learned-rules.test.ts` proves both halves: the
operator's own rule decides, and a mined rule appended behind the catch-all
never does.

The harness mints a `hold` rule and never a `deny` rule. Three refusals of the
same shape are a pattern worth asking about, not a permanent prohibition, and
a refusal the operator never asked for should pause for a human who can undo
it. Promotion to `deny` is an operator act: they read the count and write the
rule themselves.

The test `packages/workbench/src/harness-tools.test.ts` proves the two tools
the agent may call: `void_harness_add` proposes a lesson and
`void_harness_forget` proposes that one be forgotten. The tool writes a
proposal, never a change: a proposal is inert until an operator approves its
exact digest, and an approval is a human act with a human reading the text.
An agent that could write its own instructions would be an agent that could
talk itself out of every boundary above it, so the tool stops at the proposal.
The proposal cites the chain records it was derived from, because the chain is
signed and an uncited claim cannot be recorded; the agent does not know those
sequence numbers, so the tool cites the head of the chain it observed. Before
the chain holds a record there is nothing a proposal could rest on, and the
tool says exactly that.

The test `packages/workbench/src/harness-conversation.test.ts` proves the
conversation tail the reviewer sees. The reviewer was blind to the
conversation, and a blind reviewer proposes the same generic lesson again.
The tail is the last exchanges of the conversation, cut whole, labelled as
untrusted context, and charged to the operator's prompt ceiling before the
two evidence halves share what is left. A tool message never travels, because
a tool result is an upstream payload. Tool call arguments never travel,
because they are model authored JSON that can quote a document. A system
message never travels, because a harness entry must not reach the reviewer
twice. A message longer than the per message cap keeps its last characters
and says that the earlier part was omitted, because a half message presented
as a whole one is how a reviewer learns something that was never said. A tail
whose text carries a secret is withheld whole rather than trimmed, and the
operator is told, because a silent omission would leave them believing the
reviewer read the conversation. The tail goes to the reviewer and nowhere
else: it is not written into a chain record, and it is not echoed into a
refusal.

The test `packages/workbench/src/harness-review-model.test.ts` proves the
reviewer model selection. `refinementModel` is empty by default and empty
means the conversation's own model pays for the review. A selected model takes
the review call, the usage record names the model the call actually went to,
and a provider that does not know the model fails the review with the model
named. A malformed or unknown selection is refused by name and changes
nothing, and a hand-edited state file cannot inject a model id the validator
refuses. The selection is a name rather than a limit, so it lives in its own
table with shape validation instead of a clamp, and it is set over HTTP at
`/api/harness-review-settings`.

The test `packages/workbench/src/connector.test.ts` proves the consent gate
end to end against a loopback MCP server that counts its requests, including
the migration of a snapshot written before the gate.
`packages/workbench/src/policy-review.test.ts` proves that the operator rule and
not the classifier decides, that an invented tool never leaves the process, and
that a running conversation keeps the policy it started with.
