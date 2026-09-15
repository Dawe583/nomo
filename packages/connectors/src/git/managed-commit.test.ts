import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readlinkSync,
  renameSync,
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
  parseIndexManifest,
  parseTreeManifest,
  type CommitCapture,
  type CommitPlan,
} from "./managed-commit.ts";
import type { Json } from "../recovery.ts";

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
