import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { localRecoveryVault, VaultCapacityError } from "./vault.ts";
import { managedFilesystemAdapter } from "../../connectors/src/filesystem/managed.ts";
import { recoveryRuntime, localOperationJournal } from "./index.ts";
import { devKeyProvider } from "../../ledger/src/sign.ts";

const big = (bytes: number) => ({ blob: "x".repeat(bytes) });

test("the read budget defaults to the write quota, so nothing changes by default", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = localRecoveryVault(root, { k: randomBytes(32) }, "k", 1024 * 1024);
  const value = big(4096);
  const reference = await vault.put("w", value);
  assert.deepEqual(await vault.get("w", reference), value);
});

test("a host that declares a smaller read budget gets a refusal naming the size", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Written against a generous quota, so the artifact is legitimately stored,
  // and then read by a host that will not load that much.
  const writer = localRecoveryVault(root, { k: randomBytes(32) }, "k", 1024 * 1024);
  const reader = localRecoveryVault(root, { k: randomBytes(32) }, "k", 1024 * 1024, 1024);
  const reference = await writer.put("w", big(8192));
  await assert.rejects(reader.get("w", reference), (error: unknown) => {
    assert.ok(error instanceof VaultCapacityError);
    assert.match((error as Error).message, /bytes exceeds the 1024 byte read budget/);
    return true;
  });
  // The artifact itself is untouched, so a host that later raises its budget
  // can still read it.
  assert.deepEqual((await writer.get("w", reference) as { blob: string }).blob.length, 8192);
});

test("a read budget below the cipher overhead cannot be satisfied by any artifact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = localRecoveryVault(root, { k: randomBytes(32) }, "k", 1024 * 1024, 0);
  const reference = await vault.put("w", big(16));
  await assert.rejects(vault.get("w", reference), VaultCapacityError);
});

test("the refusal happens before the read, so a hostile size cannot cost an allocation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "project"), { recursive: true });
  // A real capture is written through the generous default, then a runtime with
  // a tight budget is asked to run recovery against it.
  // The same journal and the same key, which is the real topology: one
  // workspace, two hosts that disagree about how much they will load.
  const journal = localOperationJournal(join(root, "journal"), await devKeyProvider({ dir: join(root, "keys"), env: {} }));
  const key = randomBytes(32);
  const generous = recoveryRuntime({
    journal,
    vault: localRecoveryVault(join(root, "vault"), { k: key }, "k"),
    adapters: [managedFilesystemAdapter({ root: join(root, "project"), cooperative: true })],
    authorize: async () => true,
  });
  const request = {
    workspace: "w",
    operationId: "op",
    runId: "run",
    agentId: "agent",
    adapterId: "filesystem.managed",
    arguments: { action: "write", path: "notes.md", base64: Buffer.from("small").toString("base64") },
  };
  // The same journal and vault, a host that will not load that much.
  const runtime = recoveryRuntime({
    journal,
    vault: localRecoveryVault(join(root, "vault"), { k: key }, "k", 1024 * 1024, 512),
    adapters: [managedFilesystemAdapter({ root: join(root, "project"), cooperative: true })],
    authorize: async () => true,
  });
  const applied = await generous.execute(request);
  assert.equal(applied.status, "succeeded");
  const plan = await generous.planRecovery("w", "op");
  // The refusal propagates rather than becoming a result. A host that cannot
  // load the capture must learn that, not receive a "conflict" or, worse, a
  // "restored" it did not verify.
  await assert.rejects(
    runtime.recover(plan, async () => true),
    (error: unknown) => {
      assert.ok(error instanceof VaultCapacityError, `unexpected refusal: ${String(error)}`);
      assert.match((error as Error).message, /exceeds the 512 byte read budget/);
      return true;
    },
  );
  // The generous host is unaffected: the artifact was never touched.
  assert.equal((await generous.recover(plan, async () => true)).status, "restored");
});
