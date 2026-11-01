# Changelog

All notable user-facing changes since the first repository commit.

## Unreleased

- Updated the interactive NOMO workspace with eleven views, mouse and keyboard navigation, model selection, and color themes. Existing approvals, ledger, Workbench actions, and active-session model behavior remain unchanged.
- The Control Plane exposes an inbound OpenAI-compatible subset at `GET /v1/models`
  and `POST /v1/chat/completions`, using existing bearer auth and Workbench
  policy. It returns JSON or SSE-framed final output, not token-by-token
  streaming; client tools and unsupported request shapes are rejected.
- The inbound OpenAI Chat Completions SSE subset now supports
  `stream_options.include_usage`: ordinary chunks carry `usage: null` and a
  final empty-choice chunk carries exact Workbench usage or `null`. The response
  remains final-only, not token-by-token streaming.
- TUI text wrapping now prefers word boundaries while retaining hard wraps for overlong tokens.
- A one-row live chat viewport now follows non-empty streamed code rows instead
  of the blank separator after a newline.
- Removed a width-40 debug diagnostic that leaked renderer details to stderr.
- Spacious NOMO TUI views keep the pale aperture and live metadata, dock a full-width flat charcoal composer and compact counts, suppress verbose shortcut chrome, and render user/error messages as a flat sequence.
- Spacious prompt surfaces now include vertical padding, and the workspace canvas uses the terminal's default background.
- Empty TUI lists center their existing placeholder in the available body.
- Status rows retain model names when the displayed row has enough room.
- Spacious workspaces identify the active panel in the header.
- The narrow `/settings` heading wraps on a word boundary at 40 columns.
- Compact chat keeps the full conversation and approval counts visible at 40 columns.
- Narrow TUI status docks reflow full authority and context labels across rows.
- Compact confirmation reviews show a preview and accept/reject/cancel controls at 40 columns.
- Compact confirmation previews retain a PgDn cue when content scrolls at 40 columns.
- The color command palette keeps selected commands visible without wrapping ANSI styling as text.
- The 40-column command palette keeps its selected result inside the visible viewport.
- Compact keybindings show a PageDown cue when details overflow at 40 columns.
- The compact command palette keeps its Enter and Esc controls visible at 40 columns.
- Opening keybindings clears palette guidance and preserves other notices.
- Assistant Markdown headings now render as clean NOMO-styled terminal titles without changing the event or transcript text.
- Approval review overlays emphasize their existing title and evidence labels without changing review values.
- Undo confirmations distinguish the existing Operation label from its value without changing preview content.
- Add an opt-in Claude Agent SDK AgentRunner adapter with brokered in-process
  tools, local-only synthetic API fixtures and disabled SDK telemetry/transcript
  persistence. No live provider request or provider-parity claim.

- Remaining private workspace identities now use `@nomo`: root, CLI and
  scripts, alongside the earlier nine Harness packages. The independent ledger
  verifier source package is `@nomo/verifier`; neither the previous nor target
  verifier package name was present in npm at the 2026-10-28 check. Nothing was
  published. Release metadata tests now pin the root/scripts/CLI/verifier
  identities. Existing package suites, typechecks and release gates remain
  recorded below.
- Current Workbench agent presets, model instructions, policy denials/errors
  and tool-decision copy now use NOMO. The Workbench suite passed 843/845 (2
  skipped) and typecheck passed; commit `ff228cc` is on the feature branch.
- Cloudflare Workers AI exposes the single pinned Prime DeepSeek V4 Flash model
  through its official account-scoped OpenAI Chat Completions URL. Workbench
  requires HTTPS `api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1`,
  rejects other hosts, paths and URL decorations, sends the standard API-key
  Bearer header, and returns the pinned model without probing `/models`. This
  does not imply support for other Workers AI models or tool calling. Local
  fixtures cover route, auth, endpoint rejection and secret redaction; no live
  provider request or credential access. Source:
  [Cloudflare OpenAI compatibility](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/).
- Cloudflare AI Gateway now exposes manifest-backed descriptors for pinned OMP
  and Prime chat rows across Anthropic Messages (`/anthropic`), OMP Chat
  Completions (`/compat`) and Prime Responses (`/openai`). Endpoint validation
  binds each transport to its official host and route, rejecting custom ports,
  query strings, unresolved IDs and encoded path separators. The API-key profile
  is the Cloudflare gateway token only; separate upstream-provider keys remain
  unsupported. Cloudflare marks `/compat` deprecated for new single-model calls
  but continues supporting existing integrations; its newer REST route is not
  part of this pinned manifest. RED reproduced missing descriptors and accepted
  encoded path separators. GREEN: provider catalog 22/22, gateway 7/7 and HTTP
  setup 1/1. Synthetic local fixtures only; no real provider request or
  credential access. H21 and full OMP/Prime parity remain incomplete. Sources:
  [Cloudflare Anthropic](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/),
  [Cloudflare OpenAI](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/),
  [Cloudflare Unified API](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/).

- OMP Bedrock Mantle now has an API-key Responses route for all five pinned
  GPT-5.4, GPT-5.5 and GPT-5.6 Luna/Sol/Terra models. The adapter accepts only
  HTTPS `bedrock-mantle.{region}.api.aws/openai/v1` endpoints and sends the
  Bedrock API key as Bearer auth. The host-credential SigV4 route and OMP
  bearer-token lifecycle remain unsupported. API tests verify encrypted key
  persistence, non-disclosure and endpoint rejection. Full Workbench: 804
  (802 passed, 2 skipped); typecheck, API 38/38, API TypeScript and docs-truth
  9/9 passed. Fixture-only; no provider requests, credential reads, GUI/TUI or
  OMP runtime. H21 and full OMP/Prime parity remain incomplete.
- OMP Ollama Cloud now has exact API-key descriptors for all 51 pinned chat
  models. It uses canonical `https://ollama.com`, Bearer auth on `/api/chat`,
  and the selected manifest model; it never probes undocumented Cloud
  `/api/tags`. Local Ollama remains loopback/no-auth. Streamed output redacts
  the key across chunk boundaries. The coverage API now lists 136 remaining
  blocked rows in 9 groups. Sources: [pinned OMP adapter](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.6.2/packages/ai/src/providers/ollama.ts),
  [Ollama auth](https://docs.ollama.com/api/authentication).
  Verification: Workbench 804 (802 passed, 2 skipped), Workbench typecheck,
  API 38/38, API TypeScript and docs-truth 9/9. Fixture-only; no provider
  request, credential access, OMP runtime, GUI or TUI. H21 and full OMP/Prime
  parity remain incomplete.
- All 209 pinned in-scope OMP Bedrock chat rows now have Workbench descriptors
  using the existing AWS credential chain when their manifest declares the
  host-credential path. OMP bearer-token auth remains unsupported; no OMP
  runtime, credentials or provider request. Coverage RED found 209 uncovered
  rows; GREEN and full Workbench passed (799 total, 797 passed, 2 skipped),
  Workbench typecheck passed, API tests passed 37/37, docs-truth 9/9. H21 and
  full OMP/Prime parity remain incomplete.

- OpenRouter typed provider setup now accepts host-bound routing and attribution
  preferences through `/api/provider`; the Settings form exposes the OpenRouter
  object as optional JSON and reloads saved values. API validation rejects
  malformed preferences and use with other provider IDs. API suite: 35/35,
  gateway suite: 7/7, UI suite: 138/138, full Workbench: 791 total, 789 passed,
  2 skipped; workspace typecheck passed. Browser smoke captured the exact local
  request payload with an intercepted response; no upstream provider request
  or credentials. H21 remains active; no parity claim or TUI change.

- Anthropic Messages now streams text and tool calls over SSE when the agent
  provides `onDelta`. It preserves indexed block order, assembles fragmented
  tool JSON and cumulative usage, redacts split API-key prefixes from emitted
  text, and rejects incomplete, malformed, oversized or out-of-order streams
  and unsupported stop reasons. Thinking/signature deltas are not emitted;
  unknown event types are ignored per the documented contract. Provider-native
  tests: 9/9; full Workbench: 784 total, 782 passed, 2 skipped, 0 failed;
  typecheck passed. Source: https://platform.claude.com/docs/en/build-with-claude/streaming.

- Cloudflare Anthropic gateway now preserves `Accept: text/event-stream` for
  streamed Messages requests and retains `application/json` for non-stream
  calls. A local end-to-end SSE fixture verifies text deltas, fragmented tool
  JSON, tool IDs and usage. RED reproduced invalid event-stream decoding after
  the gateway overwrote Accept. Gateway tests: 7/7; full Workbench: 785 total,
  783 passed, 2 skipped, 0 failed; typecheck passed. No live provider requests
  or credentials. Cloudflare documents the Anthropic route at
  https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/index;
  Anthropic defines SSE streaming at
  https://platform.claude.com/docs/en/build-with-claude/streaming.

- Google GenAI now rejects candidate content in later SSE frames after
  `finishReason: STOP`, while retaining independent usage-only metadata frames.
  RED reproduced late text and functionCall acceptance (`Missing expected
rejection`); GREEN Google fixtures: 10/10. Full Workbench: 787 total, 785
  passed, 2 skipped, 0 failed; workspace `pnpm run typecheck` passed. No live
  provider request or credentials. Google defines `finishReason` as the reason
  generation stopped, says it is empty while generation continues, and defines
  `STOP` as a natural stop point:
  https://ai.google.dev/api/generate-content#v1beta.Candidate.

- Bedrock ConverseStream now rejects non-metadata events after `messageStop`
  while allowing the documented trailing usage `metadata`. AWS diagrams
  `messageStart`, content blocks, `messageStop`, then metadata:
  https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html#conversation-inference-call-response-converse-stream.
  RED fixture failed with `Missing expected rejection`; Bedrock suite: 13/13.
  Full Workbench: 788 total, 786 passed, 2 skipped, 0 failed; workspace
  `pnpm run typecheck` passed. No live AWS request or credentials.

- OpenAI-compatible Chat Completions now rejects choice data after a
  `finish_reason` and nonempty SSE data after `[DONE]`, while retaining the
  documented trailing usage-only chunk with `choices: []`. OpenAI defines
  `finish_reason` as why generation stopped and documents usage before `[DONE]`:
  https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events
  and https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create.
  RED fixtures first failed with missing expected rejection; focused stream
  tests: 16/16. Full Workbench: 790 total, 788 passed, 2 skipped, 0 failed;
  workspace `pnpm run typecheck` passed. No provider requests or credentials.

- Mistral Conversations now rejects event data following
  `conversation.response.done` instead of silently discarding later events.
  The official API documents `conversation.response.done` within the
  `ConversationEvents` stream type but does not explicitly define post-terminal
  ordering; this guard treats the named completion event as terminal:
  https://docs.mistral.ai/api/endpoint/beta/conversations.
  RED reproduced silent acceptance; Mistral adapter tests: 14/14. Full
  Workbench: 791 total, 789 passed, 2 skipped, 0 failed; workspace
  `pnpm run typecheck` passed. No live provider request or credentials.

- Anthropic Messages now validates non-stream `stop_reason` before content or
  tool mapping. The official contract documents `end_turn`, `max_tokens`,
  `stop_sequence`, `tool_use`, `pause_turn`, `refusal`, and
  `model_context_window_exceeded`, and states non-stream values are non-null:
  https://platform.claude.com/docs/en/api/messages (lines 4095-4103).
  Missing/unknown reasons fail closed; `max_tokens`, context-window overflow,
  and `pause_turn` retain explicit errors; other documented reasons are
  accepted. RED provider-native: 5 passed/1 failed (`Missing expected
rejection` for missing status); after adding the guard, gateway fixtures
  needed documented `end_turn`. GREEN native + gateway: 12/12. Full Workbench:
  781 total, 779 passed, 2 skipped, 0 failed; `npm run typecheck` exit 0.
  Independent review found no issues. No provider requests or credentials.

- OpenAI Chat Completions now normalizes supported `text`/`refusal` content
  parts and uses top-level `message.refusal` when nonempty text is absent.
  Unknown content/refusal parts fail closed. Provider-retry fixtures passed
  8/8; full Workbench: 772 total, 770 passed, 2 skipped, 0 failed; typecheck
  passed. No provider request or credentials.
- OpenAI-compatible Chat Completions now supports legacy `function_call`:
  non-stream calls become one Workbench tool call with a generated ID, while
  streaming fragments accumulate into one ID-preserving call. Malformed or
  mixed legacy/modern forms fail closed. Targeted fixtures passed 24/24; full
  Workbench: 779 total, 777 passed, 2 skipped, 0 failed; typecheck passed.
  No provider request or credentials.
- OpenAI-compatible streaming now appends `delta.refusal` through the same
  path as `delta.content`, including redaction, response-size limits,
  `onDelta`, and assistant content. Refusal-only streams are preserved.
  Provider-stream fixtures passed 12/12; full Workbench: 775 total, 773 passed,
  2 skipped, 0 failed; typecheck passed. No provider request or credentials.
- OpenAI-compatible streaming completions now validate terminal
  `finish_reason`: intermediate `null` chunks remain valid, but only
  `stop`/`tool_calls`/`function_call` may finish a response. `length` and
  `content_filter` retain truncation errors; unknown reasons and `[DONE]` with
  content but no terminal reason are rejected. Targeted suite passed 11/11;
  full Workbench: 774 total, 772 passed, 2 skipped, 0 failed; typecheck passed.
  No provider request or credentials.
- OpenAI-compatible non-stream completions now validate `finish_reason`:
  `length` and `content_filter` retain explicit truncation errors, while only
  `stop`, `tool_calls` and `function_call` are accepted terminal reasons.
  Missing/unknown reasons are rejected. Targeted fixtures passed 10/10; full
  Workbench: 770 total, 768 passed, 2 skipped, 0 failed; typecheck passed.
  No provider request or credentials.
- Anthropic Messages now rejects `stop_reason: "model_context_window_exceeded"`
  before content or tool-call mapping, returning an explicit context-window
  error rather than accepting partial text. Targeted fixtures passed 4/4; full
  Workbench passed 766/766 (2 skipped), with typecheck passing. No provider
  request or credential was used.
- Mistral SSE handling now explicitly permits `conversation.response.started`
  and rejects unhandled event types instead of silently ignoring them. This
  prevents partial message/tool output from being accepted after an incomplete
  stream. Targeted fixtures passed 13/13; full Workbench passed 767/767
  (2 skipped), with typecheck passing. No provider request or credentials.
- Anthropic Messages now rejects responses with `stop_reason: "max_tokens"`
  before parsing content, reporting output truncation instead of accepting an
  incomplete text/tool response. Targeted fixtures passed 3/3; full Workbench
  passed 765/765 (2 skipped), with typecheck passing. Fixture/stub only; no
  provider request or credentials.
- Google GenAI function calls now preserve provider-supplied call IDs through
  tool-call conversion and replayed function responses, while retaining the
  synthetic-ID fallback when the provider omits an ID. Focused fixtures passed
  7/7; full Workbench suite passed 763/763 (2 skipped), with typecheck passing.
  Verification used fixtures and stub fetch only; no provider request or
  credential was used.
- Google GenAI model discovery now follows `nextPageToken` using `pageToken`,
  shares one 15s timeout, validates pagination tokens and filters models by
  `supportedGenerationMethods`. Vertex remains manifest-pinned. Google GenAI
  fixtures passed 8/8; full Workbench passed 764/764 (2 skipped), with
  typecheck passing. Fixtures/stub fetch only; no provider request or
  credentials.
- Provider status polling no longer triggers environment-provider discovery.
  Settings exposes an explicit server-side check for NVIDIA and DashScope
  environment credentials; keys stay out of the renderer. Workbench session
  start keeps its existing environment resolution. Regressions use synthetic
  credentials and stub fetch only.

- OpenAI and Azure Responses now preserve refusal output as assistant message
  content and stream refusal deltas through the same content and delta callback
  paths as other text. OpenAI and Azure Responses fixture suites passed 20/20;
  no live provider request was made.

- Mistral now uses the source-backed Conversations API at
  `POST /v1/conversations`, not Chat Completions. Ordered history is serialized
  into `inputs`, including `function.call` and `function.result`. Official
  delta/done events and usage are mapped. Existing auth, redaction, limits and
  cancellation boundaries remain. Focused fixtures passed 12/12; no live
  provider or network request was made.

- Workbench now has an injectable AgentRunner broker with single-use consent
  previews bound to the task, runner description, profile and filtered project
  snapshot. Tool calls recheck grant, project binding, profile, capabilities,
  allowlist and current policy, then use Workbench's existing dispatch and
  signed-ledger path. Ambiguous outcomes remain unknown and are not retried.
  This is not a shipped vendor adapter or Control Plane consent route. The
  preview names possible transfer categories (task, system prompt, tool
  arguments and results), but provider metadata and transfer scope remain
  adapter claims; no live provider or remote execution was verified. Coverage
  uses offline synthetic runners only.
- Google Vertex AI Standard now supports typed project and location settings.
  Workbench derives the HTTPS endpoint, sends the key only in
  `x-goog-api-key`, and lists models from the pinned manifest. ADC, gcloud
  credential discovery and Vertex Express remain unsupported.
- Local project workspaces use a private filtered copy. The local Control Plane
  reviews one-file diffs and requires the exact digest before applying a change.
  Saved workspaces require renewed confirmation after a Workbench restart.
- Spawned children now use the parent's connector snapshots and inherit tools
  only when both the name and connector identity match. Later connector
  additions or edits cannot widen the child's scope.
- A TUI session can now opt into one project with `nomo tui --project PATH`
  and explicitly selected, lock-listed workspace skills. The operator sees the
  project root and data-retention/provider disclosure before consent; consent is
  process-local. A custom profile must explicitly allowlist
  `nomo_project_exec`, and its R3 policy still decides each call. Commands run
  only in a pinned Docker/Podman container with no network, a read-only root,
  bounded resources and output, a non-root user, and only the selected project
  mounted writable.
  Cancellation during container creation still attempts cleanup by its unique
  name.
  Missing sandbox configuration refuses execution; no host-shell fallback
  exists. Project files and command results can contain secrets and reach the
  configured provider or local session history.
- A learned rule could feed on itself. The mining read refusals from the
  signed chain, a fired learned hold that the operator denied wrote a new
  refusal record of its own, and the miner counted that record as fresh
  evidence for the same rule, so the count behind "Refused N times" grew
  forever without a single new operator refusal. A refusal whose record names
  the learned rule that fired is now excluded from the count, so the rule
  stands only on evidence the rule did not cause, can fall below the repeat
  threshold when its only support was itself, and re-arms on real refusals.
  Refusals recorded without a fired-rule rationale, including the proxy's
  imported records, keep counting exactly as before.
- The harness now says what the learned rules actually do. They are appended
  after the operator's own rules and, because the policy grammar requires a
  terminal catch-all as its last rule, they never decide a call themselves: they
  are evidence, appended and shown, never a silent addition to a decision. The
  two places in the TUI that said they "fill a gap the operator left open" now
  say they never bind. The guard pins this for the helper path, the
  connector path and the stdio delegation path, so the claim and the code cannot
  drift apart.
- One reviewer can be wrong once, and a lesson recorded from a wrong review is
  worse than no lesson. The harness review step can now pay for up to three
  identical reviews of the same evidence, and a proposal is recorded only when
  every one of them approves: two independent reads that disagree are evidence
  the lesson was noise, so the harness fails toward not learning. A lens that
  never answered names itself and fails the round, so the lenses after it are
  never paid for, and every reply that reports usage records its own, so the
  usage tab shows exactly what was spent. The count is the operator's dial in
  `/settings`, defaulting to the single review of before, byte for byte; the
  harness never turns it up itself.
- The harness could only learn on its own schedule. A review is armed when a
  compaction happens, and an operator who saw the mistake now had to wait for
  one, or move the conversation along until a boundary came. `/harness review`
  asks by hand: the confirmation states what will be spent and what still
  applies, an idle conversation is reviewed immediately, a running one records
  the request and serves it at the next settled boundary, and a second request
  inside the cooldown, a gate refusal or a provider that is not connected are
  each reported as themselves instead of as a review. A review still only
  proposes; nothing activates without the operator's approval.
- Two working providers could not be configured at all. An OpenAI-compatible
  endpoint that answers `/models` with 404, or with an empty list, was reported
  as having no available models even when the operator had named the model it
  serves: Puter routes named models without publishing a catalog, and the Qwen
  preset on DashScope was refused the same way when its catalog did not answer.
  When a probe says 404 or returns an empty list, the model the operator named
  now stands in for the catalog, which is the choice a catalog would have
  offered. Any other probe failure, a refused connection, a rejected
  credential, a server error or a malformed body, still reaches the operator as
  itself, so a broken endpoint is never reported as configured. The provider
  list now offers Puter and Qwen, and a DashScope key in the environment
  configures the Qwen preset on first use, the way the NVIDIA key already
  configures its own.
- The agent now learns from its own signed ledger, and what it learned shows
  up where the operator already looks. A cleanly finished turn is the only
  moment the agent may spend a model call on learning, and a cheap
  deterministic gate decides first, so an ordinary run spends nothing. When
  the gate opens, the review's output is a proposal, never authority: it is
  validated against the verified chain, every edit must cite existing
  sequence numbers from that same chain, and anything shaped like a secret
  is refused before it is recorded. A review that fails is stamped the same
  as one that succeeds, and a branch moved in between discards the result,
  so money is never spent twice on the same silence.

  Lessons mined from the chain take effect on their own, but a change to the
  agent's prompt never does. A prompt edit waits as a signed proposal on the
  ledger tab, where the exact diff and the chain sequences it rests on are
  inspectable, and `/harness approve <digest>` activates it only when the
  digest still reproduces byte for byte and every cited sequence still
  verifies. Rejection is recorded the same way, and deciding twice is a
  replay, not a second decision. The base system prompt is immutable;
  approved additions reach only later turns of the same workspace, ranked,
  bounded by a caller ceiling, and never another workspace's, and they are
  rebuilt from the signed chain after a restart rather than restored from a
  file.

  Learned rules stay pauses for a human and stay behind the operator's own
  rules: they can fill a gap the operator left open and can never override a
  deliberate choice, and nothing the model proposes can change how a
  decision is made.

  The ledger tab now also carries the measured score: hold rate and deny
  rate with confidence intervals over case counts, and a first-pass rate
  only when the chain carries an observed correction signal, because a call
  the operator allowed and then had to roll back is not a pass. Below two
  cases there is no interval, and the tab says so instead of showing a
  number nobody checked. No score changes a gate, a policy or a permission.

- Settings an operator configured before the rename kept working after it.
  Names like `NOMO_LEDGER_DIR` and `NOMO_DATA_DIR` are the current spelling,
  but a machine whose shell profile, launch agent or `.env` still says
  `VOID_LEDGER_DIR` was reading nothing at all: every setting fell back to its
  default while looking configured, which reads as data loss and loses
  nothing. The old names now answer wherever the new ones do.

  The rule is one line, and the empty case is the part that matters. A
  `NOMO_*` name that is present wins, including when its value is the empty
  string, because an operator who exported an empty value chose it and
  silently falling back would run with a setting nobody typed. Only an absent
  `NOMO_*` name falls back.

  The list of settings that alias is a list, not a scan. `PATH`, `HOME` and
  `TERM` are not ours and `VOID_HOME` was never a spelling of a variable the
  product owned, so a helper that guessed would change what the process reads.
  Settings a process passes to its own children for one call, such as the hook
  context, are deliberately excluded: each has a known writer inside a single
  run, and a second spelling would only be another name to keep in step.

  Nothing gets wider. An unknown permission mode under either spelling narrows
  to read-only exactly as it did under the new one, because the server, not the
  environment, decides what may run. `nomo config` names the spelling that is
  actually in force, so an operator whose legacy name is doing the work can see
  that it is.

  `nomo state` reports where state lives and `nomo state migrate` moves it.
  Reading is free and never writes. The migration copies to a sibling
  temporary directory, compares a SHA-256 manifest of every file against the
  source, and only then renames it into place, so the destination is either
  absent or complete. It refuses when both directories exist, because an
  operator who already migrated and re-ran the command would otherwise have
  their newest state replaced by whatever the old name still held, and there is
  no flag that overrides this. The source is never deleted, moved or written,
  so the migration has a rollback: the tree it came from.

- How an agent learns and how it is scored is now written down, read out of
  the two harnesses NOMO drives rather than assumed, together with what a NOMO
  harness of its own would add. It is a specification and nothing in it has
  been built.

  Reading the source rather than the documentation changed the plan in three
  places. One of those harnesses keeps what the agent learned in a plain file
  inside the working tree, and the other keeps its refinement history in a
  plain file beside the session, so neither can prove where a conclusion came
  from. NOMO already derives what it learns from a signed chain, which is the
  better position and was not recognised as such before this was read. One of
  them holds the only honest scoring machinery of the three, but it scores
  benchmark runs rather than safety decisions, and NOMO has no statistics at
  all. And the other gets the safety of its own learning right in a way that
  transfers directly: check the gates, then a cheap review, and only an
  approving review does any work, with a cooldown stamped by every attempt
  including the ones that fail.

  The plan splits learning in two so it can learn under a token budget.
  Reading signal out of the signed chain stays deterministic and costs nothing,
  so an ordinary run spends no extra calls on it. The model pass is paid for
  only when a gate says the trajectory holds something worth keeping, and what
  it produces is written back as a signed record rather than a loose file.

  What the document refuses to do is stated as plainly as what it would do. The
  model passes and the statistics must never reach the decision itself. A
  learned rule stays a pause for a human and stays behind the operator's own
  rules, which is what the existing rule mining already says.

- Every limit that governed a run was a literal in the code: 20 turns, 4096
  output tokens, a 32000 character prompt, a 20-deep queue, a 65536 byte
  request, a 32-call tool batch, a 5s hook timeout, and a retry loop tied to
  the free endpoint. Both agent harnesses NOMO drives expose this kind of limit
  as an operator setting, so a limit nobody can change is a limit nobody chose.
  They are now settings, keeping NOMO's own conservative defaults rather than
  either harness's.

  `/settings` lists every limit with the value in force and the range it may be
  set within; `/settings key value` sets one. The same is available over HTTP.
  A value outside its range is clamped rather than refused, both when set and
  when a stored workspace is loaded, so an edited state file cannot widen a
  limit nobody chose. A misspelled limit is refused by name instead of being
  ignored, because a silent no-op reads as a change that was applied.

  Two limits enforced in more than one place did not agree with each other. A
  conversation branch rewrote a prompt against its own hardcoded ceiling while
  the other entry points moved to the setting, so a raised limit would have
  been silently ignored there. The web interface also kept reporting the old
  prompt ceiling, so it would have refused prompts the runtime accepts. Both
  now follow the setting.

  A run can now be given a wall-clock deadline. The resulting state matters:
  a run that reaches the deadline is reported as an unproven outcome rather
  than a clean finish or a failure, so Undo and reconciliation stay available.
  A limit is only offered when something actually reads it.

  Permission mode is deliberately not a setting and remains controlled by the
  server.

- `policyProfile` on an agent profile now selects a policy. It was validated,
  stored, and then admitted exactly one value, so an agent profile could not
  run under any policy but the built-in default. A profile now names a policy
  file that already exists on disk: `default` is the built-in policy, and every
  other name is a `.yaml` file in the directory `NOMO_POLICY_PATH` points at,
  read with the same loader and decided by the same `decide` the connector path
  already used. `agents().policyProfiles` reports the names on disk rather than
  the literal `["default"]`, so the operator's own files are the catalogue and
  this runtime grows no second place to configure one.

  Nothing falls back. A name with no file, a file the validator rejects, and a
  name that is a path rather than a name are all the same answer: unresolved,
  and unresolved denies. That holds at three points, not one: creating the
  profile, starting a turn, and deciding a tool call, so a policy file that
  disappears after the profile was saved fails the turn instead of quietly
  running under a policy the operator never chose.

- The licensing decision behind the taint graph is now written down, and no
  code moved to match it. The graph builder has been Apache 2.0 since the day
  the graph landed, so it cannot be un-licensed by taking it away: anyone
  holding an earlier clone, tarball or fork keeps those rights, and the second
  amendment commits the open package to staying complete. The paid part is the
  productised surface, and it has been gated since the capability gate shipped:
  an owner without an entitlement gets `402 capability_not_included` before a
  ledger row is read, while the local command stays open because it reads a
  ledger the operator already holds on disk.

  The amendment also answers the paid list entry by entry, which is what the
  first disclosure lacked, and the first of those three is now executed. The
  Slack approval channel moved out of the Apache 2.0 policy package into the
  closed paid package, so §5 amendment one's collision is closed rather than
  recorded: the channel interface stayed open, as the amendment requires, and a
  gate now fails if the implementation is put back in an open package. Two
  items on the list are still paid by name and shipped open. Irreversibility
  budgets are accounting inside Apache 2.0 code, and gating them would be a
  feature flag in open source rather than a boundary the licence can hold.
  Retention beyond seven days has no seven-day bound anywhere in the code at
  all. The rest of the list is absent rather than leaked, and the amendment
  says which is which so the next reader does not re-derive it.

- A missing ledger is now named as the thing the operator passed. `void verify`,
  `void export`, `void attest` and `nomo metrics` resolve the ledger through one
  helper, which returns a result rather than letting `fs.stat` raise: a readable
  but empty directory is answered with that directory, a path that does not
  exist says so, a path the filesystem refuses says so, and a directory holding
  other workspaces names the workspace that was wanted. Previously all four
  arrived as `ENOENT ... /<dir>/default.jsonl`, a file the caller never named
  and may not have.

  `nomo metrics` exits non-zero when it cannot measure and prints nothing to
  stdout, so a probe cannot record a healthy pipeline while no counter was
  counted. An empty directory is still a measurement and still exits zero: that
  is a report of zeroes, which is what it means.

  The standalone verifier takes a directory: one bundle inside it is read and
  the file read is echoed on stdout, an empty one says it is empty, several say
  it will not guess, and a malformed bundle is still reported as malformed. It
  still imports nothing that would need installing.

  `nomo recovery` no longer answers `Invalid recovery configuration.` It names
  every reason, distinguishes an adapter this executor does not read from a
  field that is malformed, and points a filesystem-shaped config at
  `nomo recovery conformance`, which does run `filesystem.managed`.
  `nomo recovery doctor --config <file>` is new: it prints every field the
  command reads, every required field it did not find and every field it
  ignores, with their source and never a secret, and exits 1 when the
  configuration is unusable.

- Billing is wired to Polar as merchant of record, on the server only. A signed
  delivery is verified against the exact bytes Polar sent and writes one
  subscription document into the account's own namespace, and a signed-in
  caller can read their own state at `GET /api/billing`. The browser never
  holds a Polar credential, a webhook secret or a customer id, and the content
  security policy is unchanged: the chat origin still talks only to itself.

  Verification is delegated to Polar's own SDK rather than reimplemented,
  because the SDK derives two candidate keys from one secret and a
  spec-derived implementation does not match Polar's. The webhook answers
  before sign-in and before the body is re-parsed, because a delivery carries
  no session and a re-parsed body is not the body that was signed. Each
  delivery's id is recorded in the same transaction that applies it, so a
  retried delivery applies once and two deliveries in flight at once cannot
  both apply.

  A signature that does not verify is refused. A correctly signed event type
  this deployment has not heard of is accepted and recorded, because telling
  Polar to redeliver a valid event forever is not a decision any deployment
  gets to make. A subscription for a customer nobody has linked is recorded
  and ignored, for the same reason.

  At the time this shipped, what the entitlement gated was nothing: none of the
  paid capabilities had an enforcement point yet. The gate added below is that
  enforcement point for the taint graph, and only the taint graph.
  The capability answer a browser receives for everything else is unchanged,
  and the open workbench surface is untouched.
  Checkout, a customer portal, usage metering and seats are not part of this,
  and none of it has been run against a live Polar account.

- The capability gate now gates the taint graph, and it does not gate
  retention. `GET /api/capabilities` answers `taintGraph: false` for an owner
  who is not subscribed and `true` for one who is, the paid route answers `402`
  without reading a ledger row, and the overlay can only ever take a capability
  away, so a billing read that fails fails the capability off rather than the
  whole surface open.

  Section 5 lists "retention beyond seven days" as paid, and the tree was
  recorded as having nothing to gate for it. That record was wrong, and this
  corrects it. Time-based retention does exist: the file recovery vault
  compares an operator-selected TTL in milliseconds against each artifact's
  mtime, and it ships with no ceiling and a default that never collects
  anything at all. Free retention is therefore already unbounded and already
  open, which makes a seven-day cap the removal of a shipped capability rather
  than the withholding of an absent one. Section 5's own hard rule is that a
  feature never moves from open to paid, and its own operational rule answers
  the same way: a developer protecting one database needs the before-image that
  undoes a bad migration found a month later, which is the artifact a seven
  day cap deletes. The signed ledger and the recovery journal were ruled out as
  the surface for the same question: both are append-only by construction, so
  an age is not representable on either without dismantling the guarantee
  first.

  Three checks in the codebase pin this so it cannot be reversed quietly.
  Each was confirmed by breaking the property it names and watching it fail:
  adding `retention` to the paid list, capping the time limit at seven days,
  making the shipped default collect implicitly, and giving `LedgerStore` a
  `delete` each break exactly the check that forbids that change.

- `void classify --tool <id>` answers the one-call question the transcript form
  could not: what does this single entry decide for this single tool, given
  these facts and these arguments. `--facts <file>` supplies a verified facts
  file, `--fact k=v` overrides it for that call, and `--args <json>` supplies
  the intercepted arguments, so a `versionId` on an object delete reclassifies
  the same tool from a recoverable marker to permanent destruction. The answer
  comes from the same evaluator an intercepted call goes through, not a second
  one, so a tone checked by hand is the tone a call receives.

  The output says which inputs it had. With no declared facts the evaluator
  can only reach an entry's terminal case, so the `tone:` line alone would
  read as a reading of your account when it is the fail-closed posture; the
  `facts:` line names which it is, and the registry disclaimer travels with
  every verdict. An unknown tool is a named outcome and exits 2 rather than
  being given a guessed class, and a mistyped flag is refused instead of
  quietly reading as a classification you did not ask for. `--fact` values are
  the literal text the registry compares against, because every declared value
  in the registry is a string and a boolean read would match no case while
  appearing to have been measured.

- `void update` updates a local install in place, and an installer script puts
  `void` on your PATH as a checkout you own, with no global package manager
  and no account. The installer checks for Node.js 24 or newer, git and pnpm,
  puts the tree at `$HOME/.local/share/void-cli` (override with `NOMO_HOME`),
  installs from the shipped lockfile, and writes a launcher at
  `$HOME/.local/bin/void`. It does not edit your PATH: add that directory
  yourself and open a new terminal. The repository is private, so the first
  clone needs credentials the machine already has, and it refuses to
  overwrite a launcher it did not write. `void update` fetches and moves the
  checkout forward, `void update --check` reports whether anything is new
  without moving the tree and exits 3 when an update is available, and
  `void update --force` allows a move that is not a fast-forward. Nothing
  local is thrown away: a modified file or a local commit stops the update
  and says which one, so an update can never eat work in progress. When the
  install is missing or is not a NOMO checkout the command refuses and names
  the way out rather than guessing. Your ledger, workspace data and pending
  approvals live outside the checkout and are never touched by an update. To
  go back, move the tree onto the commit you want and reinstall from the
  lockfile.
- Cloud recovery planning now accepts a journal checkpoint in addition to one
  exact run or an explicit operation list. Naming a checkpoint restores
  everything up to that point in the journal after the usual digest-bound
  approval, and the signed plan still records the exact steps it undoes.
  Planning the same job ID a second time with a checkpoint is refused, so a
  fresh look needs a new job ID. Dependency and time selection remain
  unavailable on the cloud surface.

- A recovery chain stopped at the first step of anything but two writes to one
  path. Creating, renaming and deleting the same file in one run reported
  `conflict` on a path nobody had touched, because a missing file was
  identified by its directory's timestamp: restoring one step changed that
  timestamp, which invalidated every later step that expected the file to be
  missing, so the chain could never finish. A missing file is now identified by
  its directory alone, and creating one still refuses to overwrite a file that
  appeared in between. A create, write, write, rename and delete journey on one
  file now restores completely after restart; an edit made between two steps
  still conflicts and is left intact.

- Recovery jobs now carry runtime-derived lineage between adjacent inverses on
  the same resource. Two consecutive writes to one filesystem path restore the
  original bytes and mode after restart while a same-byte external rewrite
  still conflicts; a managed PostgreSQL job likewise restores consecutive
  updates to one configured row and reconciles a lost response without
  repeating the inverse. The continuation is bound to the signed job plan,
  prior operation receipt, adapter and resource scope; it does not widen
  standalone recovery or unrelated operations.
- A recovery job that takes over an expired lease now records `supersededBy`
  in the signed pause. The displaced pause remains visible after restart but no
  longer blocks later safe recovery jobs. Ordinary unavailable-step pauses
  still block. MCP server requests also retain their original string or numeric
  IDs when concurrent success and error replies return through `runProxy`.
- The agent conversation's `requestDigest` did not see the conversation. Each
  turn hashed only the messages added since the previous turn plus a bare
  message count, so two conversations that reached the same tail through
  different histories produced the same value, and the code comment claiming
  the prefix was already inside the previous digest's input described a value
  nothing read. Every turn now folds in the previous turn's digest under a
  versioned domain separator, so a difference anywhere reaches every later
  value while the per-turn cost stays proportional to what the turn added. A
  recorded digest is opaque and still verifies, so no historical record is
  rewritten; the shipped function is now called directly instead of through a
  copy of it, which is how the two drifted apart.
- The ledger file was created without a mode, so on a host running umask 022
  every workspace JSONL was world-readable while the module documented itself
  as 0600 and `DECISIONS.md` recorded 0600 as the decision. The file is now
  created owner-only, and a ledger an earlier build left broad is refused with
  the mode it actually has rather than silently narrowed: the bytes were
  readable by another user before the call, and an operator who never sees a
  refusal has no way to learn that. Both umask 022 and 077 are covered, as is
  the file an earlier build left at 0644; Windows ACL behaviour is unchanged and
  is not claimed.
- An answer to a server-originated MCP request was forwarded upstream under
  the agent's own request id. The relay read its id map off the session object,
  where the map lives under `maps`, so the lookup found nothing and returned
  the agent id unchanged: the upstream saw a response to an id it never issued
  and its own question went unanswered. The relay now takes the map directly,
  so the shape that compiles is the shape that carries the mapping, and a
  `runProxy` fixture with a real server request asserts the reply reaches the
  server under the id the server chose.
- A worker that took over a recovery job whose lease had expired could not
  record the takeover. The `paused` payload it wrote named only the progress
  and the reason, and carried a `lease-expired` code the payload validator did
  not accept, so the write was refused with `Invalid recovery job progress
payload` and the takeover failed instead of being recorded. The payload now
  carries the job ID, the status and the operation ID the validator reads back,
  and `lease-expired` joins `step-unavailable` as the second closed pause code.
  The journal is verified and replayed as a whole, so a code the validator
  rejects would take the entire workspace down, not only the job it belongs to.
- The evidence behind a managed Git commit was checked against values taken
  from the same prepared document it was supposed to check: the parent tree,
  the parent entry of the selected path and the recorded manifest digests all
  came out of that document and were compared with each other. Verification now
  re-reads the recorded parent's commit and tree from the object store, rebuilds
  the expected manifest from that tree and the selected index entry, and
  requires the captured values and both recorded digests to equal the
  re-derivation, so a document edited after dispatch can no longer corroborate
  itself on the recovery path. Object connectivity is one `git fsck
--connectivity-only` over the parent and the receipt commit instead of one
  `cat-file` per file, which also covers the parent after its branch is gone.
- `void_project_info` now answers with where it is being served from and a
  pasteable client configuration, because a caller connecting for the first time
  needs the address before it needs anything else. Both come from the operator's
  `NOMO_MCP_ENDPOINT` rather than from the source, since the domain is expected
  to change and a value written into the code answers the wrong one the moment
  it does. An undeclared endpoint reports itself undeclared instead of emitting
  a configuration with an empty URL, which looks pasteable and fails on use.
- Every precondition in the hosted registry now carries the gate the registry
  holds beside it: 491 of 491 cases publish a structured `if` alongside the
  prose, where 445 previously published nothing and did not know they were
  missing any. A caller holding a Stripe account can evaluate
  `{"kind": "fact", "fact": "stripe.charge.settled", "is": "true"}` instead of
  parsing a sentence, and a conjunction publishes its children rather than a
  gate that can never be true. The parser was reading the fields around the
  gate and matching none of them, because the source quotes its keys.
- A deployed hosted MCP served an **empty CLI command list and an empty local
  tool catalogue**. The registry read its fallback, because it had one; the
  other two readers did not, and in production there is no source tree to read
  from, so `void_cli_commands` and `void_local_tools` answered with nothing
  while nothing in the repository noticed. Every reader now falls back to the
  snapshot, the deployed tarball is extracted somewhere with no repository in it
  and asked the same questions before a build can pass, and a reader pointed at
  a missing snapshot returns empty instead of raising, so a deployed function
  answers an honest nothing rather than no answer at all.
- A restore that the bucket refused for lack of permission was reported as
  `internal_error` when the refusal came from the `PUT` and as
  `permission_denied` when it came from anywhere else: the same bucket
  refusing the same write, classified two ways depending on which frame caught
  it. One helper now applies both status shapes (the AWS SDK's `$metadata` and
  a bare `statusCode` from a proxy) at both sites, because a refusal reason is
  what tells an operator whether to fix credentials or go looking for a fault.
- The hosted NOMO MCP now publishes six tools over the reversibility
  registry, and every fact it publishes is read out of the source tree rather
  than written by hand. The previous build carried a literal list of eight
  recovery tool names that nothing compared against the CLI, so it would have
  kept publishing names which no longer existed without anybody noticing. A
  deployed Appwrite function receives a tarball and not a checkout, so the
  facts travel in a generated snapshot that is checked against the source it
  was generated from, and a snapshot that drifts fails the build rather than
  being served. Measured from the live tree: 268 operations, 491 preconditions
  across 48 vendors and 170 surfaces, published one row per precondition
  because an S3 PUT is reversible on a versioned bucket and permanent on an
  unversioned one, and one class per operation would be wrong half the time.
- The Appwrite control plane now carries the registry as data:
  `registry_operations`, `registry_cases` and `mcp_tools`, all with row and
  document security on and no row-level permissions, so a browser cannot read
  a catalogue that is published by the function. Provisioning and seeding are
  both idempotent and both refuse to run against a parse that produced nothing.
  A signed ledger is deliberately **not** published: its value is that it is
  signed and append-only, and a hosted unsigned copy would be a second thing
  for a reader to argue about.
- A hosted-mcp CI job now exists. Until it did, nothing on a remote commit had
  ever checked the hosted function's behaviour or confirmed that the snapshot
  it deploys still matches the repository it was generated from.
- 52 hand-written `44px` and `28px` hit targets in the control-plane stylesheet
  now read the tokens the design document already publishes. Each token holds
  the identical value, so nothing about the rendered surface changes.

- The hosted reference endpoint answers a real MCP handshake now, offline,
  against a fake Appwrite function context, so the adapter is exercised
  rather than assumed. A handshake, the tool catalogue, a tool call, a
  refused unknown tool, a malformed body, a plain GET and every branch of the
  bearer-token boundary are all covered. What this proves is the code path and
  not the deployment: the only thing standing between this repository and a
  working hosted endpoint is the domain a person adds in the console. The
  registry manifest now names the server it publishes, and a required field
  missing from it fails rather than shipping.
- Every surface now takes its values from one machine-readable file, and the
  value it used to invent is gone. `design-tokens.json` carries the type ramp,
  the 4 point spacing rhythm, the semantic colour roles, the radius scale
  and the control sizes, quoted from the Human Interface Guidelines the
  design system cites, and two generators write it out: one replaces the
  marked region of `styles.css` before the Vite build, and one writes
  `VoidTokens.generated.swift` for the Swift module. Either generated file is
  a build artefact: a hand edit in one is overwritten, and because both
  regions are compared against a fresh render, that edit is caught rather
  than kept, because a value with two homes is a value that drifts. The web
  control plane now paints the platform palette rather than the warm paper
  one: a white or black canvas, the system surface greys, the platform
  accent and the platform red and green, in both appearances, at the design
  system's 15 pixel body size, measured at 1440 and at 320 pixels. A
  contrast check recomputes all thirty pairings the token document declares,
  in both appearances, and fails on one below its stated minimum, so a
  colour claim is a measurement and not a comment. The one value it forced
  is the light green: the platform green measures 2.2:1 on white, so the
  role carries the platform hue darkened until it clears 4.5:1 on both the
  canvas and the surface with a margin worth having. What is not done: the
  components still use the old spacing, radius and font values. Adopting
  the new tokens, removing the override layer between `styles.css`,
  `ascii.css` and `mobile.css`, and dropping the font imports the components
  still name are the web rebuild, and none of it has happened yet.
- NOMO now has a shared design system package for the Apple surfaces, and the
  theme on iOS has a place to import from. `VoidDesignSystem` is a Swift
  package for iOS 17 and macOS 14 that exposes the tokens through the
  platform's own semantic types and imports neither UIKit nor AppKit, so the
  same values can reach a macOS client without needing a second copy. What is
  not done: there is no macOS client. The package makes one possible later,
  and nothing in this repository is an app yet. `CompanionProtocolKit` now
  declares macOS alongside iOS, and its 58 host cases still hold on both. 31
  checks in the package cover the contrast pairs, the spacing rhythm, the
  radii, the control floors and the type roles.
- The record stopped contradicting itself in three places that a person
  reading it would have hit within a minute. `GUI-RULES.md` stacked three
  visual directions by date, named a colour and a font in each, and named a
  default model provider that `DECISIONS.md` had already removed; it is now
  a pointer to the design system that carries the surviving operational
  rules and names no value at all. `STANDARDS.md` required monospace for
  every label while the same file forbade it; the narrower rule is now the
  one both files state. The roadmap asked for the three status ledgers to be
  collapsed into one, which `DECISIONS.md` refused on 2026-09-26; the
  roadmap row is marked refused with its authority rather than quietly
  deleted, and a dated errata section records the corrections with the
  command that measures each one. The registry breadth claim is now true in
  the documents that make it: 268 entries and 48 vendors, measured, and
  pinned by a check in the registry package that replaced a tautology
  asserting nothing. Two claims the audit could not settle are now settled
  by the tree: the capability schema carries a dated certification decision
  on every shipped profile, so the release gate has somewhere to record the
  answer that `certification: false` is permanent, and the matrix rows
  `D04.09` and `D04.13` are corrected against the 2026-09-28 decision that
  answers them. The documentation gate gained the three assertions that stop
  all of this from returning.

- An MCP server is now something you agree to rather than something that
  happens to you. Adding one used to contact it immediately: `addConnector`
  fetched the tool catalogue as a side effect of a local write, so a server
  added by a restored workspace, a config file or a mistake was already
  trusted before anybody read a line of it, and an edit re-probed the server
  whether or not you wanted it to. A connector now starts `staged`, with a
  name, a URL and a policy and no tools, and adding, editing, loading and
  removing it send nothing at all. `probe` is the single outbound request, it
  is reached only from an explicit command, and it opens a confirmation that
  names the exact host; a failed probe writes nothing and the connector stays
  staged with an empty catalogue. `confirm` accepts only a probed catalogue,
  and only a confirmed connector gives a new conversation tools, so the tools
  a model can call are always ones you have seen. An edit or a rename returns
  the connector to staged and drops the catalogue. A running conversation
  keeps the tools and the policy it started with. A workspace written before
  this gate carries no consent state at all and loads as staged, which leaves
  an existing connector inert until it is probed and confirmed again; that is
  deliberate, because a server nobody confirmed is one nobody has read. The
  TUI grows a real `/mcp` view with list, inspect, add, probe, confirm, rename
  and remove, and `/connector-file` stopped claiming a server was connected
  when all it did was write a record. `/mcp inspect` also answers what the
  policy would do to every tool the connector lists: the registry
  classification, the mapped id, the decision and the rule behind it, and the
  blast radius, which is reported as unknown rather than guessed, because only
  a measured probe produces one. A tool the registry cannot classify is shown
  as denied, which is what a conversation does with it, and a tool the provider
  invents is refused before the connector is contacted at all.
- A sign in now lasts as long as it says it does. The account cookie sealed a
  thirty day expiry and the middleware asked the provider who the access token
  in it belonged to on every request, but nothing ever renewed that token, so
  the real lifetime was the provider's access token, about an hour by default,
  and a person was signed out roughly an hour after signing in while the
  cookie went on claiming thirty days. A token that is at its end, or that the
  provider stops vouching for sooner than it said, is now traded for a new one
  with the refresh token already sealed in the cookie, and the renewal comes
  back as the same HttpOnly cookie, so the browser still never holds a provider
  token and `connect-src 'self'` is unchanged. The thirty days is now a window
  the code honours rather than a claim it does not: it is fixed at the sign in,
  a refresh does not slide it, the `Max-Age` on the cookie is computed from
  that same date so a renewed cookie never advertises more time than the
  session has, and a session past its own end is refused before the provider
  is asked anything. What actually ends a session early is the provider: a
  refresh it refuses ends the session and clears the cookie rather than
  falling back to a stale credential, and signing out revokes the refresh token
  at the provider, which is what ends the same session on another device. To
  make that revocation count, signing out renews a spent credential first,
  because a logout sent with an expired bearer is refused and revokes nothing.

- The chat origin now has a sign in screen, and the account broker finally has
  a route of its own. Previously the broker could only resolve a cookie that
  already existed, so a person could hold an account and have no way to become
  signed in. `GET /api/account` reports whether this deployment has accounts and
  whether the caller has a session, `POST /api/account/signin` exchanges an
  email and a password for a sealed HttpOnly cookie, and `DELETE /api/account`
  revokes and clears. All three answer before an owner is resolved, because a
  caller with no credential yet is who they are for, and all three sit below
  the origin checks, so a cross-site sign in is still refused. Password is the
  only way in: no magic link, no registration, no reset and no social sign in
  is offered, because the broker will not complete any of them. The screen says
  plainly which credential it wants, because the workspace access token and a
  person's account are not the same thing and pasting one into the other is the
  obvious mistake. A failure is rendered from a code in this repository's own
  words and never from a provider's message, so no refusal can name whether an
  address holds an account. Nothing in the browser talks to the provider:
  `connect-src 'self'` is unchanged, and the screen ships in the one shared
  bundle rather than a lazy chunk, because the surface a person reaches when
  they cannot get in is the worst place for a chunk to still be loading.
  Accounts stay unenabled: with no Supabase project configured these routes
  report that they are unconfigured and the workspace access token gate is
  exactly what it was.

- The hosted cloud workspace is now scoped by an owner. Every row in
  `void_cloud_state`, `void_cloud_ledger` and `void_cloud_events` carries the
  verified identity it belongs to, and that identity is the first column of
  every primary key, so two accounts cannot address each other's rows even by
  the same session identifier. Every statement in the cloud data layer carries
  the owner as a bound parameter, and a missing owner fails closed rather than
  exposing shared data. The owner is resolved once, in
  the session middleware, from a verified session and from nowhere else: a
  header, a query parameter or a body field is not a source. The operator's
  access token keeps working and now resolves to one reserved owner, `operator`,
  which sees its own rows and nothing else; there is no token that reads every
  account. The public demo is still open with no credential and is still its own
  surface, but its rows are owned too, as `public-demo`, so an open endpoint is
  no longer a window into somebody else's namespace. Accounts are not enabled:
  signup is refused, and the switch is `NOMO_ACCOUNT_SIGNUP`. An existing
  database is moved to the new shape by `cloud/0001-account-ownership.sql`,
  which is additive, runs cleanly more than once, and lifts the append-only
  trigger for exactly the backfill that trigger would otherwise refuse. Run it
  before deploying a build that carries this change, once, with the deploy
  paused.

- NOMO no longer ships a default provider or a default model. `providerId` and
  `defaultModel` are `null` in a workspace with nothing configured, the provider
  panel says no provider is connected instead of naming a vendor, and the first
  conversation asks which model to use from the catalog the connected provider
  returns. This is a behaviour change: a workspace that relied on the old
  `nvidia` / `z-ai/glm-5.3-flash` default now has to connect a provider and
  choose a model, or set `NVIDIA_API_KEY` and pick from NVIDIA's own catalog. The
  presets are untouched, because offering a choice is not the same as choosing
  for the operator, and the three endpoint constants stay exported. A retired
  model id left in an old workspace is re-picked from that workspace's own
  validated catalog, or dropped when there is none. The retry guard that keeps a
  paid model from being retried no longer identifies the free model by a global
  constant: each free endpoint names the model it serves, so a paid model, and
  any model the operator typed that is in no table, is still dispatched once and
  never retried. The public demo has no operator to ask, so it names its own
  model in one place and reports it on `/api/demo/status`; that is the demo
  choosing a configuration, not the product having a default.
- Companion pairing now requires a host-minted invitation, and this is a
  behaviour change for anyone pairing a device. `POST
/api/companion/invitations` mints one; the invitation expires after 120
  seconds, is accepted exactly once, and can only be minted by the loopback
  host operator, never by a device that already holds a credential. Pairing
  without one is refused. The spend is a single exclusive create rather than a
  read-modify-write, so two devices racing the same invitation produce one
  device and one named loser rather than two. A workspace that is already at
  its device limit is told so before the invitation is spent, so a request that
  could never have paired does not consume the operator's authority to pair.
  The frozen `void.companion.v1` contract is unchanged: this is host admission
  control around the existing route, so no handshake capability was added and
  no existing validator can start failing.
- iOS: nothing the executor answers is stored on the device. The URL cache,
  cookie store and credential store are emptied and detached for every session
  the client builds, and the process-wide shared caches are purged as well. A
  transcript is in memory for that process only, is stamped non-authoritative
  by a stored constant no decoder can change, and is bounded at 200 entries;
  it exposes a list and nothing else, so it cannot answer whether an operation
  is running or reversible. A new mutation cannot be computed from it, because
  the idempotency key comes from a turn sequence the cache has no way to
  produce. The device token is stored in the Keychain and nowhere else, and
  the credential type redacts itself from `print`, interpolation, crash
  reports and the debugger. Removing this device now revokes on the executor
  first and deletes the Keychain credential second, and it says which happened:
  removed, removed locally only because the executor was unreachable, or
  failed. The policy is written down in the operator documentation and shown in
  Settings in both languages.
- Evidence: the managed PostgreSQL adapter and the Git commit lifecycle are
  now published capability profiles, so the release gate can no longer ship
  either of them unnamed. `nomo recovery conformance --adapter
postgres-managed-conformance` runs five scenarios over an in-process
  database, including a real cascade subtree and a row-level tenant scope
  executed as an unprivileged role; `--adapter git.managed` runs seven,
  including the commit lifecycle and its durable receipts. The profiles state
  that the durable-receipt guarantee covers the commit operation and not the
  worktree and index actions, which still reconcile to unknown because state
  equality is ABA-unsafe.

- Operator guide: there is now one entry point for using NOMO. A new
  handbook, with a Czech edition beside it, was written from the product
  rather than from the other documents: every command, TUI tab, slash
  command, GUI route, composer command, policy key and MCP tool was read out of
  the source first. It leads with what NOMO does not do, because a guide that
  overstates the product is worse than no guide. It is a gate rather than
  prose: `scripts/src/handbook.test.mjs` fails the build when the guide names a
  command, script or path the product does not have, when it omits a command
  the binary accepts, when the provider and model it calls the default are not
  the ones the code declares, or when the two editions document different
  command sets.
- Distribution: the standalone ledger verifier is now its own installable
  package, `@void/verifier`, with a `void-verify` binary, zero dependencies of
  any kind, no import from this repository and no build step. It moved out of
  `scripts/src` rather than being copied, because its own header calls drift
  between it and the ledger a defect and a second copy would have been exactly
  that. Its README commits in writing to keeping both properties: a verifier
  that pulls in a dependency tree inherits that tree's supply chain, which is
  the thing an audit is supposed to be independent of. The rest of the open
  core is still `private: true`, deliberately, because twelve of those packages
  export TypeScript source with no build step and publishing them would ship
  something Node cannot run; `scripts/src/licence-line.test.mjs` now refuses any
  package that is publishable without a way to produce its files, so the flag
  cannot be flipped on its own.
- Licence: the boundary between the open core and the paid side is written down
  rather than implied. `CONTRIBUTING.md` asks for a Developer Certificate of
  Origin sign-off and no CLA, states that registry data is the easiest valuable
  contribution while connector work needs prior agreement and a feature needs a
  described use case, and records the maintenance bound honestly: one person,
  issues are read, no response time is promised. `apps/control-plane/LICENSE`
  marks the paid and closed side, because one root licence cannot describe a
  repository that deliberately contains both. The README now carries the
  licence, the open and paid split, the rule that nothing moves from open to
  paid, and the tamper-evident rather than tamper-proof limitation where a
  reader meets it.
- Gates: three checks were added, each written after the drift it catches
  actually shipped. Documentation that names a file that does not exist now
  fails (`scripts/src/doc-truth.test.mjs`), a component that grows a colour
  literal or an unprefixed keyframe now fails
  (`scripts/src/design-token.test.mjs`), and a package that claims to be
  publishable without a way to produce its files now fails
  (`scripts/src/licence-line.test.mjs`).
- CI: the pipeline runs its checks before the build. The build had sat first for
  long enough that a build regression made seventeen consecutive runs report
  failure while executing zero unit checks and zero end-to-end scripts, so a red
  pipeline said nothing about whether the product worked. Each step now carries
  its own explicit time budget rather than sharing one deadline, which is what
  let a killed `git.managed` conformance run once look green.

- Desktop: a refused macOS keychain read is no longer reported as a missing
  key. A key that exists but cannot be opened, because the access was denied
  or the user cancelled, is now told apart from a key that was never created,
  and a refused read prints fixed operator guidance instead of exiting with
  `Cannot unlock the NOMO workspace key in macOS Keychain`. Collapsing the two
  cases would have let a fresh key be minted over an existing encrypted
  workspace.
- Mac desktop builds no longer default to an ad-hoc signature. The signing
  identity is now resolved in three observable steps: the operator's own
  `APPLE_SIGNING_IDENTITY`, then a stable identity already present in the
  keychain, discovered read-only, then ad-hoc as a last resort that warns with
  the consequence spelled out. A notarised run refuses ad-hoc outright. This
  removes the failure where a rebuild lost access to the app's own workspace
  key, which macOS ends with no remedy because the encrypted data has no other
  key.
- Evidence: every ledger record now carries which policy decided it and which
  rule fired, so a decision can be re-derived rather than only observed. An
  allowed call names its authorizing rule too, which it previously did not
  record at all, and that is the record that most needs it. Ledgers written
  before this keep verifying and are described as carrying no reason, which is
  kept distinct from a reason that is malformed; a malformed one fails the
  chain instead of passing quietly. No migration was needed, because the
  record body was already opaque to the hash.
- Evidence: every verification surface now says what a signature actually
  establishes. A chain signature proves the bytes came from a process holding
  a particular key and that the chain is internally consistent; it does not
  prove nobody rewrote the history, because in every shipped topology the
  recorder, the signer and the verifier are one principal. The headline states
  integrity alongside the claim instead of leaving a bare `verified` to be read
  as tamper-evidence it is not.
- Evidence: verification no longer reads a private key to decide what a valid
  signature means. The trusted public half is pinned separately, and a
  substituted key is now rejected instead of accepted. Signed anchors for the
  ledger head gain a real command path, so a shortened history is caught. The
  honest boundary is unchanged and now stated plainly: this detects tampering
  by a third party, not by the agent itself, and the status surfaces say which
  key was used rather than only that a signature verified.
- Web chat: stopping a run now settles the last answer instead of leaving it
  permanently marked as arriving with its copy, branch and retry controls
  suppressed. A draft and its attachments are now saved and restored together,
  so navigating back can no longer restore attachments against an empty draft
  and send a different message than the one on screen. Scrolling up mid-stream
  is respected, the composer budget is measured from the real composer height,
  and the visible size counter and the send guard read one limit rather than two
  copies of it.
- Web chat: the permission banner no longer claims the server mode is
  unavailable on every page load while the mode is still being fetched, and a
  read-only session is styled as distinctly not granted rather than as
  settled. The mode control is no longer rendered as a group of unselectable
  options; where no setter exists, the mode is shown as text.
- iOS: the app declares its supported orientations and a launch screen, so
  UIKit no longer warns about both on every build. The entry title resolves
  correctly on a regular width layout, and a table or code block below the fold
  is laid out and reachable rather than filled in only on scroll.
- CLI: `void watch --ledger` now accepts a ledger directory and resolves it to
  that workspace's ledger file, matching what the sibling commands read. A path
  that is already a file is still taken as given, and a path that does not
  exist yet is left alone rather than silently rewritten.
- QA harness: the workspace preview now passes the caller's environment
  through to the control plane instead of a two-value object. A permission mode
  chosen by the operator was being dropped on the way in, so the preview always
  served read-only and the document write path looked broken rather than never
  enabled. The disposable preview data directories still override.
- iOS: the app no longer triggers the UIKit App Config warnings about
  orientation support and launch screens. The orientation and launch-screen
  declarations are now build settings rather than missing, and the version keys
  follow the project's own version and build number instead of hardcoded text.
- iOS: the iPad contrast check no longer fails on a missing entry title. At
  regular width the entry title lives in the navigation bar rather than the
  scroll view, so the check now looks there as well. The AA contrast
  requirement is unchanged and still measures rendered pixels.
- Runtime: the budget crash-consistency check no longer depends on the wall
  clock. It derived its clock from the current time plus an hour, so between
  23:00 and 00:00 UTC the snapshot crossed a UTC day boundary, the reservation
  was correctly filtered out as belonging to the previous day, and the check
  failed every night for an hour while passing the rest of the day. The worker
  and the inspecting ledger now share one fixed instant. The budget behaviour
  itself is unchanged and correct.

- Add a live ledger TUI with keyboard inspection and signature checks.
- Refine the GUI with shared Apple-inspired styling, call search and details.
- Bring TUI management closer to Claude Code: fuzzy slash commands, status,
  cost, resume, rewind with auto-selected recoverable operation, control-key
  shortcuts, a real usage status line, and unified diff review.
- Add read-only `void doctor`, `void config`, `void init`, and `void --version`
  commands, each reused by matching TUI slash commands.
- Show the real provider token report in GUI chat, open reviewed branches with
  Arrow Up, and expose class, blast radius, and policy rationale in approvals.
- Consolidate the remaining-work list and clarify release requirements for
  Apple signing and notarization, Linux packaging, production key management,
  physical mobile keyboards, screen readers, and 200% browser zoom.
- Clarify that Node 26 is supported locally, not as the Vercel runtime.

### Security fixes

- Authenticate existing SDK ledger signatures before starting an upstream.

- Prevent agent-provided row counts from satisfying measured-radius policy rules.
- Reject malformed policies without crashing or echoing YAML source.
- Reject hostile browser origins and DNS rebinding against the local control plane.
- Distinguish signature verification from hash integrity in the ledger feed.
- Include the control plane and script suites in the standard workspace check.
- Hold every non-read-only cloud tool call, including built-in managed-document
  writes. The cloud agent previously short-circuited built-in tools to `allow`,
  so an r1 `void_workspace_write` or `void_workspace_delete` ran with no human
  in the loop while the signed journal recorded the agent itself as the
  approver. The cloud recovery sink also passed an unconditional authorize
  callback to the runtime, which forged an `authorized` stage nobody granted.
  Both now fail closed against an explicit allowlist of authorizing surfaces.
- Refuse a branch document snapshot when the server permission mode forbids
  document editing. `POST /api/sessions/:id/branches` with
  `snapshotDocuments: true` performed durable managed-document writes while
  `/api/capabilities` advertised `documentEditing: false`.
- Name the two permission-mode defaults. A local operator surface and the
  remote-facing control plane resolve an absent `NOMO_PERMISSION_MODE`
  differently on purpose; both are now named constants with a check instead of
  two unrelated literals that had drifted apart unnoticed.
- Serve the frozen `void.companion.v1` outcome vocabulary from
  `operation.status`, and refuse a stored record carrying any other value.
- Require a per-hold possession token for a cloud approval decision. The hold
  identifier is derived from public session counters, so guessing one was
  enough to decide someone else's hold; the decision now also has to present
  the unguessable token minted with the hold, as the local approval broker
  already required.
- Give the web composer textarea a visible keyboard focus ring. `.composer
textarea { outline: none }` outranked `:focus-visible`, and the halo painted
  the canvas colour on the canvas colour, so a keyboard user had no visible
  focus indicator at all.
- Return focus to the composer after a run is stopped. Pressing Stop unmounted
  the focused button and dropped focus to the document body.

### Added

- Add the three companion transport operations the release matrix recorded as
  having no server route: `operation.status`, `device.revoke` and
  `diagnostics.read`, plus a minimal device pairing model. Paired devices are
  read-only by default, are scoped to one workspace, and can never see or
  revoke another device. Diagnostics are an allowlisted, redacted projection
  capped at 100 entries; no host path, raw log line or credential shape is
  reachable through it.
- Add a single-endpoint companion envelope adapter so the Apple client can
  round-trip the protocol it was written against, and add `device.pair` to the
  client catalog as a separate request type.
- Add a standard-library Python client for the NOMO proxy wire, closing the
  transport-client half of the R12 milestone. It has no third-party
  dependency, refuses a mismatched response identity, an oversized body, an
  unknown shape and a mutating call without an idempotency key, and never
  retries silently. Its canonical JSON is checked byte-for-byte against the
  repository's own canonical-JSON implementation running under Node.
- Remove the unreachable pairing alert from the iOS companion entry screen. Its
  button is disabled in every state of this build, so the dialog that confirmed
  the same sentence already on screen could never open.
- R03: add file recovery vault retention and collection. The shipped default
  policy is manual, so nothing is collected implicitly; a pinned artifact is
  never evicted and a policy that gives a pinned kind an expiry is refused;
  unreadable evidence refuses the whole run before any delete; and every run
  lands as a signed `vault.retention` journal chain, so a delete is never
  silent. Not certified, and it does not cover the reserved SQLite vault.
- G06: publish a versioned, per-provider machine-readable capability profile
  and require it in the release gate. `void.adapter-capability.v2` states
  `authority: "scope-only"`, names the conformance runtime each provider ran
  against, and refuses unknown fields, a retired `v1` report, and a bare
  `certification: true` presented as evidence. An adapter with no published
  profile is refused, not skipped. Every profile stays `certification: false`.
- R14: add an export bundle that can prove it is complete, and a metrics
  surface. `void.export-bundle.v1` records the ledger, journal, vault manifest
  and capability profile with counts, byte lengths and digests, and writes its
  `complete` manifest last, so a failed export leaves no completeness claim on
  disk. Verification takes an out-of-band anchor and recomputes every declared
  number from the bytes. `nomo metrics` recomputes 18 closed-label counters
  from the existing ledger, journal and vault, with no new persisted state.
  Neither is an operational certification.
- Move the Windows Credential Manager target name and the accepted blob length
  out of the `cfg(windows)` block and pin them with checks, so a rule that could
  only be exercised on Windows is now exercised on every host. Renaming the
  target turns two of those checks red.
- Add a real appearance preference to the iOS companion: light, dark and
  system, persisted across launches and applied once at the root, with copy in
  English and Czech. Two entry screens that the extra control pushed below the
  fold on a 402-point-wide window are fixed by laying the language and
  appearance controls out in one row when it fits.
- R10: add a shared, fenced server budget ledger. Reserve before dispatch,
  settle on a terminal result, release only on confirmed non-execution, and a
  crash between reserve and settle leaves a durable spend that expiry surfaces
  without refunding, because a crashed process cannot prove it never ran.
  A per-session ledger is refused outright: N workers would each authorise the
  full limit.
- R02: add a production composition root for legacy proxy bindings, with
  explicit operator selection, a refusal on an unknown name, and three bound
  tools, each with a cross-layer fixture.
- Keep a paired device's operation status inside that device. The bound
  envelope path resolved an operation by workspace alone while the internal
  route also checked the owner, so a sibling device could read it.
- Take the collection lock when recording a retention pin, and re-read the
  evidence immediately before each unlink. A pin written during a collection
  was previously never observed, and the artifact and its pin record were both
  deleted by the run meant to respect the pin.
- Refuse retention evidence written inside the artifact root, which is the one
  place a sidecar breaks the reserved vault.
- Say in an export bundle's own capability section that the ledger and journal
  sections are verbatim copies of recorded operations.
- Derive the `signed` flag in a bundle verification and a metrics report
  instead of asserting it, and report basenames rather than absolute host
  paths, so a pasted report does not carry the operator's home directory.
- Add an internal `/gallery` route for the component families that have a real
  consumer, using the existing app and the existing browser harness rather than
  a new UI kit. It replaces the shell before `App` mounts, issues no API
  requests, is absent from the sidebar and the command palette, and is checked
  by the same viewport, focus, reduced-motion, zoom and touch-target gate as
  the rest of the product.
- Fix the cloud build. The agent-step workflow imports the policy decision
  module, which imported the policy barrel for two string constants, and the
  barrel re-exports the pack loader and the approval broker, both of which
  touch the filesystem. The workflow runtime refuses Node builtins, so the
  deployment failed. The grammar now lives in a leaf module the leaves share,
  the barrel keeps the public names, and a check refuses a leaf that imports the
  barrel again.
- Add a read budget to the file recovery vault, so a host that will not load a
  large artifact gets a refusal naming the size instead of an allocation it
  cannot satisfy. It defaults to the write quota, so nothing changes by default,
  and the artifact itself is untouched so a host that later raises its budget
  can still read it.
- Give the recovery path an operator mode, so the same control the workbench
  exposes as a permission mode also exists where files actually change.
  `audit` and `plan` refuse dispatch before the policy is consulted, so widening
  a policy cannot widen the mode; `normal` is the unchanged default; and
  `recovery health` reports the effective mode.
- Make a recovery plan prove its own undo order. Adapters may record the read
  set they consulted, it is stored durably in the capture, and a plan whose order
  cannot be proven is refused rather than run. An absent read set is unknown, not
  empty.
- Give a recovery job a durable lease that is reclaimed only when it expired and
  its holder is provably gone, so a worker that dies mid-apply cannot freeze the
  workspace forever and a live one is never displaced.
- Add a disposable end-to-end exercise of the agentic reverse loop against real
  files: a refused call changes nothing, an approved call captures before it
  writes, a reused identity cannot be rebound, the signed journal verifies, a
  restart keeps the history, the confirmed inverse restores exact bytes and
  mode, and a replayed inverse is refused. The same loop runs against a real
  database over PGlite, where a refused row change leaves the row alone and the
  confirmed inverse restores the captured values rather than a reconstruction.
  A third arm drives the loop over real MCP stdio against a spawned
  `nomo recovery serve`, so the claim covers the transport an agent actually
  uses. All three run in the gate.
- Deduplicate a mutating companion operation by its idempotency key, bound to
  the exact request body, so a retry is distinguishable from a key reused for a
  different body. A replayed pairing is refused with a conflict instead of
  minting a second device, and its one-time credential is never written to disk
  to make a retry cheap. The handshake now lists what it does not enforce.
- Stop letting a pairing caller grant itself `companion:write`. The write scope
  is the host operator's decision now, refused unless the host configured
  `NOMO_COMPANION_WRITE_PAIRING=1` and refused rather than quietly downgraded,
  so a client never believes it holds an authority it does not.

- d125b7e9: Restored the product baseline from upstream history.
- 9ef84fe2: Synchronized the product branch with upstream history.
- f40bbead: Improved the interactive telemetry and replay story.
- 976e0bd2: Added the first registry, hold, shadow run, taint, and attestation concepts.
- f120d562: Added the product build plan.
- b02de3b4: Added the workflow execution plan and market plan.
- b2d3e9f1: Added the package scaffold and authoritative context pack.
- 4a157891: Added the terminal interface workstream to the plan.
- e9f55b1f: Added a visual preview for the terminal interface.
- e3093e56: Added the workbench master prompt.
- af093034: Added the terminal render model.
- c074fd5f: Added the Agent Workbench workstream.
- 1107eecb: Added the append only ledger, canonical form, signing, and verification.
- 0d2e0059: Added runtime registry evaluation.
- f7b89d77: Added declared facts loading and precondition validation.
- ec9ad970: Added a complete MCP message inventory for the proxy.
- c6adaeb0: Fixed terminal classification coverage found in review.
- 07970ddd: Added the proxy inventory verification checklist.
- 5d878b52: Added policy loading, decisions, and blocking holds.
- a692f88b: Added the terminal approval channel.
- 1200068b: Changed the proxy interface from draft to frozen contract.
- 523c26f6: Added review helpers, Slack-shaped approvals, and the demo moment.
- 400bdf08: Added the first control plane pages.
- 532354ed: Added the proxy message pipeline.
- bd78892e: Improved terminal watch and approval views.
- f1b11092: Added an adversarial registry migration audit.
- f5e0372c: Improved the root project explanation.
- 75edef91: Expanded the demo moment and terminal preview.
- 02909fa6: Added verified ledger feed support and the feed command.
- 2c3ee6a0: Added SQL parsing support for connector classification.
- b0cff15a: Changed connector and snapshot store contracts from draft to frozen.
- cb5b0626: Changed the proxy to write real ledger entries during interception.
- 6e36fb25: Added replay planning against snapshot manifests.
- b1c28f5e: Added blast radius probes.
- 662cbe62: Added S3 connector capture and restore logic.
- 698e9bc2: Added local and S3-backed snapshot stores.
- b7c1b919: Added Postgres connector capture, inverse, and replay logic.
- 371c4d2c: Added connector round trip proof for restore and drift refusal.
- eb776cf9: Added the local control plane API server.
- c327656e: Added approval broker wiring for held calls.
- 7fd9d6b3: Added taint graph construction from ledger entries.
- 1b9176d7: Added Streamable HTTP upstream transport support.
- 8644f817: Added taint graph querying from the CLI.
- cedff44a: Expanded registry coverage across more agent tool surfaces.
- a6150688: Added signed ledger attestations and standalone verification.

### Changed

- 69fa9a41: Refreshed the dependency set and prompt asset used by the workspace.
- 0ce7cc61: Refreshed the NOMO artifact with new interface components and assets.
- 2eeae3f1: Rebuilt the site with a fuller design system, complete pages, and a working backend.
- 9fc95d90: Changed the default site theme to light.
- a2000b64: Restored the site to the original Replit-style visual language.
- 41357f32: Adjusted the site palette toward beige paper and burnt orange.
- 93c19b96: Improved the dark theme and strengthened the warm palette.
- 4ef6f792: Reworked deployment wiring so the live pieces connect correctly.
- 170f7afc: Moved this repository to product-only focus after the site split.
- 86586427: Added classification for the pilot registry entries and the classify command.
- a7e666ec: Changed remaining registry entries to structured guards.
- 59b88a25: Added the runnable proxy binary.
- e84e6657: Changed blast radius handling to prefer measured probe results.
- f9790f24: Added connector lookup and snapshot manifest wiring.
- Lowered the declared Node.js floor from >=26 to >=24 so hosted build platforms that offer Node 24 can build the repo; verified green under Node v24.21.0.

### Fixed

- 32e9d891: Made the repository deployable on Vercel and exposed the API through serverless functions.
- 5b8d7013: Fixed the serverless function build so it emits deployable code.
- 8b097a19: Fixed registry guards that matched too broadly.
- 04e19881: Fixed hold error wording.

### Added since wave 4

- 79d8683: Added the whole-product arc e2e moment.
- 3a482ca: Synced operator docs to the wave 5 surfaces.
- 411d505: Audited the 270 registry entries and pinned the invariants.
- 7041b06: Hardened the wave-5 surface in an adversarial pass.
- 6967fcc: Closed S08 for the control plane with signature aware feeds.

### Fixed since wave 4

- The control plane verify endpoint now reports signed separately from chain
  integrity, and the web UI downgrades to an integrity-only warning when no
  signing key is configured instead of labeling a hash-only view verified.
- The decision endpoint rejects posts that do not carry an application/json
  content type.
- The unknown-tool classification outcome no longer carries assume or tone
  fields.
