# VOID agent workbench

A compatible-provider model loop whose tools always go through the VOID SDK and
its fail-closed MCP proxy. There is no direct shell or database tool bypass.

The runtime owns provider validation, model discovery, session state, cancellation
and the shared approval broker. GUI and `void agent` consume this domain.

Configure `VOID_UPSTREAM_COMMAND` as a JSON array, `VOID_POLICY_PATH` as a policy
file, and optionally `VOID_FACTS_PATH` and `VOID_LEDGER_DIR`. A missing upstream or
policy refuses the session. Each session has its own ledger workspace, avoiding
concurrent writers to the same JSONL chain.

Configure a provider through `/providers` and `/login` or `Workbench.configure`.
A successful model catalog request is required before showing connected.
`NVIDIA_API_KEY` can connect the NVIDIA preset. Ollama and LM Studio presets can
run without a cloud key on loopback endpoints. Direct `openai.com` provider URLs
are rejected. Model provider credentials and MCP OAuth are separate flows.
Prompts and tool results are sent to the selected model provider.

Provider profiles and conversations are stored in the encrypted local workspace
snapshot. Session snapshots keep the provider endpoint and kind, not duplicate
API keys. By default, `workspace.enc` is encrypted with `workspace.key` in the
same owner-only directory. The host can provide `VOID_WORKSPACE_KEY`; the
desktop shell can source it from OS credential storage. This protects stored
state from other accounts, not from the same user or copies of the directory.

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

Validation: `node --test packages/workbench/src/workbench.test.ts` drives real MCP
fixture processes behind a local provider test double, including approval denial.
It does not spend credits or claim external-provider account validation.
