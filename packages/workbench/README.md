# VOID agent workbench

A compatible-provider model loop whose tools always go through the VOID SDK and
its fail-closed MCP proxy. There is no direct shell or database tool bypass.

The runtime owns provider validation, model discovery, session state, cancellation
and the shared approval broker. GUI and `void agent` consume this domain.

Configure `VOID_UPSTREAM_COMMAND` as a JSON array, `VOID_POLICY_PATH` as a policy
file, and optionally `VOID_FACTS_PATH` and `VOID_LEDGER_DIR`. A missing upstream or
policy refuses the session. Each session has its own ledger workspace, avoiding
concurrent writers to the same JSONL chain.

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

Set `OPENROUTER_API_KEY` and optional `VOID_PROVIDER_URL`, or validate a provider
through the GUI. GUI keys are held only in process memory; they are never saved
in configuration, transcripts or the ledger. This beta does not implement OS
keychain persistence. Prompts and tool results are sent to the configured model
provider. A successful model catalog request is required before showing connected.

The beta supports one active session, 20 model turns per message, 4096 output
tokens per turn and a 100-session runtime cap. Transcripts are in memory, limited
to 200 events. Signed tool ledgers remain on disk after runtime restart. Model
responses are displayed after each completion, not token streamed. There is no
claim of Codex/Claude Code/OpenCode process adapters, PTY, or desktop packaging.
Those are separate AW work packages.

Validation: `node --test packages/workbench/src/workbench.test.ts` drives real MCP
fixture processes behind a local provider test double, including approval denial.
It does not spend credits or claim external-provider account validation.

`node --test packages/workbench/src/connector.test.ts` proves the consent gate
end to end against a loopback MCP server that counts its requests, including
the migration of a snapshot written before the gate.
`packages/workbench/src/policy-review.test.ts` proves that the operator rule and
not the classifier decides, that an invented tool never leaves the process, and
that a running conversation keeps the policy it started with.
