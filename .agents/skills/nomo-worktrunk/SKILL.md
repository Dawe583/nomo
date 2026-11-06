---
name: nomo-worktrunk
description: Use Worktrunk at every NOMO task start and isolate NOMO changes in task-owned Git worktrees when safe.
---

# NOMO Worktrunk

At the start of every NOMO task, run `scripts/nomo-wt.sh list` and inspect
worktree ownership, branch and dirty state. Before editing, continue in the
task's assigned worktree or use Worktrunk to create/switch to an isolated one
when safe. The wrapper pins new paths under NOMO's `.worktrees/` directory and
prefers the local binary, then `wt` on `PATH`.

Run `scripts/nomo-wt.sh --help` for commands. Interactive directory switching
uses the configured global zsh integration. The wrapper does not edit user
shell configuration.

If the shared checkout is dirty or its active task belongs to another agent,
preserve it. Do not create a parallel worktree that drops required uncommitted
context. Never remove, reset, merge or clean another task's worktree. Never
copy source-repository hooks into NOMO's configuration.
