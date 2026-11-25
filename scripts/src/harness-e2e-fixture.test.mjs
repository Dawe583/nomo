import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isolatedWorkbench } from "../../packages/workbench/src/test-fixture.ts";
import { runHarnessCommand } from "../../packages/cli/src/harness.ts";

const evalScript = fileURLToPath(new URL("./harness-eval.mjs", import.meta.url));
const runner = fileURLToPath(new URL("./harness-eval-runner.mjs", import.meta.url));
const taskset = fileURLToPath(new URL("./fixtures/harness-eval-v2.json", import.meta.url));

const fetcher = async (url) =>
  String(url).endsWith("/models")
    ? Response.json({ data: [{ id: "fixture" }] })
    : Response.json({ choices: [{ message: { role: "assistant", content: "Ready" }, finish_reason: "stop" }] });

test("fixture proposal activates, is measured through eval, and rolls back without a live model or network", async (t) => {
  const fixture = await isolatedWorkbench(t, fetcher, {}, { prefix: "nomo-h15-" });
  const { app } = fixture;
  const session = await app.start("Review the workspace", "fixture");
  await app.settled();
  await app.editDocument(session.id, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });

  const created = await app.refineHarness(session.id, {
    summary: "dry run lesson",
    rationale: "supported by signed records",
    expectedOutcome: "one durable lesson",
    edits: [{
      action: "create",
      kind: "memory",
      id: "lesson-h15-dry",
      title: "approval pattern",
      content: "measure before keeping a harness change",
      derivedFromSeq: [1],
      reason: "the dry run needs one exact edit",
    }],
  });
  const digest = created.proposalDigest;
  assert.match(digest, /^[a-f0-9]{64}$/);
  await app.approveHarnessProposal(session.id, digest);
  assert.equal((await app.harnessEntries(session.workspace))[0]?.id, "lesson-h15-dry");

  const dir = mkdtempSync(join(tmpdir(), "nomo-h15-eval-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const variantPath = join(dir, "variant.json");
  const recordsPath = join(dir, "records.jsonl");
  writeFileSync(variantPath, JSON.stringify({
    model: "fixture",
    promptPreamble: "h15 dry run",
    settings: { rewardCostWeight: 0, rewardLatencyWeight: 0.001 },
  }));
  const evalRun = spawnSync(process.execPath, [
    evalScript,
    taskset,
    "--runs", "1",
    "--records", recordsPath,
    "--weights", "breach=0,cost=0,latency=0.001",
    "--variant", variantPath,
    "--", process.execPath, runner,
  ], { encoding: "utf8" });
  assert.equal(evalRun.status, 0, evalRun.stderr);
  assert.match(evalRun.stdout, /total: 14\/14 passed/);

  const first = readFileSync(recordsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))[0];
  const stored = await app.recordHarnessReward(session.id, first);
  assert.equal(stored.reward, first.reward);
  assert.equal(typeof stored.reward, "number");

  const proof = await app.ledger(session.workspace);
  const rewardEntry = proof.entries.findLast((entry) => entry.body?.schema === "nomo.reward.v1");
  assert.ok(rewardEntry, "the workspace chain carries the measured reward");
  assert.equal(rewardEntry.body.caseId, first.caseId);
  assert.equal(rewardEntry.body.decision, "reward:recorded");

  const out = [];
  const err = [];
  const rewardCode = await runHarnessCommand(
    ["reward", "--session", session.id, first.caseId],
    { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
    { workbench: async () => app },
  );
  assert.equal(rewardCode, 0, err.join(" "));
  assert.match(out.join("\n"), /recompute=match/);
  assert.match(out.join("\n"), new RegExp(`case=${JSON.stringify(first.caseId)}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  await app.rollbackHarnessProposal(session.id, digest);
  assert.deepEqual(await app.harnessEntries(session.workspace), []);
  const finalBody = (await app.ledger(session.workspace)).entries.at(-1).body;
  assert.equal(finalBody.decision, "refinement:rolled-back");
  assert.equal(finalBody.harnessRefinement.rolledBackDigest, digest);
});
