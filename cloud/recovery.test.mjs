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
import { OPERATOR_OWNER } from "./owner.mjs";
if (process.env.NOMO_GUI_DATABASE_TEST === "1")
  validateCloudTestEnvironment(process.env);

test(
  "cloud managed documents commit evidence atomically, refuse drift and missing artifacts",
  {
    skip: process.env.NOMO_GUI_DATABASE_TEST !== "1",
  },
  async () => {
    assert.equal(
      new URL(process.env.DATABASE_URL).pathname,
      "/void_gui_upgrade_preview",
    );
    const id = randomUUID(),
      session = { id, workspace: `agent-${id}`, generation: 2 };
    const mutate = (operationId, content, path = "check.txt") =>
      transaction(OPERATOR_OWNER, id, (c) =>
        mutateCloudDocument(OPERATOR_OWNER, session, c, {
          id: operationId,
          name: "void_workspace_write",
          arguments: { path, content },
        }),
      );
    const state = async () => decrypt(await read(OPERATOR_OWNER, `workspace:${id}`));
    try {
      await mutate("first", "before");
      await mutate("second", "after");
      await assert.rejects(
        transaction(OPERATOR_OWNER, id, (c) => managedCloudUndo(OPERATOR_OWNER, session, c, "first")),
        /newer changes/,
      );
      assert.equal(
        await transaction(OPERATOR_OWNER, id, (c) => managedCloudUndo(OPERATOR_OWNER, session, c, "second")),
        true,
      );
      assert.equal((await state()).files["check.txt"], "before");
      const count = (await state()).operations.length;
      await transaction(OPERATOR_OWNER, id, (c) => managedCloudUndo(OPERATOR_OWNER, session, c, "second"));
      assert.equal((await state()).operations.length, count);
      const proof = await ledger(OPERATOR_OWNER, session.workspace);
      assert.ok(
        proof.entries.some((e) => e.body.runtimeEvent?.stage === "restored"),
      );
      await assert.rejects(
        transaction(OPERATOR_OWNER, id, async (c) => {
          await mutateCloudDocument(OPERATOR_OWNER, session, c, {
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
        (await ledger(OPERATOR_OWNER, session.workspace)).entries.length,
        proof.entries.length,
      );
      await assert.rejects(
        transaction(OPERATOR_OWNER, id, async (c) => {
          const quota = await read(OPERATOR_OWNER, `recovery-quota:${id}`, c);
          await write(OPERATOR_OWNER,
            `recovery-quota:${id}`,
            { ...quota, bytes: 64 * 1024 * 1024 },
            c,
          );
          await mutateCloudDocument(OPERATOR_OWNER, session, c, {
            id: "no-space",
            name: "void_workspace_write",
            arguments: { path: "check.txt", content: "no space" },
          });
        }),
        /failed/,
      );
      assert.equal((await state()).files["check.txt"], "before");
      await assert.rejects(
        transaction(OPERATOR_OWNER, id, async (c) => {
          await c.query("DELETE FROM void_cloud_state WHERE owner=$1 AND key LIKE $2", [
            OPERATOR_OWNER,
            `recovery-artifact:${id}:%`,
          ]);
          await managedCloudUndo(OPERATOR_OWNER, session, c, "first");
        }),
        /artifact/,
      );
      await transaction(OPERATOR_OWNER, id, (c) => managedCloudUndo(OPERATOR_OWNER, session, c, "first"));
      assert.equal((await state()).files["check.txt"], undefined);
      await mutate("job-first", "job before");
      await mutate("job-second", "job after");
      const jobId = "recovery-job";
      const selection = {
        kind: "operations",
        operationIds: ["job-first", "job-second", "missing"],
      };
      const plan = await transaction(OPERATOR_OWNER, id, (c) =>
        planCloudRecoveryJob(
          OPERATOR_OWNER,
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
      const boundary = (await ledger(OPERATOR_OWNER, session.workspace)).entries.length;
      await assert.rejects(
        transaction(OPERATOR_OWNER, id, (c) =>
          runCloudRecoveryJob(OPERATOR_OWNER, session, c, jobId, async () => false),
        ),
        /authorized/,
      );
      await mutate(
        "forward-after-plan",
        "do not widen the closed plan silently",
      );
      const beforeStatuses = [];
      const staleResult = await transaction(OPERATOR_OWNER, id, (c) =>
        runCloudRecoveryJob(OPERATOR_OWNER, session, c, jobId, async (stored) => {
          beforeStatuses.push(stored.digest);
          return true;
        }),
      ).catch((error) => error);
      assert.match(String(staleResult?.message ?? staleResult), /stale/);
      const stored = await transaction(OPERATOR_OWNER, id, (c) =>
        cloudRecoveryJobStatus(OPERATOR_OWNER, session, c, jobId),
      );
      assert.equal(stored.jobId, jobId);
      assert.equal(stored.digest, plan.digest);
      assert.ok((await ledger(OPERATOR_OWNER, session.workspace)).entries.length > boundary);
      await transaction(OPERATOR_OWNER, id, (c) =>
        managedCloudUndo(OPERATOR_OWNER, session, c, "forward-after-plan"),
      );
      const resumedJobId = "recovery-job-after-stale";
      const resumedPlan = await transaction(OPERATOR_OWNER, id, (c) =>
        planCloudRecoveryJob(
          OPERATOR_OWNER,
          { workspace: session.workspace, jobId: resumedJobId, selection },
          session,
          c,
        ),
      );
      const applied = await transaction(OPERATOR_OWNER, id, (c) =>
        runCloudRecoveryJob(OPERATOR_OWNER, session, c, resumedJobId, async (candidate) => {
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
      const proofAfter = await ledger(OPERATOR_OWNER, session.workspace);
      assert.ok(
        proofAfter.entries.some(
          (entry) => entry.body.runtimeJobEvent?.stage === "partial",
        ),
      );
      assert.deepEqual(
        await transaction(OPERATOR_OWNER, id, (c) =>
          runCloudRecoveryJob(OPERATOR_OWNER, session, c, resumedJobId, async () => false),
        ),
        applied,
      );
      const nextPlan = await transaction(OPERATOR_OWNER, id, (c) =>
        planCloudRecoveryJob(
          OPERATOR_OWNER,
          { workspace: session.workspace, jobId: resumedJobId, selection },
          session,
          c,
        ),
      );
      assert.equal(nextPlan.digest, resumedPlan.digest);
      await mutate("run-selection-operation", "run selection", "run-selection.txt");
      const runPlan = await transaction(OPERATOR_OWNER, id, (c) =>
        planCloudRecoveryJob(
          OPERATOR_OWNER,
          {
            workspace: session.workspace,
            jobId: "run-recovery-job",
            selection: { kind: "run", runId: `${session.id}:2` },
          },
          session,
          c,
        ),
      );
      assert.ok(runPlan.steps.length > 0);
      assert.ok(
        runPlan.steps.every((step) => !/^[a-f0-9]{64}$/.test(step.operationId)),
      );
      // A checkpoint names a prefix of the journal, so it is proven in its
      // own workspace: the shared session above already holds older work that
      // any checkpoint would honestly include.
      const cpId = randomUUID(),
        cpSession = { id: cpId, workspace: `agent-${cpId}`, generation: 2 };
      const cpMutate = (operationId, content, path = "cp.txt") =>
        transaction(OPERATOR_OWNER, cpId, (c) =>
          mutateCloudDocument(OPERATOR_OWNER, cpSession, c, {
            id: operationId,
            name: "void_workspace_write",
            arguments: { path, content },
          }),
        );
      const cpState = async () =>
        decrypt(await read(OPERATOR_OWNER, `workspace:${cpId}`));
      const cpPlan = (jobId, selection) =>
        transaction(OPERATOR_OWNER, cpId, (c) =>
          planCloudRecoveryJob(
            OPERATOR_OWNER,
            { workspace: cpSession.workspace, jobId, selection },
            cpSession,
            c,
          ),
        );
      await cpMutate("cp-first", "cp before");
      await cpMutate("cp-second", "cp after");
      const listed = await cpPlan("cp-listed", {
        kind: "operations",
        operationIds: ["cp-first", "cp-second"],
      });
      assert.deepEqual(
        listed.steps.map((step) => step.operationId),
        ["cp-second", "cp-first"],
      );
      const at = Math.max(...listed.steps.map((step) => step.sequence));
      const checkpoint = await cpPlan("cp-job", {
        kind: "checkpoint",
        sequence: at,
      });
      assert.deepEqual(
        checkpoint.steps.map((step) => step.operationId),
        ["cp-second", "cp-first"],
      );
      assert.deepEqual(checkpoint.residuals, []);
      await assert.rejects(
        cpPlan("cp-job", { kind: "checkpoint", sequence: at }),
        /already planned/,
      );
      await assert.rejects(
        cpPlan("cp-past", {
          kind: "checkpoint",
          sequence: checkpoint.boundary.sequence + 100,
        }),
        /boundary/,
      );
      const cpApplied = await transaction(OPERATOR_OWNER, cpId, (c) =>
        runCloudRecoveryJob(
          OPERATOR_OWNER,
          cpSession,
          c,
          "cp-job",
          async (candidate) => {
            assert.equal(candidate.digest, checkpoint.digest);
            return true;
          },
        ),
      );
      assert.equal(cpApplied.status, "restored");
      assert.equal(cpApplied.checkpoint, 2);
      // The first step created the file, so undoing both steps removes it.
      assert.equal((await cpState()).files["cp.txt"], undefined);
    } finally {
      // Keep this uniquely scoped evidence in the isolated append-only test ledger.
      await database().end();
    }
  },
);
