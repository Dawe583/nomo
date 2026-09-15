# Managed Git Commit Recovery Design

Status: approved in chat on 2026-09-15

## Goal

Extend `git.managed` version 1 with a local POSIX `commit` action whose forward
mutation advances one attached local branch by one single-parent commit and
whose recovery appends a new single-parent commit. The action changes only one
selected regular-file path in the branch tree. It preserves unrelated later
linear commits and never invokes a remote, rewrites history, or modifies the
real index or worktree.

This is standalone branch-tree recovery. It does not make a prior
`write -> stage -> commit` job fully recoverable. The recovery commit changes
HEAD, so older version 1 worktree and index inverses continue to reject that
HEAD drift instead of weakening their ABA protection.

## Public contract

The additive MCP and adapter action is:

```json
{ "action": "commit", "path": "src/file.ts" }
```

There is no caller-supplied Git commit message or identity. The adapter creates
a fixed bounded ASCII subject containing a digest of the VOID operation ID. It
uses a fixed truthful VOID author and committer identity and an explicitly
captured UTC timestamp. It creates unsigned commits only.

The adapter ID and version remain `git.managed` and `1`. Existing persisted
version 1 operations must remain recoverable by the same configured adapter.
The new action is additive and uses a discriminated internal capture and plan.
No runtime, ledger, registry, configuration, or connector interface changes are
required.

The declared target is one selected path in one local branch tree. The forward
result is an append-only commit. Recovery restores that selected branch-tree
entry to its value in the managed commit's parent by appending another commit.
It is R1 recovery with a visible trace for that selected resource. It is not
exact repository restoration because HEAD, history, reflogs, receipts, index,
worktree, and stored objects remain different.

## Admissible repository profile

The commit action is verified only when all of these conditions hold:

- POSIX, non-bare repository with SHA-1 or SHA-256 object format.
- Exactly one registered worktree for the repository.
- Attached, born HEAD whose direct symbolic target is one canonical
  `refs/heads/*` ref.
- Files ref backend with an enabled existing branch reflog.
- No shallow boundary, partial or promisor clone, alternates, grafts, replace
  refs, missing objects, sparse index, split index, unmerged entries, submodule
  entry, symlink entry, special file mode, unsupported flags or extensions.
- No merge, rebase, cherry-pick, revert, bisect, sequencer, or relevant lock.
- The selected canonical relative path is nonempty, UTF-8 round-trippable,
  outside Git administrative aliases, and resolves to a regular-file entry or
  a staged deletion.
- The selected index entry differs from its HEAD tree entry. Equality is a
  refused no-op.
- The selected worktree file, when present, exactly matches the selected staged
  blob and mode. A staged deletion requires the selected worktree path to be
  absent. This prevents the operation from hiding a selected unstaged edit.

Unrelated staged, unstaged, and untracked state is allowed and must remain
unchanged. The managed tree is built from HEAD plus only the selected index
entry, never from the complete real index.

Repository-local configuration is treated as untrusted. The adapter uses only
fixed plumbing arguments, disables replacement objects, prompts, pagers,
editors, hooks, signing, credential helpers, global and system configuration,
filters, lazy object fetching, and optional locks where appropriate. It rejects
configuration or repository metadata that can alter the proven object graph.
No shell or porcelain `git commit`, `git revert`, `git add`, or checkout command
is used.

## Capture and preparation

Commit preflight captures and binds:

- repository identity, root, Git directory, common directory, index path, object
  format, ref backend, and single-worktree profile;
- exact branch ref, HEAD commit, HEAD tree, branch reflog bytes and generation;
- complete logical and raw index generation;
- selected HEAD entry, selected index entry, and selected worktree state;
- all refusal-sensitive repository state;
- the canonical selected path.

Preparation repeats the capture and requires exact observation equality. It
binds the selected logical tree edit and a digest of the complete expected tree
manifest without writing a Git object. Authorization, reservation, and durable
encrypted capture therefore complete before any content reaches the object
database.

Preparation binds the fixed commit metadata, subject, expected tree manifest,
parent, concrete branch, operation receipt ref, and repository identity. Receipt
names use a fixed prefix plus a SHA-256 digest of the operation ID. Untrusted IDs
are never interpolated into a ref name. Preparation must not move a ref, write a
Git object, write the real index, or write the worktree.

## Forward transaction and receipt

Execution recreates and verifies every capture binding. It builds a private
index from the captured HEAD tree, applies only the selected captured entry,
writes the tree, verifies its complete manifest digest, and creates the commit
object from that tree and parent with fixed environment metadata. These
content-addressed writes can leave unreachable objects if the later ref
transaction fails. Execution then starts one `git update-ref --stdin`
transaction that:

1. requires the concrete branch to equal the captured parent OID;
2. creates the operation receipt ref only if absent;
3. prepares and holds both ref locks;
4. rechecks the captured branch reflog bytes and generation while the branch
   lock is held;
5. commits the branch update and receipt creation atomically.

The receipt is `refs/void/operations/<digest>` and points to the exact managed
commit. A preexisting receipt conflicts. The adapter never removes a lock it did
not create. Output and lifetime of the interactive ref transaction are bounded.
Failure or timeout aborts and terminates the transaction without a retry.

Verification checks the new branch tip, receipt, parent, tree, selected entry,
unrelated tree equality, and unchanged real index and worktree. The outcome
records only bounded digests and object IDs needed for later proof. It contains
no file bytes, absolute path, raw commit subject, or credentials.

`reconcile()` returns succeeded only when the exact operation receipt exists,
points to the planned commit, and the commit's parent, tree, metadata, selected
entry, and repository binding validate. Branch movement after the managed
commit does not invalidate that durable execution proof. A missing, wrong, or ambiguous receipt returns unknown under the existing
reconciliation contract. Target equality or commit ancestry without the receipt
never proves execution and never authorizes redispatch.

## Append-only recovery

Recovery requires the same concrete branch and a current attached HEAD. The
managed commit must be on the current tip's first-parent chain. The interval
from the managed commit to the current tip is limited to 128 commits and must be
linear. A merge commit anywhere in the interval conflicts.

Every intervening commit is compared with its parent for the selected literal
path. Any selected-path change conflicts, even if a later commit restores equal
content. This detects committed ABA. Unrelated commits are accepted and remain
ancestors of the recovery commit.

The adapter builds the recovery tree from the current tip tree and replaces
only the selected path with its exact entry from the managed commit's parent.
It creates a fixed-metadata unsigned recovery commit with the current tip as its
single parent. One prepared ref transaction then:

1. requires the branch to equal that captured current tip;
2. creates `refs/void/recoveries/<digest>` only if absent;
3. holds both locks and rechecks the current branch reflog generation;
4. atomically advances the branch and creates the recovery receipt.

Post-verification proves that the recovery commit has the captured tip as its
parent, the selected entry matches the pre-commit entry, every unrelated tree
entry matches the captured tip, the original managed commit remains an
ancestor, and the real index and worktree are unchanged.

`reconcileRecovery()` reports restored only from the exact recovery receipt and
a fully validated recovery commit. Equality without a receipt is unknown. An
uncertain inverse is never repeated.

## Human state and composition

Forward commit and recovery do not serialize or install the real index and do
not write worktree paths. Existing unrelated staged entries remain staged.
Unstaged and untracked bytes and modes remain byte-for-byte unchanged.

Immediately before the managed commit, the selected staged entry differs from
HEAD. After the forward ref update, the unchanged index makes it clean relative
to the new HEAD. After append-only recovery, that unchanged selected index entry
normally appears staged again relative to the recovered branch tree, matching
its pre-commit logical staging state. Later human index or worktree edits are
also preserved, not normalized.

This action is standalone. If a recovery job first appends the recovery commit
and then attempts an older `stage`, `write`, `delete`, or `rename` inverse, that
older operation sees a different HEAD OID and conflicts. Tests and documentation
must preserve this result. A later design may add provenance-bound managed
lineage. Tree equality alone must never replace the existing HEAD binding.

## Failure and security semantics

Authorization and durable artifact capture complete before any object write.
Object writes are content-addressed but can retain selected bytes and consume
disk. The operation and recovery receipts keep their commits reachable. Recovery
is not secret deletion, object deletion, ref cleanup, or garbage collection.

A later push is a separate external effect. This adapter does not inspect,
contact, fetch, pull, or push a remote and does not claim that a local recovery
retracts a published commit. Credential helpers and network transports must not
run.

The cooperative boundary covers VOID writers through the existing local writer
mutex and Git's ref locks. A noncooperative process or administrator can rewrite
refs, reflogs, receipts, objects, or configuration and remains outside the
claim. The reflog recheck closes branch ABA before transaction commit for normal
cooperative writers. Hostile reflog replacement and physical power-loss behavior
are not certified.

All unsupported or unprovable states fail before branch mutation. CAS, receipt,
reflog, ancestry, selected-path, configuration, index, worktree, or object drift
preserves current refs and human state. Response-loss handling reads receipts
and never repeats an uncertain ref transaction.

## Tests and conformance

Direct connector tests cover:

- add, modify, delete, binary content, executable mode, SHA-1 and SHA-256;
- selected staged entry plus unrelated staged, unstaged, and untracked state;
- private tree construction and byte-for-byte real index/worktree preservation;
- fixed metadata, bounded receipt refs, atomic branch plus receipt transitions;
- response loss, restart reconciliation, receipt absence, collision, corruption,
  wrong commit, wrong repository, and ancestry without receipt;
- recovery at the managed tip and after one or many unrelated linear commits;
- selected-path change, selected-path committed ABA, merge interval, branch
  switch, non-ancestor tip, 128-commit bound, and current-tip CAS race;
- detached and unborn HEAD, multiple worktrees, shallow and partial clones,
  replacements, grafts, alternates, active operations, signing requirements,
  locks, unsupported index entries, symlinks, submodules, and no-op input;
- hook, editor, signer, pager, credential, filter, and remote sentinels that must
  never execute;
- process concurrency where exactly one branch CAS succeeds and no foreign lock
  is removed;
- recovery response loss creates no second recovery commit;
- older Git inverse after commit recovery retains its HEAD-drift conflict.

The MCP schema is a closed union and accepts exactly the commit fields. Invalid
or cross-action fields fail before adapter dispatch and preserve branch, index,
worktree, and receipts.

Disposable conformance adds a seventh POSIX Git scenario. The report contains
seven scenarios with eight shared runtime checks each, for 56 checks. Its
semantic fixture observes the selected branch-tree resource plus independent
index, worktree, staged, unstaged, and untracked sentinels. Direct tests, not the
generic runner alone, prove that recovery creates a new commit without rewriting
history. The report remains `certification:false` and
`sharedRuntimeChecksOnly:true`.

## Documentation and claims

Update `MANAGED-GIT.md`, adapter conformance, recovery coverage, progress, and
upgrade checkpoint documents. Claims must say local, POSIX, cooperative,
standalone selected branch-tree recovery with an append-only trace. They must
state the receipt retention, dangling object, unchanged index/worktree, job
composition, remote publication, multi-worktree, process-death, power-loss, and
noncooperative-writer limits.

No Windows, remote, recovery PR, merge recovery, multi-path commit, caller commit
message, signing, directory tree, history rewrite, object deletion, or full run
composition is part of this slice.
