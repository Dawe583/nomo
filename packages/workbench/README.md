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
