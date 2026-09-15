# Managed Git Recovery Design

## Status

Approved in chat on 2026-09-15. This document fixes the contract before implementation.

## Goal

Add a local executable `git.managed` recovery adapter that changes one declared
Git worktree or index target at a time, captures the exact prior state, and
restores only that target when repository state still matches its recorded
outcome.

This is the first Git slice of WP-R05. It does not claim public commit recovery,
remote recovery, arbitrary command interception or full repository rollback.

## Trust boundary

The operator configures an existing, non-bare Git repository and declares it
cooperative. The adapter accepts structured JSON only. It never evaluates a
shell command, contacts a remote, runs a hook, invokes a credential helper,
loads a submodule or changes shared history.

The repository root, Git executable and process environment are operator
boundaries. Model supplied paths and mutation values are untrusted. Every path
must be relative, canonical, inside the configured worktree and outside Git
administrative paths. Symlinks, hardlinks, submodules, unmerged index entries,
sparse checkout, active merge, rebase, cherry-pick and bisect state are refused.

The initial verified profile is POSIX only. Windows returns unsupported before
mutation until equivalent native evidence exists.

## Public adapter contract

`managedGitAdapter({ root, cooperative: true })` implements the existing
`RecoveryAdapter` interface with ID `git.managed` and version `1`.

Accepted mutations are a closed union:

- `write`, `delete`: one regular worktree file. Write carries canonical
  base64 bytes and an optional POSIX mode.
- `rename`: one existing regular worktree file to one absent destination.
- `stage`: replace one index entry with the current regular worktree file.
- `unstage`: restore one index path to its exact HEAD entry, or remove the index
  entry when the path is absent from HEAD.

Create is represented by `write` to an absent path in the existing filesystem
API, but the Git capability report distinguishes the observed before state.
Each operation is limited to 1 MiB decoded bytes.

Worktree mutations leave the index byte for byte unchanged. Index mutations
leave worktree bytes and mode unchanged. One runtime operation therefore owns
one atomic surface. Multi-path change sets and commits are deferred because a
process death between independent writes would not have a safe automatic inverse.

## Capture and identity

Preflight captures and reports:

- exact HEAD object ID;
- exact selected index entry, including absence, object ID, mode and stage;
- exact worktree state, including absence, bytes digest, size and POSIX mode;
- untracked identity as worktree present plus index absent;
- both endpoint states for rename.

Prepared encrypted evidence contains the bytes needed for recovery. Public
observations and journal data contain only bounded metadata and digests.
Resource keys distinguish repository identity, worktree paths and index paths.
The plan digest binds the canonical mutation, repository identity, HEAD and all
selected revisions.

Repository identity is based on the canonical worktree root and its resolved Git
administrative directory. A copied repository is not silently accepted as the
same target.

## Execution

Before dispatch, the adapter repeats repository, HEAD, index and worktree checks.
Any drift returns an error before mutation.

Worktree writes use temporary files plus native rename. Delete and rename use
native directory entry operations. The same cooperative POSIX race boundary as
`filesystem.managed` applies: an excluded concurrent writer can still act after
the final check.

Index changes use fixed Git plumbing arguments and Git's lockfile replacement.
Stage writes a content-addressed blob from standard input without filters, then installs an exact regular-file cache entry. The dangling blob is an additive object-store side effect that recovery does not remove. It can retain selected bytes and consume disk until Git garbage collection. Index recovery preserves exact logical entries, stages, modes, object IDs and supported flags, not byte-identical index serialization. Unstage installs the exact HEAD cache entry or removes the selected
index entry. No `git add`, checkout, reset or user configurable alias is used.

Git subprocesses receive no prompt and no terminal. Output is bounded. Failure
text is redacted to stable adapter errors.

## Reconciliation and recovery

After a lost execution response, reconciliation returns unknown. Target state equality is not operation-specific durable evidence and can be ABA. It never reports succeeded or failed from target equality alone.

Recovery first validates HEAD and every selected current state against the
recorded after state. Worktree recovery ignores unrelated whole-index generation
drift only when selected endpoint index entries remain exact. Index recovery
requires the whole recorded index generation; an unrelated index edit conflicts
and is preserved. Drift is conflict and preserves human changes. A valid
inverse restores only the recorded worktree or index surface. Recovery then
verifies exact before state before returning restored.

After a lost recovery response, reconciliation returns unknown because this slice has no operation-specific durable recovery receipt. It never reports restored from target equality and never repeats an uncertain inverse.

## CLI and MCP surface

Recovery configuration accepts exactly one of `filesystem`, `postgres` or
`git`. Git configuration contains a relative `root` and `cooperative: true`.
Existing inspect, execute, plan, apply, reconcile and reconcile-recovery commands
reuse the runtime. Git has no install action.

The MCP `void_execute` mutation schema becomes adapter specific. Git exposes only
the closed mutation union above and states the POSIX cooperative limitation.
Policy classification uses connector `git`.

The disposable command accepts `--adapter git.managed`. It initializes a local
temporary repository with local identity only and never adds a remote.

## Conformance evidence

Automated tests must cover:

- tracked, staged, unstaged and untracked single-path states;
- binary bytes and executable mode;
- create, write, delete, rename, stage and unstage;
- preexisting human changes outside the selected path remain byte and index exact;
- changed request identity, authorization refusal and approval digest binding;
- restart before recovery and idempotent repeated recovery;
- lost execution and recovery responses through reconciliation;
- worktree, index, HEAD, ABA, source recreation and destination drift conflicts;
- traversal, Git administrative paths, symlink, hardlink, submodule, unmerged
  index, active operation and sparse checkout refusal;
- fixed MCP schemas and invalid mutation rejection;
- a profile whose counts and platform exclusions match executed scenarios.

## Explicit exclusions

No commit, revert, branch, tag, stash, remote, fetch, pull, push, force push,
reset, clean, checkout, merge, rebase, cherry-pick, submodule or hook execution.
No ACL, ownership or xattr restoration. No directory mutation. No ignored-file
snapshot beyond a selected explicit path. No safety claim against noncooperative
writers or malicious local administrators.

A later append-only history slice may add managed commit creation and recovery by
new revert commit or recovery PR. It must never reset or force push shared
history and needs its own design and evidence.
