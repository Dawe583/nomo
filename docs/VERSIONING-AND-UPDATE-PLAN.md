# VOID versioning and self-update plan

Written 2026-10-01 against commit `5b943f3` on the `omp/selfupdate-release`
branch. Local claims were read from source or produced by a command on that
date, and the commands are given so they can be re-run. External claims were
fetched from the vendor's own API on the same date.

**This document is a plan of record for the next release, not a description of
a shipped mechanism.** The `void update` command described in section 5 is
being implemented against this specification in parallel and had not landed
when this was written, so section 5 is normative for that implementation
rather than a report of it.

Where this document cannot establish something it says so. Section 9 lists
what that covers.

---

## 1. Where the version lives today

**The version is a literal repeated in thirteen manifests, and a test pins the
literal.** There is no single source of truth and no propagation step.

The manifests are the ones `scripts/src/release-packaging.test.mjs` enumerates
at lines 12-15: the workspace root, every directory under the package root
that has a manifest, `apps/control-plane`, and `scripts`. Enumerated and read
on 2026-10-01, that is exactly thirteen, and all thirteen carry `"version":
"0.1.0"`:

| Directory | Name | Version | `private` |
|---|---|---|---|
| `.` | `@void/workspace` | 0.1.0 | true |
| `packages/cli` | `@void/cli` | 0.1.0 | true |
| `packages/connectors` | `@void/connectors` | 0.1.0 | true |
| `packages/ledger` | `@void/ledger` | 0.1.0 | true |
| `packages/policy` | `@void/policy` | 0.1.0 | true |
| `packages/proxy` | `@void/proxy` | 0.1.0 | true |
| `packages/registry` | `@void/registry` | 0.1.0 | true |
| `packages/runtime` | `@void/runtime` | 0.1.0 | true |
| `packages/sdk` | `@void/sdk` | 0.1.0 | true |
| `packages/verifier` | `@void/verifier` | 0.1.0 | **absent** |
| `packages/workbench` | `@void/workbench` | 0.1.0 | true |
| `apps/control-plane` | `@void/control-plane-api` | 0.1.0 | true |
| `scripts` | `@void/scripts` | 0.1.0 | true |

**One correction to the usual description, because it changes what a reviewer
checks.** "Every workspace manifest is private" is true of twelve of the
thirteen, not all of them. `packages/verifier` deliberately has no `private`
flag: it is the single entry in the packaging gate's `PUBLISHABLE` map
(`scripts/src/release-packaging.test.mjs:27-32`), which is a two-state
assertion rather than a blanket one. The gate requires a listed publishable
package to be non-private (`:45`) and every other directory to be private
(`:51`), and a second test at `:276-298` fails if a directory becomes
publishable without being listed with a reason. A version bump does not touch
any of that.

### What a bump breaks, precisely

Changing any manifest's version without changing the gate fails, by exactly
this assertion, once per directory:

```js
assert.equal(data.version, "0.1.0");   // scripts/src/release-packaging.test.mjs:41
```

That is **thirteen failing test cases**, one generated per directory by the
loop at `:34-66`, with the failing directory named in each test title. The
default node reporter prints the generated titles; with `--test-reporter=tap`,
which the root runner uses, the same thirteen appear as `not ok` lines. This
is the desirable failure: it is loud, it names the directory, and it cannot be
mistaken for a product regression.

**Two places carry the version that the gate does not cover.** Both are real
and both are found by reading, not by running anything:

1. `packages/cli/src/recovery-mcp.ts:299` constructs the MCP server with a
   hardcoded `{ name: "void-recovery", version: "0.1.0" }`. Nothing asserts
   this against the manifest, so it silently becomes a lie on the first bump.
2. `README.md:45` states in prose that packages are private at version 0.1.0.
   It is an operational document, so a stale number there is a reader-facing
   error rather than a technicality.

`void --version` is not one of these: `packages/cli/bin/void.mjs:21-33` reads
`packages/cli/package.json` at run time and prints `void <version>`, and
`packageVersion()` in `packages/cli/src/dispatch.ts:27` does the same for
`void config`, whose first line is `version: <version> (package)`
(`packages/cli/src/config.ts:73`). Both follow the CLI manifest, so both
follow a bump automatically.

---

## 2. Single source of truth

**Shipped 2026-10-02 on branch `omp/selfupdate`:** one version for the whole
product, living in the root `package.json`, propagated by a script, and
compared against by the gate instead of a literal.

**Status, 2026-10-02.** All four changes below are implemented and verified in
this tree. `scripts/src/set-version.mjs` is the propagation script,
`scripts/src/set-version.test.mjs` is its check, the gate in
`scripts/src/release-packaging.test.mjs` compares each manifest against the
root manifest, and `packages/cli/src/recovery-mcp.ts` reads the same manifest
for the version its MCP `initialize` response reports. The four changes are
kept below because they are the specification the implementation is held to,
and because the reasoning for each one is not in the code. Where this document
and the shipped script disagree, the script is the behaviour and this section
is the defect.

Concretely, four changes, in this order:

1. **Declare the root manifest authoritative.** `@void/workspace` is the only
   manifest present in every checkout of the product, including a git-only
   install with no workspace tooling involved, so it is the one an installer,
   a tag, and a rollback can all read without knowing the package layout.
2. **Add a script that takes the new version as one argument and writes it
   into all thirteen manifests.** Name it scripts/src/set-version.mjs
   (proposed, not built). It must derive the manifest list the same way the
   packaging gate does rather than repeating a hand-maintained list, and the
   cheapest way to guarantee one list is to have the script export the list and
   have the gate import it. A version that can be set with thirteen edits is a
   version that will be set eleven times.
3. **Change the gate to compare against the root manifest.** Replace
   `assert.equal(data.version, "0.1.0")` at
   `scripts/src/release-packaging.test.mjs:41` with a comparison against the
   root manifest's version, and assert once that the root version is a
   three-part numeric version. The invariant the gate actually protects is
   "all manifests move together", not "the number is 0.1.0"; the literal only
   ever tested the second.
4. **Cover the two uncovered places at the same time.** The script must also
   write the MCP server version at `packages/cli/src/recovery-mcp.ts:299`, and
   the gate should assert that it equals the root version, so it cannot rot
   again. The README sentence is prose and is updated by hand at release time
   (section 4, step 2).

**Why not the alternative.** Two mechanisms were rejected. A version file
(VERSION, or a field in the workspace config) needs every reader, including
`void --version`, to parse it, and the manifests are what npm, pnpm and the
registry read, so a second file is a second thing that can disagree. Generating
the manifests from the root one was rejected as the same mechanism with more
moving parts: writing thirteen derived files is what the script already does.

**What is deliberately not in scope.** Publishing versions. All twelve private
manifests and the root stay private at 1.0 unless the publishing work in
section 6 happens; a version is not a licence to publish.

---

## 3. Semver policy

**Before 1.0: `0.MINOR.PATCH`, where MINOR carries breaking changes and PATCH
does not.** This is not a fresh decision; it restates the policy already
written down in `docs/RELEASE.md:15-19`, which says versions move together
while formats are being validated, that incompatible API, policy, snapshot or
ledger changes must be recorded explicitly with migration instructions before
1.0, and that signed records are never silently rewritten. Semantic versioning
proper, with a published compatibility promise per persisted format, starts at
1.0, which is also what that document already promises.

### What counts as breaking

| Surface | Breaking when |
|---|---|
| CLI | A command is removed or renamed; a flag stops being accepted; a documented exit code changes; the shape of `void --version` or `void config` output changes. |
| MCP | A tool is removed or renamed; a result field is removed or its type changes; a refusal stops being a refusal. New tools and new optional fields are additions. |
| SDK | An export is removed or narrowed from the barrel in `packages/sdk/src/index.ts`, which `scripts/src/docs-release.test.mjs:20-44` already holds in step with `docs/SDK.md`. |
| Persisted data | A record a released build accepts stops verifying or stops parsing. This is the only category that can lose an operator's evidence. |

### Does a ledger or recovery-state schema change force a major bump?

**No, not by itself, and the reason matters more than the rule.**

Persisted formats carry their own version tags, independent of the product
version, and they were designed to. Verified in source: the signed ledger
preimage is tagged `void.ledger.v1`
(`packages/ledger/src/index.ts:54`, with entry, attestation and Merkle domain
separators at `packages/verifier/verify-ledger.mjs:40-43`); journal events
carry `void.operation.v1` and `void.recovery-job.v1`
(`packages/runtime/src/journal.ts:26`, `:278-280`); the metrics export is
`void.metrics.v1` (`packages/cli/src/metrics.ts:48`); the taint export is
`void.taint.v1` (`packages/ledger/src/taint/capture.ts:9`); the recovery vault
uses the SQLite `user_version` pragma (`packages/runtime/src/reserved-vault.ts:302-304`).
The product version is not what tells a reader how to interpret those bytes,
and changing a tag does not by itself break anything an operator holds.

So a schema change is a **patch or minor by version number, plus three
obligations**:

1. **Additive by default, because the ledger is append-only and signed.** A new
   build must still verify every record an older build wrote. That is what
   makes a format change compatible: the old tag stays accepted, the new tag is
   added, and no existing record is rewritten. A change that makes an
   already-valid record fail to verify is the one case that is a major bump,
   because it is indistinguishable from data loss to the operator holding it.
2. **A stated migration or a stated refusal, per format.** Every format above
   is either migrated forward or refused, never silently reinterpreted. The
   vault is the worked example of both halves: it migrates an older
   `user_version` forward on open, which
   `packages/runtime/src/reserved-vault.test.ts:456-477` exercises, and it
   refuses a version it does not know with `Unsupported recovery vault schema
   version.` (`packages/runtime/src/reserved-vault.ts:303-304`), which the
   same file exercises at `:491-504`.
3. **A compatibility line in the changelog entry naming the format and what an
   operator must do.** Nothing in the format tags forces this; it is a review
   obligation, and section 4 makes it a step rather than a hope.

### How an operator migrates

There is no `void migrate` command today, and adding one is not proposed here.
Migration is what the reader does, and it must be one of exactly three
outcomes, stated per format in the changelog:

- **Nothing to do.** The new build reads the old state. This is the common case
  and the release notes say so explicitly rather than leaving it implied.
- **A forward, in-place migration on first open.** Already true for the
  recovery vault. The operator's action is to make a copy first (section 8),
  because the migration is not reversible by the older build.
- **An explicit refusal with a named command.** If a format cannot be migrated,
  the build says which format and what to do instead. Silent loss is not one of
  the three outcomes.

---

## 4. The release procedure

Ordered, from a clean reviewed revision, on a machine with the supported
runtime. Measured on 2026-10-01: node v26.8.1, pnpm 10.33.0, git 2.54.0. The
supported floor is Node 24 (`engines.node: >=24` in the root manifest).

**Step 0. Decide the version, in writing, before touching a file.** Name the
compatibility note that goes in the changelog entry: for every persisted format
the release touches, one of the three outcomes in section 3. A bump with no
compatibility note is not ready to cut.

**Step 1. Confirm the tree is the revision you think it is.**

```sh
git status --short --branch
git rev-parse HEAD
```

A dirty tree means the release contains something nobody reviewed.

**Step 2. Set the version.** After section 2 lands:

```sh
node scripts/src/set-version.mjs X.Y.Z
```

Until it lands, the equivalent is thirteen manifest edits, the literal at
`scripts/src/release-packaging.test.mjs:41`, the MCP server version at
`packages/cli/src/recovery-mcp.ts:299`, and the sentence at `README.md:45`.
Doing that by hand is what section 2 exists to remove; if it is being done by
hand for a real release, that is the argument for landing the script first.

**Step 3. Write the changelog entry.** One user-facing bullet under
`## Unreleased` describing what a user can now do or what changed for them.
The rules are enforced, not stylistic: `scripts/src/docs-release.test.mjs:46-52`
fails a changelog containing the strings `WP-` followed by a digit, `packages/`,
or `docs/`, and the same file's first test (`:13-18`) fails on a single en dash
or em dash anywhere in it. The same file is inside `pnpm test` (see step 4), so
a changelog violation fails the release gate.

**Step 4. Run the gates, in this order.** The root manifest defines them:

| Command | What it is |
|---|---|
| `node --check packages/cli/bin/void.mjs` | The entrypoint parses. |
| `node --test --test-reporter=tap scripts/src/release-packaging.test.mjs` | Release metadata, including the version assertions. |
| `pnpm run typecheck` | Filters every package and the scripts directory, then `apps/control-plane`, then the control-plane UI. |
| `pnpm test` | `node scripts/src/check-tests.mjs`: every package suite, the control-plane suite, the scripts suite, the cloud suites, and two Python suites. |

`pnpm check` runs `pnpm run typecheck` and `pnpm test` as one command, which
is what a release should use. Two details are load-bearing:

- **The changelog gate and the documentation gate are inside `pnpm test`, not
  separate steps.** `scripts/src/check-tests.mjs:80-88` globs every
  `*.test.mjs` in `scripts/src` and runs them as the `scripts` suite, so
  `docs-release.test.mjs` and `doc-truth.test.mjs` run there. Do not report a
  release as gated without saying which suites ran.
- **Use the TAP reporter for release checks**, as `docs/RELEASE.md:39-43`
  already records: Node 26's default spec reporter is not accepted by the
  workspace count gate.

Report nonzero test counts, zero failures, and no unrun suite. When a suite
cannot run, `scripts/src/check-tests.mjs` prints it as `UNRUN` with the
interpreters it tried and excludes it from the total, so a count quoted from
this gate cannot be read as covering a suite that never executed.

**Step 5. Commit and tag.**

```sh
git commit -am "release: X.Y.Z"
git tag -a vX.Y.Z -m "VOID X.Y.Z"
git push origin HEAD --tags
```

On tag shape: the repository currently has five tags, four of them
`desktop-v0.1.0-beta.N` and one `pre-max-merge-20260926-1910`. No plain
`vX.Y.Z` tag exists yet. **Use `vX.Y.Z` for the product** and keep the
`desktop-` prefix for the desktop bundle, which already has its own numbering.
The mixed history is why a convention has to be written down before the first
release tag rather than inferred from the list.

**Step 6. Verify the tag, locally and then on the machine that installed it.**

```sh
git describe --tags --exact-match
node packages/cli/bin/void.mjs --version      # prints: void X.Y.Z
```

An installed operator checks `void --version` and `void config`, whose first
line is `version: X.Y.Z (package)`. Both read the manifest at run time, so
both are the proof that the tag and the tree agree.

**What step 5 cannot do today.** `docs/RELEASE.md:111-114` records that
pushing is blocked by repository credentials and that a human must restore
access before the reviewed branch and release tag can be pushed. This document
does not claim that a push has succeeded; see section 9.

---

## 5. The `void update` contract

Normative. The implementation is the text of record and this section describes
it; where wording drifts, this section is corrected to the code rather than
the code to this section.

**What it operates on.** The install tree: a git clone of this repository at
`$HOME/.local/share/void-cli`, reachable through the `VOID_HOME` environment
variable when it is set, run through the launcher at `$HOME/.local/bin/void`.
The updater defaults to the same tree the launcher runs from, so a `void` on
your PATH and the tree `void update` moves are the same tree by construction.
It never touches operator state, which lives outside the clone under
`~/.void/ledger`, `~/.void/workbench` and `~/.void/approvals/<workspace>`
(`packages/cli/src/config.ts:31-37`).

**Why the default is `void-cli` and not `void`.** On the maintainer's machine
`~/.local/share/void` already holds unrelated local state, and the installer
refuses to clone into a directory that is not a VOID checkout. Naming the tree
`void-cli` keeps a second tool's directory out of the picture instead of
failing on it, and `VOID_HOME` moves it for anyone who wants a different path.

### Invocation

| Command | Effect |
|---|---|
| `void update` | Move the install tree onto the tracked remote ref, run the locked dependency install, and report. |
| `void update --check` | Report the verdict and change nothing. |
| `void update --force` | Allow a move that is not a fast-forward. Everything else is unchanged. |

### Exit codes

| Code | `void update` | `void update --check` |
|---|---|---|
| 0 | The tree already sits on the tracked branch, or the update was applied. | The tree is up to date. **Also** when the check answered and there is nothing to install now: a refused update still exists, and a fetch that could not reach the remote leaves the target `unknown`. |
| 1 | The move could not be completed, so the tree was left where it was. Also when there is no updatable tree to speak of. | Never returned. |
| 2 | Usage. Nothing was touched. | Usage. Nothing was touched. |
| 3 | Never returned. | An update is available. The single answer a script should branch on. |

**Three outcomes share code 0, so read this part twice.** `--check` exits 0
when the tree is current, when an update exists but is refused (a dirty
worktree does not make an available update stop existing, it makes the command
decline to apply it, so that case is 3, not 0), and when the fetch could not
reach the remote. **A script that needs to tell "up to date" from "could not
check" must read the verdict line or the `target-commit` line, not the exit
code.** That is deliberate and it is the honest outcome: an unreachable remote
is not an answer of "no", so it is reported as `target-commit: unknown` rather
than as up to date. Only "an update exists" is worth branching on from the
code alone.

**Code 3 is a deliberate deviation from `omp update --check`, not an
oversight.** The reasoning is scriptability: a wrapper or a scheduled job has
to be able to branch on "an update exists" without parsing prose, and 0/1
cannot carry that because 0 is already spoken for by three other outcomes.
Matching the other tool's convention here would have bought consistency at
the cost of making the answer unavailable to a script.

Code 2 is the convention the binary already uses for an argument a command
does not accept (`packages/cli/bin/void.mjs:36-38`,
`packages/cli/src/config.ts:68-71`). `--check` cannot be combined with
`--force`: one of them promises not to move the tree and the other says it
may, so the combination is refused with the usage line and exit 2.

### Output

One `key: value` line per fact, then one human verdict line. No progress
spinners, no colour, because the output is read in logs and in a terminal with
no TTY. The four fact lines are identical in every mode; only the verdict
changes.

**Commits, not a version transition.** The target of an update is a git ref,
and it has no version until it is checked out, so printing `0.1.0 -> 0.2.0`
would mean inventing a second version reader and guessing what the new tree
will say. The identity that exists on both sides of the move is the commit.
Real output from a run against an installed tree:

```
installed: void 0.1.0 at /Users/dawe/.local/share/void-cli
installed-commit: 5b943f3deb342134b397c4d6a08f93df1e207321
tracked-branch: origin/main
target-commit: 5b943f3deb342134b397c4d6a08f93df1e207321
up to date
```

The facts are `cut`-able by key, so a script reads them and never
pattern-matches a line that could be reworded later.

Verdicts for `--check`, verbatim:

```
up to date
update available: run `void update`
update available, not applied: <reason>
```

On the install path, the move is announced before it happens and confirmed
after it:

```
nothing to do: the tree already sits on the tracked branch
fast-forward: git merge --ff-only origin/main
moving onto 5b943f3deb34: git reset --keep
updated to 5b943f3deb34
```

The dependency install's own output is inherited rather than swallowed, so the
operator sees what ran. If the tree moved but the install failed, the command
says so on stderr and names the command to run by hand.

A refusal writes one line to stderr, exits 1, and leaves the tree where it
was. Every one names the way out:

```
the installed tree has uncommitted changes; commit or discard them first. --force does not discard uncommitted work.
the installed tree has 1 local commit the tracked branch does not have, and moving would drop it. Give it a branch, or re-run with --force.
<path> is not a git checkout. Reinstall it with scripts/install-void.sh, or point VOID_HOME at the checkout you want to update.
no installed tree at <path>. Run scripts/install-void.sh to create one, or point VOID_HOME at an existing checkout.
<path> tracks no upstream branch, so there is no target to update to.
```

A usage error writes one line to stderr and nothing else, matching `void
config`:

```
usage: void update [--check] [--force]
```

### What `--force` does, and what it deliberately does not

**`--force` permits a non-fast-forward move onto the tracked ref. It does not
discard anything.** Two refusals are load-bearing and neither is
configurable:

- **A dirty worktree is refused, including under `--force`.** No flag is a good
  enough reason to delete an edit somebody made in the install directory, so
  `--force` cannot wave that through.
- **The move is `git reset --keep`, never `--hard`.** Even a mistake then stops
  at an uncommitted file instead of eating it. Untracked files are not edits
  and do not block a fast-forward, and nothing deletes them on any path.

What `--force` does authorise is dropping local commits the tracked branch
does not have, which is the operator saying out loud that they may go. The
consequence to know: `--force` moves history, it does not clean a tree. If the
tree is dirty, commit or discard first, then update.

### Channels: one, not two

**VOID does not need a stable and canary split yet, and should not have one
until two named conditions are met.** The argument is about cost, not taste:

- A channel is not one flag. It is a second published version line, a second
  tag namespace, a recorded "which channel am I on" per install, and an
  upgrade path between them. Today none of those exists and none of them would
  be exercised, because the only installs are local clones cut by one
  maintainer.
- A canary earns its keep when the failure it catches is "the default path is
  broken for a subset of users and nobody notices for a week". With one
  operator who runs the build before releasing it, the pre-flight gates in
  section 4 catch the same failure first.
- It has a real cost here: two channels is the usual way an operator ends up on
  a build nobody chose, because "the latest" means something different on each
  machine.

**The conditions that would change this answer**, both required: more than one
external operator who is not the maintainer, and at least one incident caused
by a bad push to the tracked ref that a canary would have caught. When both
hold, the shape is an explicit `VOID_UPDATE_CHANNEL` with values `stable` and
`canary`, resolving to tag prefixes `v` and `canary-v`, printed by `void
config` so an operator can see which one they are on. Until then the channel
is "the tracked remote ref", stated here so it is a decision rather than an
omission. No environment variable for a channel should exist in the code
before then.

### What the updater must never do

- Never rewrite, reorder or delete anything under the operator state
  directory. `docs/RELEASE.md:274-276` is explicit that a ledger rollback is
  never a release rollback.
- Never leave the install tree where `void --version` does not run. If the new
  commit fails its first command, the updater returns the tree to the previous
  commit and exits 1.
- Never require a credential. Section 7.
- Never report a commit it did not read from the tree, and never report a
  version it did not read by running the code.

---

## 6. Why git-based distribution, and not npm

**The findings below are reused from `docs/DISTRIBUTION-PATH.md` sections 2
and 3 rather than re-researched, with the two that have a shelf life
re-checked today.**

**The repository is private.** `docs/DISTRIBUTION-PATH.md:29-33` records that
`GET https://api.github.com/repos/Dawe583/void` returns 404 while the user
account returns 200, so the remote is configured and the repository is not
public. Re-checked 2026-10-01:

```
repos/Dawe583/void -> 404
```

Almost every distribution channel has this as a hard prerequisite, including
npm provenance.

**Nothing is publishable, by tested invariant.** `docs/DISTRIBUTION-PATH.md:84-90`
states it and points at the gate, and it is still true: twelve of the thirteen
manifests are private, and the thirteenth is the one deliberate exception
(section 1). Making a package publishable is a reviewed change to that
invariant, not a flag somebody forgot.

**The unscoped npm name is taken.** `docs/DISTRIBUTION-PATH.md:203-212`
records `void@0.20.3` owned by voidzero-dev/void. Re-checked 2026-10-01, the
package is still there and has moved:

```
npm void latest: 0.22.0 | repo: git+https://github.com/voidzero-dev/void.git
| modified: 2026-10-01T07:56:42.227Z
```

So the plan's own headline install command cannot be the plan's headline
install command. The same check found `@void/cli`, `void-mcp` and `void-ledger`
free (404 each), which is where section 6's later work would start.

**The bin is not installable from npm today.** `docs/DISTRIBUTION-PATH.md:91-103`
records three facts, all still visible in the tree: the `void` and `void-proxy`
bins are declared on the private root manifest, the CLI manifest has no `bin`,
and the entrypoint imports across package boundaries into a `workspace:*`
dependency that npm cannot resolve. Publishing therefore means a bundle, and
`rollup` is already a root dependency.

**None of that is an argument against git-based distribution; it is the
argument for it.** A git clone plus a launcher needs no registry account, no
trusted publishing identity, no scope ownership, no provenance attestation,
and no public repository. It works today on the machine that has the
repository. `void update` is built on it for exactly that reason.

### What must happen before any npm or GitHub Releases channel

Ordered, because each is a prerequisite for the next:

1. **A public repository**, with a secret scan of the full history first.
   `docs/DISTRIBUTION-PATH.md:129` prices this at one session and correctly
   calls it a prerequisite for six other rows rather than a channel itself.
2. **A bundled, installable CLI artifact.** One file, no `workspace:*`, no
   relative imports across package directories, and a clean install outside
   the workspace that runs. The gate already performs exactly that check for
   the one publishable package
   (`scripts/src/release-packaging.test.mjs:170-274`), so the machinery
   exists and is reusable.
3. **A name that is free**, from the free set in this section. The unscoped
   `void` is not available.
4. **A publishing identity and a reviewed publish workflow**, with an explicit
   package allowlist and protected approval. `docs/RELEASE.md:88-98` lists this
   as release blocker 1 and 2, and the instruction there not to un-private a
   manifest to make a publish command pass is the whole reason section 2 does
   not touch the private flags.
5. **Real-service end-to-end evidence**, which `docs/RELEASE.md:104-110`
   records as release blocker 4 and which no packaging change substitutes for.

Until all five are done, the version number is a label, and the honest channel
is the one in section 4.

---

## 7. GitHub Releases as the future artifact host

**Releases are the right eventual host for the artifact, because the artifact
would be a single built file per platform rather than a source tree.** They are
not available now for the same reason npm is not: a private repository has no
Releases page, and the download URLs the tree already advertises point at
paths that cannot exist. `apps/control-plane/ui/src/desktop-downloads.ts:2-6`
hardcodes `https://github.com/Dawe583/void/releases/download/desktop-v0.1.0-beta.4/...`,
which is unreachable today for exactly that reason, not because the tag is
missing.

What it means for the updater, and it is the part worth writing down now:

- **A credential is never required for an update check.** `GITHUB_TOKEN` and
  `GH_TOKEN` are read if present and used only to raise the API rate limit or
  to reach a repository that is still private. With neither set, the check
  still works over `git fetch --tags` in the existing clone, and the updater
  must behave identically apart from the rate limit. An update check that
  needs a token is an update check that fails on a machine where nobody set
  one up.
- **A token is never written down.** Not into the install tree, not into the
  operator state directory, not into a log line. The updater must never print
  one, including in an error message that quotes a command it ran.
- **The check is advisory about a remote and authoritative about the local
  tree.** Which tag is latest is a remote question; which version is installed
  is answered by `void --version`. The updater reports the second and only
  ever reports the first after it has fetched it.

**Rollout order.** Git-only update first, releases second, npm third, because
each step makes the next one possible and none of them is required to update
code that is already on the machine.

---

## 8. Rollback

**The install is a git clone, so rolling back code is a checkout, not an
uninstall.**

**A shallow install cannot roll back until it is given history.** The installer
clones with `--depth 1`, which is the right trade for a first install: it is one
commit and no tags. Verified on 2026-10-02, a fresh `--depth 1` clone reports
`git rev-list --count HEAD` of 1 and `git tag -l` empty, so the checkout below
fails with `error: pathspec 'v0.1.0' did not match any file(s) known to git`.
`void update` fetches commits but never deepens history, so an operator who has
only ever run `void update` still has nothing to roll back to. Fetch the history
once:

```sh
git -C "${VOID_HOME:-$HOME/.local/share/void-cli}" fetch --unshallow --tags
```

That takes the same tree from 1 commit and 0 tags to the full history and every
tag, measured at 440 commits and 5 tags on 2026-10-02. Then:

```sh
git -C "${VOID_HOME:-$HOME/.local/share/void-cli}" checkout v0.1.0
void --version      # prints: void 0.1.0
```

**No `vX.Y.Z` tag exists yet, so that checkout cannot succeed today.** As of
2026-10-02 the repository carries five tags, four of them
`desktop-v0.1.0-beta.N` and one `pre-max-merge-20260926-1910`, and
`git tag -l 'v*'` is empty. The rollback procedure above becomes usable when
section 4's tagging step runs for the first time; until then, the honest
rollback is a commit the operator names explicitly, and the version in
`package.json` is the only version label that exists.

The launcher is version-agnostic: it execs the entrypoint inside whatever tree
it points at, so no reinstall and no PATH change is involved. If a bad version
was published and the tag is still wrong, `--force` after the tag is corrected
moves the tree forward again.

**Rollback leaves the tree on a detached HEAD**, because checking out a tag
does. That is a real operational consequence: `void update` moves a tree that
sits on the tracked branch, so an operator who rolled back must first return
to that branch inside the install tree before `void update` will move it
forward again. Which branch is tracked is per install; read it off the tree
rather than assuming `main`. This document does not state the updater's
message for a detached tree, because the implementation is the text of record
for that (section 5).

**State survives a code rollback because state is not in the tree.** The ledger
is at `~/.void/ledger/<workspace>.jsonl`, the workbench data at
`~/.void/workbench`, approvals at `~/.void/approvals/<workspace>`
(`packages/cli/src/config.ts:31-37`,
`packages/ledger/src/store.ts:55`). Checking out an older commit changes code,
not evidence. That separation is the reason a code rollback is safe here at
all, and it is worth keeping deliberate: nothing in the product should ever
write operator state inside the install tree.

**The one direction that is not reversible is the recovery vault**, and it is
reversible only from a copy. `packages/runtime/src/reserved-vault.ts:303-304`
refuses a `user_version` above what it knows, so a build that raises the vault
schema leaves an older build unable to open it. Therefore:

1. **Before any update, copy the state directory.** `cp -a ~/.void
   ~/.void.before-<version>` is sufficient and is the whole of the backup
   story for the code path; it is not a backup product, and
   `docs/OPERATIONS.md:229-231` says so in its own words.
2. **Rollback of the vault means restoring that copy**, not checking out an
   older tag. The procedure is: stop the proxy, restore the directory, check
   out the older tag, start.
3. **The ledger is never rolled back.** Not truncated, not rewritten, not
   deleted, at any version. `docs/RELEASE.md:274-276`. A rollback that touches
   a signed record is a worse outcome than the bug that caused it.

**Verification either side of the move.** `void verify` exists and is the
proof, before and after: an update that leaves the chain unverified is a
defect, not a successful update, and the correct response is to report it and
stay on the previous tree. `packages/verifier/verify-ledger.mjs` verifies a
ledger with no VOID package dependency at all, which is what makes this check
possible from a machine that cannot run the new build.

**The honest limit.** A rollback restores the code. It cannot un-run a
migration that already ran against an operator's data, and it cannot restore
an operation that a newer build already performed. That is why step 1 is a
copy rather than an instruction to be careful.

---

## 9. What this document does not establish

- **That a push or a tag reaches the remote.** `docs/RELEASE.md:111-114`
  records pushing as credential-blocked. No push, and no remote CI result, is
  claimed here; section 4 step 5 is written as the procedure to run once a
  human has restored access.
- **That `void update` behaves as section 5 specifies.** It is the
  specification. The implementation lands against it and this section is
  corrected if the implementation and the document ever disagree.
- **Whether the npm name situation changes.** The registry was queried on
  2026-10-01 and `void` is taken at 0.22.0. A name can be released later; the
  free set must be re-checked at the time, not assumed from here.
- **How a frozen-lockfile install behaves inside the install tree.** Not run.
  The updater's second output line claims dependencies were installed, and
  that claim needs an end-to-end run against a real clone before a release
  says it.
- **What a from-scratch install on a machine without this repository looks
  like.** The installer lands with the same work as the updater and gets its
  own evidence; nothing here should be read as a substitute for it.