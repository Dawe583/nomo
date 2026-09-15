import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { runRecoveryCommand } from "./recovery.ts";
import type {
  RecoveryJobPlan,
  RecoveryJobResult,
} from "../../runtime/src/index.ts";

test("CLI persists, approves and resumes a run recovery job by jobId", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-cli-recovery-job-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "project"));
  await writeFile(join(root, "project", "a.txt"), "before-a");
  await writeFile(join(root, "project", "b.txt"), "before-b");
  const config = join(root, "config.json");
  const env = { TEST_KEY: randomBytes(32).toString("base64") };
  await writeFile(
    config,
    JSON.stringify({
      workspace: "test",
      stateDir: "state",
      encryptionKeyEnv: "TEST_KEY",
      filesystem: { root: "project", cooperative: true },
    }),
  );
  for (const [operationId, path] of [
    ["one", "a.txt"],
    ["two", "b.txt"],
  ] as const) {
    const input = join(root, `${operationId}.json`);
    await writeFile(
      input,
      JSON.stringify({
        workspace: "test",
        operationId,
        runId: "run",
        agentId: "agent",
        adapterId: "filesystem.managed",
        arguments: {
          action: "write",
          path,
          base64: Buffer.from(`after-${operationId}`).toString("base64"),
        },
      }),
    );
    let approval = "";
    assert.equal(
      await runRecoveryCommand(
        ["inspect", "--config", config, "--input", input],
        env,
        (line) => {
          approval = (JSON.parse(line) as { approvalDigest: string })
            .approvalDigest;
        },
      ),
      0,
    );
    assert.equal(
      await runRecoveryCommand(
        [
          "execute",
          "--config",
          config,
          "--input",
          input,
          "--approve",
          approval,
        ],
        env,
        () => {},
      ),
      0,
    );
  }
  const jobInput = join(root, "job.json");
  await writeFile(
    jobInput,
    JSON.stringify({
      workspace: "test",
      jobId: "job",
      selection: { kind: "run", runId: "run" },
    }),
  );
  let plan!: RecoveryJobPlan;
  assert.equal(
    await runRecoveryCommand(
      ["plan-job", "--config", config, "--input", jobInput],
      env,
      (line) => {
        plan = JSON.parse(line) as RecoveryJobPlan;
      },
    ),
    0,
  );
  assert.deepEqual(
    plan.steps.map((step) => step.operationId),
    ["two", "one"],
  );
  await writeFile(
    jobInput,
    JSON.stringify({ workspace: "test", jobId: "job" }),
  );
  await assert.rejects(
    runRecoveryCommand(
      [
        "apply-job",
        "--config",
        config,
        "--input",
        jobInput,
        "--approve",
        "0".repeat(64),
      ],
      env,
      () => {},
    ),
    /not authorized/,
  );
  assert.equal(
    await runRecoveryCommand(
      [
        "apply-job",
        "--config",
        config,
        "--input",
        jobInput,
        "--approve",
        plan.digest,
      ],
      env,
      () => {},
    ),
    0,
  );
  assert.equal(
    await readFile(join(root, "project", "a.txt"), "utf8"),
    "before-a",
  );
  assert.equal(
    await readFile(join(root, "project", "b.txt"), "utf8"),
    "before-b",
  );
  let status!: RecoveryJobResult;
  assert.equal(
    await runRecoveryCommand(
      ["status-job", "--config", config, "--input", jobInput],
      env,
      (line) => {
        status = JSON.parse(line) as RecoveryJobResult;
      },
    ),
    0,
  );
  assert.equal(status.status, "restored");
  assert.equal(
    await runRecoveryCommand(
      [
        "apply-job",
        "--config",
        config,
        "--input",
        jobInput,
        "--approve",
        "0".repeat(64),
      ],
      env,
      () => {},
    ),
    0,
  );
});
