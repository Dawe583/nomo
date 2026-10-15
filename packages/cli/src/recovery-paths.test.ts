import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRecoveryStateOutsideRoot } from "./recovery-paths.ts";

test("state containment rejects native paths and aliases before creating state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-state-boundary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "project");
  await mkdir(root);
  const alias = join(dir, "alias");
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  for (const state of [
    root,
    join(root, "new", "state"),
    alias,
    join(alias, "new", "state"),
  ])
    await assert.rejects(
      assertRecoveryStateOutsideRoot(root, state),
      /outside/,
    );
  await assert.rejects(
    assertRecoveryStateOutsideRoot(alias, join(root, "state")),
    /outside/,
  );
  await assertRecoveryStateOutsideRoot(root, join(dir, "project-state"));
  await assertRecoveryStateOutsideRoot(root, join(dir, "state", "new"));
  if (process.platform === "win32")
    await assert.rejects(
      assertRecoveryStateOutsideRoot(root, join(root.toUpperCase(), "state")),
      /outside/,
    );
});
