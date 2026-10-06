# Harness settings

Every limit that governs a run used to be a literal in the run path. This page
is the operator's reference for the ones that are now changeable, and the
reason the rest are not.

## What changed and why

Both agents VOID orchestrates expose this class of limit as operator settings.
prime-agent has `autonomous.maxTurns`, `autonomous.maxTokens`,
`autonomous.timeoutMs` and `autonomous.maxContinuations`
(`/Users/dawe/Developer/upstream/prime-src/crates/pa-core/src/autonomous/mod.rs:26-29`),
and omp has `task.maxConcurrency`, `task.maxRecursionDepth` and
`task.maxRuntimeMs`
(`/Users/dawe/Developer/upstream/omp-src/packages/coding-agent/src/task/settings.ts:235-295`).

VOID kept its own defaults rather than either upstream's, because VOID's
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
`PATCH /api/harness-settings` accepts the same keys.

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
| `hookTimeoutMs`       | 5000    | 100 to 60000     | how long one hook process may run before it is killed        |
| `retryAttempts`       | 3       | 1 to 10          | attempts for a transient provider rejection                  |
| `retryBaseDelayMs`    | 1000    | 100 to 60000     | base wait between those attempts                             |
| `maxConcurrentRuns`   | 1       | 1 to 10          | how many background runs may execute in parallel             |
| `maxContinuations`    | 3       | 0 to 20          | how many times a run may continue after a hold approval      |
| `maxRunTokens`        | 0       | 0 to 1000000     | total token budget for one run (0 = unlimited)               |
| `retryMaxDelayMs`     | 60000   | 1000 to 600000   | ceiling on the exponential backoff between provider retries  |

An agent profile's own `maxTurns` still wins over the harness setting, because
a profile is a deliberate per-agent choice and `AGENT_LIMITS` already caps it.

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

**`permissionMode`.** It is an authority decision, not a preference. It comes
from `VOID_PERMISSION_MODE`, fails closed to `read-only`, and any patch naming
it is refused with `Permission mode is server-controlled.` That refusal is
pinned by an existing test in `gui.test.ts`.

**The provider retry target.** `retryAttempts` and `retryBaseDelayMs` are
settings, but the retry loop still only retries the free model an origin is
known to serve, and only on 429, 502, 503 and 504. That restriction is
deliberate and commented in `provider.ts`: nothing about a model an operator
typed makes it free, so an unknown model is never retried and a paid model is
never substituted.

**Hook command allowlisting.** `VOID_HOOK_COMMANDS` stays environment-only. An
API that could add its own entry would let a hook author authorise the command
their own hook runs, so `packages/workbench/src/index.ts` does not accept it.

**Anything omp exposes that VOID does not have.** omp has 27 top-level config
domains. Most of them govern a coding agent's own surface: bash allowlists,
browser control, SSH hosts, a sandbox, a judge role, an extension bus. VOID is
not a coding agent and does not have those surfaces, so exposing their settings
would be a claim about behaviour that does not exist here. The table is
deliberately the settings VOID can honour, not a mirror of another project's
configuration file. See `docs/AGENT-BINARIES.md` for what VOID actually
consumes from each binary.

## Tests that must keep this honest

| file                                                  | what it protects                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/workbench/src/harness-settings.test.ts`     | clamping, the unknown-key refusal, the stored-state clamp, and that every declared consumer exists in the file it claims                                                  |
| `packages/workbench/src/harness-wiring.test.ts`       | that a lowered limit actually stops the run, that a raised queue bound admits more, that a timeout is not reported as a clean finish, and that settings survive a restart |
| `packages/workbench/src/gui-harness-settings.test.ts` | that `capabilities` reports the configured limits rather than the shipped constants                                                                                       |
| `apps/control-plane/api/harness-settings.test.ts`     | that a refused patch is not accepted over HTTP                                                                                                                            |
| `packages/cli/src/tui/workspace-settings.test.ts`     | that `/settings` lists, sets, refuses an unknown key, refuses a non-number, and reports what actually took effect after a clamp                                           |
