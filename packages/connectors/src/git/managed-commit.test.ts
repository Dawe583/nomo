import test, { type TestContext } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  chmodSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { managedGitAdapter } from "./managed.ts";
import {
  cleanupPrivateIndexWorkspace,
  captureContainedPathChain,
  commitRefTransaction,
  createCommit,
  createPrivateIndexWorkspace,
  parseIndexManifest,
  parseTreeManifest,
  recordOwnedPrivateFile,
  writeCandidateTree,
  verifySelectedHumanState,
  verifyFilesRefPaths,
  type CommitCapture,
  type CommitServices,
  type CommitPlan,
} from "./managed-commit.ts";
import type { Json } from "../recovery.ts";
import {
  localOperationJournal,
  localRecoveryVault,
  recoveryRuntime,
  type ExecutionRequest,
} from "../../../runtime/src/index.ts";
import { devKeyProvider } from "../../../ledger/src/sign.ts";

const posixTest = process.platform === "win32" ? test.skip : test;
const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

type PathSnapshot =
  | { present: false }
  | {
      present: true;
      kind: "file" | "directory" | "symlink" | "other";
      mode: string;
      dev: string;
      ino: string;
      uid: string;
      nlink: string;
      size: string;
      ctimeNs: string;
      bytes?: Buffer;
      link?: string;
    };
type Snapshot = {
  rootBoundary: PathSnapshot;
  commonBoundary: PathSnapshot;
  head: string;
  index: PathSnapshot;
  looseBranchRef: PathSnapshot;
  branchReflog: PathSnapshot;
  packedRefs: PathSnapshot;
  config: PathSnapshot;
  gitMetadata: Record<string, PathSnapshot>;
  worktree: Record<string, PathSnapshot>;
  refs: string[];
  objects: string[];
};
type CommitFixture = Awaited<ReturnType<typeof commitRepository>>;

async function commitRepository(
  t: TestContext,
  format: "sha1" | "sha256" = "sha1",
) {
  const createdRoot = await mkdtemp(join(tmpdir(), "void-git-commit-"));
  const root = await realpath(createdRoot);
  const extras: string[] = [];
  t.after(async () => {
    await Promise.all(extras.map((path) => rm(path, { recursive: true, force: true })));
    await rm(root, { recursive: true, force: true });
  });
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", `--object-format=${format}`, root]);
  run("config", "user.name", "VOID test");
  run("config", "user.email", "void@example.invalid");
  await writeFile(join(root, "selected"), "before");
  await writeFile(join(root, "staged-sentinel"), "base");
  await writeFile(join(root, "unstaged-sentinel"), "base");
  run("add", "selected", "staged-sentinel", "unstaged-sentinel");
  run("commit", "-qm", "initial");
  await writeFile(join(root, "staged-sentinel"), "staged");
  run("add", "staged-sentinel");
  await writeFile(join(root, "unstaged-sentinel"), "unstaged");
  await writeFile(join(root, "untracked-sentinel"), "untracked");
  const registeredGitPaths = new Set<string>();
  const registeredWorktreePaths = new Set<string>();
  const directoryBindings = new Map<string, BigIntStats>();
  const bindFixedPath = (path: string, boundary: string, registry: Set<string>) => {
    let current = path;
    for (;;) {
      registry.add(current);
      try {
        const item = lstatSync(current, { bigint: true });
        if (item.isDirectory() && !item.isSymbolicLink()) directoryBindings.set(current, item);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (current === boundary) break;
      const parent = dirname(current);
      if (parent === current || !current.startsWith(`${boundary}${sep}`)) break;
      current = parent;
    }
  };
  const gitPaths = new Map<string, string>();
  const gitPath = (path: string) => {
    const cached = gitPaths.get(path);
    if (cached) return cached;
    const value = run("rev-parse", "--git-path", path);
    const resolved = value.startsWith("/") ? value : join(root, value);
    gitPaths.set(path, resolved);
    bindFixedPath(resolved, root, registeredGitPaths);
    return resolved;
  };
  for (const path of [".", "index", "refs/heads/main", "logs/refs/heads/main", "packed-refs", "config"])
    gitPath(path);
  type SnapshotSeamEvent = "before-file-open";
  let snapshotSeam: (event: SnapshotSeamEvent, path: string) => void = () => {};
  type SnapshotBudget = { entries: number; fileBytes: number };
  const maxSnapshotDepth = 32;
  const maxSnapshotEntries = 512;
  const maxSnapshotAggregateBytes = 8 * 1024 * 1024;
  const maxSnapshotFileBytes = 20 * 1024 * 1024;
  const statIdentity = (left: BigIntStats, right: BigIntStats) =>
    left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode;
  const pathSnapshot = async (path: string, budget: SnapshotBudget): Promise<PathSnapshot> => {
    let item;
    try { item = lstatSync(path, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false };
      throw error;
    }
    if (++budget.entries > maxSnapshotEntries) throw new Error("Snapshot exceeds the total entries limit.");
    const kind = item.isFile() ? "file" : item.isDirectory() ? "directory" : item.isSymbolicLink() ? "symlink" : "other";
    let bytes: Buffer | undefined;
    let link: string | undefined;
    let after = item;
    if (kind === "file") {
      snapshotSeam("before-file-open", path);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = fstatSync(fd, { bigint: true });
        if (!statIdentity(item, before) || !before.isFile())
          throw new Error("Snapshot file identity changed.");
        if (before.size > BigInt(maxSnapshotFileBytes)) throw new Error("Snapshot file is unsupported.");
        if (budget.fileBytes + Number(before.size) > maxSnapshotAggregateBytes)
          throw new Error("Snapshot exceeds the aggregate file bytes limit.");
        budget.fileBytes += Number(before.size);
        bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
          const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (count <= 0) throw new Error("Snapshot file changed.");
          offset += count;
        }
        const descriptorAfter = fstatSync(fd, { bigint: true });
        const pathnameAfter = lstatSync(path, { bigint: true });
        if (
          !statIdentity(before, descriptorAfter) || before.size !== descriptorAfter.size ||
          before.ctimeNs !== descriptorAfter.ctimeNs || !statIdentity(descriptorAfter, pathnameAfter) ||
          pathnameAfter.isSymbolicLink()
        ) throw new Error("Snapshot file identity changed.");
        after = pathnameAfter;
      } finally { closeSync(fd); }
    } else if (kind === "symlink") {
      link = readlinkSync(path);
      after = lstatSync(path, { bigint: true });
      if (!statIdentity(item, after) || !after.isSymbolicLink())
        throw new Error("Snapshot symbolic link identity changed.");
    } else {
      after = lstatSync(path, { bigint: true });
      if (!statIdentity(item, after)) throw new Error("Snapshot path identity changed.");
    }
    return {
      present: true,
      kind,
      mode: String(after.mode),
      dev: String(after.dev),
      ino: String(after.ino),
      uid: String(after.uid),
      nlink: String(after.nlink),
      size: String(after.size),
      ctimeNs: String(after.ctimeNs),
      ...(bytes === undefined ? {} : { bytes }),
      ...(link === undefined ? {} : { link }),
    };
  };
  const initialRoot = lstatSync(root, { bigint: true });
  const commonPath = gitPath(".");
  const initialCommon = lstatSync(commonPath, { bigint: true });
  const boundaryMatches = (captured: PathSnapshot, expected: BigIntStats) =>
    captured.present && captured.kind === "directory" && captured.dev === String(expected.dev) &&
    captured.ino === String(expected.ino) && captured.uid === String(expected.uid) &&
    captured.mode === String(expected.mode);
  const statMatchesSnapshot = (item: BigIntStats, expected: PathSnapshot) =>
    expected.present && expected.kind === "directory" && item.isDirectory() && !item.isSymbolicLink() &&
    String(item.dev) === expected.dev && String(item.ino) === expected.ino &&
    String(item.uid) === expected.uid && String(item.mode) === expected.mode;
  const assertBoundaryIdentities = () => {
    const currentRoot = lstatSync(root, { bigint: true });
    const currentCommon = lstatSync(commonPath, { bigint: true });
    if (
      !currentRoot.isDirectory() || currentRoot.isSymbolicLink() ||
      !currentCommon.isDirectory() || currentCommon.isSymbolicLink() ||
      !statIdentity(initialRoot, currentRoot) || !statIdentity(initialCommon, currentCommon)
    ) throw new Error("Snapshot boundary identity changed.");
  };
  const trackExistingTree = async (
    directory: string,
    boundary: string,
    registry: Set<string>,
    skipObjects = false,
  ): Promise<void> => {
    bindFixedPath(directory, boundary, registry);
    for (const name of await readdir(directory)) {
      const child = join(directory, name);
      bindFixedPath(child, boundary, registry);
      const item = lstatSync(child);
      if (item.isDirectory() && !item.isSymbolicLink() && !(skipObjects && child === join(directory, "objects")))
        await trackExistingTree(child, boundary, registry, false);
    }
  };
  for (const path of ["selected", "staged-sentinel", "unstaged-sentinel", "untracked-sentinel"])
    bindFixedPath(join(root, path), root, registeredWorktreePaths);
  await trackExistingTree(commonPath, commonPath, registeredGitPaths, true);
  const emptySnapshot = (
    rootBoundary: PathSnapshot,
    commonBoundary: PathSnapshot,
    gitMetadata: Record<string, PathSnapshot>,
  ): Snapshot => ({
    rootBoundary,
    commonBoundary,
    head: "",
    refs: [],
    objects: [],
    index: { present: false },
    looseBranchRef: { present: false },
    branchReflog: { present: false },
    packedRefs: { present: false },
    config: { present: false },
    worktree: {},
    gitMetadata,
  });
  const fixedSnapshot = async (
    paths: Set<string>,
    boundary: string,
    budget: SnapshotBudget,
  ): Promise<{ entries: Record<string, PathSnapshot>; unsafe: boolean }> => {
    const entries: Record<string, PathSnapshot> = {};
    let unsafe = false;
    const ordered = [...paths].sort((left, right) => left.split(sep).length - right.split(sep).length || left.localeCompare(right));
    if (ordered.length + budget.entries > maxSnapshotEntries)
      throw new Error("Snapshot exceeds the total entries limit.");
    const blocked: string[] = [];
    for (const path of ordered) {
      if (blocked.some((parent) => path.startsWith(`${parent}${sep}`))) continue;
      const relativePath = relative(boundary, path) || ".";
      const depth = relativePath === "." ? 0 : relativePath.split(sep).length;
      if (depth > maxSnapshotDepth) throw new Error("Snapshot exceeds the directory depth limit.");
      const captured = await pathSnapshot(path, budget);
      entries[relativePath] = captured;
      const expected = directoryBindings.get(path);
      if (expected && !boundaryMatches(captured, expected)) unsafe = true;
      if (captured.present && captured.kind === "symlink") unsafe = true;
      if (!captured.present || captured.kind !== "directory" || (expected && !boundaryMatches(captured, expected)))
        blocked.push(path);
    }
    return { entries, unsafe };
  };
  const snapshot = async (): Promise<Snapshot> => {
    const budget: SnapshotBudget = { entries: 0, fileBytes: 0 };
    const rootBoundary = await pathSnapshot(root, budget);
    if (!boundaryMatches(rootBoundary, initialRoot))
      return emptySnapshot(rootBoundary, { present: false }, {});
    const commonBoundary = await pathSnapshot(commonPath, budget);
    if (!boundaryMatches(commonBoundary, initialCommon))
      return emptySnapshot(rootBoundary, commonBoundary, { ".": commonBoundary });
    assertBoundaryIdentities();
    const gitFixed = await fixedSnapshot(registeredGitPaths, commonPath, budget);
    assertBoundaryIdentities();
    if (gitFixed.unsafe) return emptySnapshot(rootBoundary, commonBoundary, gitFixed.entries);
    assertBoundaryIdentities();
    const head = (() => {
      const result = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
      return result.status === 0 ? result.stdout.trim() : "";
    })();
    assertBoundaryIdentities();
    const refs = run("for-each-ref", "--format=%(refname):%(objectname)")
      .split("\n").filter(Boolean).sort();
    assertBoundaryIdentities();
    const objects = run("-c", "remote.origin.promisor=false", "cat-file", "--batch-all-objects", "--batch-check=%(objectname)")
      .split("\n").filter(Boolean).sort();
    assertBoundaryIdentities();
    const worktreeFixed = await fixedSnapshot(registeredWorktreePaths, root, budget);
    assertBoundaryIdentities();
    return {
      rootBoundary,
      commonBoundary,
      head,
      refs,
      objects,
      index: gitFixed.entries[relative(commonPath, gitPath("index"))] ?? { present: false },
      looseBranchRef: gitFixed.entries[relative(commonPath, gitPath("refs/heads/main"))] ?? { present: false },
      branchReflog: gitFixed.entries[relative(commonPath, gitPath("logs/refs/heads/main"))] ?? { present: false },
      packedRefs: gitFixed.entries[relative(commonPath, gitPath("packed-refs"))] ?? { present: false },
      config: gitFixed.entries[relative(commonPath, gitPath("config"))] ?? { present: false },
      worktree: worktreeFixed.entries,
      gitMetadata: gitFixed.entries,
    };
  };
  return {
    root,
    run,
    gitPath,
    adapter: managedGitAdapter({ root, cooperative: true }),
    write: async (path: string, value: string | Buffer, mode = 0o644) => {
      await writeFile(join(root, path), value);
      await chmod(join(root, path), mode);
      bindFixedPath(join(root, path), root, registeredWorktreePaths);
    },
    async mkdirWorktree(path: string) {
      await mkdir(join(root, path));
      bindFixedPath(join(root, path), root, registeredWorktreePaths);
    },
    async trackGitTree(path = ".") {
      await trackExistingTree(gitPath(path), commonPath, registeredGitPaths);
    },
    snapshot,
    setSnapshotSeam(seam: (event: SnapshotSeamEvent, path: string) => void) {
      snapshotSeam = seam;
    },
    async temp() {
      const path = await mkdtemp(join(tmpdir(), "void-git-external-"));
      extras.push(path);
      return path;
    },
  };
}

async function stageChange(f: CommitFixture, value = "after", mode = 0o644) {
  await f.write("selected", value, mode);
  f.run("add", "selected");
}

async function refusesUnchanged(
  f: CommitFixture,
  error: RegExp,
  path = "selected",
) {
  const before = await f.snapshot();
  await assert.rejects(
    f.adapter.preflight({ action: "commit", path }),
    error,
  );
  assert.deepEqual(await f.snapshot(), before);
}

posixTest("commit accepts exactly action and path", async (t) => {
  const fixture = await commitRepository(t);
  await stageChange(fixture);
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
  ] as Json[]) {
    const before = await fixture.snapshot();
    await assert.rejects(fixture.adapter.preflight(args));
    assert.deepEqual(await fixture.snapshot(), before);
  }
});

posixTest(
  "preflight and prepare bind the selected staged entry without writing Git state",
  async (t) => {
    const f = await commitRepository(t);
    await stageChange(f, "after", 0o755);
    const before = await f.snapshot();
    const args = { action: "commit", path: "selected" } as const;
    const observed = await f.adapter.preflight(args);
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(observed.reversibility, "r1");
    assert.equal(observed.blastRadius.count, 1);
    assert.equal(observed.resources.length, 2);
    assert.ok(observed.resources.every((value) => !value.includes(f.root)));
    const beforePrepare = await f.snapshot();
    const prepared = await f.adapter.prepare(args, observed, "unsafe/id with spaces");
    assert.deepEqual(await f.snapshot(), beforePrepare);
    const plan = prepared.plan as unknown as CommitPlan;
    assert.match(plan.receiptRef, /^refs\/void\/operations\/[0-9a-f]{64}$/);
    assert.ok(!plan.receiptRef.includes("unsafe"));
    assert.equal(
      plan.metadata.subject,
      `VOID managed commit ${sha256("unsafe/id with spaces").slice(0, 16)}`,
    );
    assert.match(plan.metadata.timestamp, /^\d+$/);
    const capture = prepared.before as unknown as CommitCapture;
    assert.equal(capture.repository.root, f.root);
    assert.ok(capture.branch.reflogDigest);
    assert.ok(capture.branch.reflogGeneration);
    assert.equal(JSON.stringify(capture).includes("VOID test"), false);
    assert.equal(JSON.stringify(capture).includes("initial"), false);
  },
);

const refusedProfiles: Array<{
  name: string;
  arrange(f: CommitFixture): Promise<void> | void;
  error: RegExp;
}> = [
  { name: "detached HEAD", arrange: (f) => { f.run("checkout", "--detach", "-q"); }, error: /attached/ },
  { name: "unborn HEAD", arrange: (f) => { f.run("checkout", "--orphan", "unborn"); }, error: /born/ },
  {
    name: "second worktree",
    arrange: async (f) => {
      const path = await f.temp();
      await rm(path, { recursive: true });
      f.run("worktree", "add", "-q", "-b", "other", path);
      await f.trackGitTree("worktrees");
    },
    error: /one registered worktree/,
  },
  { name: "shallow", arrange: (f) => writeFile(f.gitPath("shallow"), `${f.run("rev-parse", "HEAD")}\n`), error: /shallow/i },
  { name: "replace ref", arrange: async (f) => { const head = f.run("rev-parse", "HEAD"); f.run("replace", head, head); await f.trackGitTree("refs/replace"); }, error: /replace/i },
  { name: "graft", arrange: (f) => writeFile(f.gitPath("info/grafts"), `${f.run("rev-parse", "HEAD")}\n`), error: /graft/i },
  { name: "alternates", arrange: async (f) => { const path = await f.temp(); await mkdir(join(path, "info"), { recursive: true }); await mkdir(join(path, "pack"), { recursive: true }); await writeFile(f.gitPath("objects/info/alternates"), `${path}\n`); }, error: /alternate/i },
  { name: "promisor config", arrange: (f) => { f.run("config", "remote.origin.promisor", "true"); }, error: /promisor/ },
  { name: "promisor pack marker", arrange: (f) => writeFile(f.gitPath("objects/pack/foreign.promisor"), ""), error: /promisor/ },
  { name: "partial clone extension only", arrange: (f) => { f.run("config", "extensions.partialClone", "origin"); }, error: /partial/i },
  { name: "signing required", arrange: (f) => { f.run("config", "commit.gpgSign", "true"); }, error: /signing/ },
  { name: "missing reflog", arrange: (f) => unlink(f.gitPath("logs/refs/heads/main")), error: /reflog/ },
  { name: "branch lock", arrange: (f) => writeFile(f.gitPath("refs/heads/main.lock"), "foreign"), error: /lock/ },
  { name: "branch reflog lock", arrange: (f) => writeFile(f.gitPath("logs/refs/heads/main.lock"), "foreign"), error: /lock/ },
  { name: "packed refs lock", arrange: (f) => writeFile(f.gitPath("packed-refs.lock"), "foreign-packed-lock"), error: /lock/ },
  {
    name: "packed refs lock symbolic link",
    arrange: async (f) => {
      const external = await f.temp();
      const sentinel = join(external, "lock");
      await writeFile(sentinel, "foreign-packed-lock");
      await symlink(sentinel, f.gitPath("packed-refs.lock"));
    },
    error: /symbolic link|containment|lock|ownership/,
  },
  { name: "receipt lock", arrange: async (f) => { const path = f.gitPath(`refs/void/operations/${sha256("op")}.lock`); await mkdir(dirname(path), { recursive: true }); await writeFile(path, "foreign"); }, error: /lock/ },
];

for (const profile of refusedProfiles) {
  posixTest(`commit refuses ${profile.name} without writes`, async (t) => {
    const f = await commitRepository(t);
    await stageChange(f);
    await profile.arrange(f);
    await refusesUnchanged(f, profile.error);
  });
}

posixTest("commit preserves foreign packed refs lock bytes", async (t) => {
  const f = await commitRepository(t);
  await stageChange(f);
  const lock = f.gitPath("packed-refs.lock");
  const bytes = Buffer.from([0, 255, 1, 2]);
  await writeFile(lock, bytes);
  await refusesUnchanged(f, /lock/);
  assert.deepEqual(await readFile(lock), bytes);
});

for (const marker of [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "BISECT_START",
  "AUTO_MERGE",
  "sequencer",
  "rebase-apply",
  "rebase-merge",
]) {
  posixTest(`commit refuses active operation marker ${marker}`, async (t) => {
    const f = await commitRepository(t);
    await stageChange(f);
    const path = f.gitPath(marker);
    if (/sequencer|rebase/.test(marker)) await mkdir(path, { recursive: true });
    else await writeFile(path, `${f.run("rev-parse", "HEAD")}\n`);
    await refusesUnchanged(f, /operation/i);
  });
}

function snapshotContainsBytes(value: unknown, wanted: Buffer): boolean {
  if (Buffer.isBuffer(value)) return value.equals(wanted);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((item) => snapshotContainsBytes(item, wanted));
}

posixTest("snapshot refuses a file replacement between lstat and fd open", async (t) => {
  const f = await commitRepository(t);
  await stageChange(f);
  f.run("pack-refs", "--all");
  const target = f.gitPath("packed-refs");
  const external = await f.temp();
  const moved = join(external, "packed-original");
  const original = await readFile(target);
  let replaced = false;
  f.setSnapshotSeam((event, path) => {
    if (replaced || event !== "before-file-open" || path !== target) return;
    replaced = true;
    renameSync(target, moved);
    writeFileSync(target, "replacement");
  });
  await assert.rejects(f.snapshot(), /identity/);
  assert.deepEqual(await readFile(moved), original);
});

posixTest("snapshot refuses a directory replacement before traversal", async (t) => {
  const f = await commitRepository(t);
  await stageChange(f);
  const target = f.gitPath("refs/heads");
  const external = await f.temp();
  const moved = join(external, "heads-original");
  const sentinel = Buffer.from("directory-replacement-sentinel");
  renameSync(target, moved);
  mkdirSync(target);
  writeFileSync(join(target, "foreign"), sentinel);
  const captured = await f.snapshot();
  assert.equal(captured.head, "");
  assert.equal(snapshotContainsBytes(captured, sentinel), false);
  assert.deepEqual(await readFile(join(target, "foreign")), sentinel);
});

posixTest("snapshot refuses excessive directory depth", async (t) => {
  const f = await commitRepository(t);
  let path = "";
  for (let depth = 0; depth < 40; depth++) {
    path = path ? `${path}/depth-${depth}` : `depth-${depth}`;
    await f.mkdirWorktree(path);
  }
  await assert.rejects(f.snapshot(), /depth/);
});

posixTest("snapshot refuses excessive total entries", async (t) => {
  const f = await commitRepository(t);
  const directory = join(f.root, "entries");
  await mkdir(directory);
  await Promise.all(Array.from({ length: 600 }, (_, index) =>
    f.write(`entries/entry-${index}`, "x"),
  ));
  await assert.rejects(f.snapshot(), /entries/);
});

posixTest("snapshot refuses excessive aggregate bytes before reading the file", async (t) => {
  const f = await commitRepository(t);
  await f.write("oversized-snapshot", Buffer.alloc(9 * 1024 * 1024, 0x61));
  await assert.rejects(f.snapshot(), /aggregate/);
});

for (const alias of ["common directory", "refs heads directory"] as const) {
  posixTest(`snapshot stops before following ${alias} alias`, async (t) => {
    const f = await commitRepository(t);
    await stageChange(f);
    const target = alias === "common directory" ? f.gitPath(".") : f.gitPath("refs/heads");
    const external = await f.temp();
    const moved = join(external, "moved");
    await rename(target, moved);
    const sentinel = Buffer.from(`external-secret-${alias}`);
    await writeFile(join(moved, "snapshot-sentinel"), sentinel);
    await symlink(moved, target);
    const captured = await f.snapshot();
    assert.equal(captured.head, "");
    assert.equal(snapshotContainsBytes(captured, sentinel), false);
    assert.deepEqual(await readFile(join(moved, "snapshot-sentinel")), sentinel);
  });
}

posixTest("commit refuses a packed refs alias and preserves external bytes", async (t) => {
  const f = await commitRepository(t);
  await stageChange(f);
  f.run("pack-refs", "--all");
  const target = f.gitPath("packed-refs");
  const external = await f.temp();
  const moved = join(external, "packed-refs");
  await rename(target, moved);
  await symlink(moved, target);
  const externalBefore = await readFile(moved);
  await refusesUnchanged(f, /symbolic link|containment|ownership/);
  assert.deepEqual(await readFile(moved), externalBefore);
});

for (const relative of [
  "refs/heads",
  "logs/refs/heads",
  "refs/void",
  "refs/void/operations",
  "refs/void/recoveries",
]) {
  posixTest(`commit refuses destructive path alias at ${relative}`, async (t) => {
    const f = await commitRepository(t);
    await stageChange(f);
    const target = f.gitPath(relative);
    const external = await f.temp();
    const moved = join(external, "moved");
    try { await rename(target, moved); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(moved, { recursive: true });
    }
    const sentinel = join(moved, ".sentinel");
    await writeFile(sentinel, Buffer.from([0, 1, 2, 255]));
    await mkdir(dirname(target), { recursive: true });
    await symlink(moved, target);
    const externalBefore = await readFile(sentinel);
    await refusesUnchanged(f, /symbolic link|containment|ownership/);
    assert.deepEqual(await readFile(sentinel), externalBefore);
  });
}

const indexProfiles: Array<{
  name: string;
  arrange(f: CommitFixture): Promise<void> | void;
  error: RegExp;
}> = [
  { name: "sparse index", arrange: (f) => f.run("config", "core.sparseCheckout", "true"), error: /sparse/i },
  { name: "split index", arrange: async (f) => { f.run("update-index", "--split-index"); await f.trackGitTree(); }, error: /split/i },
  {
    name: "unmerged entries",
    arrange: (f) => {
      const oid = f.run("hash-object", "selected");
      const line = `100644 ${oid} 1\tselected\n100644 ${oid} 2\tselected\n`;
      execFileSync("git", ["-C", f.root, "update-index", "--index-info"], { input: line });
    },
    error: /unmerged|flags/i,
  },
  { name: "assume unchanged", arrange: (f) => f.run("update-index", "--assume-unchanged", "selected"), error: /flags/i },
  { name: "skip worktree", arrange: (f) => f.run("update-index", "--skip-worktree", "selected"), error: /flags|index format/i },
  {
    name: "symlink mode",
    arrange: async (f) => { await unlink(join(f.root, "selected")); await symlink("elsewhere", join(f.root, "selected")); f.run("add", "selected"); },
    error: /mode|symlink|regular/i,
  },
  {
    name: "submodule mode",
    arrange: (f) => { const oid = f.run("rev-parse", "HEAD"); f.run("update-index", "--add", "--cacheinfo", "160000", oid, "selected"); },
    error: /mode|submodule/i,
  },
  {
    name: "unsupported mode",
    arrange: async (f) => {
      const path = f.gitPath("index");
      const bytes = await readFile(path);
      const hashLength = bytes.length > 32 && bytes.subarray(-32).equals(createHash("sha256").update(bytes.subarray(0, -32)).digest()) ? 32 : 20;
      bytes.writeUInt32BE(Number.parseInt("100600", 8), 12 + 24);
      createHash(hashLength === 20 ? "sha1" : "sha256").update(bytes.subarray(0, -hashLength)).digest().copy(bytes, bytes.length - hashLength);
      await writeFile(path, bytes);
    },
    error: /mode/i,
  },
  {
    name: "non UTF-8 index path",
    arrange: async (f) => {
      const path = f.gitPath("index");
      const bytes = await readFile(path);
      const at = bytes.indexOf(Buffer.from("selected"));
      assert.notEqual(at, -1);
      bytes[at] = 0xff;
      const hashLength = bytes.length > 32 && bytes.subarray(-32).equals(createHash("sha256").update(bytes.subarray(0, -32)).digest()) ? 32 : 20;
      createHash(hashLength === 20 ? "sha1" : "sha256").update(bytes.subarray(0, -hashLength)).digest().copy(bytes, bytes.length - hashLength);
      await writeFile(path, bytes);
    },
    error: /pathname|UTF-8/i,
  },
  {
    name: "missing object",
    arrange: async (f) => { const oid = f.run("rev-parse", ":selected"); await unlink(f.gitPath(`objects/${oid.slice(0, 2)}/${oid.slice(2)}`)); },
    error: /object|command|connectivity/i,
  },
];

for (const profile of indexProfiles) {
  posixTest(`commit refuses ${profile.name} without writes`, async (t) => {
    const f = await commitRepository(t);
    await stageChange(f);
    await profile.arrange(f);
    await refusesUnchanged(f, profile.error);
  });
}

posixTest("commit refuses a staged no-op", async (t) => {
  const f = await commitRepository(t);
  await refusesUnchanged(f, /no-op/i);
});

posixTest("commit refuses a selected unstaged edit", async (t) => {
  const f = await commitRepository(t);
  await stageChange(f, "staged");
  await f.write("selected", "unstaged");
  await refusesUnchanged(f, /worktree|staged/i);
});

posixTest("commit refuses staged deletion with a present worktree path", async (t) => {
  const f = await commitRepository(t);
  f.run("rm", "--cached", "selected");
  await refusesUnchanged(f, /deletion|absent/i);
});

posixTest("commit refuses staged deletion with a dangling symlink leaf", async (t) => {
  const f = await commitRepository(t);
  f.run("rm", "--cached", "selected");
  await unlink(join(f.root, "selected"));
  await symlink("missing-target", join(f.root, "selected"));
  await refusesUnchanged(f, /deletion|absent/i);
});

for (const path of ["", ".git/config", ".GIT/config", "line\nbreak", "a//b", "a/../b", "back\\slash", "\ud800"]) {
  posixTest(`commit refuses invalid selected path ${JSON.stringify(path)}`, async (t) => {
    const f = await commitRepository(t);
    await stageChange(f);
    const before = await f.snapshot();
    await assert.rejects(f.adapter.preflight({ action: "commit", path }), /path|Git mutation/i);
    assert.deepEqual(await f.snapshot(), before);
  });
}

type PrepareDrift = {
  name: string;
  arrange(f: CommitFixture): Promise<void> | void;
};

const prepareDrifts: PrepareDrift[] = [
  { name: "HEAD and branch", arrange: (f) => { f.run("commit", "-qm", "human"); } },
  { name: "branch reflog append", arrange: (f) => writeFile(f.gitPath("logs/refs/heads/main"), "foreign reflog\n", { flag: "a" }) },
  {
    name: "branch reflog away and back",
    arrange: async (f) => {
      const path = f.gitPath("logs/refs/heads/main");
      const bytes = await readFile(path);
      await rename(path, `${path}.away`);
      await writeFile(path, bytes);
    },
  },
  { name: "repository config", arrange: (f) => { f.run("config", "void.drift", "changed"); } },
  { name: "raw index format", arrange: (f) => { f.run("update-index", "--index-version", "3"); } },
  {
    name: "logical index entry",
    arrange: async (f) => {
      await f.write("staged-sentinel", "raced-stage");
      f.run("add", "staged-sentinel");
    },
  },
  { name: "selected worktree bytes", arrange: (f) => f.write("selected", "raced-bytes") },
  { name: "selected worktree mode", arrange: (f) => chmod(join(f.root, "selected"), 0o755) },
  {
    name: "repository root identity",
    arrange: async (f) => {
      const external = await f.temp();
      const moved = join(external, "repository");
      await rename(f.root, moved);
      await symlink(moved, f.root);
    },
  },
  {
    name: "common directory alias",
    arrange: async (f) => {
      const target = f.gitPath(".");
      const external = await f.temp();
      const moved = join(external, "gitdir");
      await rename(target, moved);
      await symlink(moved, target);
    },
  },
  {
    name: "destructive ref parent alias",
    arrange: async (f) => {
      const target = f.gitPath("refs/heads");
      const external = await f.temp();
      const moved = join(external, "heads");
      await rename(target, moved);
      await symlink(moved, target);
    },
  },
];

for (const drift of prepareDrifts) {
  posixTest(`commit prepare refuses exact ${drift.name} drift`, async (t) => {
    const f = await commitRepository(t);
    await stageChange(f);
    const args = { action: "commit", path: "selected" } as const;
    const observed = await f.adapter.preflight(args);
    await drift.arrange(f);
    const raced = await f.snapshot();
    await assert.rejects(f.adapter.prepare(args, observed, "drift-op"));
    assert.deepEqual(await f.snapshot(), raced);
  });
}

posixTest("byte manifest parsers preserve newline paths", () => {
  const oid = "a".repeat(40);
  const pattern = /^[0-9a-f]{40}$/;
  assert.deepEqual(
    parseTreeManifest(Buffer.from(`100644 blob ${oid}\tline\nbreak\0`), pattern),
    [{ path: "line\nbreak", mode: "100644", oid }],
  );
  assert.deepEqual(
    parseIndexManifest(Buffer.from(`100644 ${oid} 0\tline\nbreak\0`), pattern),
    [{ path: "line\nbreak", mode: "100644", oid }],
  );
});

posixTest("byte manifest parsers reject invalid UTF-8 paths", () => {
  const oid = "a".repeat(40);
  const pattern = /^[0-9a-f]{40}$/;
  assert.throws(
    () => parseTreeManifest(Buffer.concat([Buffer.from(`100644 blob ${oid}\t`), Buffer.from([0xff, 0])]), pattern),
    /pathname/,
  );
  assert.throws(
    () => parseIndexManifest(Buffer.concat([Buffer.from(`100644 ${oid} 0\t`), Buffer.from([0xff, 0])]), pattern),
    /pathname/,
  );
});

posixTest("commit preparation rejects invalid identifier tokens without writes", async (t) => {
  for (const operationId of ["", "x".repeat(4097), "\ud800"]) {
    const f = await commitRepository(t);
    await stageChange(f);
    const before = await f.snapshot();
    const args = { action: "commit", path: "selected" } as const;
    const observed = await f.adapter.preflight(args);
    await assert.rejects(f.adapter.prepare(args, observed, operationId), /identifier/i);
    assert.deepEqual(await f.snapshot(), before);
  }
});

posixTest("commit parses NUL manifests without newline ambiguity", async (t) => {
  const f = await commitRepository(t);
  const odd = "unrelated\nname";
  await f.write(odd, "odd");
  f.run("add", odd);
  await stageChange(f);
  const before = await f.snapshot();
  const observed = await f.adapter.preflight({ action: "commit", path: "selected" });
  await f.adapter.prepare({ action: "commit", path: "selected" }, observed, "op");
  assert.deepEqual(await f.snapshot(), before);
});

posixTest("commit captures a manifest larger than one MiB without writes", async (t) => {
  const f = await commitRepository(t);
  const oid = f.run("rev-parse", ":selected");
  const records = Array.from({ length: 13_000 }, (_, index) =>
    `100644 ${oid} 0\tlarge/${String(index).padStart(5, "0")}-${"x".repeat(48)}\n`,
  ).join("");
  execFileSync("git", ["-C", f.root, "update-index", "--index-info"], {
    input: records,
    maxBuffer: 32 * 1024 * 1024,
  });
  await stageChange(f);
  const before = await f.snapshot();
  const args = { action: "commit", path: "selected" } as const;
  const observed = await f.adapter.preflight(args);
  await f.adapter.prepare(args, observed, "large-manifest");
  assert.deepEqual(await f.snapshot(), before);
});

posixTest("commit supports SHA-256 capture and pure preparation", async (t) => {
  const f = await commitRepository(t, "sha256");
  await stageChange(f);
  const before = await f.snapshot();
  const args = { action: "commit", path: "selected" } as const;
  const observed = await f.adapter.preflight(args);
  const prepared = await f.adapter.prepare(args, observed, "op");
  assert.equal((prepared.plan as unknown as CommitPlan).parent.length, 64);
  assert.deepEqual(await f.snapshot(), before);
});


async function dispatchForward(f: CommitFixture, operationId: string) {
  const args = { action: "commit", path: "selected" } as const;
  const observation = await f.adapter.preflight(args);
  const prepared = await f.adapter.prepare(args, observation, operationId);
  const outcome = await f.adapter.execute(args, prepared, operationId);
  return { prepared, outcome };
}

async function arrangeForwardScenario(
  f: CommitFixture,
  scenario: "add" | "modify" | "delete" | "binary" | "executable",
) {
  if (scenario === "add") {
    f.run("rm", "-q", "selected");
    f.run("commit", "-qm", "remove selected");
    await f.write("selected", "added");
    f.run("add", "selected");
  } else if (scenario === "delete") {
    f.run("rm", "-q", "selected");
  } else if (scenario === "binary") {
    await f.write("selected", Buffer.from([0, 255, 1, 10, 128]));
    f.run("add", "selected");
  } else if (scenario === "executable") {
    await stageChange(f, "#!/bin/sh\nexit 0\n", 0o755);
  } else {
    await stageChange(f, "modified");
  }
}

for (const scenario of ["add", "modify", "delete", "binary", "executable"] as const) {
  posixTest(`forward commit handles ${scenario} and preserves human state`, async (t) => {
    const f = await commitRepository(t);
    await arrangeForwardScenario(f, scenario);
    const before = await f.snapshot();
    const { prepared, outcome } = await dispatchForward(f, `forward-${scenario}`);
    const after = await f.snapshot();
    const plan = prepared.plan as unknown as CommitPlan;
    const head = f.run("rev-parse", "HEAD");
    assert.equal(f.run("rev-parse", "HEAD^"), before.head);
    assert.equal(f.run("rev-list", "--parents", "-n", "1", head).split(" ").length, 2);
    assert.equal(f.run("rev-parse", plan.receiptRef), head);
    assert.equal(f.run("diff-tree", "--no-commit-id", "--name-only", "-r", head), "selected");
    assert.deepEqual(after.index, before.index);
    assert.deepEqual(after.worktree, before.worktree);
    assert.deepEqual(await readFile(join(f.root, "staged-sentinel")), Buffer.from("staged"));
    assert.deepEqual(await readFile(join(f.root, "unstaged-sentinel")), Buffer.from("unstaged"));
    assert.deepEqual(await readFile(join(f.root, "untracked-sentinel")), Buffer.from("untracked"));
    assert.equal(JSON.stringify(outcome).includes(f.root), false);
    const raw = f.run("cat-file", "commit", head) + "\n";
    assert.match(raw, /^tree [0-9a-f]+\nparent [0-9a-f]+\nauthor VOID Managed Git <managed-git@void.invalid> \d+ \+0000\ncommitter VOID Managed Git <managed-git@void.invalid> \d+ \+0000\n\nVOID managed commit [0-9a-f]{16}\n$/);
    assert.equal(raw.includes("gpgsig"), false);
    assert.ok(Buffer.byteLength(raw) < 1024);
    assert.equal((await readdir(dirname(f.gitPath("index")))).some((name) => name.startsWith(".void-git-index-")), false);
  });
}

posixTest("forward commit completes a SHA-256 lifecycle", async (t) => {
  const f = await commitRepository(t, "sha256");
  await stageChange(f, "sha256-after");
  const before = await f.snapshot();
  const { prepared } = await dispatchForward(f, "sha256-forward");
  const plan = prepared.plan as unknown as CommitPlan;
  const head = f.run("rev-parse", "HEAD");
  assert.equal(head.length, 64);
  assert.equal(f.run("rev-parse", "HEAD^"), before.head);
  assert.equal(f.run("rev-parse", plan.receiptRef), head);
  assert.deepEqual((await f.snapshot()).index, before.index);
  assert.deepEqual((await f.snapshot()).worktree, before.worktree);
});

posixTest("forward commit advances a packed branch and creates a loose receipt", async (t) => {
  const f = await commitRepository(t);
  f.run("pack-refs", "--all", "--prune");
  assert.equal(pathExistsForTest(f.gitPath("refs/heads/main")), false);
  await stageChange(f, "packed-branch");
  const before = await f.snapshot();
  const { prepared } = await dispatchForward(f, "packed-forward");
  const plan = prepared.plan as unknown as CommitPlan;
  const head = f.run("rev-parse", "HEAD");
  assert.equal(f.run("rev-parse", "HEAD^"), before.head);
  assert.equal(f.run("rev-parse", plan.receiptRef), head);
  assert.deepEqual((await f.snapshot()).index, before.index);
  assert.deepEqual((await f.snapshot()).worktree, before.worktree);
});


for (const [name, arrange] of [
  ["branch CAS drift", async (f: CommitFixture) => { f.run("commit", "-qm", "human raced commit"); }],
  ["branch reflog append", async (f: CommitFixture) => { await writeFile(f.gitPath("logs/refs/heads/main"), "foreign reflog\n", { flag: "a" }); }],
  ["branch reflog ABA replacement", async (f: CommitFixture) => {
    const path = f.gitPath("logs/refs/heads/main");
    const bytes = await readFile(path);
    await rename(path, `${path}.old`);
    await writeFile(path, bytes);
  }],
] as const) {
  posixTest(`forward commit refuses ${name} before object writes`, async (t) => {
    const f = await commitRepository(t);
    await stageChange(f);
    const args = { action: "commit", path: "selected" } as const;
    const observation = await f.adapter.preflight(args);
    const prepared = await f.adapter.prepare(args, observation, "raced-op");
    await arrange(f);
    const raced = await f.snapshot();
    await assert.rejects(f.adapter.execute(args, prepared, "raced-op"));
    assert.deepEqual(await f.snapshot(), raced);
  });
}

posixTest("forward commit refuses a preexisting receipt without object writes", async (t) => {
  const f = await commitRepository(t);
  await stageChange(f);
  const args = { action: "commit", path: "selected" } as const;
  const observation = await f.adapter.preflight(args);
  const prepared = await f.adapter.prepare(args, observation, "receipt-op");
  const plan = prepared.plan as unknown as CommitPlan;
  f.run("update-ref", plan.receiptRef, f.run("rev-parse", "HEAD"));
  await f.trackGitTree("refs/void");
  const raced = await f.snapshot();
  await assert.rejects(f.adapter.execute(args, prepared, "receipt-op"));
  assert.deepEqual(await f.snapshot(), raced);
});

for (const payload of [Buffer.alloc(0), Buffer.from("foreign lock")]) {
  posixTest(`forward commit never touches a foreign real index lock of ${payload.length} bytes`, async (t) => {
    const f = await commitRepository(t);
    await stageChange(f);
    const args = { action: "commit", path: "selected" } as const;
    const observation = await f.adapter.preflight(args);
    const prepared = await f.adapter.prepare(args, observation, "index-lock-op");
    const lock = `${f.gitPath("index")}.lock`;
    await writeFile(lock, payload);
    const before = await readFile(lock);
    const objects = (await f.snapshot()).objects;
    await assert.rejects(f.adapter.execute(args, prepared, "index-lock-op"), /lock|conflict|changed/i);
    assert.deepEqual(await readFile(lock), before);
    assert.deepEqual((await f.snapshot()).objects, objects);
  });
}

for (const relativePath of [
  "refs/void/operations",
  `refs/void/operations/${sha256("leaf-op")}`,
] as const) {
  posixTest(`forward commit validates exact receipt chain at ${relativePath} before objects`, async (t) => {
    const f = await commitRepository(t);
    await stageChange(f);
    const args = { action: "commit", path: "selected" } as const;
    const observation = await f.adapter.preflight(args);
    const prepared = await f.adapter.prepare(args, observation, "leaf-op");
    const target = f.gitPath(relativePath);
    const external = await f.temp();
    const foreign = join(external, "foreign");
    await mkdir(foreign, { recursive: true });
    const sentinel = Buffer.from([9, 0, 255, 7]);
    await writeFile(join(foreign, "sentinel"), sentinel);
    await rm(target, { recursive: true, force: true });
    await mkdir(dirname(target), { recursive: true });
    await symlink(foreign, target);
    const before = await f.snapshot();
    await assert.rejects(f.adapter.execute(args, prepared, "leaf-op"), /symbolic|containment|identity|path|state/i);
    const after = await f.snapshot();
    assert.deepEqual(after.objects, before.objects);
    assert.deepEqual(await readFile(join(foreign, "sentinel")), sentinel);
    assert.equal(after.head, before.head);
  });
}

posixTest("private index starts absent and has a private ownership token", async (t) => {
  const f = await commitRepository(t);
  const workspace = createPrivateIndexWorkspace(f.gitPath("index"));
  try {
    await assert.rejects(lstat(workspace.indexPath), { code: "ENOENT" });
    const directory = await lstat(workspace.directory, { bigint: true });
    const token = await lstat(workspace.tokenPath, { bigint: true });
    assert.equal(directory.mode & 0o777n, 0o700n);
    assert.equal(token.mode & 0o777n, 0o600n);
    assert.equal(token.uid, directory.uid);
    assert.equal(token.nlink, 1n);
    assert.equal(token.ino, workspace.tokenIno);
  } finally {
    cleanupPrivateIndexWorkspace(workspace);
  }
});

posixTest("private index cleanup refuses a replaced directory", async (t) => {
  const f = await commitRepository(t);
  const workspace = createPrivateIndexWorkspace(f.gitPath("index"));
  const moved = `${workspace.directory}.owned`;
  await rename(workspace.directory, moved);
  await mkdir(workspace.directory, { mode: 0o700 });
  const sentinel = Buffer.from("foreign sentinel");
  await writeFile(join(workspace.directory, "sentinel"), sentinel);
  assert.throws(() => cleanupPrivateIndexWorkspace(workspace), /identity/);
  assert.deepEqual(await readFile(join(workspace.directory, "sentinel")), sentinel);
  await rm(workspace.directory, { recursive: true, force: true });
  await rm(moved, { recursive: true, force: true });
});

for (const attack of ["extra file", "token replacement", "index replacement", "lock replacement"] as const) {
  posixTest(`private index cleanup fails closed on ${attack}`, async (t) => {
    const f = await commitRepository(t);
    const workspace = createPrivateIndexWorkspace(f.gitPath("index"));
    const foreign = Buffer.from(`foreign ${attack}`);
    let target: string;
    if (attack === "extra file") {
      target = join(workspace.directory, "extra");
      await writeFile(target, foreign);
    } else if (attack === "token replacement") {
      target = workspace.tokenPath;
      await unlink(target);
      await writeFile(target, foreign);
    } else {
      target = attack === "index replacement" ? workspace.indexPath : `${workspace.indexPath}.lock`;
      await writeFile(target, "owned");
      recordOwnedPrivateFile(workspace, target);
      await unlink(target);
      await writeFile(target, foreign);
    }
    assert.throws(() => cleanupPrivateIndexWorkspace(workspace), /identity|unknown/);
    assert.deepEqual(await readFile(target), foreign);
    await rm(workspace.directory, { recursive: true, force: true });
  });
}


for (const name of ["index", "index.lock"] as const) {
  posixTest(`private ${name} cleanup preserves a replacement with reused inode numbers`, async (t) => {
    const f = await commitRepository(t);
    const workspace = createPrivateIndexWorkspace(f.gitPath("index"));
    const target = join(workspace.directory, name);
    await writeFile(target, "owned");
    recordOwnedPrivateFile(workspace, target);
    const owned = lstatSync(target, { bigint: true });
    await unlink(target);
    const foreign = Buffer.from("foreign inode replacement");
    await writeFile(target, foreign);
    reusePathInode(t, target, owned);
    assert.throws(() => cleanupPrivateIndexWorkspace(workspace), /identity/);
    assert.deepEqual(await readFile(target), foreign);
  });
}

for (const outcome of ["success", "refusal"] as const) {
  posixTest(`private index ${outcome} closes every retained descriptor`, async (t) => {
    const f = await commitRepository(t);
    const workspace = createPrivateIndexWorkspace(f.gitPath("index"));
    for (const path of [workspace.indexPath, `${workspace.indexPath}.lock`]) {
      await writeFile(path, "owned");
      recordOwnedPrivateFile(workspace, path);
    }
    const descriptors = [...workspace.ownedFiles.values()].map((file) => file.descriptor);
    if (outcome === "refusal") {
      await writeFile(join(workspace.directory, "foreign"), "preserve");
      assert.throws(() => cleanupPrivateIndexWorkspace(workspace), /unknown/);
    } else {
      cleanupPrivateIndexWorkspace(workspace);
    }
    for (const descriptor of descriptors)
      assert.throws(() => fstatSync(descriptor), { code: "EBADF" });
  });
}

posixTest("recording a replaced Git private index closes the previous descriptor", async (t) => {
  const f = await commitRepository(t);
  const workspace = createPrivateIndexWorkspace(f.gitPath("index"));
  try {
    await writeFile(workspace.indexPath, "first Git index");
    recordOwnedPrivateFile(workspace, workspace.indexPath);
    const previous = workspace.ownedFiles.get(workspace.indexPath)!;
    await unlink(workspace.indexPath);
    await writeFile(workspace.indexPath, "next Git index");
    recordOwnedPrivateFile(workspace, workspace.indexPath);
    assert.throws(() => fstatSync(previous.descriptor), { code: "EBADF" });
    assert.equal(fstatSync(workspace.ownedFiles.get(workspace.indexPath)!.descriptor).nlink, 1);
  } finally { cleanupPrivateIndexWorkspace(workspace); }
});

function reusePathInode(t: TestContext, target: string, owned: BigIntStats): void {
  // Only pathname inode allocation is simulated. Real descriptors must still
  // identify the unlinked original, and cleanup must preserve real foreign bytes.
  const original = fs.lstatSync;
  const mocked = t.mock.method(fs, "lstatSync", (...args: Parameters<typeof original>) => {
    const item = original(...args);
    if (item && String(args[0]) === target) {
      item.dev = owned.dev;
      item.ino = owned.ino;
    }
    return item;
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
}

function transactionServices(f: CommitFixture): CommitServices {
  const head = f.run("rev-parse", "HEAD");
  return {
    root: f.root,
    oidPattern: new RegExp(`^[0-9a-f]{${head.length}}$`),
  } as unknown as CommitServices;
}

posixTest("ref transaction holds both locks through the locked recheck", async (t) => {
  const f = await commitRepository(t);
  const oldHead = f.run("rev-parse", "HEAD");
  const tree = f.run("rev-parse", "HEAD^{tree}");
  const commit = f.run("commit-tree", tree, "-p", oldHead, "-m", "candidate");
  const receipt = `refs/void/operations/${sha256("held-locks")}`;
  let checked = false;
  await commitRefTransaction(
    [
      { ref: "refs/heads/main", newOid: commit, oldOid: oldHead },
      { ref: receipt, newOid: commit, oldOid: null },
    ],
    () => {
      assert.equal(lstatSync(`${f.gitPath("refs/heads/main")}.lock`).isFile(), true);
      assert.equal(lstatSync(`${f.gitPath(receipt)}.lock`).isFile(), true);
      checked = true;
    },
    transactionServices(f),
  );
  assert.equal(checked, true);
  assert.equal(f.run("rev-parse", "HEAD"), commit);
  assert.equal(f.run("rev-parse", receipt), commit);
});

posixTest("ref transaction aborts a reflog race after prepare while locks remain held", async (t) => {
  const f = await commitRepository(t);
  const oldHead = f.run("rev-parse", "HEAD");
  const tree = f.run("rev-parse", "HEAD^{tree}");
  const commit = f.run("commit-tree", tree, "-p", oldHead, "-m", "candidate");
  const receipt = `refs/void/operations/${sha256("reflog-race")}`;
  const racedLine = Buffer.from("foreign reflog append\n");
  await assert.rejects(commitRefTransaction(
    [
      { ref: "refs/heads/main", newOid: commit, oldOid: oldHead },
      { ref: receipt, newOid: commit, oldOid: null },
    ],
    () => {
      assert.equal(lstatSync(`${f.gitPath("refs/heads/main")}.lock`).isFile(), true);
      writeFileSync(f.gitPath("logs/refs/heads/main"), racedLine, { flag: "a" });
      throw new Error("reflog changed");
    },
    transactionServices(f),
  ), /transaction/);
  assert.equal(f.run("rev-parse", "HEAD"), oldHead);
  assert.notEqual(spawnSync("git", ["-C", f.root, "show-ref", "--verify", receipt]).status, 0);
  assert.deepEqual((await readFile(f.gitPath("logs/refs/heads/main"))).subarray(-racedLine.length), racedLine);
});

posixTest("ref transaction timeout waits for SIGTERM then SIGKILL and leaves no child", async (t) => {
  const f = await commitRepository(t);
  const directory = await f.temp();
  const pidPath = join(directory, "pid");
  const command = join(directory, "hanging-git");
  await writeFile(command, `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.on("SIGTERM",()=>{});process.stdin.resume();setInterval(()=>{},1000);\n`);
  const oid = f.run("rev-parse", "HEAD");
  const signals: NodeJS.Signals[] = [];
  const started = Date.now();
  await assert.rejects(commitRefTransaction(
    [{ ref: "refs/heads/main", newOid: oid, oldOid: oid }],
    () => {},
    transactionServices(f),
    { command: process.execPath, commandArgs: [command], timeoutMs: 250, termGraceMs: 100, killGraceMs: 100, onSignal: (signal) => signals.push(signal) },
  ), /transaction/);
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(signals.slice(0, 2), ["SIGTERM", "SIGKILL"]);
  const pid = Number(await readFile(pidPath, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(pathExistsForTest(`${f.gitPath("refs/heads/main")}.lock`), false);
});

function pathExistsForTest(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

posixTest("two processes racing one prepared commit produce one winner", async (t) => {
  const f = await commitRepository(t);
  await stageChange(f, "process-race");
  const args = { action: "commit", path: "selected" } as const;
  const observation = await f.adapter.preflight(args);
  const prepared = await f.adapter.prepare(args, observation, "two-process-op");
  const directory = await f.temp();
  const artifact = join(directory, "prepared.json");
  const script = join(directory, "race.mjs");
  await writeFile(artifact, JSON.stringify(prepared));
  const moduleUrl = new URL("./managed.ts", import.meta.url).href;
  await writeFile(script, `import fs from "node:fs";import { managedGitAdapter } from ${JSON.stringify(moduleUrl)};const prepared=JSON.parse(fs.readFileSync(${JSON.stringify(artifact)},"utf8"));const adapter=managedGitAdapter({root:${JSON.stringify(f.root)},cooperative:true});try{await adapter.execute({action:"commit",path:"selected"},prepared,"two-process-op");process.exit(0)}catch{process.exit(2)}\n`);
  const runChild = () => new Promise<number>((resolvePromise) => {
    const child = spawn(process.execPath, [script], { cwd: process.cwd(), stdio: "ignore" });
    child.on("close", (code) => resolvePromise(code ?? 3));
  });
  const beforeHead = f.run("rev-parse", "HEAD");
  const codes = await Promise.all([runChild(), runChild()]);
  assert.deepEqual(codes.sort(), [0, 2]);
  assert.equal(f.run("rev-parse", "HEAD^"), beforeHead);
  const receipt = (prepared.plan as unknown as CommitPlan).receiptRef;
  assert.equal(f.run("rev-parse", receipt), f.run("rev-parse", "HEAD"));
  assert.equal(f.run("for-each-ref", "--format=%(refname)", "refs/void/operations").split("\n").filter(Boolean).length, 1);
});


posixTest("private index cleanup runs after an injected Git failure", async (t) => {
  const f = await commitRepository(t);
  await stageChange(f, "failure-after-index");
  const realIndex = await readFile(f.gitPath("index"));
  const worktree = await readFile(join(f.root, "selected"));
  const oid = f.run("rev-parse", ":selected");
  const services = {
    root: f.root,
    indexPath: f.gitPath("index"),
    oidPattern: /^[0-9a-f]{40}$/,
    git(args: readonly string[], input?: Buffer | string, extraEnv: NodeJS.ProcessEnv = {}) {
      if (args[0] === "update-index") {
        writeFileSync(`${extraEnv.GIT_INDEX_FILE}.lock`, "owned lock");
        throw new Error("injected Git failure");
      }
      return execFileSync("git", ["-C", f.root, ...args], {
        input,
        env: { ...process.env, ...extraEnv },
        encoding: "utf8",
      }).trim();
    },
  } as unknown as CommitServices;
  await assert.rejects(
    writeCandidateTree(f.run("rev-parse", "HEAD^{tree}"), "selected", {
      present: true,
      mode: "100644",
      oid,
    }, "unused", services),
    /injected/,
  );
  assert.deepEqual(await readFile(f.gitPath("index")), realIndex);
  assert.deepEqual(await readFile(join(f.root, "selected")), worktree);
  assert.equal((await readdir(dirname(f.gitPath("index")))).some((name) => name.startsWith(".void-git-index-")), false);
});


for (const race of ["branch CAS", "preexisting receipt"] as const) {
  posixTest(`prepared ref transaction preserves ${race} raced state`, async (t) => {
    const f = await commitRepository(t);
    const plannedParent = f.run("rev-parse", "HEAD");
    const tree = f.run("rev-parse", "HEAD^{tree}");
    const candidate = f.run("commit-tree", tree, "-p", plannedParent, "-m", "candidate");
    const raced = f.run("commit-tree", tree, "-p", plannedParent, "-m", "raced");
    const receipt = `refs/void/operations/${sha256(`transaction-${race}`)}`;
    if (race === "branch CAS") f.run("update-ref", "refs/heads/main", raced, plannedParent);
    else f.run("update-ref", receipt, raced);
    const expectedHead = f.run("rev-parse", "HEAD");
    const expectedReceipt = race === "preexisting receipt" ? raced : null;
    const index = await readFile(f.gitPath("index"));
    const worktree = await readFile(join(f.root, "selected"));
    const foreignLock = `${f.gitPath("index")}.lock`;
    const lockBytes = Buffer.from(`foreign ${race} lock`);
    await writeFile(foreignLock, lockBytes);
    await assert.rejects(commitRefTransaction(
      [
        { ref: "refs/heads/main", newOid: candidate, oldOid: plannedParent },
        { ref: receipt, newOid: candidate, oldOid: null },
      ],
      () => {},
      transactionServices(f),
    ), /transaction/);
    assert.equal(f.run("rev-parse", "HEAD"), expectedHead);
    if (expectedReceipt) assert.equal(f.run("rev-parse", receipt), expectedReceipt);
    else assert.notEqual(spawnSync("git", ["-C", f.root, "show-ref", "--verify", receipt]).status, 0);
    assert.deepEqual(await readFile(f.gitPath("index")), index);
    assert.deepEqual(await readFile(join(f.root, "selected")), worktree);
    assert.deepEqual(await readFile(foreignLock), lockBytes);
  });
}

for (const lockKind of ["branch", "receipt"] as const) {
  posixTest(`ref transaction preserves a foreign ${lockKind} lock`, async (t) => {
    const f = await commitRepository(t);
    const head = f.run("rev-parse", "HEAD");
    const receipt = `refs/void/operations/${sha256(`lock-${lockKind}`)}`;
    const lock = lockKind === "branch"
      ? `${f.gitPath("refs/heads/main")}.lock`
      : `${f.gitPath(receipt)}.lock`;
    await mkdir(dirname(lock), { recursive: true });
    const bytes = Buffer.from([0, 255, 4, 2]);
    await writeFile(lock, bytes);
    await assert.rejects(commitRefTransaction(
      [
        { ref: "refs/heads/main", newOid: head, oldOid: head },
        { ref: receipt, newOid: head, oldOid: null },
      ],
      () => {},
      transactionServices(f),
    ), /transaction/);
    assert.deepEqual(await readFile(lock), bytes);
    assert.equal(f.run("rev-parse", "HEAD"), head);
  });
}


posixTest("failed nested-path transaction leaves every new object unreachable", async (t) => {
  const f = await commitRepository(t);
  await f.mkdirWorktree("nested");
  await f.write("nested/selected", "nested-candidate");
  f.run("add", "nested/selected");
  const args = { action: "commit", path: "nested/selected" } as const;
  const observation = await f.adapter.preflight(args);
  const prepared = await f.adapter.prepare(args, observation, "dangling-op");
  const captured = prepared.before as unknown as CommitCapture;
  const plan = prepared.plan as unknown as CommitPlan;
  const services = {
    ...transactionServices(f),
    indexPath: f.gitPath("index"),
    git(args: readonly string[], input?: Buffer | string, extraEnv: NodeJS.ProcessEnv = {}) {
      return execFileSync("git", ["-C", f.root, ...args], {
        input: typeof input === "string" ? Buffer.from(input) : input,
        env: { ...process.env, ...extraEnv },
        encoding: "utf8",
      }).trim();
    },
    gitBuffer(args: readonly string[], input?: Buffer | string, extraEnv: NodeJS.ProcessEnv = {}) {
      return execFileSync("git", ["-C", f.root, ...args], {
        input: typeof input === "string" ? Buffer.from(input) : input,
        env: { ...process.env, ...extraEnv },
        encoding: "buffer",
        maxBuffer: 20 * 1024 * 1024,
      });
    },
  } as unknown as CommitServices;
  const raced = f.run("commit-tree", captured.branch.tree, "-p", plan.parent, "-m", "raced");
  const beforeObjects = (await f.snapshot()).objects;
  const tree = await writeCandidateTree(
    captured.branch.tree,
    captured.selected.path,
    captured.selected.index,
    plan.expectedTreeManifestDigest,
    services,
  );
  const candidate = await createCommit(tree, plan.parent, plan.metadata, services);
  f.run("update-ref", plan.branchRef, raced, plan.parent);
  const racedState = await f.snapshot();
  await assert.rejects(commitRefTransaction(
    [
      { ref: plan.branchRef, newOid: candidate, oldOid: plan.parent },
      { ref: plan.receiptRef, newOid: candidate, oldOid: null },
    ],
    () => {},
    services,
  ), /transaction/);
  const after = await f.snapshot();
  assert.deepEqual(after.refs, racedState.refs);
  assert.deepEqual(after.index, racedState.index);
  assert.deepEqual(after.worktree, racedState.worktree);
  const newlyWritten = after.objects.filter((oid) => !beforeObjects.includes(oid));
  assert.ok(newlyWritten.length >= 3);
  const reachable = new Set(f.run("rev-list", "--objects", "--all").split("\n").map((line) => line.split(" ")[0]));
  for (const oid of newlyWritten) assert.equal(reachable.has(oid), false);
});

for (const alias of ["receipt leaf", "receipt parent"] as const) {
  posixTest(`locked ref transaction refuses a ${alias} alias and preserves its sentinel`, async (t) => {
    const f = await commitRepository(t);
    const oldHead = f.run("rev-parse", "HEAD");
    const tree = f.run("rev-parse", "HEAD^{tree}");
    const candidate = f.run("commit-tree", tree, "-p", oldHead, "-m", "candidate");
    const receipt = `refs/void/operations/${sha256(`locked-${alias}`)}`;
    const receiptPath = f.gitPath(receipt);
    await mkdir(dirname(receiptPath), { recursive: true });
    const captured = captureContainedPathChain(f.gitPath("."), receiptPath, "missing-or-file");
    const external = await f.temp();
    const sentinel = join(external, "sentinel");
    const bytes = Buffer.from([0, 7, 255, 1]);
    await writeFile(sentinel, bytes);
    await assert.rejects(commitRefTransaction(
      [
        { ref: "refs/heads/main", newOid: candidate, oldOid: oldHead },
        { ref: receipt, newOid: candidate, oldOid: null },
      ],
      () => {
        if (alias === "receipt leaf") {
          symlinkSyncForTest(sentinel, receiptPath);
        } else {
          const parent = dirname(receiptPath);
          const moved = join(external, "operations");
          renameSync(parent, moved);
          symlinkSyncForTest(moved, parent);
        }
        const current = captureContainedPathChain(f.gitPath("."), receiptPath, "missing-or-file");
        assert.deepEqual(current, captured);
      },
      transactionServices(f),
    ), /transaction/);
    assert.equal(f.run("rev-parse", "HEAD"), oldHead);
    assert.deepEqual(await readFile(sentinel), bytes);
  });
}

function symlinkSyncForTest(target: string, path: string): void {
  execFileSync("ln", ["-s", target, path]);
}


posixTest("private index token mode ignores a hostile umask", async (t) => {
  const f = await commitRepository(t);
  const prior = process.umask(0o777);
  try {
    const workspace = createPrivateIndexWorkspace(f.gitPath("index"));
    try {
      assert.equal((await lstat(workspace.directory, { bigint: true })).mode & 0o777n, 0o700n);
      assert.equal((await lstat(workspace.tokenPath, { bigint: true })).mode & 0o777n, 0o600n);
    } finally { cleanupPrivateIndexWorkspace(workspace); }
  } finally { process.umask(prior); }
});

for (const event of ["random", "open", "write", "close", "lstat", "validation"] as const) {
  posixTest(`private index initialization cleans up an injected ${event} failure`, async (t) => {
    const f = await commitRepository(t);
    const parent = dirname(f.gitPath("index"));
    const before = (await readdir(parent)).filter((name) => name.startsWith(".void-git-index-")).sort();
    assert.throws(() => createPrivateIndexWorkspace(f.gitPath("index"), {
      seam(actual) {
        if (actual === event) throw new Error(`injected ${event} failure`);
      },
    }), new RegExp(`injected ${event}`));
    const after = (await readdir(parent)).filter((name) => name.startsWith(".void-git-index-")).sort();
    assert.deepEqual(after, before);
  });
}

posixTest("real prepared transaction timeout aborts and releases both locks", async (t) => {
  const f = await commitRepository(t);
  const oldHead = f.run("rev-parse", "HEAD");
  const tree = f.run("rev-parse", "HEAD^{tree}");
  const candidate = f.run("commit-tree", tree, "-p", oldHead, "-m", "candidate");
  const receipt = `refs/void/operations/${sha256("real-timeout")}`;
  let pid = 0;
  await assert.rejects(commitRefTransaction(
    [
      { ref: "refs/heads/main", newOid: candidate, oldOid: oldHead },
      { ref: receipt, newOid: candidate, oldOid: null },
    ],
    () => {},
    transactionServices(f),
    {
      timeoutMs: 100,
      termGraceMs: 100,
      killGraceMs: 100,
      holdAfterPrepare: true,
      onSpawn: (childPid) => { pid = childPid; },
    },
  ), (error: Error) => error.message === "Managed Git ref transaction failed.");
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(pathExistsForTest(`${f.gitPath("refs/heads/main")}.lock`), false);
  assert.equal(pathExistsForTest(`${f.gitPath(receipt)}.lock`), false);
  assert.equal(f.run("rev-parse", "HEAD"), oldHead);
});

posixTest("real prepared protocol failure aborts and releases both locks", async (t) => {
  const f = await commitRepository(t);
  const oldHead = f.run("rev-parse", "HEAD");
  const tree = f.run("rev-parse", "HEAD^{tree}");
  const candidate = f.run("commit-tree", tree, "-p", oldHead, "-m", "candidate");
  const receipt = `refs/void/operations/${sha256("real-protocol")}`;
  let pid = 0;
  await assert.rejects(commitRefTransaction(
    [
      { ref: "refs/heads/main", newOid: candidate, oldOid: oldHead },
      { ref: receipt, newOid: candidate, oldOid: null },
    ],
    () => { throw new Error("secret recheck output"); },
    transactionServices(f),
    { onSpawn: (childPid) => { pid = childPid; } },
  ), (error: Error) => error.message === "Managed Git ref transaction failed." && !error.message.includes("secret"));
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(pathExistsForTest(`${f.gitPath("refs/heads/main")}.lock`), false);
  assert.equal(pathExistsForTest(`${f.gitPath(receipt)}.lock`), false);
  assert.equal(f.run("rev-parse", "HEAD"), oldHead);
});

const protocolCases = [
  { name: "early close", body: "process.exit(0)" },
  { name: "nonzero close", body: "process.exit(7)" },
  { name: "signal close", body: "process.kill(process.pid, 'SIGTERM')" },
  { name: "bounded stderr", body: "process.stderr.write('secret-child-stderr');process.exit(1)" },
  { name: "overcap stderr", body: "process.stderr.write('secret'.repeat(12000));process.exit(1)" },
  { name: "malformed stdout", body: "process.stdout.write('secret malformed\\n');process.stdin.resume()" },
  { name: "overcap stdout", body: "process.stdout.write('secret'.repeat(12000));process.stdin.resume()" },
  { name: "close after prepare", body: "process.stdout.write('start: ok\\nprepare: ok\\n');process.exit(0)" },
] as const;

for (const protocol of protocolCases) {
  posixTest(`ref transaction redacts and bounds ${protocol.name}`, async (t) => {
    const f = await commitRepository(t);
    const directory = await f.temp();
    const script = join(directory, "protocol.cjs");
    const pidPath = join(directory, "pid");
    await writeFile(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));${protocol.body};setInterval(()=>{},1000);`);
    const head = f.run("rev-parse", "HEAD");
    await assert.rejects(commitRefTransaction(
      [{ ref: "refs/heads/main", newOid: head, oldOid: head }],
      () => {},
      transactionServices(f),
      {
        command: process.execPath,
        commandArgs: [script],
        timeoutMs: 150,
        termGraceMs: 75,
        killGraceMs: 75,
      },
    ), (error: Error) => error.message === "Managed Git ref transaction failed." && !error.message.includes("secret"));
    const pid = Number(await readFile(pidPath, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(pathExistsForTest(`${f.gitPath("refs/heads/main")}.lock`), false);
  });
}

const preparedProtocolFailures = [
  {
    name: "same chunk malformed ASCII",
    writes: "process.stdout.write(Buffer.concat([Buffer.from('start: ok\\nprepare: ok\\n'),Buffer.from('malformed\\n')]))",
  },
  {
    name: "fragmented malformed ASCII",
    writes: "process.stdout.write('start: ok\\npre');setTimeout(()=>process.stdout.write('pare: ok\\nmalformed\\n'),20)",
  },
  {
    name: "same chunk invalid UTF-8",
    writes: "process.stdout.write(Buffer.concat([Buffer.from('start: ok\\nprepare: ok\\n'),Buffer.from([0xff])]))",
  },
  {
    name: "fragmented invalid UTF-8",
    writes: "process.stdout.write('start: ok\\npre');setTimeout(()=>process.stdout.write(Buffer.concat([Buffer.from('pare: ok\\n'),Buffer.from([0xff])])),20)",
  },
  {
    name: "same chunk over-cap stdout",
    writes: "process.stdout.write(Buffer.concat([Buffer.from('start: ok\\nprepare: ok\\n'),Buffer.alloc(70*1024,120)]))",
  },
  {
    name: "fragmented over-cap stdout",
    writes: "process.stdout.write('start: ok\\npre');setTimeout(()=>process.stdout.write(Buffer.concat([Buffer.from('pare: ok\\n'),Buffer.alloc(70*1024,120)])),20)",
  },
] as const;

for (const protocol of preparedProtocolFailures) {
  posixTest(`prepared ${protocol.name} flushes abort before termination`, async (t) => {
    const f = await commitRepository(t);
    const directory = await f.temp();
    const script = join(directory, "prepared-protocol.cjs");
    const pidPath = join(directory, "pid");
    const abortPath = join(directory, "abort");
    const receipt = `refs/void/operations/${sha256(`prepared-${protocol.name}`)}`;
    const lockPaths = [
      `${f.gitPath("refs/heads/main")}.lock`,
      `${f.gitPath(receipt)}.lock`,
    ];
    await mkdir(dirname(lockPaths[1]!), { recursive: true });
    await writeFile(script, `const fs=require('node:fs');const locks=${JSON.stringify(lockPaths)};fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));for(const lock of locks)fs.writeFileSync(lock,'owned lock');process.on('SIGTERM',()=>{});process.stdin.on('data',chunk=>{if(chunk.toString().includes('abort\\n')){fs.writeFileSync(${JSON.stringify(abortPath)},'abort\\n');for(const lock of locks)fs.unlinkSync(lock)}});${protocol.writes};setInterval(()=>{},1000);`);
    const head = f.run("rev-parse", "HEAD");
    const signals: NodeJS.Signals[] = [];
    await assert.rejects(commitRefTransaction(
      [
        { ref: "refs/heads/main", newOid: head, oldOid: head },
        { ref: receipt, newOid: head, oldOid: null },
      ],
      () => {},
      transactionServices(f),
      {
        command: process.execPath,
        commandArgs: [script],
        timeoutMs: 500,
        abortGraceMs: 100,
        termGraceMs: 100,
        killGraceMs: 100,
        holdAfterPrepare: true,
        onSignal(signal) {
          assert.deepEqual(readFileSync(abortPath), Buffer.from("abort\n"));
          for (const lockPath of lockPaths)
            assert.equal(pathExistsForTest(lockPath), false);
          signals.push(signal);
        },
      },
    ), (error: Error) => error.message === "Managed Git ref transaction failed." && !error.message.includes("malformed"));
    assert.deepEqual(await readFile(abortPath), Buffer.from("abort\n"));
    assert.deepEqual(signals.slice(0, 2), ["SIGTERM", "SIGKILL"]);
    const pid = Number(await readFile(pidPath, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    for (const lockPath of lockPaths)
      assert.equal(pathExistsForTest(lockPath), false);
  });
}

posixTest("private index actual first directory lstat failure cleans its owned directory", async (t) => {
  const f = await commitRepository(t);
  const parent = dirname(f.gitPath("index"));
  const before = (await readdir(parent)).filter((name) => name.startsWith(".void-git-index-")).sort();
  assert.throws(() => createPrivateIndexWorkspace(f.gitPath("index"), {
    directoryLstat() {
      throw new Error("injected actual first lstat failure");
    },
  }), /injected actual first lstat/);
  const after = (await readdir(parent)).filter((name) => name.startsWith(".void-git-index-")).sort();
  assert.deepEqual(after, before);
});

for (const replacementKind of ["different-mode directory", "nonempty directory", "symlink"] as const) {
  posixTest(`private index first lstat failure preserves a ${replacementKind} replacement`, async (t) => {
    const f = await commitRepository(t);
    const parent = dirname(f.gitPath("index"));
    const before = new Set(await readdir(parent));
    const external = await f.temp();
    const sentinel = join(external, "sentinel");
    const foreign = Buffer.from(`foreign ${replacementKind}`);
    await writeFile(sentinel, foreign);
    let original = "";
    let replacement = "";
    assert.throws(() => createPrivateIndexWorkspace(f.gitPath("index"), {
      directoryLstat(path) {
        original = `${path}-moved`;
        replacement = path;
        renameSync(path, original);
        if (replacementKind === "symlink") {
          symlinkSyncForTest(external, replacement);
        } else {
          mkdirSync(replacement, { mode: replacementKind === "different-mode directory" ? 0o755 : 0o700 });
          if (replacementKind === "different-mode directory")
            chmodSync(replacement, 0o755);
          if (replacementKind === "nonempty directory")
            writeFileSync(join(replacement, "sentinel"), foreign);
        }
        throw new Error("injected replacement before first lstat");
      },
    }), /injected replacement before first lstat/);
    if (replacementKind === "symlink") {
      assert.deepEqual(await readFile(join(replacement, "sentinel")), foreign);
    } else if (replacementKind === "nonempty directory") {
      assert.deepEqual(await readFile(join(replacement, "sentinel")), foreign);
    } else {
      assert.equal((await lstat(replacement)).isDirectory(), true);
    }
    assert.deepEqual(
      (await readdir(parent)).filter((name) => before.has(name)).sort(),
      [...before].sort(),
    );
    await rm(original, { recursive: true, force: true });
    await rm(replacement, { recursive: true, force: true });
  });
}

const stdinEndCallbackCases = [
  { name: "missing", schedule: (_callback: () => void) => {} },
  { name: "delayed", schedule: (callback: () => void) => setTimeout(callback, 500) },
] as const;

for (const callbackCase of stdinEndCallbackCases) {
  posixTest(`prepared shutdown survives a ${callbackCase.name} stdin end callback`, async (t) => {
    const f = await commitRepository(t);
    const directory = await f.temp();
    const script = join(directory, "stdin-callback.cjs");
    const pidPath = join(directory, "pid");
    await writeFile(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.on('SIGTERM',()=>{});process.stdin.resume();process.stdout.write('start: ok\\nprepare: ok\\nmalformed\\n');setInterval(()=>{},1000);`);
    const head = f.run("rev-parse", "HEAD");
    const signals: NodeJS.Signals[] = [];
    let scheduled = 0;
    const started = Date.now();
    await assert.rejects(commitRefTransaction(
      [{ ref: "refs/heads/main", newOid: head, oldOid: head }],
      () => {},
      transactionServices(f),
      {
        command: process.execPath,
        commandArgs: [script],
        timeoutMs: 500,
        abortGraceMs: 50,
        termGraceMs: 50,
        killGraceMs: 100,
        scheduleStdinEndCallback(callback) {
          scheduled += 1;
          callbackCase.schedule(callback);
        },
        onSignal: (signal) => signals.push(signal),
      },
    ), /transaction/);
    assert.equal(scheduled, 1);
    assert.ok(Date.now() - started < 400);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    const pid = Number(await readFile(pidPath, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  });
}

posixTest("prepared shutdown flushes abort before SIGTERM and SIGKILL", async (t) => {
  const f = await commitRepository(t);
  const directory = await f.temp();
  const script = join(directory, "prepared-hang.cjs");
  const pidPath = join(directory, "pid");
  const abortPath = join(directory, "abort");
  await writeFile(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.on('SIGTERM',()=>{});process.stdout.write('start: ok\\nprepare: ok\\n');process.stdin.on('data',chunk=>{if(chunk.toString().includes('abort\\n'))fs.writeFileSync(${JSON.stringify(abortPath)},'abort\\n')});setInterval(()=>{},1000);`);
  const head = f.run("rev-parse", "HEAD");
  const signals: NodeJS.Signals[] = [];
  await assert.rejects(commitRefTransaction(
    [{ ref: "refs/heads/main", newOid: head, oldOid: head }],
    () => {},
    transactionServices(f),
    {
      command: process.execPath,
      commandArgs: [script],
      timeoutMs: 100,
      abortGraceMs: 100,
      termGraceMs: 100,
      killGraceMs: 100,
      holdAfterPrepare: true,
      onSignal(signal) {
        assert.equal(pathExistsForTest(abortPath), true);
        signals.push(signal);
      },
    },
  ), (error: Error) => error.message === "Managed Git ref transaction failed.");
  assert.deepEqual(await readFile(abortPath), Buffer.from("abort\n"));
  assert.deepEqual(signals.slice(0, 2), ["SIGTERM", "SIGKILL"]);
  const pid = Number(await readFile(pidPath, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

posixTest("private index initialization never deletes a replaced foreign token", async (t) => {
  const f = await commitRepository(t);
  const parent = dirname(f.gitPath("index"));
  const before = new Set(await readdir(parent));
  const foreign = Buffer.from("foreign initialization token");
  let tokenPath = "";
  assert.throws(() => createPrivateIndexWorkspace(f.gitPath("index"), {
    seam(event) {
      if (event !== "validation") return;
      const directory = readdirSync(parent).map((name) => join(parent, name))
        .find((path) => !before.has(path.slice(parent.length + 1)) && path.includes(".void-git-index-"));
      assert.ok(directory);
      tokenPath = join(directory, "owner");
      unlinkSync(tokenPath);
      writeFileSync(tokenPath, foreign);
      throw new Error("injected foreign replacement");
    },
  }), /injected foreign replacement/);
  assert.deepEqual(await readFile(tokenPath), foreign);
  await rm(dirname(tokenPath), { recursive: true, force: true });
});

posixTest("private index initialization preserves a token with reused inode numbers", async (t) => {
  const f = await commitRepository(t);
  const parent = dirname(f.gitPath("index"));
  const before = new Set(await readdir(parent));
  const foreign = Buffer.from("foreign initialization token");
  let tokenPath = "";
  assert.throws(() => createPrivateIndexWorkspace(f.gitPath("index"), {
    seam(event) {
      if (event !== "validation") return;
      const directory = readdirSync(parent).map((name) => join(parent, name))
        .find((path) => !before.has(path.slice(parent.length + 1)) && path.includes(".void-git-index-"));
      assert.ok(directory);
      tokenPath = join(directory, "owner");
      const owned = lstatSync(tokenPath, { bigint: true });
      unlinkSync(tokenPath);
      writeFileSync(tokenPath, foreign);
      reusePathInode(t, tokenPath, owned);
      throw new Error("injected foreign replacement");
    },
  }), /injected foreign replacement/);
  assert.deepEqual(await readFile(tokenPath), foreign);
  await rm(dirname(tokenPath), { recursive: true, force: true });
});

type ReceiptDamage =
  | "missing"
  | "wrong-commit"
  | "corrupt-object"
  | "wrong-metadata"
  | "wrong-tree"
  | "wrong-parent";

function forgeManagedCommit(
  f: CommitFixture,
  plan: CommitPlan,
  options: { tree?: string; parent?: string | null; fixedMetadata?: boolean } = {},
): string {
  const tree = options.tree ?? f.run("rev-parse", `${plan.parent}^{tree}`);
  const parent = options.parent === undefined ? plan.parent : options.parent;
  const args = ["-C", f.root, "commit-tree", tree];
  if (parent !== null) args.push("-p", parent);
  const fixed = options.fixedMetadata !== false;
  return execFileSync("git", args, {
    encoding: "utf8",
    input: `${plan.metadata.subject}\n`,
    env: fixed ? {
      ...process.env,
      LC_ALL: "C",
      GIT_AUTHOR_NAME: plan.metadata.authorName,
      GIT_AUTHOR_EMAIL: plan.metadata.authorEmail,
      GIT_AUTHOR_DATE: `${plan.metadata.timestamp} +0000`,
      GIT_COMMITTER_NAME: plan.metadata.committerName,
      GIT_COMMITTER_EMAIL: plan.metadata.committerEmail,
      GIT_COMMITTER_DATE: `${plan.metadata.timestamp} +0000`,
    } : { ...process.env, LC_ALL: "C" },
  }).trim();
}

async function damageOperationReceipt(
  f: CommitFixture,
  plan: CommitPlan,
  damage: ReceiptDamage,
): Promise<void> {
  if (damage === "missing") {
    f.run("update-ref", "-d", plan.receiptRef);
    return;
  }
  if (damage === "wrong-commit") {
    f.run("update-ref", plan.receiptRef, plan.parent);
    return;
  }
  if (damage === "corrupt-object") {
    const oid = "a".repeat(40);
    const objectDirectory = f.gitPath(`objects/${oid.slice(0, 2)}`);
    await mkdir(objectDirectory, { recursive: true });
    await writeFile(join(objectDirectory, oid.slice(2)), "corrupt");
    await writeFile(f.gitPath(plan.receiptRef), `${oid}\n`);
    return;
  }
  const managedTree = f.run("rev-parse", `${plan.receiptRef}^{tree}`);
  const commit = damage === "wrong-metadata"
    ? forgeManagedCommit(f, plan, { tree: managedTree, fixedMetadata: false })
    : damage === "wrong-tree"
      ? forgeManagedCommit(f, plan, { fixedMetadata: true })
      : forgeManagedCommit(f, plan, { tree: managedTree, parent: null, fixedMetadata: true });
  f.run("update-ref", plan.receiptRef, commit);
}

posixTest(
  "forward reconciliation requires the exact fully validated receipt",
  async (t) => {
    for (const damage of [
      "none",
      "missing",
      "wrong-commit",
      "corrupt-object",
      "wrong-metadata",
      "wrong-tree",
      "wrong-parent",
    ] as const) {
      await t.test(damage, async (t) => {
        const f = await commitRepository(t);
        await stageChange(f, "after");
        const { prepared, outcome } = await dispatchForward(f, "receipt-op");
        const plan = prepared.plan as unknown as CommitPlan;
        const before = await f.snapshot();
        if (damage !== "none") await damageOperationReceipt(f, plan, damage);
        const beforeReconcile = await f.snapshot();
        const result = await managedGitAdapter({ root: f.root, cooperative: true })
          .reconcile("receipt-op", prepared);
        if (damage === "none") {
          assert.equal(result.status, "succeeded");
          assert.deepEqual(result.status === "succeeded" && result.outcome, outcome);
        } else {
          assert.deepEqual(result, { status: "unknown" });
        }
        const after = await f.snapshot();
        assert.equal(after.head, before.head);
        assert.deepEqual(after.index, beforeReconcile.index);
        assert.deepEqual(after.worktree, beforeReconcile.worktree);
      });
    }
  },
);

posixTest(
  "forward reconciliation survives restart and unrelated later commits",
  async (t) => {
    const f = await commitRepository(t);
    await stageChange(f, "managed");
    const { prepared, outcome } = await dispatchForward(f, "later-op");
    await f.write("later-one", "one");
    f.run("add", "later-one");
    f.run("commit", "-qm", "later one");
    await f.write("later-two", "two");
    f.run("add", "later-two");
    f.run("commit", "-qm", "later two");
    const before = await f.snapshot();
    const result = await managedGitAdapter({ root: f.root, cooperative: true })
      .reconcile("later-op", JSON.parse(JSON.stringify(prepared)));
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.status === "succeeded" && result.outcome, outcome);
    assert.deepEqual(await f.snapshot(), before);
  },
);

posixTest(
  "forward reconciliation rejects equality and ancestry without the exact receipt",
  async (t) => {
    for (const ancestry of [false, true]) {
      await t.test(ancestry ? "ancestry" : "target equality", async (t) => {
        const f = await commitRepository(t);
        await stageChange(f, "managed");
        const { prepared } = await dispatchForward(f, "no-receipt-op");
        const plan = prepared.plan as unknown as CommitPlan;
        if (ancestry) {
          await f.write("later", "later");
          f.run("add", "later");
          f.run("commit", "-qm", "later");
        }
        f.run("update-ref", "-d", plan.receiptRef);
        const before = await f.snapshot();
        assert.deepEqual(
          await managedGitAdapter({ root: f.root, cooperative: true })
            .reconcile("no-receipt-op", prepared),
          { status: "unknown" },
        );
        assert.deepEqual(await f.snapshot(), before);
      });
    }
  },
);

posixTest(
  "forward reconciliation rejects copied prepared evidence and wrong repository identity",
  async (t) => {
    const source = await commitRepository(t);
    await stageChange(source, "managed");
    const { prepared } = await dispatchForward(source, "source-op");
    const sourceBefore = await source.snapshot();
    assert.deepEqual(
      await managedGitAdapter({ root: source.root, cooperative: true })
        .reconcile("copied-op", prepared),
      { status: "unknown" },
    );
    assert.deepEqual(await source.snapshot(), sourceBefore);
    for (const tamper of ["metadata", "tree", "parent", "repository"] as const) {
      const changed = JSON.parse(JSON.stringify(prepared));
      const plan = changed.plan as CommitPlan;
      if (tamper === "metadata") plan.metadata.subject = "tampered";
      else if (tamper === "tree") plan.expectedTreeManifestDigest = "0".repeat(64);
      else if (tamper === "parent") plan.parent = (prepared.plan as unknown as CommitPlan).receiptRef.slice(-40);
      else plan.repository.identity = "copied repository";
      assert.deepEqual(
        await managedGitAdapter({ root: source.root, cooperative: true })
          .reconcile("source-op", changed),
        { status: "unknown" },
      );
      assert.deepEqual(await source.snapshot(), sourceBefore);
    }

    const other = await commitRepository(t);
    const otherBefore = await other.snapshot();
    assert.deepEqual(
      await managedGitAdapter({ root: other.root, cooperative: true })
        .reconcile("source-op", prepared),
      { status: "unknown" },
    );
    assert.deepEqual(await other.snapshot(), otherBefore);
  },
);

posixTest(
  "lost execution response reconciles once after restart without redispatch",
  async (t) => {
    const f = await commitRepository(t);
    await stageChange(f, "managed");
    const state = await f.temp();
    const signer = await devKeyProvider({ dir: join(state, "keys"), env: {} });
    const keys = { test: randomBytes(32) };
    const journal = localOperationJournal(join(state, "journal"), signer);
    const vault = localRecoveryVault(join(state, "vault"), keys, "test");
    const adapter = managedGitAdapter({ root: f.root, cooperative: true });
    const execute = adapter.execute;
    let dispatches = 0;
    adapter.execute = async (...args) => {
      dispatches++;
      await execute(...args);
      throw new Error("lost response");
    };
    const options = {
      journal,
      vault,
      adapters: [adapter],
      authorize: async () => true,
    };
    const request: ExecutionRequest = {
      workspace: "test",
      operationId: "runtime-op",
      agentId: "agent",
      runId: "run",
      adapterId: "git.managed",
      arguments: { action: "commit", path: "selected" },
    };
    const parent = f.run("rev-parse", "HEAD");
    const before = await f.snapshot();
    assert.equal((await recoveryRuntime(options).execute(request)).status, "unknown");
    const fresh = recoveryRuntime({
      ...options,
      adapters: [managedGitAdapter({ root: f.root, cooperative: true })],
    });
    assert.equal((await fresh.reconcile("test", "runtime-op")).status, "succeeded");
    assert.equal(dispatches, 1);
    assert.equal(f.run("rev-list", "--count", `${parent}..HEAD`), "1");
    assert.equal(
      f.run("for-each-ref", "--format=%(refname)", "refs/void/operations/")
        .split("\n").filter(Boolean).length,
      1,
    );
    const after = await f.snapshot();
    assert.deepEqual(after.index, before.index);
    assert.deepEqual(after.worktree, before.worktree);
  },
);


posixTest("recovery appends an inverse commit and durable receipt", async (t) => {
  const f = await commitRepository(t);
  await stageChange(f, "managed");
  const { prepared, outcome } = await dispatchForward(f, "recover-op");
  const forward = f.run("rev-parse", "HEAD");
  const indexBefore = await readFile(f.gitPath("index"));
  const worktreeBefore = await readFile(join(f.root, "selected"));
  const result = await f.adapter.recover(prepared, outcome, "recover-id");
  assert.equal(result.status, "restored");
  const inverse = f.run("rev-parse", "HEAD");
  assert.notEqual(inverse, forward);
  assert.equal(f.run("rev-parse", `${inverse}^`), forward);
  assert.equal(f.run("show", `${inverse}:selected`), "before");
  assert.equal(f.run("rev-parse", "refs/void/recoveries/da80fe9f48e6d203b1c5ce1aef6a8566795642dd501ffe3fc59104cc268c0810"), inverse);
  assert.deepEqual(await readFile(f.gitPath("index")), indexBefore);
  assert.deepEqual(await readFile(join(f.root, "selected")), worktreeBefore);
});

posixTest("a managed commit on top of a merge commit keeps the merge and recovers", async (t) => {
  const f = await commitRepository(t);
  // A real merge, not a fast-forward, so the tip the adapter builds on has two
  // parents. The claim under test is that such a tip is an ordinary base: the
  // documents used to say merge commits were out of scope, and nothing in the
  // source inspects the parent's count.
  f.run("checkout", "-q", "-b", "side");
  await f.write("side-only", "side");
  f.run("add", "side-only");
  f.run("commit", "-qm", "side");
  f.run("checkout", "-q", "main");
  await f.write("main-only", "main");
  f.run("add", "main-only");
  f.run("commit", "-qm", "main");
  f.run("merge", "-q", "--no-ff", "-m", "merge side", "side");
  const merged = f.run("rev-parse", "HEAD");
  assert.equal(f.run("rev-list", "--parents", "-n", "1", merged).split(" ").length, 3);
  await stageChange(f, "after-merge");
  const before = await f.snapshot();
  const { prepared, outcome } = await dispatchForward(f, "merge-forward");
  const head = f.run("rev-parse", "HEAD");
  assert.equal(f.run("rev-parse", "HEAD^"), merged);
  assert.equal(f.run("rev-list", "--parents", "-n", "1", head).split(" ").length, 2);
  assert.equal(f.run("show", `${head}:side-only`), "side");
  assert.equal(f.run("show", `${head}:main-only`), "main");
  assert.deepEqual((await f.snapshot()).worktree, before.worktree);
  assert.equal((await f.adapter.recover(prepared, outcome, "merge-recover")).status, "restored");
  // The inverse lands on the managed commit, and both merged files survive it.
  const inverse = f.run("rev-parse", "HEAD");
  assert.equal(f.run("rev-parse", `${inverse}^`), head);
  assert.equal(f.run("show", `${inverse}:selected`), "before");
  assert.equal(f.run("show", `${inverse}:side-only`), "side");
  assert.equal(f.run("show", `${inverse}:main-only`), "main");
});

posixTest("recovery is restart-idempotent from its exact receipt", async (t) => {
  const f = await commitRepository(t);
  await stageChange(f, "managed");
  const { prepared, outcome } = await dispatchForward(f, "restart-op");
  const first = await f.adapter.recover(prepared, outcome, "restart-recovery");
  assert.equal(first.status, "restored");
  const head = f.run("rev-parse", "HEAD");
  const restarted = managedGitAdapter({ root: f.root, cooperative: true });
  assert.deepEqual(await restarted.reconcileRecovery?.(
    prepared, outcome, "restart-recovery",
  ), first);
  assert.deepEqual(await restarted.recover(
    prepared, outcome, "restart-recovery",
  ), first);
  assert.equal(f.run("rev-parse", "HEAD"), head);
});

posixTest("recovery preserves an unrelated later commit", async (t) => {
  const f = await commitRepository(t);
  await stageChange(f, "managed");
  const { prepared, outcome } = await dispatchForward(f, "later-op");
  await f.write("unrelated", "later");
  f.run("add", "unrelated");
  f.run("commit", "-qm", "later unrelated");
  const later = f.run("rev-parse", "HEAD");
  const result = await f.adapter.recover(prepared, outcome, "later-recovery");
  assert.equal(result.status, "restored");
  assert.equal(f.run("rev-parse", "HEAD^"), later);
  assert.equal(f.run("show", "HEAD:selected"), "before");
  assert.equal(f.run("show", "HEAD:unrelated"), "later");
});

posixTest("recovery refuses selected-path and branch drift without a receipt", async (t) => {
  for (const drift of ["index", "worktree", "branch"] as const) await t.test(drift, async (t) => {
    const f = await commitRepository(t);
    await stageChange(f, "managed");
    const { prepared, outcome } = await dispatchForward(f, `drift-${drift}`);
    if (drift === "index") {
      await f.write("selected", "foreign");
      f.run("add", "selected");
      await f.write("selected", "managed");
    } else if (drift === "worktree") await f.write("selected", "foreign");
    else f.run("update-ref", "refs/heads/main", f.run("rev-parse", "HEAD^"));
    const before = f.run("rev-parse", "HEAD");
    assert.deepEqual(
      await f.adapter.recover(prepared, outcome, `drift-recovery-${drift}`),
      { status: "conflict", evidence: null },
    );
    assert.equal(f.run("rev-parse", "HEAD"), before);
  });
});


function selectedStateServices(f: CommitFixture): CommitServices {
  const head = f.run("rev-parse", "HEAD");
  return {
    root: f.root,
    oidPattern: new RegExp(`^[0-9a-f]{${head.length}}$`),
    git: (args: readonly string[]) => f.run(...args),
    gitBuffer: (args: readonly string[]) => execFileSync("git", ["-C", f.root, ...args]),
    pathTarget: (path: string) => join(f.root, path),
  } as unknown as CommitServices;
}

posixTest("locked recovery boundary rejects selected index and worktree races", async (t) => {
  for (const race of ["index", "worktree"] as const) await t.test(race, async (t) => {
    const f = await commitRepository(t);
    await stageChange(f, "managed");
    const args = { action: "commit", path: "selected" } as const;
    const observation = await f.adapter.preflight(args);
    const prepared = await f.adapter.prepare(args, observation, `boundary-${race}`);
    const captured = prepared.before as unknown as CommitCapture;
    const oldHead = f.run("rev-parse", "HEAD");
    const tree = f.run("rev-parse", "HEAD^{tree}");
    const candidate = f.run("commit-tree", tree, "-p", oldHead, "-m", "candidate");
    const receipt = `refs/void/recoveries/${sha256(`boundary-${race}`)}`;
    await assert.rejects(commitRefTransaction(
      [
        { ref: "refs/heads/main", newOid: candidate, oldOid: oldHead },
        { ref: receipt, newOid: candidate, oldOid: null },
      ],
      () => {
        if (race === "index") {
          writeFileSync(join(f.root, "selected"), "foreign");
          f.run("add", "selected");
          writeFileSync(join(f.root, "selected"), "managed");
        } else writeFileSync(join(f.root, "selected"), "foreign");
        verifySelectedHumanState(captured, selectedStateServices(f));
      },
      transactionServices(f),
    ));
    assert.equal(f.run("rev-parse", "HEAD"), oldHead);
    assert.throws(() => f.run("show-ref", "--verify", receipt));
  });
});

posixTest("ref transaction disables reference-transaction hooks", async (t) => {
  const f = await commitRepository(t);
  const sentinel = join(f.root, "hook-ran");
  const hook = f.gitPath("hooks/reference-transaction");
  await writeFile(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(sentinel)}\n`);
  await chmod(hook, 0o755);
  const oldHead = f.run("rev-parse", "HEAD");
  const tree = f.run("rev-parse", "HEAD^{tree}");
  const candidate = f.run("commit-tree", tree, "-p", oldHead, "-m", "candidate");
  const receipt = `refs/void/operations/${sha256("hook-disabled")}`;
  await commitRefTransaction(
    [
      { ref: "refs/heads/main", newOid: candidate, oldOid: oldHead },
      { ref: receipt, newOid: candidate, oldOid: null },
    ],
    () => {},
    transactionServices(f),
  );
  await assert.rejects(readFile(sentinel), /ENOENT/);
});

posixTest("recovery refuses destructive ref path drift", async (t) => {
  for (const drift of ["packed", "void-alias"] as const) await t.test(drift, async (t) => {
    const f = await commitRepository(t);
    await stageChange(f, "managed");
    const { prepared, outcome } = await dispatchForward(f, `path-${drift}`);
    const head = f.run("rev-parse", "HEAD");
    if (drift === "packed") {
      await writeFile(f.gitPath("packed-refs"), "# pack-refs with: peeled fully-peeled sorted \n");
    } else {
      const namespace = f.gitPath("refs/void");
      const moved = f.gitPath("refs/void-moved");
      await rename(namespace, moved);
      await symlink(moved, namespace);
    }
    assert.deepEqual(await f.adapter.recover(prepared, outcome, `path-recovery-${drift}`), {
      status: "conflict", evidence: null,
    });
    assert.equal(f.run("rev-parse", "HEAD"), head);
    assert.throws(() => f.run("show-ref", "--verify", `refs/void/recoveries/${sha256(`path-recovery-${drift}`)}`));
  });
});


posixTest("locked ref boundary rejects branch and reflog inode races", async (t) => {
  for (const race of ["branch", "reflog"] as const) await t.test(race, async (t) => {
    const f = await commitRepository(t);
    await stageChange(f, "managed");
    const args = { action: "commit", path: "selected" } as const;
    const observation = await f.adapter.preflight(args);
    const prepared = await f.adapter.prepare(args, observation, `ref-boundary-${race}`);
    const captured = prepared.before as unknown as CommitCapture;
    const oldHead = f.run("rev-parse", "HEAD");
    const tree = f.run("rev-parse", "HEAD^{tree}");
    const candidate = f.run("commit-tree", tree, "-p", oldHead, "-m", "candidate");
    const receipt = `refs/void/recoveries/${sha256(`ref-boundary-${race}`)}`;
    await assert.rejects(commitRefTransaction(
      [
        { ref: "refs/heads/main", newOid: candidate, oldOid: oldHead },
        { ref: receipt, newOid: candidate, oldOid: null },
      ],
      () => {
        const target = f.gitPath(race === "branch" ? "refs/heads/main" : "logs/refs/heads/main");
        const bytes = readFileSync(target);
        unlinkSync(target);
        writeFileSync(target, bytes);
        verifyFilesRefPaths(captured.repository.destructivePaths);
      },
      transactionServices(f),
    ));
    assert.equal(f.run("rev-parse", "HEAD"), oldHead);
    assert.throws(() => f.run("show-ref", "--verify", receipt));
  });
});


posixTest("recovery rejects packed-branch refs heads directory replacement", async (t) => {
  const f = await commitRepository(t);
  f.run("pack-refs", "--all");
  assert.equal((await lstat(f.gitPath("refs/heads/main")).catch(() => null)), null);
  await stageChange(f, "managed");
  const { prepared, outcome } = await dispatchForward(f, "packed-branch-op");
  const head = f.run("rev-parse", "HEAD");
  const heads = f.gitPath("refs/heads");
  const moved = f.gitPath("refs/heads-old");
  await rename(heads, moved);
  await mkdir(heads);
  await writeFile(join(heads, "main"), `${head}\n`);
  assert.deepEqual(await f.adapter.recover(prepared, outcome, "packed-branch-recovery"), {
    status: "conflict", evidence: null,
  });
  assert.equal(f.run("rev-parse", "HEAD"), head);
  assert.throws(() => f.run("show-ref", "--verify", `refs/void/recoveries/${sha256("packed-branch-recovery")}`));
});

posixTest("recovery rejects same-owner refs void directory replacement", async (t) => {
  const f = await commitRepository(t);
  await stageChange(f, "managed");
  const { prepared, outcome } = await dispatchForward(f, "void-directory-op");
  const plan = prepared.plan as unknown as CommitPlan;
  const head = f.run("rev-parse", "HEAD");
  const namespace = f.gitPath("refs/void");
  const moved = f.gitPath("refs/void-old");
  const receipt = await readFile(f.gitPath(plan.receiptRef));
  await rename(namespace, moved);
  await mkdir(join(namespace, "operations"), { recursive: true });
  await writeFile(f.gitPath(plan.receiptRef), receipt);
  assert.deepEqual(await f.adapter.recover(prepared, outcome, "void-directory-recovery"), {
    status: "conflict", evidence: null,
  });
  assert.equal(f.run("rev-parse", "HEAD"), head);
  assert.throws(() => f.run("show-ref", "--verify", `refs/void/recoveries/${sha256("void-directory-recovery")}`));
});
