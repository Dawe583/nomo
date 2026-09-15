import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  symlink,
  link,
  chmod,
  stat,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { managedFilesystemAdapter } from "./managed.ts";
import type { Json, Outcome, Prepared } from "../recovery.ts";
import {
  recoveryRuntime,
  localOperationJournal,
  reservedRecoveryVault,
} from "../../../runtime/src/index.ts";
import { devKeyProvider } from "../../../ledger/src/sign.ts";
async function fixture(t: import("node:test").TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "void-files-")),
    root = join(dir, "project");
  await mkdir(root);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const signer = await devKeyProvider({ dir: join(dir, "keys"), env: {} }),
    key = randomBytes(32);
  const adapter = () => managedFilesystemAdapter({ root, cooperative: true });
  const runtime = () =>
    recoveryRuntime({
      journal: localOperationJournal(join(dir, "journal"), signer),
      vault: reservedRecoveryVault(join(dir, "vault"), { key }, "key"),
      adapters: [adapter()],
      authorize: async () => true,
    });
  const execute = (
    action: "write" | "delete",
    path = "file",
    base64?: string,
  ) =>
    runtime().execute({
      workspace: "test",
      operationId: `op-${action}`,
      runId: "run",
      agentId: "agent",
      adapterId: "filesystem.managed",
      arguments: { action, path, ...(base64 === undefined ? {} : { base64 }) },
    });
  return { dir, root, adapter, runtime, execute };
}
test("real binary write and delete restore bytes/mode across restart and preserve other user files", async (t) => {
  const f = await fixture(t),
    original = randomBytes(5000);
  await writeFile(join(f.root, "file"), original, { mode: 0o751 });
  await writeFile(join(f.root, "human.txt"), "uncommitted human work");
  assert.equal(
    (await f.execute("write", "file", Buffer.from("new").toString("base64")))
      .status,
    "succeeded",
  );
  const restarted = f.runtime(),
    plan = await restarted.planRecovery("test", "op-write");
  assert.equal(
    (await restarted.recover(plan, async () => true)).status,
    "restored",
  );
  assert.deepEqual(await readFile(join(f.root, "file")), original);
  assert.equal(
    (await stat(join(f.root, "file"))).mode & 0o777,
    process.platform === "win32" ? 0o666 : 0o751,
  );
  assert.equal(
    (await restarted.recover(plan, async () => true)).status,
    "restored",
  );
  assert.equal((await f.execute("delete")).status, "succeeded");
  assert.equal(
    (
      await f
        .runtime()
        .recover(
          await f.runtime().planRecovery("test", "op-delete"),
          async () => true,
        )
    ).status,
    "restored",
  );
  assert.deepEqual(await readFile(join(f.root, "file")), original);
  assert.equal(
    await readFile(join(f.root, "human.txt"), "utf8"),
    "uncommitted human work",
  );
  assert.ok(
    !(await readFile(join(f.dir, "journal/test.jsonl"), "utf8")).includes(
      original.toString("base64"),
    ),
  );
});
test("create Undo removes only the new file; same request is idempotent", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.execute("write", "file", "")).status, "succeeded");
  assert.equal((await f.execute("write", "file", "")).status, "succeeded");
  assert.equal(
    (
      await f
        .runtime()
        .recover(
          await f.runtime().planRecovery("test", "op-write"),
          async () => true,
        )
    ).status,
    "restored",
  );
  await assert.rejects(stat(join(f.root, "file")), { code: "ENOENT" });
});
test("external content, ABA and mode edits conflict instead of being overwritten", async (t) => {
  for (const change of ["content", "aba", "mode"]) {
    const f = await fixture(t);
    await writeFile(join(f.root, "file"), "before");
    await f.execute("write", "file", Buffer.from("agent").toString("base64"));
    if (change === "mode")
      await chmod(
        join(f.root, "file"),
        process.platform === "win32" ? 0o444 : 0o700,
      );
    else {
      await writeFile(join(f.root, "file"), "human");
      if (change === "aba") await writeFile(join(f.root, "file"), "agent");
    }
    assert.equal(
      (
        await f
          .runtime()
          .recover(
            await f.runtime().planRecovery("test", "op-write"),
            async () => true,
          )
      ).status,
      "conflict",
    );
  }
});
test("traversal, protected paths, symlinks, hardlinks and oversized files fail before dispatch", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dir, "private"), "secret");
  await symlink(
    process.platform === "win32" ? f.dir : join(f.dir, "private"),
    join(f.root, "symbol"),
    process.platform === "win32" ? "junction" : "file",
  );
  await symlink(
    f.dir,
    join(f.root, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await link(join(f.dir, "private"), join(f.root, "hard"));
  await writeFile(join(f.root, "large"), Buffer.alloc(1024 * 1024 + 1));
  for (const path of [
    "../private",
    "/etc/passwd",
    ".git/config",
    ".env",
    ".git /config",
    ".git./config",
    "file:stream",
    "NUL.txt",
    "nested/COM1",
    "trailing.",
    "trailing ",
    "symbol",
    "escape/private",
    "hard",
    "large",
  ])
    await assert.rejects(
      f.adapter().preflight({ action: "write", path, base64: "" }),
    );
  await assert.rejects(
    f
      .adapter()
      .preflight({ action: "write", path: "file", base64: "invalid!" }),
  );
  assert.equal(await readFile(join(f.dir, "private"), "utf8"), "secret");
});
test("drift between prepare and dispatch refuses write; lost response remains unknown", async (t) => {
  const f = await fixture(t),
    adapter = f.adapter(),
    args = { action: "write", path: "file", base64: "" };
  await writeFile(join(f.root, "file"), "before");
  const observation = await adapter.preflight(args),
    prepared = await adapter.prepare(args, observation, "op");
  await writeFile(join(f.root, "file"), "human");
  await assert.rejects(adapter.execute(args, prepared, "op"), /conflict/);
  assert.deepEqual(await adapter.reconcile("op", prepared), {
    status: "unknown",
  });
  assert.equal(await readFile(join(f.root, "file"), "utf8"), "human");
});

test(
  "Windows refuses unsupported modes before dispatch",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f
        .adapter()
        .preflight({ action: "write", path: "new", base64: "", mode: 0o755 }),
      /0666/,
    );
    await assert.rejects(stat(join(f.root, "new")), { code: "ENOENT" });
    await writeFile(join(f.root, "readonly"), "human", { mode: 0o444 });
    await assert.rejects(
      f.adapter().preflight({ action: "delete", path: "readonly" }),
      /writable/,
    );
    assert.equal(await readFile(join(f.root, "readonly"), "utf8"), "human");
    await writeFile(join(f.root, "rename-source"), "source");
    await assert.rejects(
      f.adapter().preflight({
        action: "rename",
        path: "rename-source",
        to: "rename-target",
      }),
      /not verified on Windows/,
    );
  },
);

test(
  "binary rename restores both endpoints across restart and preserves unrelated files",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      original = randomBytes(4096);
    await writeFile(join(f.root, "source.bin"), original, { mode: 0o751 });
    await writeFile(join(f.root, "human.txt"), "human");
    const observation = await f
      .adapter()
      .preflight({ action: "rename", path: "source.bin", to: "moved.bin" });
    assert.equal(observation.resources.length, 2);
    assert.equal(observation.blastRadius.count, 2);
    const result = await f.runtime().execute({
      workspace: "test",
      operationId: "op-rename",
      runId: "run",
      agentId: "agent",
      adapterId: "filesystem.managed",
      arguments: { action: "rename", path: "source.bin", to: "moved.bin" },
    });
    assert.equal(result.status, "succeeded");
    assert.deepEqual(await readFile(join(f.root, "moved.bin")), original);
    assert.equal(
      (await stat(join(f.root, "moved.bin"))).mode & 0o777,
      process.platform === "win32" ? 0o666 : 0o751,
    );
    await assert.rejects(stat(join(f.root, "source.bin")), { code: "ENOENT" });
    const restarted = f.runtime();
    assert.equal(
      (
        await restarted.recover(
          await restarted.planRecovery("test", "op-rename"),
          async () => true,
        )
      ).status,
      "restored",
    );
    assert.deepEqual(await readFile(join(f.root, "source.bin")), original);
    assert.equal(
      (await stat(join(f.root, "source.bin"))).mode & 0o777,
      process.platform === "win32" ? 0o666 : 0o751,
    );
    await assert.rejects(stat(join(f.root, "moved.bin")), { code: "ENOENT" });
    assert.equal(await readFile(join(f.root, "human.txt"), "utf8"), "human");
  },
);

test(
  "rename refuses unsafe endpoints and never overwrites a destination",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.root, "source"), "source");
    await writeFile(join(f.root, "destination"), "human");
    await link(join(f.root, "source"), join(f.root, "hard"));
    await symlink(join(f.root, "source"), join(f.root, "symbol"));
    for (const args of [
      { action: "rename", path: "source", to: "source" },
      { action: "rename", path: "source", to: "destination" },
      { action: "rename", path: "missing", to: "new" },
      { action: "rename", path: "source", to: "../escape" },
      { action: "rename", path: "source", to: ".git/config" },
      { action: "rename", path: "symbol", to: "new" },
      { action: "rename", path: "hard", to: "new" },
    ])
      await assert.rejects(f.adapter().preflight(args));
    assert.equal(await readFile(join(f.root, "source"), "utf8"), "source");
    assert.equal(await readFile(join(f.root, "destination"), "utf8"), "human");
  },
);

test(
  "rename Undo conflicts on destination edit, ABA or source recreation",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const change of ["destination", "aba", "source"] as const) {
      const f = await fixture(t);
      await writeFile(join(f.root, "source"), "original");
      const runtime = f.runtime();
      assert.equal(
        (
          await runtime.execute({
            workspace: "test",
            operationId: `rename-${change}`,
            runId: "run",
            agentId: "agent",
            adapterId: "filesystem.managed",
            arguments: { action: "rename", path: "source", to: "moved" },
          })
        ).status,
        "succeeded",
      );
      if (change === "source") await writeFile(join(f.root, "source"), "human");
      else {
        await writeFile(join(f.root, "moved"), "human");
        if (change === "aba")
          await writeFile(join(f.root, "moved"), "original");
      }
      const restarted = f.runtime();
      assert.equal(
        (
          await restarted.recover(
            await restarted.planRecovery("test", `rename-${change}`),
            async () => true,
          )
        ).status,
        "conflict",
      );
      if (change === "source")
        assert.equal(await readFile(join(f.root, "source"), "utf8"), "human");
    }
  },
);

test(
  "rename revalidates both endpoints and binds destination to operation identity",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      adapter = f.adapter();
    await writeFile(join(f.root, "source"), "original");
    const args = { action: "rename", path: "source", to: "moved" } as const;
    const observation = await adapter.preflight(args);
    const prepared = await adapter.prepare(args, observation, "operation");
    await writeFile(join(f.root, "moved"), "human");
    await assert.rejects(
      adapter.execute(args, prepared, "operation"),
      /conflict/,
    );
    assert.equal(await readFile(join(f.root, "source"), "utf8"), "original");
    const runtime = f.runtime();
    await rm(join(f.root, "moved"));
    assert.equal(
      (
        await runtime.execute({
          workspace: "test",
          operationId: "bound",
          runId: "run",
          agentId: "agent",
          adapterId: "filesystem.managed",
          arguments: args,
        })
      ).status,
      "succeeded",
    );
    await assert.rejects(
      runtime.execute({
        workspace: "test",
        operationId: "bound",
        runId: "run",
        agentId: "agent",
        adapterId: "filesystem.managed",
        arguments: { ...args, to: "other" },
      }),
      /another request/,
    );
  },
);

test("literal legacy v1 prepared write and delete artifacts still reconcile and recover", async (t) => {
  for (const action of ["write", "delete"] as const) {
    const f = await fixture(t),
      adapter = f.adapter(),
      path = `${action}.bin`,
      base64 = Buffer.from("agent").toString("base64"),
      args: Json =
        action === "write" ? { action, path, base64 } : { action, path };
    await writeFile(join(f.root, path), `before-${action}`);
    const observation = await adapter.preflight(args),
      generated = await adapter.prepare(args, observation, `legacy-${action}`),
      generatedBefore = generated.before as {
        path: string;
        snapshot: Json;
      },
      generatedPlan = generated.plan as {
        root: string;
        identity: string;
      };
    const legacyPrepared: Prepared = {
      before: {
        path,
        snapshot: generatedBefore.snapshot,
      },
      plan: {
        mutation: args,
        root: generatedPlan.root,
        identity: generatedPlan.identity,
      },
    };
    const executed = await adapter.execute(
      args,
      legacyPrepared,
      `legacy-${action}`,
    );
    const legacyOutcome: Outcome = {
      result: { path, action },
      evidence: {
        revision: (executed.evidence as { revision: string }).revision,
      },
    };
    assert.deepEqual(
      await adapter.reconcile(`legacy-${action}`, legacyPrepared),
      { status: "unknown" },
    );
    assert.equal(
      (
        await adapter.recover(
          legacyPrepared,
          legacyOutcome,
          `legacy-recovery-${action}`,
        )
      ).status,
      "restored",
    );
    assert.equal(
      await readFile(join(f.root, path), "utf8"),
      `before-${action}`,
    );
    assert.equal(
      "to" in (legacyPrepared.before as Record<string, Json>),
      false,
    );
  }
});
