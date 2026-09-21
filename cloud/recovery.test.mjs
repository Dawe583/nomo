import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  database,
  transaction,
  read,
  write,
  decrypt,
  ledger,
} from "./store.mjs";
import {
  cloudRecoveryJobStatus,
  managedCloudUndo,
  mutateCloudDocument,
  planCloudRecoveryJob,
  runCloudRecoveryJob,
} from "./recovery.mjs";
import { validateCloudTestEnvironment } from "../scripts/src/cloud-test-config.mjs";
if (process.env.VOID_GUI_DATABASE_TEST === "1")
  validateCloudTestEnvironment(process.env);

test(
  "cloud managed documents commit evidence atomically, refuse drift and missing artifacts",
  {
    skip: process.env.VOID_GUI_DATABASE_TEST !== "1",
  },
  async () => {
    assert.equal(
      new URL(process.env.DATABASE_URL).pathname,
      "/void_gui_upgrade_preview",
    );
    const id = randomUUID(),
      session = { id, workspace: `agent-${id}` };
    const mutate = (operationId, content) =>
      transaction(id, (c) =>
        mutateCloudDocument(session, c, {
          id: operationId,
          name: "void_workspace_write",
          arguments: { path: "check.txt", content },
        }),
      );
    const state = async () => decrypt(await read(`workspace:${id}`));
    try {
      await mutate("first", "before");
      await mutate("second", "after");
      await assert.rejects(
        transaction(id, (c) => managedCloudUndo(session, c, "first")),
        /newer changes/,
      );
      assert.equal(
        await transaction(id, (c) => managedCloudUndo(session, c, "second")),
        true,
      );
      assert.equal((await state()).files["check.txt"], "before");
      const count = (await state()).operations.length;
      await transaction(id, (c) => managedCloudUndo(session, c, "second"));
      assert.equal((await state()).operations.length, count);
      const proof = await ledger(session.workspace);
      assert.ok(
        proof.entries.some((e) => e.body.runtimeEvent?.stage === "restored"),
      );
      await assert.rejects(
        transaction(id, async (c) => {
          await mutateCloudDocument(session, c, {
            id: "rollback",
            name: "void_workspace_write",
            arguments: { path: "check.txt", content: "must roll back" },
          });
          throw new Error("Injected transaction failure");
        }),
        /Injected transaction failure/,
      );
      assert.equal((await state()).files["check.txt"], "before");
      assert.equal(
        (await ledger(session.workspace)).entries.length,
        proof.entries.length,
      );
      await assert.rejects(
        transaction(id, async (c) => {
          const quota = await read(`recovery-quota:${id}`, c);
          await write(
            `recovery-quota:${id}`,
            { ...quota, bytes: 64 * 1024 * 1024 },
            c,
          );
          await mutateCloudDocument(session, c, {
            id: "no-space",
            name: "void_workspace_write",
            arguments: { path: "check.txt", content: "no space" },
          });
        }),
        /failed/,
      );
      assert.equal((await state()).files["check.txt"], "before");
      await assert.rejects(
        transaction(id, async (c) => {
          await c.query("DELETE FROM void_cloud_state WHERE key LIKE $1", [
            `recovery-artifact:${id}:%`,
          ]);
          await managedCloudUndo(session, c, "first");
        }),
        /artifact/,
      );
      await transaction(id, (c) => managedCloudUndo(session, c, "first"));
      assert.equal((await state()).files["check.txt"], undefined);
      await mutate("job-first", "job before");
      await mutate("job-second", "job after");
      const jobId = "recovery-job";
      const selection = {
        kind: "operations",
        operationIds: ["job-first", "job-second", "missing"],
      };
      const plan = await transaction(id, (c) =>
        planCloudRecoveryJob(
          { workspace: session.workspace, jobId, selection },
          session,
          c,
        ),
      );
      assert.deepEqual(plan.selection, selection);
      assert.deepEqual(
        plan.steps.map((step) => step.operationId),
        ["job-second", "job-first"],
      );
      assert.deepEqual(plan.residuals, [
        { operationId: "missing", status: "missing" },
      ]);
      const boundary = (await ledger(session.workspace)).entries.length;
      await assert.rejects(
        transaction(id, (c) =>
          runCloudRecoveryJob(session, c, jobId, async () => false),
        ),
        /authorized/,
      );
      await mutate(
        "forward-after-plan",
        "do not widen the closed plan silently",
      );
      const beforeStatuses = [];
      const staleResult = await transaction(id, (c) =>
        runCloudRecoveryJob(session, c, jobId, async (stored) => {
          beforeStatuses.push(stored.digest);
          return true;
        }),
      ).catch((error) => error);
      assert.match(String(staleResult?.message ?? staleResult), /stale/);
      const stored = await transaction(id, (c) =>
        cloudRecoveryJobStatus(session, c, jobId),
      );
      assert.equal(stored.jobId, jobId);
      assert.equal(stored.digest, plan.digest);
      assert.ok((await ledger(session.workspace)).entries.length > boundary);
      await transaction(id, (c) =>
        managedCloudUndo(session, c, "forward-after-plan"),
      );
      const resumedJobId = "recovery-job-after-stale";
      const resumedPlan = await transaction(id, (c) =>
        planCloudRecoveryJob(
          { workspace: session.workspace, jobId: resumedJobId, selection },
          session,
          c,
        ),
      );
      const applied = await transaction(id, (c) =>
        runCloudRecoveryJob(session, c, resumedJobId, async (candidate) => {
          assert.equal(candidate.digest, resumedPlan.digest);
          return true;
        }),
      );
      assert.equal(applied.status, "partial");
      assert.equal(applied.checkpoint, 2);
      assert.deepEqual(
        applied.outcomes.map((outcome) => outcome.status),
        ["restored", "restored"],
      );
      assert.deepEqual(applied.residuals, [
        { operationId: "missing", status: "missing" },
      ]);
      assert.equal((await state()).files["check.txt"], undefined);
      const proofAfter = await ledger(session.workspace);
      assert.ok(
        proofAfter.entries.some(
          (entry) => entry.body.runtimeJobEvent?.stage === "partial",
        ),
      );
      assert.deepEqual(
        await transaction(id, (c) =>
          runCloudRecoveryJob(session, c, resumedJobId, async () => false),
        ),
        applied,
      );
      const nextPlan = await transaction(id, (c) =>
        planCloudRecoveryJob(
          { workspace: session.workspace, jobId: resumedJobId, selection },
          session,
          c,
        ),
      );
      assert.equal(nextPlan.digest, resumedPlan.digest);
      await mutate("run-selection-operation", "run selection");
      const runPlan = await transaction(id, (c) =>
        planCloudRecoveryJob(
          {
            workspace: session.workspace,
            jobId: "run-recovery-job",
            selection: { kind: "run", runId: session.id },
          },
          session,
          c,
        ),
      );
      assert.ok(runPlan.steps.length > 0);
      assert.ok(
        runPlan.steps.every((step) => !/^[a-f0-9]{64}$/.test(step.operationId)),
      );
    } finally {
      // Keep this uniquely scoped evidence in the isolated append-only test ledger.
      await database().end();
    }
  },
);
