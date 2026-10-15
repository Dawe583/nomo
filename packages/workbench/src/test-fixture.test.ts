import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertIsolated, isolatedWorkbench } from "./test-fixture.ts";

const fetcher = async (url: unknown) =>
  String(url).endsWith("/models")
    ? Response.json({ data: [{ id: "fixture" }] })
    : Response.json({ choices: [{ message: { role: "assistant", content: "Ready" } }] });

test("a caller naming NOMO_DATA_DIR in extraEnv cannot redirect the store", async (t) => {
  // The helper exists so a test cannot write into the operator's real store.
  // That guarantee is void if `extraEnv` can win the merge: the workbench
  // builds over the caller's directory while `f.root` still names the
  // temporary one, and `assertIsolated` then checks a directory nothing was
  // written to and passes anyway. The stray path is deliberately one the
  // process can create, so the fixture gets far enough to build a workbench
  // there — that is the state this test exists to rule out.
  const stray = join(tmpdir(), "void-test-fixture-stray-store");
  await rm(stray, { recursive: true, force: true });
  t.after(async () => {
    await rm(stray, { recursive: true, force: true });
  });

  const f = await isolatedWorkbench(
    t,
    fetcher,
    { NOMO_DATA_DIR: stray },
    { prefix: "void-test-fixture-data-dir-" },
  );

  assert.ok(f.root.startsWith(tmpdir()), "the fixture did not build its own root");
  // The key file is the proof of which directory was actually written, rather
  // than a claim about which one the helper meant to hand over.
  assert.ok(existsSync(join(f.root, "workspace.key")));
  assert.equal(existsSync(stray), false, "extraEnv redirected the store");
  assertIsolated(f.root);
});

test("restart keeps the permission mode the fixture was built with", async (t) => {
  const f = await isolatedWorkbench(
    t,
    fetcher,
    { NOMO_PERMISSION_MODE: "read-only" },
    { prefix: "void-test-fixture-restart-" },
  );
  assert.equal(f.app.permissionModeState(), "read-only");

  const reopened = f.restart();
  assert.equal(reopened.permissionModeState(), "read-only");
  assert.equal(f.app.permissionModeState(), "read-only");
});

test("assertIsolated fails when the store was not built under the root", async (t) => {
  const missing = join(tmpdir(), "void-test-fixture-absent-root");
  await assert.throws(() => assertIsolated(missing), /temporary data directory/);

  // The second branch: the directory is there, so the path was honoured, but
  // no key landed in it. A workbench that fell back to the operator's store
  // leaves exactly this behind — a root nothing was written to.
  const root = await mkdtemp(join(tmpdir(), "void-test-fixture-no-key-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  assert.throws(() => assertIsolated(root), /no storage key/);
});
