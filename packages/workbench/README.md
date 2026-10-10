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
`NVIDIA_API_KEY` can connect the NVIDIA preset. Ollama and LM Studio presets can
run without a cloud key on loopback endpoints. Direct `openai.com` provider URLs
are rejected. Model provider credentials and MCP OAuth are separate flows.
Prompts and tool results are sent to the selected model provider.

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

`policyPreview(id)` answers what a connector's policy would do to every tool it
lists: the registry classification, the mapped registry id, the decision, the
rule that produced it, and the blast radius, which stays `unknown` until a
measured probe produces one. It sends nothing and writes nothing. A tool the
registry cannot classify is shown as denied, which is what a conversation does
with it, and a tool the provider invents is refused before the connector is
contacted at all.


Provider profiles and conversations are stored in the encrypted local workspace
snapshot. Session snapshots keep the provider endpoint and kind, not duplicate
API keys. By default, `workspace.enc` is encrypted with `workspace.key` in the
same owner-only directory. The host can provide `NOMO_WORKSPACE_KEY`; the
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

`node --test packages/workbench/src/connector.test.ts` proves the consent gate
end to end against a loopback MCP server that counts its requests, including
the migration of a snapshot written before the gate.
`packages/workbench/src/policy-review.test.ts` proves that the operator rule and
not the classifier decides, that an invented tool never leaves the process, and
that a running conversation keeps the policy it started with.
