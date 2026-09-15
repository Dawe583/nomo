import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
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
import { dirname, join } from "node:path";
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
  const gitPaths = new Map<string, string>();
  const gitPath = (path: string) => {
    const cached = gitPaths.get(path);
    if (cached) return cached;
    const value = run("rev-parse", "--git-path", path);
    const resolved = value.startsWith("/") ? value : join(root, value);
    gitPaths.set(path, resolved);
    return resolved;
  };
  for (const path of [".", "index", "refs/heads/main", "logs/refs/heads/main", "packed-refs", "config"])
    gitPath(path);
  const pathSnapshot = async (path: string): Promise<PathSnapshot> => {
    let item;
    try { item = await lstat(path, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false };
      throw error;
    }
    const kind = item.isFile() ? "file" : item.isDirectory() ? "directory" : item.isSymbolicLink() ? "symlink" : "other";
    const bytes = kind === "file" ? await readFile(path) : undefined;
    const link = kind === "symlink" ? await readlink(path) : undefined;
    const after = await lstat(path, { bigint: true });
    assert.equal(after.dev, item.dev);
    assert.equal(after.ino, item.ino);
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
  const worktreeSnapshot = async () => {
    const result: Record<string, PathSnapshot> = {};
    const visit = async (directory: string, prefix = "") => {
      for (const name of (await readdir(directory)).sort()) {
        if (!prefix && name === ".git") continue;
        const relative = prefix ? `${prefix}/${name}` : name;
        const absolute = join(directory, name);
        const captured = await pathSnapshot(absolute);
        result[relative] = captured;
        if (captured.present && captured.kind === "directory") await visit(absolute, relative);
      }
    };
    await visit(root);
    return result;
  };
  const gitMetadataSnapshot = async () => {
    const rootPath = gitPath(".");
    const result: Record<string, PathSnapshot> = { ".": await pathSnapshot(rootPath) };
    const visit = async (directory: string, prefix = "") => {
      for (const name of (await readdir(directory)).sort()) {
        const relative = prefix ? `${prefix}/${name}` : name;
        const absolute = join(directory, name);
        const captured = await pathSnapshot(absolute);
        result[relative] = captured;
        if (captured.present && captured.kind === "directory" && relative !== "objects")
          await visit(absolute, relative);
      }
    };
    if (result["."].present && result["."].kind === "directory") await visit(rootPath);
    return result;
  };
  const snapshot = async (): Promise<Snapshot> => {
    const head = (() => {
      const result = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
      return result.status === 0 ? result.stdout.trim() : "";
    })();
    const refs = run("for-each-ref", "--format=%(refname):%(objectname)")
      .split("\n").filter(Boolean).sort();
    const objects = run("-c", "remote.origin.promisor=false", "cat-file", "--batch-all-objects", "--batch-check=%(objectname)")
      .split("\n").filter(Boolean).sort();
    return {
      head,
      refs,
      objects,
      index: await pathSnapshot(gitPath("index")),
      looseBranchRef: await pathSnapshot(gitPath("refs/heads/main")),
      branchReflog: await pathSnapshot(gitPath("logs/refs/heads/main")),
      packedRefs: await pathSnapshot(gitPath("packed-refs")),
      config: await pathSnapshot(gitPath("config")),
      worktree: await worktreeSnapshot(),
      gitMetadata: await gitMetadataSnapshot(),
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
    },
    snapshot,
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
    assert.equal(observed.reversibility, "r1");
    assert.equal(observed.blastRadius.count, 1);
    assert.equal(observed.resources.length, 2);
    assert.ok(observed.resources.every((value) => !value.includes(f.root)));
    const prepared = await f.adapter.prepare(args, observed, "unsafe/id with spaces");
    assert.deepEqual(await f.snapshot(), before);
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
  { name: "detached HEAD", arrange: (f) => f.run("checkout", "--detach", "-q"), error: /attached/ },
  { name: "unborn HEAD", arrange: (f) => f.run("checkout", "--orphan", "unborn"), error: /born/ },
  {
    name: "second worktree",
    arrange: async (f) => {
      const path = await f.temp();
      await rm(path, { recursive: true });
      f.run("worktree", "add", "-q", "-b", "other", path);
    },
    error: /one registered worktree/,
  },
  { name: "shallow", arrange: (f) => writeFile(f.gitPath("shallow"), `${f.run("rev-parse", "HEAD")}\n`), error: /shallow/i },
  { name: "replace ref", arrange: (f) => { const head = f.run("rev-parse", "HEAD"); f.run("replace", head, head); }, error: /replace/i },
  { name: "graft", arrange: (f) => writeFile(f.gitPath("info/grafts"), `${f.run("rev-parse", "HEAD")}\n`), error: /graft/i },
  { name: "alternates", arrange: async (f) => { const path = await f.temp(); await mkdir(join(path, "info"), { recursive: true }); await mkdir(join(path, "pack"), { recursive: true }); await writeFile(f.gitPath("objects/info/alternates"), `${path}\n`); }, error: /alternate/i },
  { name: "promisor config", arrange: (f) => f.run("config", "remote.origin.promisor", "true"), error: /promisor/ },
  { name: "promisor pack marker", arrange: (f) => writeFile(f.gitPath("objects/pack/foreign.promisor"), ""), error: /promisor/ },
  { name: "partial clone extension only", arrange: (f) => f.run("config", "extensions.partialClone", "origin"), error: /partial/i },
  { name: "signing required", arrange: (f) => f.run("config", "commit.gpgSign", "true"), error: /signing/ },
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
  { name: "split index", arrange: (f) => f.run("update-index", "--split-index"), error: /split/i },
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
