---
name: nomo-workflow
description: Required execution contract for every NOMO task across Pi, OMP, Prime Agent, Codex and Claude.
---

# NOMO workflow

Use this skill together with `nomo-pydantic` for every NOMO task. This is the
only general workflow procedure; domain skills add procedures only for their
specific subject. Follow the native tools and permissions of the running
harness. A prompt or skill is not a permission boundary.

## One graph, bounded loops

Use the task's assigned Worktrunk worktree and `.nomo/work-state.json`. If no
task graph exists, make the smallest useful one: trivial work may stay in
context; multi-step work gets a durable graph with owner, dependencies, input,
allowed paths, expected output, acceptance evidence, verifier and stop rule.
Run `scripts/nomo-wt.sh list` during discovery. Preserve foreign ownership and
dirty work; use one writer per shared path.

If a child task agent is used, pass it the same contract and both core skills
through its native loader, plus one graph node with exact paths, verifier and
stop rule. Verify that the child received those files before relying on it.
Use `scripts/nomo-pi-audit.sh` for read-only audits; do not substitute a
read-only prompt on a general launcher.

For each node, repeat this evidence loop only when a targeted repair or new
evidence warrants it:

1. **Discover:** read the applicable instructions, source of truth, current
   changes, ownership and available evidence. Validate code-graph provenance.
2. **Specify:** state the expected result, owned paths, acceptance evidence,
   verifier, budget and stop rule.
3. **Change:** make one minimal, complete in-scope change. Preserve unrelated
   work.
4. **Verify:** run the narrowest deterministic check, then required wider
   gates. Read the actual output.
5. **Review:** compare the complete owned diff with the request, contracts and
   acceptance criteria.
6. **Record:** capture exact evidence, outcome, limitations and next node in
   the task graph. Append milestone evidence to the Obsidian Work Log.

Diagnose a failure before retrying and allow at most one targeted repair for
that failed check. Never mark a node done without verifier evidence. Continue
independent safe nodes if one is blocked.

## Pydantic is the typed workflow component

Use Pydantic AI, Graph and Evals where their implemented NOMO integration fits:

- Pydantic AI summarizes an explicitly authorized NOMO proxy tool result.
- Pydantic Graph orders that one-call workflow and its summary outcome.
- Pydantic Evals checks fixture-backed workflow status expectations.
- `.nomo/work-state.json` remains the durable cross-harness task graph;
  Pydantic Graph does not replace it or orchestrate arbitrary editor, shell,
  GitHub or harness actions.

For governed calls, follow `nomo-pydantic` and
`python/nomo-pydantic/README.md`. Use `run_governed_call` through the NOMO
loopback transport, an explicit tool allowlist and idempotency key. Never retry
an uncertain dispatch until reconciled. Use fixtures for evaluations. Do not
claim Pydantic enforcement of OS, harness or file permissions.

## Autonomy and improvement

Within a user task, research, implement, test and review without asking for
routine choices. When no authorized implementation remains, inspect the
roadmap, issues and verified evidence; research candidates, evaluate them with
measurable evidence, then present the best materially different next options
for the user to choose. Do not silently choose product direction or launch
unscheduled work.

Treat recursive learning as a measured improvement loop: record outcome,
evaluate a proposed workflow or prompt change against fixed fixtures or
observed outcomes, review the full change and keep a human decision for product
direction. Never let an agent automatically weaken its own controls, widen
permissions or declare its own quality from a green graph alone.

## Governance and stopping

Keep execution, governance and improvement separate. Constrain dynamic routing
with the harness's real tool, path, transition, concurrency and budget
controls. Reconcile uncertain external effects before retrying. Humans decide
ambiguous product choices and irreversible or externally visible release
actions. Follow `AGENTS.local.md` for publication authority. Stop at the budget,
retry cap, scope boundary, unresolved outcome or approval gate; record the
evidence and report the concrete blocker once.

## Routing

- Read `nomo-scrapling` for public research or a user-supplied public URL; use
  its read-only basic GET first. Do not fetch unrelated sites for local tasks.
- Load a domain skill only when the task route needs it.
- Use `scripts/nomo-pi-audit.sh` for read-only audit agents. Its tool allowlist
  is the runtime restriction; do not dispatch an audit with a general launcher.
- Inspect MCP schemas and scope before use. Never claim an unavailable tool or
  integration was used.
- Run `pnpm run typecheck` before code-completion claims; use `node:test` for
  JavaScript. Do not run unrelated tools or heavy test processes concurrently.
