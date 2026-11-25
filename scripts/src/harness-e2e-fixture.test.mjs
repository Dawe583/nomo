import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isolatedWorkbench } from "../../packages/workbench/src/test-fixture.ts";
import { runHarnessCommand } from "../../packages/cli/src/harness.ts";
import { rewardRecord } from "../../packages/workbench/src/harness-scores.ts";
import { exportTrajectories } from "./trajectory-export.mjs";

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


test("ingest-rewards validates a bare eval file, writes it once, and refuses tampering before any write", async (t) => {
  const fixture = await isolatedWorkbench(t, fetcher, {}, { prefix: "nomo-h19-" });
  const { app } = fixture;
  const session = await app.start("Measure rewards", "fixture");
  await app.settled();
  const dir = mkdtempSync(join(tmpdir(), "nomo-h19-ingest-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = {
    variantId: "sha256:" + "a".repeat(64),
    baselineVariantId: null,
    changedAxis: null,
    guardrails: {},
    costUsd: 0,
    latencyMs: 10,
    approvalMs: "unmeasured",
    weights: { breach: 0, cost: 0, latency: 0 },
  };
  const first = rewardRecord({ ...input, caseId: "case-one", passed: true });
  const second = rewardRecord({ ...input, caseId: "case-two", passed: false });
  const recordsPath = join(dir, "records.jsonl");
  writeFileSync(recordsPath, [first, second].map((record) => JSON.stringify(record)).join("\n") + "\n");

  const rewardEntries = async () =>
    (await app.ledger(session.workspace)).entries.filter(
      (entry) => entry.body?.schema === "nomo.reward.v1",
    );
  const run = async (path) => {
    const out = [];
    const err = [];
    const code = await runHarnessCommand(
      ["ingest-rewards", "--session", session.id, path],
      { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
      { workbench: async () => app },
    );
    return { code, out, err };
  };

  const initial = await run(recordsPath);
  assert.equal(initial.code, 0, initial.err.join(" "));
  assert.deepEqual(initial.out, ["ingest-rewards: 2 written, 0 duplicates skipped, 2 validated"]);
  const initialEntries = await rewardEntries();
  assert.deepEqual(initialEntries.map((entry) => entry.body.caseId), ["case-one", "case-two"]);
  const initialDigest = createHash("sha256").update(readFileSync(recordsPath, "utf8")).digest("hex");
  assert.deepEqual(initialEntries.map((entry) => entry.body.rewardIngestion), [
    { fileDigest: initialDigest, index: 0, count: 2 },
    { fileDigest: initialDigest, index: 1, count: 2 },
  ]);

  const rerun = await run(recordsPath);
  assert.equal(rerun.code, 0, rerun.err.join(" "));
  assert.deepEqual(rerun.out, ["ingest-rewards: 0 written, 2 duplicates skipped, 2 validated"]);
  assert.equal((await rewardEntries()).length, 2);

  const third = rewardRecord({ ...input, caseId: "case-three", passed: true });
  await assert.rejects(
    () => app.recordHarnessReward(session.id, third, { fileDigest: "bad", index: 0, count: 1 }),
    /fileDigest must be a sha256 hex digest/,
  );
  assert.equal((await rewardEntries()).length, 2);
  const tampered = { ...third, reward: typeof third.reward === "number" ? third.reward + 0.25 : 0 };
  const tamperedPath = join(dir, "tampered.jsonl");
  writeFileSync(tamperedPath, JSON.stringify(tampered) + "\n");
  const refused = await run(tamperedPath);
  assert.equal(refused.code, 1);
  assert.match(refused.err.join("\n"), /stored reward does not recompute/);
  assert.match(refused.err.join("\n"), /Nothing was written/);
  assert.equal((await rewardEntries()).length, 2);

  const tooLargePath = join(dir, "too-large.jsonl");
  writeFileSync(tooLargePath, "x".repeat(1024 * 1024 + 1));
  const tooLarge = await run(tooLargePath);
  assert.equal(tooLarge.code, 1);
  assert.match(tooLarge.err.join("\n"), /at most 1 MiB/);
  assert.equal((await rewardEntries()).length, 2);

  const sideChannel = { ...third, prompt: "SECRET-PROMPT-CANARY" };
  const sideChannelPath = join(dir, "side-channel.jsonl");
  writeFileSync(sideChannelPath, JSON.stringify(sideChannel) + "\n");
  const sideChannelRefused = await run(sideChannelPath);
  assert.equal(sideChannelRefused.code, 1);
  assert.match(sideChannelRefused.err.join("\n"), /unknown reward field/);
  assert.doesNotMatch(sideChannelRefused.err.join("\n"), /SECRET-PROMPT-CANARY/);
  assert.equal((await rewardEntries()).length, 2);

  for (const [name, hostile] of [
    ["case id", { ...third, caseId: "SECRET-PROMPT-CANARY case" }],
    ["guardrail name", { ...third, guardrails: { "SECRET-PROMPT-CANARY guardrail": 1 } }],
    ["weight name", { ...third, weights: { ...third.weights, "SECRET-PROMPT-CANARY weight": 1 } }],
  ]) {
    const hostilePath = join(dir, `${name.replaceAll(" ", "-")}.jsonl`);
    writeFileSync(hostilePath, JSON.stringify(hostile) + "\n");
    const hostileRefused = await run(hostilePath);
    assert.equal(hostileRefused.code, 1, name);
    assert.match(hostileRefused.err.join("\n"), /bounded identifiers|weights must contain only/);
    assert.doesNotMatch(hostileRefused.err.join("\n"), /SECRET-PROMPT-CANARY/, name);
    assert.equal((await rewardEntries()).length, 2, name);
  }

  // A separate measurement file may coincidentally contain exactly the same
  // values. That is new evidence, not a duplicate: only the same file digest
  // and record index make a rerun the same ingestion.
  const independentPath = join(dir, "independent-identical.jsonl");
  writeFileSync(
    independentPath,
    "\n" + [first, second].map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  const independent = await run(independentPath);
  assert.equal(independent.code, 0, independent.err.join(" "));
  assert.deepEqual(independent.out, ["ingest-rewards: 2 written, 0 duplicates skipped, 2 validated"]);
  assert.equal((await rewardEntries()).length, 4);

  // A partial write resumes at the missing position rather than starting over.
  const fourth = rewardRecord({ ...input, caseId: "case-four", passed: true });
  const fifth = rewardRecord({ ...input, caseId: "case-five", passed: false });
  const partialPath = join(dir, "partial.jsonl");
  const partialRaw = [fourth, fifth].map((record) => JSON.stringify(record)).join("\n") + "\n";
  writeFileSync(partialPath, partialRaw);
  const partialDigest = createHash("sha256").update(partialRaw).digest("hex");
  await app.recordHarnessReward(session.id, fourth, { fileDigest: partialDigest, index: 0, count: 2 });
  const resumed = await run(partialPath);
  assert.equal(resumed.code, 0, resumed.err.join(" "));
  assert.deepEqual(resumed.out, ["ingest-rewards: 1 written, 1 duplicates skipped, 2 validated"]);
  assert.deepEqual(
    (await rewardEntries()).map((entry) => entry.body.caseId).slice(-2),
    ["case-four", "case-five"],
  );
  assert.equal((await rewardEntries()).length, 6);
});


test("ingest-eval writes attributed tool measurements and rewards once after whole-file validation", async (t) => {
  const fixture = await isolatedWorkbench(t, fetcher, {}, { prefix: "nomo-h20b-" });
  const { app } = fixture;
  const session = await app.start("Measure attributed tools", "fixture");
  await app.settled();
  const dir = mkdtempSync(join(tmpdir(), "nomo-h20b-ingest-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const variantId = "sha256:" + "b".repeat(64);
  const reward = rewardRecord({
    caseId: "read-existing-document",
    variantId,
    baselineVariantId: null,
    changedAxis: null,
    passed: true,
    guardrails: {},
    costUsd: "unmeasured",
    latencyMs: 10,
    approvalMs: "unmeasured",
    weights: { breach: 0, cost: 0, latency: 0 },
  });
  const tool = {
    schema: "nomo.eval-tool.v1",
    caseId: "read-existing-document",
    variantId,
    run: 1,
    toolName: "void_workspace_read",
    toolClass: "r0",
    ok: true,
    execution: "managed-workspace-fixture",
  };
  const path = join(dir, "measurements.jsonl");
  writeFileSync(path, [tool, reward].map((record) => JSON.stringify(record)).join("\n") + "\n");
  const run = async (inputPath) => {
    const out = [];
    const err = [];
    const code = await runHarnessCommand(
      ["ingest-eval", "--session", session.id, inputPath],
      { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
      { workbench: async () => app },
    );
    return { code, out, err };
  };
  const measurementEntries = async () =>
    (await app.ledger(session.workspace)).entries.filter((entry) =>
      ["nomo.reward.v1", "nomo.eval-tool.v1"].includes(entry.body?.schema),
    );

  const first = await run(path);
  assert.equal(first.code, 0, first.err.join(" "));
  assert.deepEqual(first.out, ["ingest-eval: 2 written, 0 duplicates skipped, 2 validated, 1 rewards, 1 tool-records"]);
  const entries = await measurementEntries();
  assert.deepEqual(entries.map((entry) => entry.body.schema), ["nomo.eval-tool.v1", "nomo.reward.v1"]);
  const digest = createHash("sha256").update(readFileSync(path, "utf8")).digest("hex");
  assert.deepEqual(entries.map((entry) => entry.body.rewardIngestion), [
    { fileDigest: digest, index: 0, count: 2 },
    { fileDigest: digest, index: 1, count: 2 },
  ]);

  const rerun = await run(path);
  assert.equal(rerun.code, 0, rerun.err.join(" "));
  assert.deepEqual(rerun.out, ["ingest-eval: 0 written, 2 duplicates skipped, 2 validated, 1 rewards, 1 tool-records"]);
  assert.equal((await measurementEntries()).length, 2);

  const hostilePath = join(dir, "hostile.jsonl");
  writeFileSync(hostilePath, JSON.stringify({ ...tool, arguments: { path: "SECRET-PATH-CANARY" } }) + "\n" + JSON.stringify(reward) + "\n");
  const hostile = await run(hostilePath);
  assert.equal(hostile.code, 1);
  assert.match(hostile.err.join("\n"), /unknown field/);
  assert.doesNotMatch(hostile.err.join("\n"), /SECRET-PATH-CANARY/);
  assert.equal((await measurementEntries()).length, 2);

  const proof = await app.ledger(session.workspace);
  const exported = exportTrajectories(proof.entries.map((entry) => JSON.stringify(entry)).join("\n"));
  assert.equal(exported.trajectories.length, 1);
  assert.deepEqual(exported.trajectories[0].toolCalls, [
    { name: "void_workspace_read", klass: "r0", ok: true },
  ]);
});
