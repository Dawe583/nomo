# Managed Git Commit Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local POSIX `commit` action to `git.managed` version 1 that advances one attached branch with one selected staged path and recovers by appending a new commit.

**Architecture:** Keep the existing worktree and index implementation unchanged in `managed.ts`, including its persisted version 1 capture shape. Put the additive commit protocol in a focused `managed-commit.ts` lifecycle that receives the existing adapter's fixed Git runner and repository readers through a typed internal interface. Bind a concrete branch, complete tree manifest, reflog generation, fixed metadata and digest-derived receipt refs before object writes, then use one prepared `git update-ref --stdin` transaction for each append-only branch change.

**Tech Stack:** TypeScript 5.9, Node.js 24 or newer standard library, Git plumbing commands, MCP SDK already in the workspace, node:test, existing VOID recovery runtime.

**Spec:** `docs/superpowers/specs/2026-09-15-managed-git-commit-recovery-design.md`

## Global Constraints

- Keep adapter ID `git.managed` and version `1`.
- Preserve recovery of existing version 1 `write`, `delete`, `rename`, `stage` and `unstage` captures without migration.
- Add exactly `{ "action": "commit", "path": "src/file.ts" }`; accept no message, identity, mode, content or cross-action fields.
- Support local POSIX, non-bare, single-worktree repositories with SHA-1 or SHA-256, an attached born HEAD, a direct canonical `refs/heads/*` target, files refs and an enabled existing branch reflog.
- Make forward and recovery commits unsigned, single-parent and fixed-metadata. Never run porcelain `commit`, `revert`, `add`, checkout, a shell or a remote command.
- Complete authorization and durable encrypted preparation before any object write. `preflight()` and `prepare()` must not write objects, refs, the real index or the worktree.
- Preserve the raw real index and all worktree bytes and modes. Build each candidate tree through a private index from a captured tree.
- Use receipt refs derived only from SHA-256 digests of operation or recovery IDs. Never interpolate an untrusted ID into a ref, subject or Git argument.
- Treat repository-local configuration and metadata as untrusted. Disable hooks, signing, filters, replacement objects, prompts, pagers, editors, credential helpers, lazy fetch and global/system configuration.
- Keep subprocess output, interactive transaction output and process lifetime bounded. Redact Git stderr and captured paths or bytes from returned errors and evidence.
- Do not add dependencies or change the production recovery runtime, ledger, registry, connector interfaces, recovery configuration or connector version. Only the reusable conformance fixture expectation contract may change in `packages/runtime`.
- Use node:test only, with no test flags. On this machine use the TAP reporter for workspace checks through the existing scripts.
- Do not use Unicode em dash or en dash in code, comments, docs or commit messages.
- Do not touch production accounts, remotes or credentials.

---

## File map

- Create `packages/connectors/src/git/managed-commit.ts`: commit-only capture, preparation, forward receipt transaction, reconciliation, append-only recovery and commit-specific validation.
- Create `packages/connectors/src/git/managed-commit.test.ts`: direct commit protocol, refusal, transaction, reconciliation, concurrency and recovery evidence.
- Modify `packages/connectors/src/git/managed.ts`: add the closed `commit` mutation, expose only typed internal services to the commit lifecycle, and route commit captures without changing legacy capture interpretation.
- Modify `packages/connectors/src/git/managed.test.ts`: prove additive version 1 compatibility and prove older inverses still reject HEAD drift after commit recovery.
- Modify `packages/cli/src/recovery-mcp.ts`: add the exact closed MCP commit branch and truthful local append-only wording.
- Modify `packages/cli/src/recovery-mcp.test.ts`: assert schema order, exact fields and pre-dispatch rejection.
- Modify `packages/cli/src/recovery-git.test.ts`: prove fresh-command forward reconciliation and append-only recovery.
- Modify `packages/runtime/src/conformance.ts`: add optional response-loss reconciliation expectations to the reusable fixture runner without changing production recovery behavior.
- Create `packages/runtime/src/conformance.test.ts`: prove legacy unknown defaults and receipt-aware succeeded/restored expectations with one dispatch each.
- Modify `packages/cli/src/conformance.ts`: add the seventh semantic Git scenario and update truthful per-action capability metadata.
- Modify `packages/cli/src/conformance.test.ts`: assert seven scenarios and 56 shared checks.
- Modify `docs/MANAGED-GIT.md`, `docs/ADAPTER-CONFORMANCE.md`, `docs/RECOVERY-COVERAGE.md`, `docs/REVERSE-UPGRADE-PROGRESS.md` and `docs/UPGRADE-CHECKPOINT.md`: publish the exact claim and limits from the approved design.

### Task 1: Freeze additive types and legacy routing

**Files:**

- Create: `packages/connectors/src/git/managed-commit.ts`
- Create: `packages/connectors/src/git/managed-commit.test.ts`
- Modify: `packages/connectors/src/git/managed.ts:28-36,326-398`
- Modify: `packages/connectors/src/git/managed.test.ts`

**Interfaces:**

- Consumes: existing `RecoveryAdapter`, `Observation`, `Prepared`, `Outcome`, `Reconciliation`, `RecoveryOutcome` and `Json` from `packages/connectors/src/recovery.ts` without edits.
- Produces:

```ts
export type CommitMutation = { action: "commit"; path: string };
export type GitObjectFormat = "sha1" | "sha256";
export type GitEntry =
  | { present: false }
  | { present: true; mode: "100644" | "100755"; oid: string };
export type CommitMetadata = {
  authorName: "VOID Managed Git";
  authorEmail: "managed-git@void.invalid";
  committerName: "VOID Managed Git";
  committerEmail: "managed-git@void.invalid";
  timestamp: string;
  subject: string;
};
export type CommitServices = {
  root: string;
  gitDir: string;
  commonDir: string;
  indexPath: string;
  identity: string;
  objectFormat: GitObjectFormat;
  oidPattern: RegExp;
  git(
    args: readonly string[],
    input?: Buffer | string,
    extraEnv?: NodeJS.ProcessEnv,
  ): string;
  pathTarget(path: string): string;
  currentIdentity(): string;
  validateRepository(): void;
  rawIndex(): Buffer;
  indexRevision(): string;
};
export function createManagedCommitLifecycle(
  services: CommitServices,
): ManagedCommitLifecycle;
```

- Produces a discriminated new capture and plan while retaining legacy JSON whose top-level `before` is `{ mutation, state }` and plan has no `kind`:

```ts
export type CommitCapture = {
  kind: "commit";
  mutation: CommitMutation;
  repository: RepositoryBinding;
  branch: BranchBinding;
  index: IndexBinding;
  selected: SelectedBinding;
  refusalDigest: string;
};
export type CommitPlan = {
  kind: "commit";
  mutation: CommitMutation;
  repository: RepositoryBinding;
  parent: string;
  expectedTreeManifestDigest: string;
  branchRef: string;
  receiptRef: string;
  metadata: CommitMetadata;
};
export type ManagedCommitLifecycle = {
  capture(mutation: CommitMutation): CommitCapture;
  prepare(
    mutation: CommitMutation,
    captured: CommitCapture,
    operationId: string,
  ): CommitPlan;
  execute(
    mutation: CommitMutation,
    captured: CommitCapture,
    plan: CommitPlan,
    operationId: string,
  ): Promise<Outcome>;
  reconcile(
    operationId: string,
    captured: CommitCapture,
    plan: CommitPlan,
  ): Promise<Reconciliation>;
  recover(
    captured: CommitCapture,
    plan: CommitPlan,
    outcome: Outcome,
    recoveryId: string,
  ): Promise<RecoveryOutcome>;
  reconcileRecovery(
    captured: CommitCapture,
    plan: CommitPlan,
    outcome: Outcome,
    recoveryId: string,
  ): Promise<RecoveryOutcome | { status: "unknown" }>;
};
```

- `managed.ts` changes its private union to `type Mutation = LegacyMutation | CommitMutation`, creates one lifecycle after service initialization, and selects commit data only when both `before.kind === "commit"` and `plan.kind === "commit"`. A legacy capture is never cast as a commit capture.

- [ ] **Step 1: Write failing closed-input and compatibility tests**

Add this assertion shape to `managed-commit.test.ts` and the legacy restart assertion to `managed.test.ts`:

```ts
posixTest("commit accepts exactly action and path", async (t) => {
  const fixture = await commitRepository(t);
  await fixture.write("selected", "after");
  fixture.run("add", "selected");
  assert.equal(
    (await fixture.adapter.preflight({ action: "commit", path: "selected" }))
      .readiness,
    "verified",
  );
  for (const args of [
    { action: "commit" },
    { action: "commit", path: 1 },
    { action: "commit", path: "selected", message: "caller text" },
    { action: "commit", path: "selected", base64: "" },
    { action: "commit", path: "selected", mode: 0o644 },
    { action: "commit", path: "selected", to: "other" },
  ] as Json[])
    await assert.rejects(fixture.adapter.preflight(args));
});

posixTest(
  "legacy version 1 prepared JSON still executes and recovers",
  async (t) => {
    const { adapter } = await repository(t);
    const args = {
      action: "write",
      path: "tracked",
      base64: Buffer.from("agent").toString("base64"),
    } as const;
    const observation = await adapter.preflight(args);
    const prepared = JSON.parse(
      JSON.stringify(await adapter.prepare(args, observation, "legacy")),
    );
    assert.equal("kind" in (prepared.before as object), false);
    const outcome = await adapter.execute(args, prepared, "legacy");
    assert.equal(
      (await adapter.recover(prepared, outcome, "legacy-recovery")).status,
      "restored",
    );
  },
);
```

Define the shared direct fixture with concrete helpers, not a mock:

```ts
async function commitRepository(
  t: TestContext,
  format: "sha1" | "sha256" = "sha1",
): Promise<{
  root: string;
  adapter: ReturnType<typeof managedGitAdapter>;
  run(...args: string[]): string;
  write(path: string, value: string | Buffer, mode?: number): Promise<void>;
  snapshot(): Promise<{
    head: string;
    index: Buffer;
    files: Record<string, Buffer | null>;
    refs: string[];
  }>;
}>;
```

The fixture initializes a disposable repository, configures only fixture author identity, commits `selected`, `staged-sentinel` and `unstaged-sentinel`, then makes unrelated staged, unstaged and untracked sentinels available to each test. `snapshot()` reads the real index as bytes, selected and sentinel files directly, and `for-each-ref refs/void/`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```sh
node --test packages/connectors/src/git/managed-commit.test.ts packages/connectors/src/git/managed.test.ts
```

Expected: FAIL because `commit` is unsupported and `managed-commit.ts` does not exist. Existing non-commit tests must still pass.

- [ ] **Step 3: Add the exact types, parser branch and routing skeleton**

Implement the signatures above. In `parse()` accept commit only with:

```ts
if (value.action === "commit") {
  if (Object.keys(value).some((key) => !["action", "path"].includes(key)))
    throw new Error("Invalid Git commit.");
  return { action: "commit", path: value.path };
}
```

Create the commit lifecycle only after `identity`, `gitDir`, `commonDir`, `indexPath`, `oidPattern`, `pathTarget`, `validateRepository`, `indexRevision` and the fixed Git runner exist. Route all six adapter methods to it for `mutation.action === "commit"`. Keep the old `unpack()` and exact legacy branches byte-for-byte equivalent for the five existing actions.

- [ ] **Step 4: Run typecheck and focused tests**

Run:

```sh
pnpm --filter @void/connectors run typecheck
node --test packages/connectors/src/git/managed-commit.test.ts packages/connectors/src/git/managed.test.ts
```

Expected: PASS for parser and legacy tests. Later commit lifecycle tests may remain absent, not skipped.

- [ ] **Step 5: Commit the independently reviewable contract**

```sh
git add packages/connectors/src/git/managed.ts packages/connectors/src/git/managed-commit.ts packages/connectors/src/git/managed.test.ts packages/connectors/src/git/managed-commit.test.ts
git commit -m "Add managed Git commit contract" -m "Co-Authored-By: OpenAI <noreply@openai.com>"
```

### Task 2: Capture the admissible repository and prepare without writes

**Files:**

- Modify: `packages/connectors/src/git/managed-commit.ts`
- Modify: `packages/connectors/src/git/managed-commit.test.ts`

**Interfaces:**

- Consumes: `CommitServices` from Task 1.
- Produces these exact internal bindings and pure helpers:

```ts
type RepositoryBinding = {
  identity: string;
  root: string;
  gitDir: string;
  commonDir: string;
  indexPath: string;
  objectFormat: GitObjectFormat;
  refBackend: "files";
  worktreeCount: 1;
  destructivePaths: FilesRefPathBinding;
};
type PathComponentBinding = {
  path: string;
  kind: "directory" | "file";
  dev: string;
  ino: string;
  uid: string;
};
type ContainedPathChain = {
  target: string;
  existing: PathComponentBinding[];
  missingSuffix: string[];
};
type FilesRefPathBinding = {
  boundary: { commonDir: string; dev: string; ino: string; uid: string };
  branchRef: ContainedPathChain;
  branchReflog: ContainedPathChain;
  voidNamespace: ContainedPathChain;
  operationNamespace: ContainedPathChain;
  recoveryNamespace: ContainedPathChain;
};
type BranchBinding = {
  ref: string;
  head: string;
  tree: string;
  reflogDigest: string;
  reflogGeneration: string;
};
type IndexBinding = {
  rawDigest: string;
  revision: string;
  manifestDigest: string;
};
type WorktreeBinding =
  | { present: false }
  | {
      present: true;
      mode: "100644" | "100755";
      blobOid: string;
      revision: string;
    };
type SelectedBinding = {
  path: string;
  head: GitEntry;
  index: GitEntry;
  worktree: WorktreeBinding;
};
type TreeManifestEntry = {
  path: string;
  mode: "100644" | "100755";
  oid: string;
};

function receiptRef(kind: "operations" | "recoveries", id: string): string;
function captureContainedPathChain(
  commonDir: string,
  target: string,
  expectedLeaf: "directory" | "file" | "missing-or-file",
): ContainedPathChain;
function captureFilesRefPaths(
  commonDir: string,
  branchRef: string,
): FilesRefPathBinding;
function verifyFilesRefPaths(
  binding: FilesRefPathBinding,
  options?: { allowOwnedNamespaceCreation?: boolean },
): FilesRefPathBinding;
function captureCommit(
  mutation: CommitMutation,
  services: CommitServices,
): CommitCapture;
function prepareCommit(
  captured: CommitCapture,
  operationId: string,
  nowSeconds?: number,
): CommitPlan;
function readTreeManifest(
  treeish: string,
  services: CommitServices,
): TreeManifestEntry[];
function applySelectedEntry(
  manifest: readonly TreeManifestEntry[],
  path: string,
  entry: GitEntry,
): TreeManifestEntry[];
function manifestDigest(manifest: readonly TreeManifestEntry[]): string;
```

`receiptRef("operations", id)` returns `refs/void/operations/${sha256(id)}` and `receiptRef("recoveries", id)` returns `refs/void/recoveries/${sha256(id)}`. `subject` is exactly `VOID managed commit ${sha256(operationId).slice(0, 16)}`. Recovery later uses `VOID managed recovery ${sha256(recoveryId).slice(0, 16)}`. `timestamp` is decimal UTC epoch seconds captured once by `prepare()`, and Git dates use `${timestamp} +0000`.

- [ ] **Step 1: Add failing capture and pure-preparation tests**

Use direct snapshots around both `preflight()` and `prepare()`:

```ts
posixTest(
  "preflight and prepare bind the selected staged entry without writing Git state",
  async (t) => {
    const f = await commitRepository(t);
    await f.write("selected", "after", 0o755);
    f.run("add", "selected");
    const before = await f.snapshot();
    const args = { action: "commit", path: "selected" } as const;
    const observed = await f.adapter.preflight(args);
    assert.equal(observed.reversibility, "r1");
    assert.equal(observed.blastRadius.count, 1);
    assert.equal(observed.resources.length, 2);
    assert.ok(observed.resources.every((value) => !value.includes(f.root)));
    const prepared = await f.adapter.prepare(
      args,
      observed,
      "unsafe/id with spaces",
    );
    assert.deepEqual(await f.snapshot(), before);
    const plan = prepared.plan as CommitPlan;
    assert.match(plan.receiptRef, /^refs\/void\/operations\/[0-9a-f]{64}$/);
    assert.ok(!plan.receiptRef.includes("unsafe"));
    assert.equal(
      plan.metadata.subject,
      `VOID managed commit ${sha256("unsafe/id with spaces").slice(0, 16)}`,
    );
    assert.match(plan.metadata.timestamp, /^\d+$/);
    assert.equal((prepared.before as CommitCapture).repository.root, f.root);
  },
);
```

Add table-driven refusal cases with each setup starting from a fresh fixture and asserting an unchanged snapshot:

```ts
const refusedProfiles: Array<{
  name: string;
  arrange(f: CommitFixture): Promise<void> | void;
  error: RegExp;
}> = [
  {
    name: "detached HEAD",
    arrange: (f) => f.run("checkout", "--detach", "-q"),
    error: /attached/,
  },
  {
    name: "unborn HEAD",
    arrange: (f) => f.run("checkout", "--orphan", "unborn"),
    error: /born/,
  },
  {
    name: "second worktree",
    arrange: (f) => f.addWorktree(),
    error: /one registered worktree/,
  },
  {
    name: "shallow",
    arrange: (f) => f.installShallowBoundary(),
    error: /shallow/,
  },
  {
    name: "replace ref",
    arrange: (f) => f.installReplaceRef(),
    error: /replace/,
  },
  { name: "graft", arrange: (f) => f.installGraft(), error: /graft/ },
  {
    name: "alternates",
    arrange: (f) => f.installAlternates(),
    error: /alternate/,
  },
  {
    name: "promisor config",
    arrange: (f) => f.run("config", "remote.origin.promisor", "true"),
    error: /promisor/,
  },
  {
    name: "signing required",
    arrange: (f) => f.run("config", "commit.gpgSign", "true"),
    error: /signing/,
  },
  {
    name: "missing reflog",
    arrange: (f) => f.removeBranchReflog(),
    error: /reflog/,
  },
  {
    name: "branch lock",
    arrange: (f) => f.writeGitPath("refs/heads/main.lock", "foreign"),
    error: /lock/,
  },
  {
    name: "receipt lock",
    arrange: (f) =>
      f.writeGitPath(`refs/void/operations/${sha256("op")}.lock`, "foreign"),
    error: /lock/,
  },
];
```

Add focused destructive-path alias tests for `refs/heads`, `logs/refs/heads`, `refs/void`, `refs/void/operations` and `refs/void/recoveries`. For each fresh repository, move the real component or create the absent namespace in an external temporary directory, put a unique `sentinel` there, and install a symlink at the Git path. Capture the external sentinel, branch, object count, refs, raw index and worktree before preflight. Assert refusal matching `/symbolic link|containment|ownership/`, exact repository snapshot equality, and exact external sentinel bytes. Include a parent alias case, not only a final reflog-file symlink.

Also test sparse and split index, unmerged entries, assume-unchanged and skip-worktree flags, symlink mode `120000`, submodule mode `160000`, unsupported mode, missing object, active operation markers, empty or noncanonical UTF-8 paths, `.git` aliases, staged no-op, unstaged selected edit, and staged deletion with a present worktree path. Assertion shape for every case:

```ts
const before = await f.snapshot();
await assert.rejects(
  f.adapter.preflight({ action: "commit", path: "selected" }),
  profile.error,
);
assert.deepEqual(await f.snapshot(), before);
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```sh
node --test packages/connectors/src/git/managed-commit.test.ts
```

Expected: FAIL at the first missing admissibility or pure-preparation assertion. No branch or receipt ref may appear after failure.

- [ ] **Step 3: Implement bounded capture and preparation**

Use fixed commands only. Resolve the direct symbolic ref with `symbolic-ref -q HEAD`, validate `^refs/heads/(?!.*(?:^|/)\.\.?(?:/|$))[ -~]+$` more strictly by splitting and refusing empty, dot, dot-dot, backslash, control, `~^:?*[`, repeated slash and `.lock` components, then require `rev-parse --symbolic-full-name HEAD` to equal it. Require `rev-parse --show-ref-format` to be `files` and parse `git worktree list --porcelain -z` as exactly one record.

Derive the loose branch ref, branch reflog, `refs/void`, `refs/void/operations` and `refs/void/recoveries` paths only from the validated canonical `commonDir` and concrete branch ref. `captureContainedPathChain()` walks with `lstatSync`, component by component from `commonDir`; every existing component must be non-symlink, canonically contained, owned by the same uid as the captured common-directory boundary, and have the required directory or regular-file kind. Record dev, inode, uid, kind, missing suffix and absolute target for exact recapture. A missing namespace is allowed only below the last verified contained directory. The default `verifyFilesRefPaths()` requires exact existing-component identity. Its locked-only `allowOwnedNamespaceCreation` mode permits a formerly missing receipt namespace component to appear only as a contained, non-symlink directory with the boundary uid, and returns the refreshed binding; it permits no replacement of a previously existing component. Refuse parent aliases and ownership drift. Never rely on `O_NOFOLLOW` on only the final file.

Read the selected branch reflog from the validated path chain under `commonDir/logs/<branchRef>`, with `O_NOFOLLOW`, regular-file, single-link and 16 MiB bounds. Define generation as SHA-256 over `[bytesDigest, dev, ino, size, ctimeNs]`, and retain only digest/generation metadata. Capture raw index SHA-256 plus existing logical revision. Parse complete index and tree manifests in byte-safe `-z` form, reject non-UTF-8 round trips, non-stage-zero entries, modes other than `100644` and `100755`, and missing objects. Verify connectivity with fixed `fsck --connectivity-only --no-dangling` under `GIT_NO_REPLACE_OBJECTS=1` and lazy fetch disabled.

For a present selected worktree, require a single-link non-symlink regular file, derive its Git mode from executable bits, and run `hash-object --no-filters -- <path>` without `-w`; require that OID and mode to equal the selected index entry. For staged deletion, require the worktree path to be absent. Reject `head === index` as a no-op.

Preparation calls `captureCommit()` again, calls `verifyFilesRefPaths()` and compares the complete result with the preflight revision, applies only `selected.index` to the complete captured HEAD manifest in memory, calculates the expected manifest digest, derives the receipt and metadata, and returns. It must not call `hash-object -w`, `write-tree`, `commit-tree` or `update-ref`.

- [ ] **Step 4: Run connector validation**

Run:

```sh
pnpm --filter @void/connectors run typecheck
node --test packages/connectors/src/git/managed-commit.test.ts packages/connectors/src/git/managed.test.ts
```

Expected: PASS for all capture, refusal and no-write assertions.

- [ ] **Step 5: Commit capture and preparation**

```sh
git add packages/connectors/src/git/managed-commit.ts packages/connectors/src/git/managed-commit.test.ts
git commit -m "Bind managed Git commit preparation" -m "Co-Authored-By: OpenAI <noreply@openai.com>"
```

### Task 3: Append the forward commit and durable operation receipt atomically

**Files:**

- Modify: `packages/connectors/src/git/managed-commit.ts`
- Modify: `packages/connectors/src/git/managed-commit.test.ts`

**Interfaces:**

- Consumes: `CommitCapture`, `CommitPlan` and complete manifest digest from Task 2.
- Produces:

```ts
type CommitEvidence = {
  kind: "commit";
  repositoryIdentity: string;
  branchRef: string;
  parent: string;
  tree: string;
  commit: string;
  receiptRef: string;
  expectedTreeManifestDigest: string;
  indexDigest: string;
  worktreeDigest: string;
};
type RefUpdate = { ref: string; newOid: string; oldOid: string | null };
type PrivateIndexWorkspace = {
  directory: string;
  directoryDev: bigint;
  directoryIno: bigint;
  directoryUid: bigint;
  tokenPath: string;
  tokenIno: bigint;
  token: string;
  indexPath: string;
  ownedFiles: Map<string, { dev: bigint; ino: bigint }>;
};
function createPrivateIndexWorkspace(
  realIndexPath: string,
): PrivateIndexWorkspace;
function recordOwnedPrivateFile(
  workspace: PrivateIndexWorkspace,
  path: string,
): void;
function cleanupPrivateIndexWorkspace(workspace: PrivateIndexWorkspace): void;
async function writeCandidateTree(
  baseTree: string,
  path: string,
  entry: GitEntry,
  expectedManifestDigest: string,
  services: CommitServices,
): Promise<string>;
async function createCommit(
  tree: string,
  parent: string,
  metadata: CommitMetadata,
  services: CommitServices,
): Promise<string>;
async function commitRefTransaction(
  updates: readonly RefUpdate[],
  lockedRecheck: () => void,
  services: CommitServices,
): Promise<void>;
function verifyManagedCommit(
  commit: string,
  captured: CommitCapture,
  plan: CommitPlan,
  services: CommitServices,
): CommitEvidence;
```

`CommitEvidence` contains only object IDs and bounded digests. It contains no absolute path, bytes, raw subject, operation ID or credential.

- [ ] **Step 1: Add failing forward transaction tests**

Cover add, modify, staged delete, binary content and executable mode in SHA-1, then repeat a complete modify lifecycle in SHA-256:

```ts
for (const scenario of [
  "add",
  "modify",
  "delete",
  "binary",
  "executable",
] as const) {
  const f = await commitRepository(t);
  await arrangeSelectedStage(f, scenario);
  const before = await f.snapshot();
  const { prepared, outcome } = await dispatchCommit(f.adapter, "forward-op");
  const head = f.run("rev-parse", "HEAD");
  assert.equal(f.run("rev-parse", "HEAD^"), before.head);
  assert.equal(
    f.run("rev-list", "--parents", "-n", "1", head).split(" ").length,
    2,
  );
  assert.equal(
    f.run("rev-parse", (prepared.plan as CommitPlan).receiptRef),
    head,
  );
  assert.equal(
    f.run("diff-tree", "--no-commit-id", "--name-only", "-r", head),
    "selected",
  );
  assert.deepEqual((await f.snapshot()).index, before.index);
  assert.deepEqual((await f.snapshot()).files, before.files);
  assert.equal(JSON.stringify(outcome).includes(f.root), false);
}
```

Verify metadata with `cat-file commit <oid>`:

```ts
assert.match(
  rawCommit,
  /^tree [0-9a-f]+\nparent [0-9a-f]+\nauthor VOID Managed Git <managed-git@void.invalid> \d+ \+0000\ncommitter VOID Managed Git <managed-git@void.invalid> \d+ \+0000\n\nVOID managed commit [0-9a-f]{16}\n$/,
);
assert.ok(!rawCommit.includes("gpgsig"));
assert.ok(Buffer.byteLength(rawCommit) < 1024);
```

Add races by injecting the transaction seam only in tests: branch CAS drift, preexisting receipt, branch reflog append after `prepare: ok`, and timeout. For each assert `HEAD`, existing receipt, raw index and files remain at the raced state and any foreign `.lock` bytes remain unchanged. Run two child Node processes against the same prepared artifact and assert exactly one exits with success, one conflicts, the branch advances once, and exactly one operation receipt exists.

Add deterministic private-index safety tests through the internal helpers. For each real `index.lock` payload in `[Buffer.alloc(0), Buffer.from("foreign lock")]`, create the lock before dispatch, assert refusal, and assert `readFile(realLock)` is byte-for-byte unchanged. Assert `createPrivateIndexWorkspace(realIndexPath).indexPath` does not exist before the first `read-tree`. Inject a Git failure after the private index appears and assert the canonical index parent has no owned temporary directory, while the real index, real `index.lock` and worktree remain exact. Finally rename the owned private directory, recreate its former pathname with a foreign `sentinel`, call cleanup, assert cleanup throws `/identity/`, and assert the foreign sentinel remains byte-for-byte unchanged.

- [ ] **Step 2: Run tests and verify RED**

Run:

```sh
node --test packages/connectors/src/git/managed-commit.test.ts
```

Expected: FAIL because execute does not create the tree, commit and atomic receipt transaction.

- [ ] **Step 3: Implement private-tree creation and fixed commit metadata**

Before creating the private workspace or writing any Git object, `execute()` reruns `captureCommit()`, requires exact capture and plan binding equality, and calls `verifyFilesRefPaths()` with its default exact mode. Call `mkdtempSync(join(dirname(realIndexPath), ".void-git-index-"))` so the private workspace is created atomically under the canonical real-index parent. Immediately `lstatSync(..., { bigint: true })` it, require a real directory owned by the effective process user, set and verify mode `0700`, and create an `owner` token file with `O_CREAT | O_EXCL | O_NOFOLLOW`, mode `0600`, random content and recorded inode. Set `workspace.indexPath` to `<private-directory>/index` and require that pathname not to exist before Git starts. Do not precreate a zero-byte index because `git read-tree` rejects it.

Set `GIT_INDEX_FILE` to that initially nonexistent private pathname only for `read-tree <captured tree>`, `update-index --add --cacheinfo <mode> <oid> <literal path>` or `update-index --force-remove -- <literal path>`, and `write-tree`. After each Git step, `recordOwnedPrivateFile()` records only regular, non-symlink, single-link files whose parent is the still-identical private directory and whose uid matches the directory. Never copy or install the real index and never open, rename or unlink the real `index.lock`.

Cleanup first rechecks the private directory dev, inode, uid, mode and ownership token bytes plus inode. It unlinks only the token, private `index` and private `index.lock` when each current dev/inode matches its recorded owned-file entry and its canonical parent is the private directory. It then calls `rmdirSync` only on the still-identical empty private directory. On identity mismatch, an extra entry, a symlink, replacement or unknown inode, cleanup fails closed and leaves the foreign path untouched. This guarded cleanup runs on success, Git failure and transaction failure.

Read the written tree manifest and require its digest to equal `expectedTreeManifestDigest`. Run `commit-tree <tree> -p <parent>` with the fixed subject on stdin and all six author/committer environment values. Add fixed command config `commit.gpgSign=false`, `user.useConfigOnly=true`, `core.hooksPath=/dev/null`, `filter.<name>.required=false` avoidance by never using filters, plus the existing sanitized environment and `GIT_NO_REPLACE_OBJECTS=1`.

- [ ] **Step 4: Implement one held ref transaction**

Immediately before spawning, call `verifyFilesRefPaths()` again and validate the concrete digest-derived receipt parent chain with `captureContainedPathChain()`. Refuse any new symlink, ownership or containment drift before ref mutation. Spawn exactly `git update-ref --stdin` without a shell. Write these newline-terminated commands:

```text
start
update <branchRef> <commitOid> <parentOid>
create <operationReceiptRef> <commitOid>
prepare
```

Wait for bounded stdout to equal `start: ok\nprepare: ok\n`, keep stdin open, then call `lockedRecheck()`. The recheck first calls `verifyFilesRefPaths(binding, { allowOwnedNamespaceCreation: true })` while the branch lock is held, then rereads the bounded branch reflog, recomputes its digest and file generation, and requires both metadata values to equal capture. Raw reflog bytes are never stored in `CommitCapture`, `CommitPlan`, `Prepared` or the encrypted vault. On success send `commit\n`; on any mismatch send `abort\n`, close stdin and terminate the child. Use a 15 second total timeout, 64 KiB stdout and stderr caps, no retry, and a final kill if graceful termination does not complete. Treat any signal, stderr, unexpected output or nonzero exit as `Managed Git ref transaction failed.` without embedding child output.

After commit, `verifyManagedCommit()` proves the branch and receipt point to the same exact commit, parent and tree; only the selected manifest entry changed; metadata is fixed; real index bytes and every captured worktree state remain unchanged. Content-addressed objects may remain unreachable after transaction failure and must not be deleted.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```sh
pnpm --filter @void/connectors run typecheck
node --test packages/connectors/src/git/managed-commit.test.ts packages/connectors/src/git/managed.test.ts
```

Expected: PASS, including one-winner process concurrency and foreign-lock preservation.

- [ ] **Step 6: Commit forward append support**

```sh
git add packages/connectors/src/git/managed-commit.ts packages/connectors/src/git/managed-commit.test.ts
git commit -m "Append managed Git commits atomically" -m "Co-Authored-By: OpenAI <noreply@openai.com>"
```

### Task 4: Reconcile forward response loss only from the exact receipt

**Files:**

- Modify: `packages/connectors/src/git/managed-commit.ts`
- Modify: `packages/connectors/src/git/managed-commit.test.ts`

**Interfaces:**

- Consumes: `verifyManagedCommit()` and `CommitEvidence` from Task 3.
- Produces:

```ts
function readExactRef(ref: string, services: CommitServices): string | null;
function validateOperationReceipt(
  operationId: string,
  captured: CommitCapture,
  plan: CommitPlan,
  services: CommitServices,
): Outcome | null;
```

`reconcile()` returns `{ status: "succeeded", outcome }` only when the digest-derived exact receipt exists and the fully validated commit matches repository identity, plan parent/tree, fixed metadata and selected/unrelated manifest constraints. Every missing, malformed, wrong or ambiguous receipt returns `{ status: "unknown" }`.

- [ ] **Step 1: Add failing reconciliation matrix**

```ts
posixTest(
  "forward reconciliation requires the exact fully validated receipt",
  async (t) => {
    for (const damage of [
      "none",
      "missing",
      "wrong-commit",
      "corrupt-commit",
      "wrong-repository",
      "ancestry-only",
    ] as const) {
      const f = await commitRepository(t);
      await stageSelectedChange(f, "after");
      const observation = await f.adapter.preflight(COMMIT_ARGS);
      const prepared = await f.adapter.prepare(
        COMMIT_ARGS,
        observation,
        "receipt-op",
      );
      const outcome = await f.adapter.execute(
        COMMIT_ARGS,
        prepared,
        "receipt-op",
      );
      await arrangeReceiptDamage(f, prepared, damage);
      const result = await managedGitAdapter({
        root: f.root,
        cooperative: true,
      }).reconcile("receipt-op", prepared);
      if (damage === "none") {
        assert.equal(result.status, "succeeded");
        assert.deepEqual(
          result.status === "succeeded" && result.outcome,
          outcome,
        );
      } else assert.deepEqual(result, { status: "unknown" });
    }
  },
);
```

Add a separate case that appends unrelated commits after the managed commit and still expects `succeeded`. Add an injected response-loss runtime case that recreates journal, vault and adapter, calls reconciliation once, observes `succeeded`, and asserts one commit and one operation receipt, never redispatch.

- [ ] **Step 2: Run tests and verify RED**

Run:

```sh
node --test packages/connectors/src/git/managed-commit.test.ts
```

Expected: FAIL because commit reconciliation still returns unknown.

- [ ] **Step 3: Implement exact receipt validation**

Read only the digest-derived receipt with `show-ref --verify --hash`. Never search by target equality or ancestry. Parse and validate the referenced commit with bounded `cat-file` and complete tree manifest reads. Rebuild the same bounded `Outcome` and evidence as execute verification. Catch repository, receipt, object or metadata validation errors and return unknown, not failed and not succeeded.

- [ ] **Step 4: Run focused validation and commit**

```sh
pnpm --filter @void/connectors run typecheck
node --test packages/connectors/src/git/managed-commit.test.ts packages/connectors/src/git/managed.test.ts
git add packages/connectors/src/git/managed-commit.ts packages/connectors/src/git/managed-commit.test.ts
git commit -m "Reconcile managed Git commit receipts" -m "Co-Authored-By: OpenAI <noreply@openai.com>"
```

### Task 5: Append recovery after a bounded linear first-parent interval

**Files:**

- Modify: `packages/connectors/src/git/managed-commit.ts`
- Modify: `packages/connectors/src/git/managed-commit.test.ts`

**Interfaces:**

- Consumes: validated operation receipt and ref transaction from Tasks 3 and 4.
- Produces:

```ts
type RecoveryBinding = {
  currentTip: string;
  currentTree: string;
  currentReflogDigest: string;
  currentReflogGeneration: string;
  managedCommit: string;
  selectedBefore: GitEntry;
  selectedAtTip: GitEntry;
  interval: string[];
};
type RecoveryEvidence = {
  kind: "commit-recovery";
  repositoryIdentity: string;
  branchRef: string;
  managedCommit: string;
  parent: string;
  tree: string;
  commit: string;
  receiptRef: string;
  expectedTreeManifestDigest: string;
  indexDigest: string;
  worktreeDigest: string;
};
function captureRecovery(
  captured: CommitCapture,
  plan: CommitPlan,
  evidence: CommitEvidence,
  recoveryId: string,
  services: CommitServices,
): RecoveryBinding;
function validateLinearInterval(
  managedCommit: string,
  currentTip: string,
  selectedPath: string,
  services: CommitServices,
): string[];
function verifyRecoveryCommit(
  commit: string,
  binding: RecoveryBinding,
  captured: CommitCapture,
  receiptRef: string,
  services: CommitServices,
): RecoveryEvidence;
```

`validateLinearInterval()` returns commits after the managed commit through current tip in oldest-to-newest order, permits at most 128 commits, requires exactly one parent per interval commit, and rejects any selected literal-path diff against that commit's parent.

- [ ] **Step 1: Add failing happy-path append-only recovery tests**

```ts
for (const unrelatedCount of [0, 1, 8] as const) {
  const f = await commitRepository(t);
  await stageSelectedChange(f, "managed");
  const done = await dispatchCommit(f.adapter, `op-${unrelatedCount}`);
  const managed = f.run("rev-parse", "HEAD");
  for (let i = 0; i < unrelatedCount; i++)
    await f.commitUnrelated(`later-${i}`);
  const tip = f.run("rev-parse", "HEAD");
  const indexBefore = (await f.snapshot()).index;
  const filesBefore = (await f.snapshot()).files;
  const recovered = await f.adapter.recover(
    done.prepared,
    done.outcome,
    `recovery-${unrelatedCount}`,
  );
  assert.equal(recovered.status, "restored");
  const recovery = f.run("rev-parse", "HEAD");
  assert.notEqual(recovery, managed);
  assert.equal(f.run("rev-parse", `${recovery}^`), tip);
  assert.equal(f.run("merge-base", "--is-ancestor", managed, recovery), "");
  assert.equal(f.run("show", `${recovery}:selected`), "before");
  assert.equal(
    f.run("rev-list", "--parents", "-n", "1", recovery).split(" ").length,
    2,
  );
  assert.deepEqual((await f.snapshot()).index, indexBefore);
  assert.deepEqual((await f.snapshot()).files, filesBefore);
  assert.match(
    f.run("for-each-ref", "--format=%(refname)", "refs/void/recoveries/"),
    /^refs\/void\/recoveries\/[0-9a-f]{64}$/,
  );
}
```

Explicitly assert the selected index entry normally becomes staged again after recovery:

```ts
assert.equal(
  f.run("diff", "--cached", "--name-only", "--", "selected"),
  "selected",
);
```

- [ ] **Step 2: Add failing conflict and ABA tests**

Use fresh repositories for: selected-path change once, selected committed ABA, merge anywhere after managed commit, switched attached branch, detached HEAD, current tip not descended from managed commit, 129 unrelated commits, and a current-tip CAS race. Each assertion uses:

```ts
const before = await f.snapshot();
assert.equal(
  (await f.adapter.recover(done.prepared, done.outcome, recoveryId)).status,
  "conflict",
);
assert.deepEqual(await f.snapshot(), before);
```

For the boundary, prove 128 later commits succeeds and 129 conflicts. For committed ABA, commit `human`, then commit the managed bytes again and still expect conflict. For a merge, use two unrelated branches so the selected path is untouched and still expect conflict due to the two-parent commit.

- [ ] **Step 3: Run tests and verify RED**

Run:

```sh
node --test packages/connectors/src/git/managed-commit.test.ts
```

Expected: FAIL because recover does not append a recovery commit.

- [ ] **Step 4: Implement bounded recovery capture and append**

First validate the original operation receipt exactly and call `verifyFilesRefPaths()` for the captured branch and both receipt namespaces. Require current `symbolic-ref -q HEAD` to equal `plan.branchRef`. Obtain at most 130 first-parent candidates with `rev-list --first-parent --max-count=130 <tip>` and prove the managed commit is reached. For every commit after the managed commit, parse its full parent list and require exactly one parent. Compare `ls-tree -z <parent> -- <literal path>` with the same query on the commit. Any inequality conflicts even if the final tip entry equals the managed value.

Build the recovery manifest by replacing only the selected entry in current tip with `captured.selected.head`. Create a private tree and fixed unsigned commit whose single parent is captured current tip. Validate the concrete recovery receipt parent chain again, then run one held ref transaction with branch CAS and `create refs/void/recoveries/<sha256(recoveryId)> <recoveryCommit>`. While both locks are held, reverify all path chains with `allowOwnedNamespaceCreation: true`, then reread the current reflog and recheck its digest and generation metadata while locked. Never move or delete the operation receipt.

Post-verification proves parent, tree, fixed metadata, selected entry, complete unrelated-tree equality, original managed commit ancestry, unchanged raw real index and unchanged worktree. Return conflict for every pre-transaction unsupported or drift state. If a transaction was sent and its response is uncertain, throw so the runtime records unknown and never repeats it.

- [ ] **Step 5: Run focused tests and commit**

```sh
pnpm --filter @void/connectors run typecheck
node --test packages/connectors/src/git/managed-commit.test.ts packages/connectors/src/git/managed.test.ts
git add packages/connectors/src/git/managed-commit.ts packages/connectors/src/git/managed-commit.test.ts
git commit -m "Append managed Git recovery commits" -m "Co-Authored-By: OpenAI <noreply@openai.com>"
```

### Task 6: Reconcile recovery response loss and preserve older inverse conflicts

**Files:**

- Modify: `packages/connectors/src/git/managed-commit.ts`
- Modify: `packages/connectors/src/git/managed-commit.test.ts`
- Modify: `packages/connectors/src/git/managed.test.ts`

**Interfaces:**

- Consumes: `RecoveryEvidence`, exact recovery receipt and fixed validation from Task 5.
- Produces:

```ts
function validateRecoveryReceipt(
  recoveryId: string,
  captured: CommitCapture,
  plan: CommitPlan,
  outcome: Outcome,
  services: CommitServices,
): RecoveryOutcome | null;
```

`reconcileRecovery()` returns `{ status: "restored", evidence }` only from the exact recovery receipt and fully validated recovery commit. Equality, ancestry, another receipt, or an absent receipt returns `{ status: "unknown" }`.

- [ ] **Step 1: Add failing recovery reconciliation and response-loss tests**

```ts
posixTest(
  "lost recovery response creates no second recovery commit",
  async (t) => {
    const f = await runtimeCommitFixture(t);
    const runtime = f.runtime({ loseRecoveryResponse: true });
    assert.equal((await runtime.execute(f.request)).status, "succeeded");
    const plan = await runtime.planRecovery("test", "operation");
    assert.equal(
      (await runtime.recover(plan, async () => true)).status,
      "unknown",
    );
    const afterLoss = f.run("rev-list", "--count", "HEAD");
    const restarted = f.runtime();
    assert.equal(
      (await restarted.reconcileRecovery("test", "operation")).status,
      "restored",
    );
    assert.equal(f.run("rev-list", "--count", "HEAD"), afterLoss);
    assert.equal(
      f
        .run("for-each-ref", "--format=%(refname)", "refs/void/recoveries/")
        .split("\n")
        .filter(Boolean).length,
      1,
    );
  },
);
```

Repeat the Task 4 damage matrix for missing, wrong commit, corrupt metadata, wrong repository and equality without a receipt. Every damaged case returns unknown.

- [ ] **Step 2: Add the composition regression for old inverses**

In `managed.test.ts`, execute a legacy `write`, `stage`, `delete` and `rename` operation in separate fixtures, then create and recover a standalone managed commit on another path. Call the older operation's `recover()` and assert:

```ts
assert.equal(oldRecovery.status, "conflict");
assert.equal(run("rev-parse", "HEAD"), recoveryCommit);
assert.deepEqual(await readFile(indexPath), indexBeforeOldRecovery);
assert.deepEqual(await readSentinels(), sentinelsBeforeOldRecovery);
```

This test must not weaken `exactForMutation()` or its HEAD binding. Tree equality is not accepted as a replacement.

- [ ] **Step 3: Run tests and verify RED**

Run:

```sh
node --test packages/connectors/src/git/managed-commit.test.ts packages/connectors/src/git/managed.test.ts
```

Expected: FAIL at recovery receipt reconciliation. The old inverse composition assertions should already pass once recovery appends HEAD.

- [ ] **Step 4: Implement exact recovery receipt reconciliation**

Derive only `refs/void/recoveries/${sha256(recoveryId)}`. Validate repository binding, original operation receipt, recovery commit metadata, single parent, selected entry, unrelated full tree manifest and managed-commit ancestry. Return unknown on missing or invalid evidence. Never call `recover()` from `reconcileRecovery()` and never dispatch an update-ref transaction during reconciliation.

- [ ] **Step 5: Run connector tests and commit**

```sh
pnpm --filter @void/connectors run typecheck
node --test packages/connectors/src/git/managed-commit.test.ts packages/connectors/src/git/managed.test.ts
git add packages/connectors/src/git/managed-commit.ts packages/connectors/src/git/managed-commit.test.ts packages/connectors/src/git/managed.test.ts
git commit -m "Reconcile Git recovery receipts" -m "Co-Authored-By: OpenAI <noreply@openai.com>"
```

### Task 7: Complete adversarial configuration, sentinel and drift coverage

**Files:**

- Modify: `packages/connectors/src/git/managed-commit.ts`
- Modify: `packages/connectors/src/git/managed-commit.test.ts`

**Interfaces:**

- Consumes: complete commit lifecycle from Tasks 1 through 6.
- Produces no new public interface. It closes the approved failure and security matrix through regression tests and minimal validation fixes.

- [ ] **Step 1: Add sentinel tests that fail if forbidden processes execute**

Create executable sentinels for `pre-commit`, `commit-msg`, `post-commit`, editor, sequence editor, pager, signer, askpass, credential helper, clean filter, smudge filter and a fake remote transport. Configure each in repository-local config and environment, execute and recover a commit, then assert:

```ts
await assert.rejects(stat(sentinelPath), { code: "ENOENT" });
assert.equal(remoteRequests.length, 0);
assert.ok(!JSON.stringify(outcome).includes("sentinel-secret"));
```

The signing-required configuration case is refusal before object write. Benign configured hooks, editors and filters are ignored and never invoked. Add a `GIT_CONFIG_COUNT` environment injection and prove the adapter replaces, rather than inherits, it.

- [ ] **Step 2: Add exact drift matrices**

Between capture and prepare, and separately between prepare and execute, mutate one item per fresh fixture: repository inode/layout binding, HEAD, branch ref, branch reflog away-and-back, raw index bytes, logical index entry, selected worktree bytes, selected mode, active marker, replace ref, config, operation receipt, branch lock and missing object. Assert rejection, unchanged refs, exact raw index and exact worktree snapshot.

During recovery mutate: current branch, current tip, current reflog away-and-back, selected index, selected worktree, operation receipt, recovery receipt and repository identity. Assert conflict before transaction, except uncertain post-dispatch response which remains unknown for reconciliation.

- [ ] **Step 3: Run tests and verify RED where a guard is missing**

```sh
node --test packages/connectors/src/git/managed-commit.test.ts
```

Expected: any missing hardening guard produces a focused failure naming the changed observation. Do not loosen an assertion to make it green.

- [ ] **Step 4: Make only minimal hardening fixes**

Extend the captured refusal digest and exact recapture comparison for every failing observation. Keep errors fixed and bounded. Do not include child stderr, absolute paths, ref contents, subject text beyond the fixed format, file bytes, credentials or environment values. Never unlink a lock unless this process created it and inode plus ownership token still match.

- [ ] **Step 5: Run focused and package validation, then commit**

```sh
pnpm --filter @void/connectors run typecheck
node --test packages/connectors/src/git/managed-commit.test.ts packages/connectors/src/git/managed.test.ts
pnpm --filter @void/connectors test
git add packages/connectors/src/git/managed-commit.ts packages/connectors/src/git/managed-commit.test.ts
git commit -m "Harden managed Git commit recovery" -m "Co-Authored-By: OpenAI <noreply@openai.com>"
```

### Task 8: Expose the exact MCP schema and CLI restart lifecycle

**Files:**

- Modify: `packages/cli/src/recovery-mcp.ts:205-252`
- Modify: `packages/cli/src/recovery-mcp.test.ts:303-350`
- Modify: `packages/cli/src/recovery-git.test.ts`

**Interfaces:**

- Consumes: unchanged `RecoveryAdapter` and existing Git recovery config.
- Produces one additional MCP `mutation.oneOf` member:

```ts
{
  type: "object",
  additionalProperties: false,
  required: ["action", "path"],
  properties: {
    action: { type: "string", enum: ["commit"] },
    path: { type: "string", description: "Selected staged regular-file path" },
  },
}
```

No CLI config, runtime request or command syntax changes. Add one private boundary validator with the exact signature:

```ts
function validateGitMutation(value: unknown): asserts value is Json;
```

It accepts only the six action-specific closed shapes advertised by the schema, including exactly `{ action: "commit", path: string }`, and runs before `options.runtime.execute()`.

- [ ] **Step 1: Add failing MCP closed-union tests**

Change the schema order assertion to:

```ts
assert.deepEqual(
  mutation.oneOf.map((item) => item.properties.action.enum[0]),
  ["write", "delete", "stage", "unstage", "rename", "commit"],
);
const commit = mutation.oneOf.at(-1)!;
assert.deepEqual(commit.required, ["action", "path"]);
assert.deepEqual(Object.keys(commit.properties).sort(), ["action", "path"]);
assert.equal(commit.additionalProperties, false);
```

Add invalid mutations `{action:"commit"}`, numeric path, and commit with each of `base64`, `mode`, `to`, `message`, `author`, `committer` and `sign`. First use a runtime stub whose `execute()` increments `dispatches`; call every invalid mutation and assert `dispatches === 0`, proving refusal before adapter dispatch. Repeat against the real signed runtime and compare branch OID, raw index, worktree snapshot and all `refs/void/` before and after. Then call the valid commit action and assert succeeded with `dispatches === 1` in the stub case.

- [ ] **Step 2: Add failing fresh-command CLI lifecycle test**

Use the existing `runRecoveryCommand` helper with the existing Git config. Stage one selected change, execute it, replace the input with `{ workspace, operationId }`, and assert a fresh `reconcile` command returns succeeded after forward response evidence. Plan/apply recovery, assert HEAD is a new child of the managed commit or later unrelated tip, then run `reconcile-recovery` from another fresh command and assert restored. Read raw index and worktree before and after each append and assert deep equality.

- [ ] **Step 3: Run tests and verify RED**

```sh
node --test packages/cli/src/recovery-mcp.test.ts packages/cli/src/recovery-git.test.ts
```

Expected: FAIL because the MCP union lacks commit and the CLI lifecycle cannot yet dispatch it through the schema.

- [ ] **Step 4: Add the schema member and truthful description**

Implement `validateGitMutation()` with per-action exact key sets and required value types, and call it in the `void_execute` branch before `options.runtime.execute()`. Keep the adapter parser as defense in depth. Update the Git tool description to say local cooperative POSIX selected branch-tree commit recovery, append-only recovery, unchanged real index/worktree and durable local receipt refs. State that no remote is contacted and dangling content-addressed objects may remain. Remove the obsolete blanket `No commits` sentence but retain all exclusions not changed by this slice.

- [ ] **Step 5: Run CLI validation and commit**

```sh
pnpm --filter @void/cli run typecheck
node --test packages/cli/src/recovery-mcp.test.ts packages/cli/src/recovery-git.test.ts
git add packages/cli/src/recovery-mcp.ts packages/cli/src/recovery-mcp.test.ts packages/cli/src/recovery-git.test.ts
git commit -m "Expose managed Git commit recovery" -m "Co-Authored-By: OpenAI <noreply@openai.com>"
```

### Task 9: Teach reusable conformance about receipt-aware actions and add the seventh Git scenario

**Files:**

- Modify: `packages/runtime/src/conformance.ts:6-17,47-154`
- Create: `packages/runtime/src/conformance.test.ts`
- Modify: `packages/cli/src/conformance.ts:138-220`
- Modify: `packages/cli/src/conformance.test.ts:151-166`

**Interfaces:**

- Consumes: production `recoveryRuntime()` behavior and the unchanged `RecoveryAdapter` contract.
- Adds only these optional fields to the reusable test fixture:

```ts
export type ConformanceFixture = {
  adapter(): RecoveryAdapter;
  options(): Omit<RuntimeOptions, "adapters" | "authorize">;
  arguments: Json;
  changedArguments: Json;
  before: Json;
  after: Json;
  human: Json;
  read(): Promise<Json>;
  writeHuman(): Promise<void>;
  dispose(): Promise<void>;
  expectedExecutionReconciliation?: "unknown" | "succeeded";
  expectedRecoveryReconciliation?: "unknown" | "restored";
};
```

- Legacy fixtures omit both fields and retain the current `unknown` response-loss expectations.
- The commit fixture sets `expectedExecutionReconciliation: "succeeded"` and `expectedRecoveryReconciliation: "restored"`. The shared runner still asserts exactly one `execute()` and one `recover()` call.
- Produces `type GitScenario = "create" | "write" | "delete" | "rename" | "stage" | "unstage" | "commit"` on POSIX and a report with seven scenarios and 56 checks.
- Keeps profile-wide `durableExecutionReceipt: false` and `durableRecoveryReceipt: false` because five public legacy actions, plus create-by-write, lack receipts. Adds only:

```ts
actionReceipts: {
  commit: {
    durableExecutionReceipt: true;
    durableRecoveryReceipt: true;
  }
}
```

- [ ] **Step 1: Write failing runtime conformance contract tests**

Create `packages/runtime/src/conformance.test.ts`. Build a disposable fixture factory whose adapter mutates an in-memory semantic value, whose durable execution and recovery booleans are visible to `reconcile()` and `reconcileRecovery()`, and whose methods refuse a second dispatch:

```ts
test("conformance defaults response-loss reconciliation to unknown", async () => {
  const calls = { execute: 0, recover: 0 };
  const report = await runAdapterConformance(
    { id: "receipt.fixture", version: "1" },
    () => conformanceFixture({ calls }),
  );
  assert.equal(report.passed, true);
  assert.equal(
    report.checks.find((check) => check.id === "lost-execution-response")
      ?.passed,
    true,
  );
  assert.equal(
    report.checks.find((check) => check.id === "lost-recovery-response")
      ?.passed,
    true,
  );
});

test("conformance accepts durable response-loss reconciliation without redispatch", async () => {
  const perFixtureCalls: Array<{ execute: number; recover: number }> = [];
  const report = await runAdapterConformance(
    { id: "receipt.fixture", version: "1" },
    async () => {
      const calls = { execute: 0, recover: 0 };
      perFixtureCalls.push(calls);
      return conformanceFixture({
        calls,
        expectedExecutionReconciliation: "succeeded",
        expectedRecoveryReconciliation: "restored",
      });
    },
  );
  assert.equal(report.passed, true);
  assert.equal(
    report.checks.find((check) => check.id === "lost-execution-response")
      ?.passed,
    true,
  );
  assert.equal(
    report.checks.find((check) => check.id === "lost-recovery-response")
      ?.passed,
    true,
  );
  assert.ok(perFixtureCalls.every((calls) => calls.execute <= 1));
  assert.ok(perFixtureCalls.every((calls) => calls.recover <= 1));
});
```

`conformanceFixture()` has this exact test-only signature:

```ts
function conformanceFixture(options: {
  calls: { execute: number; recover: number };
  expectedExecutionReconciliation?: "succeeded";
  expectedRecoveryReconciliation?: "restored";
}): Promise<ConformanceFixture>;
```

Its `execute()` and `recover()` increment their counter and use `assert.equal(counter, 1)`. Its receipt-aware `reconcile()` returns the exact recorded `Outcome` only after execution, and `reconcileRecovery()` returns `{ status: "restored", evidence: { verified: true } }` only after recovery. The default fixture returns unknown from both methods. Use the existing local journal and reserved vault test helpers with a disposable directory, generated Ed25519 signer and random 32-byte vault key. Do not change production runtime code.

- [ ] **Step 2: Run the runtime conformance test and verify RED**

```sh
node --test packages/runtime/src/conformance.test.ts
```

Expected: the legacy-default case passes and the receipt-aware case fails because `ConformanceFixture` has no expectation fields and the runner hardcodes unknown after both lost responses.

- [ ] **Step 3: Implement optional expectations in the reusable runner**

At fixture creation, calculate:

```ts
const expectedExecutionReconciliation =
  f.expectedExecutionReconciliation ?? "unknown";
const expectedRecoveryReconciliation =
  f.expectedRecoveryReconciliation ?? "unknown";
```

In `lost-execution-response`, keep the first injected result assertion as `unknown`, then reopen and assert:

```ts
assert.equal(
  (await runtime().execute(request)).status,
  expectedExecutionReconciliation,
);
assert.equal(executions, 1);
assert.deepEqual(await f.read(), f.after);
```

In `lost-recovery-response`, keep the first injected result assertion as `unknown`, then reopen and assert:

```ts
assert.equal(
  (await runtime().recover(plan, async () => true)).status,
  expectedRecoveryReconciliation,
);
assert.equal(recoveries, 1);
assert.deepEqual(await f.read(), f.before);
```

Do not edit `packages/runtime/src/execute.ts`, any production runtime method, journal/vault behavior or `packages/connectors/src/recovery.ts`.

- [ ] **Step 4: Add failing Git profile and report assertions**

In `packages/cli/src/conformance.test.ts` assert:

```ts
assert.deepEqual(
  gitConformanceProfile.operations,
  process.platform === "win32"
    ? []
    : ["create", "write", "delete", "rename", "stage", "unstage", "commit"],
);
assert.equal(gitConformanceProfile.durableExecutionReceipt, false);
assert.equal(gitConformanceProfile.durableRecoveryReceipt, false);
assert.deepEqual(gitConformanceProfile.actionReceipts, {
  commit: {
    durableExecutionReceipt: true,
    durableRecoveryReceipt: true,
  },
});
assert.equal(gitConformanceProfile.certification, false);
assert.equal(gitConformanceProfile.conformance.sharedRuntimeChecksOnly, true);
if (process.platform !== "win32") {
  assert.equal(report.scenarios.length, 7);
  assert.equal(
    report.scenarios.reduce((sum, item) => sum + item.checks.length, 0),
    56,
  );
  assert.ok(
    report.scenarios.every((item) =>
      item.checks.every((check) => check.passed),
    ),
  );
}
```

- [ ] **Step 5: Run CLI conformance tests and verify RED**

```sh
node --test packages/cli/src/conformance.test.ts
```

Expected: FAIL because the profile has six operations and 48 Git checks, and has no commit-only receipt metadata.

- [ ] **Step 6: Implement the semantic commit fixture**

For `operation === "commit"`, stage `editedBuffer` at `sample.bin`, set `before.selected` to `HEAD:sample.bin`, set `after.selected` to the staged tree entry, and make `read()` resolve `HEAD:sample.bin` rather than the real index entry. Set both optional reconciliation expectations on this fixture only. All legacy scenario fixtures omit them.

After forward execution, HEAD changes and after recovery HEAD changes again. The generic fixture must therefore observe the declared selected branch-tree resource, not exact repository history:

```ts
type CommitFixtureState = {
  selected: string | null;
  index: string[];
  rawIndex: string;
  worktree: Json;
};
```

Set `before.selected` to the original branch-tree entry and `after.selected` to the managed branch-tree entry. Recovery then equals `before` for this declared resource while append-only history remains intentionally different. `writeHuman()` appends a selected-path commit so the human-drift check conflicts without destroying state. Do not make the generic runner prove no history rewrite; direct connector tests from Task 5 remain that authority.

Update exclusions by removing `commits`; retain remotes, multi-path commit, merge recovery, Windows, process death, power loss and noncooperative writers. Set recovery wording to `selected-worktree-or-index-or-append-only-branch-tree`. Keep both adapter-wide durable receipt booleans false and add only the `actionReceipts.commit` object defined above.

- [ ] **Step 7: Run the exact disposable report and tests**

```sh
pnpm --filter @void/runtime run typecheck
node --test packages/runtime/src/conformance.test.ts
node --test packages/cli/src/conformance.test.ts
node packages/cli/bin/void.mjs recovery conformance --adapter git.managed
```

Expected: exit 0 on POSIX, seven scenarios, 56 passed checks, commit response-loss checks reconcile to succeeded/restored with one execute/recover, and `certification:false` plus `sharedRuntimeChecksOnly:true`. Windows retains one explicit platform-refusal scenario and no mutation.

- [ ] **Step 8: Commit conformance evidence**

```sh
git add packages/runtime/src/conformance.ts packages/runtime/src/conformance.test.ts packages/cli/src/conformance.ts packages/cli/src/conformance.test.ts
git commit -m "Add Git commit conformance scenario" -m "Co-Authored-By: OpenAI <noreply@openai.com>"
```

### Task 10: Publish scoped documentation and verification evidence

**Files:**

- Modify: `docs/MANAGED-GIT.md`
- Modify: `docs/ADAPTER-CONFORMANCE.md`
- Modify: `docs/RECOVERY-COVERAGE.md`
- Modify: `docs/REVERSE-UPGRADE-PROGRESS.md`
- Modify: `docs/UPGRADE-CHECKPOINT.md`

**Interfaces:**

- Consumes: verified behavior and exact commands from Tasks 1 through 9.
- Produces no code interface. Documentation uses the exact claim: local POSIX cooperative standalone selected branch-tree R1 recovery with an append-only trace.

- [ ] **Step 1: Add the public action and exact guarantees to `MANAGED-GIT.md`**

Document `{ "action": "commit", "path": "src/file.ts" }`, fixed VOID subject and identity, captured UTC time, unsigned single-parent commits, complete-tree verification, atomic branch plus receipt refs, forward reconciliation, 128-commit linear recovery interval, selected-path committed ABA refusal and unchanged real index/worktree. State that unrelated later linear commits remain ancestors.

Add explicit limits: receipt refs retain commits; failed transactions can leave dangling objects with selected bytes; object writes occur only after authorization and durable encrypted capture; recovery is not secret/object deletion; standalone commit does not make earlier worktree/index jobs composable; an older inverse still conflicts on HEAD drift; remote publication is separate and no local recovery retracts a push; exactly one worktree and files refs only; no Windows, merge recovery, multi-path, caller message, signing, directory, rewrite, ref cleanup or full-run composition.

State cooperative writer mutex plus Git lock boundary, noncooperative/admin exclusions, bounded interactive transaction behavior, unverified process-death and physical power-loss limits.

- [ ] **Step 2: Update conformance and coverage claims**

In `ADAPTER-CONFORMANCE.md`, change Git counts from six/48 to seven/56 and describe the commit fixture's branch-tree resource plus independent index/worktree sentinels. Keep `certification:false` and `sharedRuntimeChecksOnly:true`. State that direct connector tests, not the generic runner, prove append-only history.

In `RECOVERY-COVERAGE.md`, replace the Managed Git row with commit-specific durable receipt and append-only recovery language while preserving legacy receipt limitations. Do not mark R05 complete.

- [ ] **Step 3: Update progress and checkpoint with measured results only**

In `REVERSE-UPGRADE-PROGRESS.md`, update R05 to include the standalone local commit slice and leave remote recovery, Windows Git, merge recovery and broader writer guarantees pending. Replace the old next-step wording that says commit recovery is unimplemented. Add the exact focused and conformance results actually observed.

In `UPGRADE-CHECKPOINT.md`, add a `Managed Git commit recovery` subsection with the same boundary and limits. Update counts only from fresh command output. Do not claim certification, production use, process-death, power-loss, remote retraction or full job composition.

- [ ] **Step 4: Run documentation and forbidden-character checks**

```sh
python3 -c 'from pathlib import Path; files=[Path(value) for value in ["packages/connectors/src/git/managed.ts","packages/connectors/src/git/managed-commit.ts","packages/connectors/src/git/managed.test.ts","packages/connectors/src/git/managed-commit.test.ts","packages/cli/src/recovery-mcp.ts","packages/cli/src/recovery-mcp.test.ts","packages/cli/src/recovery-git.test.ts","packages/cli/src/conformance.ts","packages/cli/src/conformance.test.ts","docs/MANAGED-GIT.md","docs/ADAPTER-CONFORMANCE.md","docs/RECOVERY-COVERAGE.md","docs/REVERSE-UPGRADE-PROGRESS.md","docs/UPGRADE-CHECKPOINT.md"]]; bad=[str(path) for path in files if any(ord(char) in {8211,8212} for char in path.read_text())]; assert not bad, bad'
```

Expected: exit 0 with no output.

- [ ] **Step 5: Run complete verification**

```sh
pnpm --filter @void/connectors run typecheck
pnpm --filter @void/runtime run typecheck
pnpm --filter @void/cli run typecheck
node --test packages/runtime/src/conformance.test.ts
node --test packages/connectors/src/git/managed-commit.test.ts packages/connectors/src/git/managed.test.ts
node --test packages/cli/src/recovery-mcp.test.ts packages/cli/src/recovery-git.test.ts packages/cli/src/conformance.test.ts
node packages/cli/bin/void.mjs recovery conformance --adapter git.managed
pnpm run test:reverse
pnpm run typecheck
pnpm run check
pnpm run build
/Users/dawe/Developer/Claude-Projects/VOID/node_modules/.bin/prettier --check packages/connectors/src/git/managed.ts packages/connectors/src/git/managed-commit.ts packages/connectors/src/git/managed.test.ts packages/connectors/src/git/managed-commit.test.ts packages/cli/src/recovery-mcp.ts packages/cli/src/recovery-mcp.test.ts packages/cli/src/recovery-git.test.ts packages/cli/src/conformance.ts packages/cli/src/conformance.test.ts docs/MANAGED-GIT.md docs/ADAPTER-CONFORMANCE.md docs/RECOVERY-COVERAGE.md docs/REVERSE-UPGRADE-PROGRESS.md docs/UPGRADE-CHECKPOINT.md
git diff --check
```

Expected: every command exits 0. The conformance JSON contains seven POSIX scenarios and 56 passed checks. Record exact test totals from output rather than copying prior checkpoint counts.

- [ ] **Step 6: Review the final diff against the approved exclusions**

```sh
git diff --stat
git diff --name-only "$(git merge-base HEAD main)" -- packages/runtime | sort
git diff "$(git merge-base HEAD main)" -- packages/connectors/src/recovery.ts packages/runtime ':(exclude)packages/runtime/src/conformance.ts' ':(exclude)packages/runtime/src/conformance.test.ts' packages/ledger packages/registry package.json pnpm-lock.yaml
git status --short
```

Expected: the first restricted command prints exactly `packages/runtime/src/conformance.test.ts` and `packages/runtime/src/conformance.ts`. The second restricted command prints nothing. `git status --short` lists only the files in this plan. Confirm there is no production runtime/config/interface change, dependency or lockfile change, remote command, caller message/signing surface, history rewrite, receipt cleanup or secret.

- [ ] **Step 7: Commit verified docs and integration**

```sh
git add docs/MANAGED-GIT.md docs/ADAPTER-CONFORMANCE.md docs/RECOVERY-COVERAGE.md docs/REVERSE-UPGRADE-PROGRESS.md docs/UPGRADE-CHECKPOINT.md
git commit -m "Document append-only Git commit recovery" -m "Co-Authored-By: OpenAI <noreply@openai.com>"
```

## Final self-review gate

- [ ] Map every approved spec section to Tasks 1 through 10: public contract and compatibility in Task 1; admissibility and preparation in Task 2; forward transaction in Task 3; forward reconciliation in Task 4; append-only recovery in Task 5; recovery reconciliation and composition in Task 6; security and failures in Task 7; MCP contract in Task 8; seven-scenario conformance in Task 9; documentation and claims in Task 10.
- [ ] Search the plan and changed files for placeholder phrases, skipped tests, test flags, Unicode en/em dashes, secrets, new dependencies and forbidden porcelain or remote commands. Resolve every match before handoff.
- [ ] Check type consistency: `CommitMutation`, `GitEntry`, `CommitCapture`, `CommitPlan`, `CommitEvidence`, `RecoveryBinding`, `RecoveryEvidence`, `CommitServices`, `ManagedCommitLifecycle`, `FilesRefPathBinding` and `PrivateIndexWorkspace` have one spelling and one definition; receipt helpers always use SHA-256; `RecoveryAdapter` stays unchanged.
- [ ] Confirm every object-writing call occurs only in `execute()` or `recover()` after runtime authorization and durable capture, and every uncertain ref transaction remains unknown without retry.
- [ ] Confirm all legacy capture paths stay readable and their HEAD-drift checks stay strict.

## Plan author self-review completed

- [x] Spec coverage: every public contract, admissibility, capture, forward transaction, receipt reconciliation, append-only recovery, human-state, failure/security, conformance and documentation requirement maps to a named task. No approved out-of-scope feature was added.
- [x] Placeholder scan: the plan contains no deferred implementation phrases and every code task has concrete signatures, assertion shapes, commands and expected results.
- [x] Type consistency: all commit lifecycle types and helper names use one spelling, receipt derivation is SHA-256 throughout, legacy captures remain undiscriminated, new captures use `kind: "commit"`, `RecoveryAdapter` is not changed, only the reusable conformance fixture receives optional expectation fields, private index cleanup is identity-bound, and destructive ref/reflog paths use one contained path-chain contract.
