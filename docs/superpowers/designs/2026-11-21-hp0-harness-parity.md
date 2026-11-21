# HP0 design record: harness parity with Hermes Agent and Prime Agent

Date: 2026-11-21. Node `HP0` in `.nomo/work-state.json`, lane of `W2`. The
owner asked on 2026-11-21 for a harness "on the level of Hermes Agent or Prime
Agent". This record measures the gap against the two agents installed on the
development machine and orders the slices that close it.

## Sources

Read-only inventories, taken on 2026-11-21 from the local installs, source
over documentation wherever the two disagree:

- Hermes Agent 0.23.0 (2026.9.24), Nous Research, git install, Python agent
  with an Ink TUI.
- Prime Agent 0.10.2, Rust CLI and daemon with a Python kernel runtime; the
  0.9.8 Rust source was used for mechanisms and line references.
- NOMO at `1ec1e5d`, read from `packages/workbench/src`, `packages/cli/src`,
  `apps/control-plane/api` and the harness documents.

The inventories themselves are working notes outside the repository. Every
NOMO claim below was re-read in source before it was written here.

## What NOMO already does better

Both reference agents trust their own files. NOMO does not, and that stays:

- Learning governance. A refusal or a review becomes an inert signed proposal;
  only an operator approval of the exact digest activates it; rollback, H10
  outcome feedback and H11 effects are replayed from the verified chain
  (`docs/NOMO-AGENT-HARNESS-SPEC.md`). Hermes writes memory and skills directly
  unless an optional write approval is on; Prime applies model-planned edits to a
  JSON store.
- Safety. Signed hash-chained ledger, registry classes, policy with holds,
  per-run grants and a network-less container for project commands. Prime
  states in its README that it is not a security sandbox; Hermes relies on
  pattern classification and optional containers.

None of the slices below may weaken either property.

## Gap matrix

| Capability | Hermes Agent | Prime Agent | NOMO at `1ec1e5d` | Slice |
| --- | --- | --- | --- | --- |
| Learning carries across conversations | memory files and skills apply to every session | harness entries carry `local` or `global` scope | per conversation: retrieval reads only the session's own `agent-<uuid>` chain | HP1 |
| Automatic context compaction | in-loop at 50 percent of the window, auxiliary summary, protected head and tail | at `min(0.95 window, window - output - reserve)`, keeps 20000 recent tokens | manual only; the 199 and 200 message caps end a conversation | HP2 |
| Project context files | `.hermes.md`, then the `AGENTS.md` chain, then `CLAUDE.md` | `AGENTS.md`, `CLAUDE.md`, root-most ancestor first | none read | HP3 |
| Plan tool for the model | `todo_list` | goal and progress notes | none; the TUI parses markdown checkboxes out of replies | HP4 |
| Delegation the model can call | `delegate_task`, batch, roles, depth 1, 10 concurrent | `rlm.spawn`, depth 2 | spawn is an operator API, not a model tool | HP5 |
| Session search for the model | `session_search` over SQLite FTS5 | none | HTTP substring filter only | HP6 |
| Goals with completion gates | judge-driven `/goal` loop | one goal, autonomous mode with shell gates and budgets | none; a run ends when the model stops calling tools | HP7 |
| Project file reading and search | `read_file`, `search_files`, `patch`, `write_file` | `ipython`, `bash`, `edit` | `nomo_project_exec` in the container and `nomo_project_changes` only | HP8 |
| Scheduled prompts | `cronjob_manage`, `/loop`, `/heartbeat` | `/heartbeat`, agent-owned heartbeats, `schedule` | none | HP9 |
| Web search and extraction | `web_search`, `web_extract` | `websearch` skill | none built in; an operator may confirm an MCP connector | HP10 |
| Messages between agents | none, a child returns one summary | parent, sibling and child messaging with rate limits | none | HP11 |
| Skill promotion | `skill_manage`, curator with a ledger | `skill` harness entries | proposals flatten to lessons | H4b, owner decision |

## Principles every slice keeps

1. Anything learned that reaches a prompt was approved by an operator by
   digest and is read back from a verified signed chain.
2. Nothing learned reaches `decide`, policy, the tool catalog or a permission.
3. A new model tool has a registry class and runs through policy and holds
   like every existing tool; an unknown outcome stays `unknown`.
4. Decision D1 holds: scores stay descriptive.
5. Decision D6 holds: no new dependency, store technology or transport. HP1
   adds one workspace to the existing encrypted snapshot and signs into the
   existing chain format; it adds no store.
6. The foreign TUI lane (`packages/cli/src/tui/*`) is never edited. A slice
   reaches the operator through the CLI, the HTTP API and the workbench API.

## Slices

Ordered by how much of the learning loop each one completes.

### HP1: operator scope for approved refinements

The gap the H7 proof left open: "later sessions retrieve only approved and
verified records" holds inside one conversation, because every conversation,
branch and subagent gets its own workspace chain.

Design:

- One operator chain, the workspace `nomo-operator-harness`, kept in the same
  encrypted snapshot and signed with the same key as every workspace chain.
- `Workbench.promoteHarnessProposal(sessionId, digest)` refuses unless the
  digest is `activated` in that session's verified chain (H10 status) and the
  entries it created or updated are still operator-approved there. It writes
  one `harness.promotion` / `promotion:activated` record carrying the source
  workspace, the source digest, the activation sequence and the entries.
- `Workbench.demoteHarnessPromotion(digest)` writes `promotion:demoted`. A
  promotion that is not active cannot be demoted twice.
- `Workbench.operatorHarnessEntries()` replays the verified operator chain.
  Every run merges those entries into its retrieval set, where a conversation's
  own entry with the same id wins. The prompt marks operator entries as
  applying to every conversation. A chain that fails verification refuses the
  run's retrieval the same way a workspace chain does.
- CLI: `nomo harness promote --session <id> <digest>`, `nomo harness demote
  <digest>`, `nomo harness global`. HTTP endpoints follow the existing
  `/api/sessions/:id/harness/*` shape.
- Acceptance: an entry approved in conversation A and promoted appears in the
  learned-entry digest of a new conversation B; after demotion it does not;
  a mined observation is never promoted; a tampered operator chain is refused.

### HP2: automatic compaction in the run loop

Before a provider request, when the conversation passes a configured share of
its budget or comes within a margin of the message cap, the workbench compacts
with the model summary it already has (`summarizeForCompaction`), keeps the
system message and the latest user turn, never splits a tool group, and arms
the harness trigger as manual compaction does. A new setting names its
consumer. Acceptance: a conversation that used to stop at the message cap
continues past it, and the stored conversation carries exactly one labelled
untrusted summary.

### HP3: project context files

When a project binding exists, `AGENTS.md` and `CLAUDE.md` at the project root
of the filtered copy are read into the project access context with the same
labelling, size bounds and refusals as project skills. Acceptance: the
context carries the file and its digest; an oversized, symlinked or non UTF-8
file is refused by name.

### HP4: plan tool

`nomo_plan_update`, class `r0`, replaces the conversation's plan with a list of
at most 50 items with `pending`, `in_progress` and `done` states, stored on the
session view and returned to the model. Acceptance: the plan survives a
restart and is visible through the API.

### HP5: delegation tool

`nomo_delegate`, which spawns a child through the existing `spawnSubagent`
path (tool narrowing, ledger before wire, untrusted result handoff), is classed
so that policy holds it by default, and returns the child id; a second tool
reads a settled child's result. Acceptance: the child cannot see a tool the
parent lacked, and the spawn record precedes the child.

### HP6: session search tool

`nomo_session_search`, class `r0`, searches the titles and message text of the
operator's other conversations and returns bounded, redacted excerpts. It is
off until the operator enables it, because it moves text between
conversations. Acceptance: disabled by default, redaction applied, bounded
output.

### HP7: goals with completion gates

A goal is an objective with a token budget and optional gates. Gates are
commands from the operator's existing hook allowlist, so a model can never
name a command the operator did not allow. Continuation runs until a gate
passes or a budget ends, and stops as Prime does when a gate fails over an
unchanged workspace. Acceptance: a passing gate completes the goal, a budget
ends it as `budget_limited`, and no command outside the allowlist runs.

### HP8: project read and search tools

`nomo_project_read` and `nomo_project_search`, class `r0`, over the filtered
project copy only, with the same path validation as the copy. Writing stays
`nomo_project_exec` in the container.

### HP9, HP10, HP11

Scheduling, web tools and agent messaging each change what runs without an
operator in the loop or what leaves the machine. They are designed after
HP1 to HP8 and need an owner decision before code: HP9 has no daemon to run
in, HP10 decides between built-in tools and a confirmed MCP connector, and
HP11 changes the trust between conversations.

## Verification for every slice

Failing test first, then the goal loop with the workbench typecheck, the
workbench suite, the CLI harness tests and the documentation tests; then
`pnpm run typecheck`, the full gate at the accepted Linux baseline, commit,
push, and a fast-forward of `main`.
