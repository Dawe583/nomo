import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { managedGitAdapter } from "./managed.ts";
import type { CommitCapture, CommitPlan } from "./managed-commit.ts";
import type { Json } from "../recovery.ts";

const posixTest = process.platform === "win32" ? test.skip : test;

async function commitRepository(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "void-git-commit-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  run("init", "-q");
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
  return {
    root,
    run,
    adapter: managedGitAdapter({ root, cooperative: true }),
    write: (path: string, value: string | Buffer, mode = 0o644) =>
      writeFile(join(root, path), value, { mode }),
    snapshot: async () => ({
      head: run("rev-parse", "HEAD"),
      index: await readFile(join(root, run("rev-parse", "--git-path", "index"))),
      files: Object.fromEntries(await Promise.all(
        ["selected", "staged-sentinel", "unstaged-sentinel", "untracked-sentinel"].map(async (path) =>
          [path, await readFile(join(root, path)).catch(() => null)] as const),
      )),
      refs: run("for-each-ref", "--format=%(refname) %(objectname)", "refs/void/").split("\n").filter(Boolean),
    }),
  };
}

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

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

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
    const plan = prepared.plan as unknown as CommitPlan;
    assert.match(plan.receiptRef, /^refs\/void\/operations\/[0-9a-f]{64}$/);
    assert.ok(!plan.receiptRef.includes("unsafe"));
    assert.equal(
      plan.metadata.subject,
      `VOID managed commit ${sha256("unsafe/id with spaces").slice(0, 16)}`,
    );
    assert.match(plan.metadata.timestamp, /^\d+$/);
    assert.equal((prepared.before as unknown as CommitCapture).repository.root, f.root);
  },
);
