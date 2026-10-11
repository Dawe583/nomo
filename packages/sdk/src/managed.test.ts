import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { managedClient } from "./managed.ts";
import { devKeyProvider } from "../../ledger/src/sign.ts";
import {
  localOperationJournal,
  localRecoveryVault,
  type RecoveryAdapter,
  type Json,
} from "../../runtime/src/index.ts";

test("managed SDK uses durable runtime, isolates workspace, and refuses dispatch if capture fails", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-sdk-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const signer = await devKeyProvider({ dir: join(dir, "keys"), env: {} }),
    journal = localOperationJournal(join(dir, "journal"), signer),
    vault = localRecoveryVault(
      join(dir, "vault"),
      { key: randomBytes(32) },
      "key",
    );
  let value: Json = "before",
    writes = 0;
  const adapter: RecoveryAdapter = {
    id: "fixture",
    version: "1",
    async preflight() {
      return {
        effect: "write",
        reversibility: "r1",
        readiness: "verified",
        scope: "test value",
        resources: ["test:value"],
        revision: value,
        blastRadius: { count: 1, precision: "exact" },
      };
    },
    async prepare(args) {
      return { before: value, plan: args };
    },
    async execute(args) {
      writes++;
      value = args;
      return { result: value, evidence: null };
    },
    async release() {},
    async reconcile() {
      return { status: "unknown" };
    },
    async recover(prepared) {
      value = prepared.before;
      return { status: "restored", evidence: value };
    },
  };
  const options = {
    workspace: "test",
    agentId: "sdk-agent",
    journal,
    vault,
    adapters: [adapter],
    authorize: async () => true,
  };
  const failed = managedClient({
    ...options,
    vault: {
      ...vault,
      put: async () => {
        throw new Error("capture unavailable");
      },
    },
  });
  assert.equal(
    (await failed.execute("fixture", "failed", "run", "after")).status,
    "failed",
  );
  assert.equal(writes, 0);
  const client = managedClient(options);
  assert.equal(
    (await client.execute("fixture", "op", "run", "after")).status,
    "succeeded",
  );
  const restarted = managedClient(options),
    plan = await restarted.planRecovery("op");
  assert.throws(
    () => restarted.recover({ ...plan, workspace: "other" }, async () => true),
    /workspace/,
  );
  assert.equal(
    (await restarted.recover(plan, async () => true)).status,
    "restored",
  );
  assert.equal(value, "before");
  const jobSecond = await restarted.execute("fixture", "second", "run", "second-after");
  assert.equal(jobSecond.status, "succeeded");
  const jobPlan = await restarted.planRecoveryJob({
    workspace: "test",
    jobId: "sdk-job",
    selection: { kind: "operations", operationIds: ["second", "missing"] },
  });
  assert.deepEqual(
    jobPlan.steps.map((step: { operationId: string }) => step.operationId),
    ["second"],
  );
  assert.deepEqual(jobPlan.residuals, [{ operationId: "missing", status: "missing" }]);
  const storedStatus = await restarted.recoveryJobStatus("sdk-job");
  assert.equal("digest" in storedStatus && storedStatus.digest, jobPlan.digest);
  const applied = await restarted.runRecoveryJob("sdk-job", async (candidate) => {
    assert.equal(candidate.digest, jobPlan.digest);
    return true;
  });
  assert.equal(applied.status, "partial");
  assert.equal(applied.checkpoint, 1);
  assert.deepEqual((await restarted.recoveryJobStatus("sdk-job")), applied);
  assert.throws(
    () =>
      restarted.planRecoveryJob({
        workspace: "other",
        jobId: "sdk-job",
        selection: { kind: "run", runId: "run" },
      }),
    /workspace/,
  );
});
