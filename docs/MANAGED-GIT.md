# Managed Git recovery

`git.managed` version 1 changes one declared cooperative POSIX Git target at a
time. Configure an existing non-bare repository with a relative root:

```json
{
  "workspace": "example",
  "stateDir": "../void-state",
  "encryptionKeyEnv": "VOID_RECOVERY_KEY",
  "git": { "root": "./repository", "cooperative": true }
}
```

The state directory must be outside the repository. Git has no install action.
The public actions are `write`, `delete`, `rename`, `stage`, `unstage` and
`commit`.
Create is the conformance name for `write` against an absent path, not another
action. Writes accept canonical base64 up to 1 MiB and an optional POSIX mode.

Worktree actions preserve the selected index entries. Index actions preserve
worktree bytes and mode. Rename captures both endpoint worktree and index state.
Recovery requires the exact recorded actual after revision and restores only the
selected worktree path or logical index entry. Worktree recovery permits unrelated
index generations only when both selected endpoint entries remain exact. Index
recovery conservatively requires the whole recorded index generation, so any
unrelated index edit conflicts and is preserved. This availability cost prevents
selected-entry ABA from being mistaken for proof. HEAD drift, selected state drift, worktree or index generation ABA, active operations, sparse checkout, unmerged entries, unsupported flags,
symlinks, hardlinks, submodules and Git administrative paths produce refusal or
conflict. Resource keys contain a repository digest and relative path, not a
local absolute path.

Git subprocesses use fixed arguments, literal pathspecs, bounded output and a
sanitized environment. Prompts, pagers, hooks, credential helpers, global and
system config, filters and lazy object fetching are disabled. No shell is
involved. Index replacement owns `index.lock`, mutates a private copied index,
checks unrelated logical entries, verifies the original index did not change and
atomically installs the result. A preexisting lock is never removed.


## Managed commit slice

`commit` accepts exactly one relative path. The path must be a staged regular
file, and its index entry must differ from the current `HEAD`. The branch must
point directly at a single-parent commit. The adapter builds a candidate tree
through a private index and creates the commit with Git plumbing. It does not
rewrite the caller's index or worktree.

The branch compare-and-swap and the operation receipt under
`refs/void/operations/` are one `git update-ref --stdin` transaction. Recovery
requires that exact receipt and exact recorded commit evidence. It creates a
new single-parent inverse commit and atomically appends a recovery receipt under
`refs/void/recoveries/`. It never moves the branch backward. Existing receipt
refs make retries idempotent, and restart reconciliation validates the receipt,
commit, parent, tree, metadata and repository binding instead of inferring
success from target equality or ancestry.

The recovery may follow unrelated later commits and preserves their tree entries.
Branch ancestry, the selected index entry and selected worktree file must still
match the forward result. Selected-path, repository, receipt or locked-ref drift
is a conflict. No reset, checkout, remote command,
hook, merge or force update is used. The initial commit, merge commits,
symlinks, submodules, multiple selected paths and non-POSIX hosts remain out of
scope.

## Limits

This is a cooperative POSIX profile. A noncooperative writer can still act after
the last worktree check. Windows is unsupported before mutation. No ACL,
ownership, xattr, inode or byte-identical index serialization is restored. Index
preservation means logical paths, stages, modes, object IDs and supported flags.

Stage writes a content-addressed dangling blob before installing the index. Undo
does not remove that object. It can retain the selected bytes and use disk until
Git garbage collection. Do not stage secrets through this adapter.

There is no operation-specific durable execution or recovery receipt. Both
reconciliation methods return unknown. Target equality is not treated as proof
because it can be ABA. This does not claim detection of HEAD moving away and back to the same object ID. The runtime never redispatches an unknown mutation or
repeats an uncertain inverse.

There is no commit, branch, tag, stash, remote, fetch, pull, push, force push,
reset, clean, checkout, merge, rebase, cherry-pick, submodule or hook execution.
There is no directory mutation, arbitrary Git command or full repository
rollback. The disposable conformance command has no remote and uses local-only
author identity:

```sh
node packages/cli/bin/void.mjs recovery conformance --adapter git.managed
```

Its six scenarios and eight shared runtime checks per scenario are repeatable
boundary evidence, not full Git certification. They simulate response loss in
one process. They do not kill a Git child or certify process death, power loss,
hostile writers or every Git repository format.
