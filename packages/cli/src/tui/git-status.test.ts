import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_BRANCH_CHARS,
  cachedGitStatus,
  primeGitStatus,
  readGitStatus,
  resetGitStatusCache,
  sanitizeBranch,
} from "./git-status.ts";

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/** A committed repository on `branch`, with one tracked file. */
async function repository(branch = "feature/location"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nomo-git-status-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "nomo@example.invalid");
  git(root, "config", "user.name", "NOMO test");
  git(root, "checkout", "-q", "-b", branch);
  await writeFile(join(root, "tracked.txt"), "one\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-qm", "initial");
  return root;
}

test("a committed repository reports its branch and a clean tree", async (t) => {
  const root = await repository();
  t.after(async () => {
    resetGitStatusCache();
    await rm(root, { recursive: true, force: true });
  });

  assert.deepEqual(await readGitStatus(root), {
    branch: "feature/location",
    dirty: false,
  });

  await writeFile(join(root, "untracked.txt"), "two\n");
  resetGitStatusCache();
  assert.deepEqual(await readGitStatus(root), {
    branch: "feature/location",
    dirty: true,
  });

  await rm(join(root, "untracked.txt"));
  resetGitStatusCache();
  assert.deepEqual(await readGitStatus(root), {
    branch: "feature/location",
    dirty: false,
  });
});

test("a directory outside any repository has no status", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-git-status-none-"));
  t.after(async () => {
    resetGitStatusCache();
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(await readGitStatus(root), null);
  // A known absence is cached too, so the frame does not retry every render.
  assert.equal(cachedGitStatus(root), null);
});

test("a path that is not an absolute directory is refused", async (t) => {
  const root = await repository();
  t.after(async () => {
    resetGitStatusCache();
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(await readGitStatus("relative/path"), null);
  assert.equal(await readGitStatus(join(root, "tracked.txt")), null);
  assert.equal(await readGitStatus(join(root, "missing")), null);
});

test("the probe is cached for two seconds and can be reset", async (t) => {
  const root = await repository();
  t.after(async () => {
    resetGitStatusCache();
    await rm(root, { recursive: true, force: true });
  });

  assert.equal((await readGitStatus(root))?.dirty, false);
  await writeFile(join(root, "untracked.txt"), "two\n");
  // The cached clean answer still stands inside the two second window.
  assert.equal((await readGitStatus(root))?.dirty, false);
  resetGitStatusCache();
  assert.equal((await readGitStatus(root))?.dirty, true);
});

test("the frame never waits for the probe and never invents a branch", async (t) => {
  const root = await repository();
  t.after(async () => {
    resetGitStatusCache();
    await rm(root, { recursive: true, force: true });
  });

  // Nothing is known before the first probe, so the frame omits the branch.
  assert.equal(cachedGitStatus(root), undefined);
  const primed = await primeGitStatus(root);
  assert.deepEqual(primed, { branch: "feature/location", dirty: false });
  assert.deepEqual(cachedGitStatus(root), {
    branch: "feature/location",
    dirty: false,
  });
});

test("a branch label is printable ASCII capped at 32 characters", () => {
  assert.equal(sanitizeBranch("feature/location"), "feature/location");
  assert.equal(sanitizeBranch("main\n"), "main");
  assert.equal(sanitizeBranch("feature/ünïcode"), "feature/?n?code");
  assert.equal(sanitizeBranch("a".repeat(40)).length, MAX_BRANCH_CHARS);
  assert.equal(sanitizeBranch("  spaced  "), "spaced");
  assert.equal(sanitizeBranch(""), "");
});

test("the probe does not write to the repository", async (t) => {
  const root = await repository();
  t.after(async () => {
    resetGitStatusCache();
    await rm(root, { recursive: true, force: true });
  });
  // Touching the tracked file without changing it makes the next `git status`
  // want to refresh the index. GIT_OPTIONAL_LOCKS=0 keeps that a read.
  const tracked = join(root, "tracked.txt");
  const later = new Date(Date.now() + 5000);
  await utimes(tracked, later, later);
  const indexPath = join(root, ".git", "index");
  const before = await readFile(indexPath);
  const beforeStat = await stat(indexPath);
  assert.equal((await readGitStatus(root))?.dirty, false);
  assert.deepEqual(await readFile(indexPath), before);
  assert.equal((await stat(indexPath)).mtimeMs, beforeStat.mtimeMs);
});
