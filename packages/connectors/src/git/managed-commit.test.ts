import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { managedGitAdapter } from "./managed.ts";
import type { Json } from "../recovery.ts";

const posixTest = process.platform === "win32" ? test.skip : test;

async function commitRepository(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "void-git-commit-"));
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
