# Harness settings

Every limit that governs a run used to be a literal in the run path. This page
is the operator's reference for the ones that are now changeable, and the
reason the rest are not.

## What changed and why

Both agents NOMO orchestrates expose this class of limit as operator settings.
prime-agent has `autonomous.maxTurns`, `autonomous.maxTokens`,
`autonomous.timeoutMs` and `autonomous.maxContinuations`
(`/Users/dawe/Developer/upstream/prime-src/crates/pa-core/src/autonomous/mod.rs:26-29`),
and omp has `task.maxConcurrency`, `task.maxRecursionDepth` and
`task.maxRuntimeMs`
(`/Users/dawe/Developer/upstream/omp-src/packages/coding-agent/src/task/settings.ts:235-295`).

NOMO kept its own defaults rather than either upstream's, because NOMO's
defaults are the conservative ones and a governance harness should start
restricted. What it did not keep was the hardcoding: a limit nobody can change
is a limit nobody chose.

The table lives in `packages/workbench/src/harness-settings.ts` and is the only
place these numbers are written down.

## Using them

In the terminal, `/settings` lists every limit with the value in force, the
range it may be set within, and the symbols that read it.
`/settings maxQueuedRuns 50` sets one.

Over HTTP, `GET /api/harness-settings` returns the same rows and
`PATCH /api/harness-settings` accepts the same keys. The one selection, which
is a name rather than a limit, has its own pair of routes:
`GET /api/harness-review-settings` and `PATCH /api/harness-review-settings`.

Both paths clamp rather than refuse an out-of-range value, and both refuse an
unknown key by name. A misspelled limit that returned success would read to an
operator as applied while changing nothing.

## The settings

| key                   | default | range            | what it governs                                              |
| --------------------- | ------- | ---------------- | ------------------------------------------------------------ |
| `maxTurns`            | 20      | 1 to 20          | model turns per run before the run stops and asks for review |
| `maxOutputTokens`     | 4096    | 256 to 32768     | the `max_tokens` ceiling on every provider request           |
| `maxPromptCharacters` | 32000   | 256 to 200000    | longest prompt accepted by start, send and a branch rewrite  |
| `maxQueuedRuns`       | 20      | 1 to 1000        | background runs that may wait behind the active one          |
| `maxRequestBytes`     | 65536   | 1024 to 10485760 | largest request body the control plane accepts               |
| `maxRunTimeoutMs`     | 600000  | 1000 to 86400000 | wall-clock ceiling for one run                               |
| `maxToolCallsPerTurn` | 32      | 1 to 256         | tool calls one provider reply may request                    |
| `refinementEnabled` | 1 | 0 to 1 | whether the harness may spend a model call reviewing what it learned (0 switches it off) |
| `refinementTurnInterval` | 25 | 1 to 1000 | settled turns that must pass before an armed trigger can pay for a review |
| `refinementCooldownMs` | 1200000 | 0 to 86400000 | how long a review attempt blocks the next one; zero means no wait |
| `refinementLensCount` | 1 | 1 to 3 | independent reviews one harness round pays for; every lens must approve |
| `hookTimeoutMs`       | 5000    | 100 to 60000     | how long one hook process may run before it is killed        |
| `retryAttempts`       | 3       | 1 to 10          | attempts for a transient provider rejection                  |
| `retryBaseDelayMs`    | 1000    | 100 to 60000     | base wait between those attempts                             |
| `maxConcurrentRuns`   | 1       | 1 to 10          | how many background runs may execute in parallel             |
| `maxContinuations`    | 3       | 0 to 20          | how many times a run may continue after a hold approval      |
| `maxRunTokens`        | 0       | 0 to 1000000     | total token budget for one run (0 = unlimited)               |
| `retryMaxDelayMs`     | 60000   | 1000 to 600000   | ceiling on the exponential backoff between provider retries  |
| `contextEntryLimit`   | 3       | 0 to 20          | learned entries per kind that reach a prompt (0 = none)     |
| `contextCharsPerEntry`| 240     | 40 to 4000       | characters of each retrieved entry a prompt shows            |
| `providerRequestTimeoutMs` | 60000 | 1000 to 600000 | per-request HTTP timeout for provider completions during a run |
| `toolRequestTimeoutMs` | 180000 | 1000 to 600000   | per-request timeout for MCP tool calls over the stdio proxy  |
| `maxToolResultCharacters` | 64000 | 256 to 200000  | characters of a tool result retained in the model conversation |
| `autoCompactMessages` | 150 | 0 to 199 | messages at which a run compacts the conversation with a model summary (0 = off) |
| `sessionSearchEnabled` | 0 | 0 to 1 | whether the model may search bounded, redacted excerpts from other conversations (0 = isolated) |
| `webToolsEnabled` | 0 | 0 to 1 | whether the run offers `nomo_web_fetch` and `nomo_web_search`, both held at r1 (0 = no web tools) |

An agent profile's own `maxTurns` still wins over the harness setting, because
a profile is a deliberate per-agent choice and `AGENT_LIMITS` already caps it.

`autoCompactMessages` (HP2) is read by `autoCompact` at the top of every turn
in `run`. When the conversation holds that many messages, or an agent profile's
`maxContextTokens` would refuse the next request, the run compacts first: the
same provider and model write a summary of the dropped turns, labelled as
untrusted history in a user message, and a summary that fails falls back to
the raw extract. It compacts only when there is history to drop beyond a
previous summary, so a long run never summarizes its own summary. The
compaction arms the harness trigger like `/compact`, records
`context.compacted` with `automatic: true`, and records the summary's tokens
under the usage source `compaction`. The maximum is 199 because the hard cap
of 200 messages would otherwise end the conversation first; zero switches it
off, and then `send` refuses a conversation at the cap as before.

`sessionSearchEnabled` (HP6) is zero by default because a search moves text
between conversations. `startSession`, `spawnSubagent`, `availableTools` and
`run` only offer `nomo_session_search` while it is one, and `executeTool`
refuses a persisted or forged call after it is switched off. Search covers
titles and non-system messages in the same operator store, never the calling
session. It returns at most eight excerpts of 240 characters from at most 100
conversations; provider and connector redaction runs before the result returns,
and a secret-shaped excerpt is withheld.
`webToolsEnabled` (HP10) is zero by default because both tools leave the
machine. While it is one, the run offers `nomo_web_fetch` and `nomo_web_search`
and the catalog drops them the moment it is switched back to zero, including
from a session's later turns. Both are classed `r1` in `workspaceToolClass`, and
a profile-less session is held before either runs, so the operator sees an
outbound request before it happens. `nomo_web_fetch` accepts only absolute
HTTPS URLs on port 443 and refuses every loopback, RFC1918, link-local, CGNAT,
multicast, reserved and cloud-metadata address, revalidating each redirect hop
against the same rules. `nomo_web_search` needs `NOMO_WEB_SEARCH_URL` and
optionally `NOMO_WEB_SEARCH_API_KEY`; with no endpoint it refuses and names the
variable instead of reaching anything. Page text is framed as untrusted, script
and style bodies are stripped, and both the run's own secrets and credential
shapes are redacted before the text reaches the prompt.


## A selection, not a limit

One setting is not a limit: `refinementModel` names the provider model the
harness spends its review calls on. It is empty by default, and empty means
the conversation's own model pays for the review.

It lives in its own small table rather than in the table above because the
rules above do not apply to a name. A limit has a bound the run path can
honour, so a clamp is what keeps a hand-edited state file from widening one.
A model id has no bound: the only honest check on it is its shape, because
whether a provider knows the model is a fact only the provider can answer.
The shape is checked on the way in: at most 128 characters, and only letters,
digits and the characters `. _ - : @ /`. Anything else is refused by name,
with the reason, and changes nothing. A stored state file cannot inject a
model id the validator refuses.

It is set over HTTP:

```
GET   /api/harness-review-settings
PATCH /api/harness-review-settings   {"refinementModel": "vendor/model-v2:1"}
```

The terminal `/settings` command still reads a number, so the selection is
not settable there yet. That is a known gap in the terminal surface, not a
design decision, and the HTTP path is the one that exists today.

Two things follow from the selection, and both are visible to an operator. The
usage record for a review names the model the call actually went to, not the
one the conversation runs on, because that record is where the spend is
accounted. And a provider that does not know the selected model fails the
review with the model named in the refusal, because a refusal that does not
say which model was called leaves the operator guessing between a wrong
selection and a provider that never had the model.

## Four rules the implementation keeps

**A setting with no consumer does not exist.** Each row names the symbols that
read it and the file that defines them, and a test reads those files. A row
cannot name a consumer that is not there. That test rejected two rows in the
commit that introduced the table, which is the point of writing it.

**Bounds are clamped on both paths.** A patch and a loaded state file both go
through the same clamp, so a hand-edited state file cannot widen a limit
nobody chose.

**Refusal stays refusal.** `maxPromptCharacters` refuses an oversized prompt in
`start`, `send` and `branch`, and truncates a long event string. Those are
different operations on purpose. A prompt is an instruction, and silently
shortening one runs something the operator did not write.

**An unproven outcome never reads as a clean stop.** When `maxRunTimeoutMs`
fires, the session goes to `unknown`, not `idle` and not `failed`. `unknown` is
the state that keeps Undo and reconciliation available, because the run's
outcome was never established.

## What is deliberately not a setting

**The bounds of the conversation tail.** The reviewer sees the last exchanges
of the conversation, cut to a fixed number of messages, a fixed number of
characters per message and a fixed number of characters overall. Those
numbers are not operator-tunable, because a tail wide enough to be worth
tuning is a tail wide enough to carry a pasted credential, and because the
ceiling that governs it is the prompt ceiling the operator already sets. The
tail is charged to that ceiling before the two evidence halves share what is
left, so a longer conversation costs the reviewer evidence rather than
silently exceeding what the operator allowed.

The tail is not written into a chain record and not echoed into a refusal. It
goes to the reviewer and nowhere else, and the pattern screen that refuses a
secret-like proposal is not the guard for it: the tail is raw session text,
and its own guard is that it is cut, screened and withheld whole.

**`permissionMode`.** It is an authority decision, not a preference. It comes
from `NOMO_PERMISSION_MODE`, fails closed to `read-only`, and any patch naming
it is refused with `Permission mode is server-controlled.` That refusal is
pinned by an existing test in `gui.test.ts`.

**The provider retry target.** `retryAttempts` and `retryBaseDelayMs` are
settings, but the retry loop still only retries the free model an origin is
known to serve, and only on 429, 502, 503 and 504. That restriction is
deliberate and commented in `provider.ts`: nothing about a model an operator
typed makes it free, so an unknown model is never retried and a paid model is
never substituted.

**Hook command allowlisting.** `NOMO_HOOK_COMMANDS` stays environment-only. An
API that could add its own entry would let a hook author authorise the command
their own hook runs, so `packages/workbench/src/index.ts` does not accept it.

**Anything omp exposes that NOMO does not have.** omp has 27 top-level config
domains. Most of them govern a coding agent's own surface: bash allowlists,
browser control, SSH hosts, a sandbox, a judge role, an extension bus. NOMO is
not a coding agent and does not have those surfaces, so exposing their settings
would be a claim about behaviour that does not exist here. The table is
deliberately the settings NOMO can honour, not a mirror of another project's
configuration file. See `docs/AGENT-BINARIES.md` for what NOMO actually
consumes from each binary.

### Audited run-path literals that remain deliberately fixed (H5b)

The broader H5b audit over `packages/workbench/src/index.ts`, `provider.ts`,
`gui.ts` and `agents.ts` promoted `providerRequestTimeoutMs`,
`toolRequestTimeoutMs` and `maxToolResultCharacters` into the table above,
wired `checkContextBudget` to reserve the configured `maxOutputTokens` instead
of a literal `4096`, and raised the SSE tool-call stream slot ceiling to
`HARNESS_SETTINGS.maxToolCallsPerTurn.max` so raising `maxToolCallsPerTurn`
past 32 reaches workbench governance instead of failing in stream decoding.
Every other numeric literal on those four files remains deliberately fixed for
the reason below:

| file | literal | what it bounds | why it stays fixed |
| --- | --- | --- | --- |
| `index.ts` | `COMPACTION_SUMMARY_CHARACTERS = 2000`, `COMPACTION_SUMMARY_REQUEST_CHARACTERS = 24000` | manual `/compact` summary and dropped-history input ceiling | compaction stays manual and separate from runtime harness settings (`docs/NOMO-AGENT-HARNESS-SPEC.md` section 4.8) |
| `index.ts` | `WORKBENCH_VIEW_MAX_EVENT_BYTES = 1024 * 1024` | retained session event ring buffer in memory | protects process memory on the view/SSE stream rather than governing agent authority or run work |
| `index.ts` | `preparedAgentRuns.size >= 32`, `10 * 60_000` (10 min consent TTL) | pending agent-run consent previews and approval expiry | consent-freshness and memory safety invariant; widening expiry weakens operator approval guarantees |
| `index.ts` | `Buffer.byteLength(resultJson, "utf8") > 64 * 1024` | external agent-runner result ceiling before forcing `execute:unknown` | matches `AGENT_RUNNER_OUTPUT_LIMITS.maxRunBytes` fail-closed safety ceiling on external runner output |
| `index.ts` | `session.messages.length >= 199` (`send`) and `>= 200` (`run`) | conversation message count ceiling per session | pinned session history ceiling (`send` checks 199 before appending the user turn so `run` caps at 200) |
| `index.ts` | `delay(100)`, `flushed > 250 \|\| delta.length > 512` | hold poll cadence (100ms) and stream delta flush cadence (250ms / 512 chars) | internal transport/UI responsiveness cadence, not a governance limit |
| `index.ts` | `projectExecutionQueued >= 4`, `PROJECT_SANDBOX_LIMITS.outputBytes - 512`, `changes.slice(0, 100)` | queued sandbox operations, JSON framing reserve and preview row cap | protects local container runtime resources and keeps preview payloads bounded under sandbox limits |
| `index.ts` | `secret.length >= 4`, regex lengths `{10,}`..`{20,}` | minimum lengths for secret screening | safety invariant: lowering or disabling would either miss credentials or redact normal text |
| `index.ts` | `1024` framing overhead in `checkContextBudget`, `connectors.length >= 12`, title/name slices (`80`, `160`), status `503` | conservative protocol reserve, saved connector cap, display labels, fallback HTTP status | structural protocol constants, saved configuration limits or UI display slices |
| `provider.ts` | `AbortSignal.timeout(15000)` (no-signal probe), `limit: "1000"` | catalog/probe request timeout and Anthropic model page size | non-run discovery timeout and vendor pagination constant |
| `provider.ts` | `content.length > 2_000_000`, `args.length > 1_000_000`, `pending.length > 2_000_000` | maximum buffered streamed content, tool-call arguments and undelimited SSE frame | memory-exhaustion safety invariants on untrusted provider streams |
| `gui.ts` | `maxActiveRuns: 1`, `Math.min(100, Math.max(1, ... \|\| 50))`, cursor `.slice(0, 16)`, statuses `401/403/404/429` | pinned capability advertisement, API page size, cursor signature prefix and error table | API wire contract and capability shape pinned by `gui-harness-settings.test.ts` |
| `agents.ts` | `HOOK_OUTPUT_LIMIT = 64 * 1024`, `AGENT_LIMITS` (`maxTurns: 20`, `maxContextTokens: 131072`), `systemPrompt.length > 16000` | captured hook stdout/stderr ceiling and saved agent profile validation bounds | safety ceiling preventing hook output floods and save-time profile validation limits |

## Tests that must keep this honest

| file                                                  | what it protects                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/workbench/src/harness-settings.test.ts`     | clamping, the unknown-key refusal, the stored-state clamp, that every declared consumer exists in the file it claims, and that a selection is shape checked and refused by name |
| `packages/workbench/src/harness-review-model.test.ts` | that the review runs on the conversation's own model until one is selected, that a selected model takes the call, and that a malformed selection changes nothing                 |
| `packages/workbench/src/harness-conversation.test.ts` | that a tool message, tool call arguments and a system message never reach the reviewer, that the tail is charged to the prompt ceiling, and that a tail carrying a secret is withheld whole |
| `packages/workbench/src/harness-wiring.test.ts`       | that a lowered limit actually stops the run, that a raised queue bound admits more, that a timeout is not reported as a clean finish, and that settings survive a restart |
| `packages/workbench/src/gui-harness-settings.test.ts` | that `capabilities` reports the configured limits rather than the shipped constants                                                                                       |
| `apps/control-plane/api/harness-settings.test.ts`     | that a refused patch is not accepted over HTTP                                                                                                                            |
| `packages/cli/src/tui/workspace-settings.test.ts`     | that `/settings` lists, sets, refuses an unknown key, refuses a non-number, and reports what actually took effect after a clamp                                           |
