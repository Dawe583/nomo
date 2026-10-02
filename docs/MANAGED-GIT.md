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
The public actions are `write`, `delete`, `rename`, `stage`, `unstage`,
`commit` and `recoverRemote`.
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
file, and its index entry must differ from the current `HEAD`. The repository
must be on an attached direct branch with a born `HEAD`, so the branch ref and
`HEAD` resolve to the same commit. The adapter builds a candidate tree through
a private index and creates the commit with Git plumbing, with exactly one
parent. It does not rewrite the caller's index or worktree.

The branch compare-and-swap and the operation receipt under
`refs/void/operations/` are one `git update-ref --stdin` transaction. Recovery
requires that exact receipt and exact recorded commit evidence. It creates a
new single-parent inverse commit and atomically appends a recovery receipt under
`refs/void/recoveries/`. It never moves the branch backward. Existing receipt
refs make retries idempotent, and restart reconciliation validates the receipt,
commit, parent, tree, metadata and repository binding instead of inferring
success from target equality or ancestry.

The tree is not taken on trust from the prepared document. Verification re-reads
the recorded parent's commit and tree from the object store, rebuilds the
expected manifest from that tree and the selected index entry, and requires the
captured parent tree, the captured parent entry of the selected path, and both
recorded manifest digests to equal the re-derivation. `git fsck
--connectivity-only` over the parent and the receipt commit then proves every
object both trees name is present, in one pass and without regard to whether any
ref still reaches the parent.

The recovery may follow unrelated later commits and preserves their tree entries.
Branch ancestry, the selected index entry and selected worktree file must still
match the forward result. Selected-path, repository, receipt or locked-ref drift
is a conflict. No reset, checkout, remote command, hook, merge or force update
is used.

The branch tip does not have to be a single-parent commit: capture never
inspects how many parents it has. A merge commit at the tip is accepted, and the
commits the adapter writes above it are single-parent. This is measured, not
assumed: `packages/connectors/src/git/managed-commit.test.ts` builds a real
two-parent merge at the tip, commits above it, and recovers, asserting that the
merge is neither flattened nor lost. An unborn branch, a symlink, a submodule,
several selected paths and a non-POSIX host remain out of scope. Symlinks,
submodules and unmerged index entries are rejected by the path and index
parsers, and an unborn branch has no index to capture in the first place.

## The Git child shutdown ladder

The branch compare-and-swap and its receipt are one `git update-ref --stdin`
transaction, and that protocol is a conversation: the adapter writes `start`,
the ref commands and `prepare` into the child's stdin
(`packages/connectors/src/git/managed-commit.ts:1011`), waits for Git to answer
`start: ok` and `prepare: ok`, and only then sends `commit`
(`packages/connectors/src/git/managed-commit.ts:1125`). A Git that stops
answering does not merely slow the commit down. It is holding `.lock` files on
the branch ref and the receipt ref, and every later Git operation that needs
those refs is refused while they exist. One wedged child can therefore block the
repository for writes that have nothing to do with the operation that hung. The
transaction runner bounds this, because an unbounded child is a repository-wide
outage caused by one commit.

The bound is a ladder rather than one timeout, and the rungs exist in this
order. The transaction deadline is 15 seconds
(`packages/connectors/src/git/managed-commit.ts:1104`), which fires the same
shutdown path that an oversized stdout, unexpected stdout, any stderr byte, a
spawn error or a failed locked recheck fires. Shutdown first closes stdin,
writing `abort` and not just EOF when the child acknowledged `prepare` but the
adapter had not yet accepted `commit`
(`packages/connectors/src/git/managed-commit.ts:1101`), so that a healthy Git
rolls its own transaction back and releases its own locks. 250 milliseconds
later comes `SIGTERM` (`packages/connectors/src/git/managed-commit.ts:1084` and
`packages/connectors/src/git/managed-commit.ts:1077`), 250 milliseconds after
that `SIGKILL` (`packages/connectors/src/git/managed-commit.ts:1080` and
`packages/connectors/src/git/managed-commit.ts:1068`), and 250 milliseconds
after that the promise rejects whatever the child is doing
(`packages/connectors/src/git/managed-commit.ts:1071`). So the worst case from
spawn is 15 seconds plus 750 milliseconds, after which the call returns
regardless of whether the child died. That last rung is the important one: the
escalation is bounded even when the process is unkillable, so a child stuck in
uninterruptible sleep cannot hold the caller open.

`SIGTERM` is what makes the repository recoverable, and it is worth being
precise about why. Git releases its transaction locks on `SIGTERM`; `SIGKILL`
cannot, because it gives Git no chance to run any cleanup at all. So a child
reached by `SIGTERM` leaves the repository usable, and a child that had to be
reached by `SIGKILL` can leave `.git/HEAD.lock` and the ref locks behind. When
the ref locks behind. When that happens the next write to that branch fails
with `cannot lock ref` and `Another git process seems to be running in this
repository, or the lock file may be stale`. Read-only commands keep working;
only the writes to the locked refs are refused. Closing stdin without `abort`
does not strand locks and does not commit either: an ended transaction at EOF is
rolled back, which is why the unacknowledged path is safe to close.

The lock disposition above was measured against Git 2.54.0 on this machine
rather than taken from the protocol's documentation, because it is the entire
difference between an incident and an outage.

The operator repair for a stranded lock is to confirm no Git process is running
against the repository, then delete the stale lock files and nothing else:

```sh
pgrep -fl "git"          # must be empty before removing a lock
find .git -name '*.lock' -type f -print -delete
```

No ref needs rewriting and no index needs rebuilding. The transaction was
all-or-nothing, so a killed child either applied both ref updates or neither,
and deleting the lock only releases the claim on the next attempt. What the
operator must not do is delete a lock while a live Git process still holds it,
which is what turns one stalled commit into two writers on one branch. This is
the same reason the adapter itself never removes a preexisting lock, noted
above.

What the operator observes is `unknown`, and never `failed` and never a retry.
The runtime records `dispatched` before it calls `execute`
(`packages/runtime/src/execute.ts:639`), so a rejection after dispatch is
recorded as `unknown` rather than `failed`
(`packages/runtime/src/execute.ts:670`): at the moment the ladder gives up, the
adapter genuinely cannot tell whether Git applied the transaction, because the
child it was asking was killed mid-protocol. `unknown` is the honest answer
rather than a retry because reconciliation is decidable from durable evidence
the adapter wrote itself. `reconcile` re-validates the operation receipt and
the commit behind it (`packages/connectors/src/git/managed-commit.ts:1566`), so
the receipt's presence settles the operation as `succeeded` and its absence
settles it as still `unknown`. Nothing is ever dispatched twice, and no
recovery is repeated; that rule is stated under "## Limits" and holds here too.

This ladder is the transaction runner's bound and it is independent of the
15-second bound on ordinary Git plumbing. `gitBuffer` in
`packages/connectors/src/git/managed.ts:72` passes `timeout: 15_000` to
`spawnSync` (`packages/connectors/src/git/managed.ts:80`), which covers the
read and plumbing commands the adapter runs around the transaction. The two
share a number and nothing else: the transaction does not run through
`spawnSync`, and the `spawnSync` timeout is a different mechanism with a
different weakness. Measured on this repository's Node, that timeout sends
`SIGTERM` only and then waits for the child to exit on its own, so it bounds a
cooperative Git and does not bound one that ignores `SIGTERM` at all. A hung
transaction is governed by the ladder above, because the ladder escalates to
`SIGKILL` and then stops waiting. Remote-touching Git is a third, separate
bound at 30 seconds with a single `SIGKILL` and no grace ladder
(`packages/connectors/src/git/managed.ts:127`).

The ladder is pinned by tests rather than asserted here. A child that ignores
`SIGTERM` is driven through both signals and asserted to leave no surviving
process and no lock (`packages/connectors/src/git/managed-commit.test.ts:1286`),
a real prepared transaction is timed out and asserted to release both locks
with `HEAD` unmoved (`packages/connectors/src/git/managed-commit.test.ts:1566`),
and the `abort` write is asserted to be flushed before `SIGTERM` and `SIGKILL`
(`packages/connectors/src/git/managed-commit.test.ts:1831`). What those tests
do not claim is the stranded-lock case: they cover a child that dies from a
signal it can act on, and no test certifies cleanup of a `SIGKILL`ed real Git,
because there is none to certify. That gap is why the repair command above is
written for a human rather than for the adapter.

This is the direct lifecycle suite and not the conformance command. "## Limits"
already records that the conformance scenarios simulate response loss in one
process and do not kill a Git child; that stays true, and this ladder is the
coverage that stands in its place.

## Managed remote recovery

`recoverRemote` undoes a managed commit that has already been pushed. It takes
the configured remote name and the operation identifier of the commit to undo,
and nothing else: the path, the parent, the receipt and the single changed path
are re-derived from the repository, never taken from the caller.

A pushed commit cannot be undone in place. `reset` and force-push rewrite
history other people already have, so neither is ever used, and no existing ref
on either side moves. The only append-only inverse is a new commit on a new
branch, parented on the remote's current tip, with every other tree entry
preserved. That branch is pushed once, by a plain create with no force flag,
under `refs/heads/void/recovery/<sha256 of the operation id>`, and the local
branch is not created at all. The remote branch and its commit are the recovery
proposal: merging or closing it is a human decision.

The proposal is deterministic and carries its own digest. It names the
operation it is undoing, that operation's receipt under `refs/void/operations/`,
its commit and parent, the one path the inverse returns and the base it applies
to, and a SHA-256 digest over exactly those claims.

The lifecycle is the same shape as the commit slice, with a different proof.
Capture fetches the named remote branch into `refs/remotes/<remote>/<branch>`
with no `+` in the refspec, so a remote that was rewritten under a stale
tracking ref is refused rather than forced into agreement. It then re-reads the
forward operation from its own receipt. Execution re-captures immediately
before the write boundary, and a remote that advanced since capture is refused
by name: the inverse is never rebuilt on the new tip. A path that changed on the
remote after the operation is also refused, because "return this path to its
pre-operation value" is no longer what the operator asked for. The receipt
under `refs/void/recoveries/` is written before the push, in one
`git update-ref --stdin` transaction, so an attempt is always recorded. The
receipt is a record of the attempt and not proof of publication: a push is
proved only by reading the remote ref back and finding that exact commit.

Consequences of that ordering, all of them deliberate. A push the remote
refuses is a definite failure, and reconcile reports `failed` rather than
unknown, because the read-back proved the branch is absent. A branch that is
present at a different commit is `unknown`, because the adapter cannot tell its
own publication from somebody else's replacement and never pushes again. A
read-back that cannot be answered at all is `unknown` for the same reason.
There is no second push under any of them, and no rebase.

`recoverRemote` has no managed inverse, so its observation is `r3` and the
default runtime denies the dispatch: a host has to configure an
irreversibility budget or a shared budget ledger before it can run at all. The
adapter's own `recover` refuses with the same reason — deleting or closing a
published branch is a human decision, not an inverse this adapter performs.
`reconcileRecovery` returns unknown, because there is no recovery receipt and
an absent one never authorizes another inverse.

Refusals name their precondition: no such remote, a remote whose push URL
differs from its fetch URL, a remote with a configured `core.sshCommand`,
upload-pack or receive-pack program, a branch the remote does not carry, a
remote branch that cannot be fetched, an operation with no managed receipt, an
operation that was never published, a no-op operation, a path that moved, a
remote that advanced, and a tampered plan.

What does not exist. No pull request is opened: the proposal is a branch plus
the text above, and turning it into a pull request needs a host credential,
which is the GitHub adapter's work, not this one's. There is no delete, rename
or prune of a remote or its refs, no tag handling, no submodule, no hook, no
`git remote add` and no multi-remote operation. Only `fetch`, `ls-remote` and
`push` are ever run against a remote, with prompts disabled and an inherited
`GIT_SSH_COMMAND` dropped; any other transport setting in the repository's own
config, an `http.proxy` for instance, is honoured exactly as it is for every
other Git command this adapter runs. There is no cross-platform evidence:
every test here is a real local remote on POSIX.

The action is not in the published `git.managed` operation list, so
`void recovery conformance` does not run it; see "## Limits" for what
publishing it requires.

## Limits

This is a cooperative POSIX profile. A noncooperative writer can still act after
the last worktree check. Windows is unsupported before mutation. No ACL,
ownership, xattr, inode or byte-identical index serialization is restored. Index
preservation means logical paths, stages, modes, object IDs and supported flags.

Stage writes a content-addressed dangling blob before installing the index. Undo
does not remove that object. It can retain the selected bytes and use disk until
Git garbage collection. Do not stage secrets through this adapter.

The worktree and index actions (`write`, `delete`, `rename`, `stage`,
`unstage`) have no operation-specific durable execution or recovery receipt.
For those five, both reconciliation methods return unknown, because target
equality is not treated as proof: it can be ABA. This does not claim detection
of HEAD moving away and back to the same object ID. `commit` is the one
exception, and it is an exception because it writes its own receipt rather
than inferring one from repository state; see "## Managed commit slice" above.
The runtime never redispatches an unknown mutation or repeats an uncertain
inverse.

Apart from the two single-path actions above, there is no branch, tag, stash,
pull, force push, reset, clean, checkout, merge, rebase, cherry-pick, submodule
or hook execution. The only remote commands are the three named above. There is
no directory mutation, no arbitrary Git command and no full repository
rollback. The disposable conformance command has no remote and uses local-only
author identity:

```sh
node packages/cli/bin/void.mjs recovery conformance --adapter git.managed
```

Each published scenario runs the same set of shared runtime checks, listed by
name in `packages/runtime/src/conformance.ts` and attached to the profile as
`sharedRuntimeChecksOnly`. The scenario list itself lives in
`packages/cli/src/conformance.ts`; read the count there rather than trusting a
number copied into this document, because the profile is where operations are
added and withdrawn. On Windows the profile publishes no operations and the
command refuses.

`recoverRemote` is implemented, wired and tested, but it is not published. The
profile's operation list, its `excluded` entry for `remotes`, the MCP tool
schema in `packages/cli/src/recovery-mcp.ts` and the scenario count recorded in
`docs/RELEASE-1.0.1-MATRIX.md` all still describe a remote-free adapter. A
conformance scenario for this action needs a real remote in the disposable
fixture, which the fixture builder does not create today.

The result is repeatable boundary evidence, not full Git certification. The
scenarios simulate response loss in one process. They do not kill a Git child
or certify process death, power loss, hostile writers or every Git repository
format. The commit lifecycle is additionally covered directly, and much more
closely, by `packages/connectors/src/git/managed-commit.test.ts`, which is a
separate suite from the conformance command and is where the receipt,
transaction and recovery behaviour above is actually pinned.

The remote recovery is covered the same way, in
`packages/connectors/src/git/managed-remote.test.ts`, against a real bare local
remote and a real second clone used as the noncooperative writer.
