---
name: worktrunk
description: Inspect and isolate Git task work with Worktrunk before editing a repository.
---

# Worktrunk

Use Worktrunk for every task in a Git repository.

1. During discovery, run `wt list` and inspect the current branch, dirty state,
   existing worktrees and task ownership.
2. Before changing files, use an existing task-owned worktree or create/switch
   to one with Worktrunk. Keep one active writer per shared path.
3. If the current checkout is already assigned to the task, the execution graph
   requires that checkout, or unrelated dirty state makes a new worktree unsafe,
   preserve that ownership. Record why Worktrunk only performed inventory.
4. Never reset, clean, remove, merge or switch away from another task's
   worktree. Avoid Worktrunk hooks, auto-merge and cleanup unless the user and
   project contract explicitly authorize them.

Use `wt switch --create <branch>` for a new task worktree. The user config places
new worktrees under `.worktrees/<branch>`. In non-interactive agents use the
project wrapper when present; shell integration is available in interactive
zsh. Treat paths and branch names as untrusted arguments and quote them.
