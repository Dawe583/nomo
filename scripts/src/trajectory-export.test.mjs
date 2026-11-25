import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { TRAJECTORY_SCHEMA, exportTrajectories } from "./trajectory-export.mjs";
import { rewardRecord } from "../../packages/workbench/src/harness-scores.ts";

const script = fileURLToPath(new URL("./trajectory-export.mjs", import.meta.url));

const PROMPT = "SECRET-PROMPT-please read /etc/passwd";
const OUTPUT = "SECRET-TOOL-OUTPUT-root:x:0:0";

const record = (overrides = {}) =>
  rewardRecord({
    caseId: "read-before-write",
    variantId: "sha256:fixture",
    baselineVariantId: null,
    changedAxis: null,
    passed: true,
    guardrails: { deny_rate: 0 },
    costUsd: 0.001,
    latencyMs: 400,
    approvalMs: "unmeasured",
    weights: { breach: 0.5, cost: 1, latency: 0.001 },
    ...overrides,
  });

const entry = (seq, body) => ({ workspace: "ws", seq, body, prev_hash: "0".repeat(64), hash: "1".repeat(64) });

/** Tool entries carrying prompt text and tool output in every field the export must not read. */
function fixtureChain() {
  return [
    entry(1, { tool: "harness.eval", decision: "execute:completed", prompt: PROMPT }),
    entry(2, { tool: "read", klass: "r0", decision: "execute:dispatched", args: { path: PROMPT } }),
    entry(3, { tool: "read", klass: "r0", decision: "execute:completed", args: { path: PROMPT }, result: OUTPUT, prompt: PROMPT }),
    entry(4, { tool: "write", klass: "r1", decision: "deny:policy", reason: OUTPUT }),
    entry(5, { tool: "shell", decision: "execute:unknown", content: [{ type: "text", text: OUTPUT }] }),
    entry(6, { ...record(), prompt: PROMPT, output: OUTPUT }),
    entry(7, { tool: "edit", klass: "r1", decision: "execute:refused", result: OUTPUT }),
    entry(8, record({ caseId: "approval-hold", passed: false })),
    entry(9, { tool: "read", klass: "r0", decision: "execute:completed" }),
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
}

describe("trajectory-export", () => {
  test("groups tool entries under the reward record that closes them, names and outcomes only", () => {
    const report = exportTrajectories(fixtureChain());
    assert.deepEqual(report.trajectories, [
      {
        schema: TRAJECTORY_SCHEMA,
        caseId: "read-before-write",
        variantId: "sha256:fixture",
        toolCalls: [
          { name: "read", klass: "r0", ok: true },
          { name: "write", klass: "r1", ok: false },
          { name: "shell", klass: "unmeasured", ok: "unmeasured" },
        ],
        verifier: { passed: true, source: "harness-eval" },
        reward: record().reward,
      },
      {
        schema: TRAJECTORY_SCHEMA,
        caseId: "approval-hold",
        variantId: "sha256:fixture",
        toolCalls: [{ name: "edit", klass: "r1", ok: false }],
        verifier: { passed: false, source: "harness-eval" },
        reward: record({ passed: false }).reward,
      },
    ]);
    assert.equal(report.skipped, 2);
    assert.equal(report.unattributed, 1);
    assert.equal(report.refused, 0);
  });

  test("a reward ingested from a bare eval file does not adopt positional tools", () => {
    const ingested = { ...record(), rewardIngestion: { fileDigest: "a".repeat(64), index: 0, count: 1 } };
    const chain = [
      entry(1, { tool: "read", klass: "r0", decision: "execute:completed" }),
      entry(2, ingested),
    ].map((line) => JSON.stringify(line)).join("\n");
    const report = exportTrajectories(chain);
    assert.equal(report.trajectories.length, 1);
    assert.deepEqual(report.trajectories[0].toolCalls, []);
    assert.equal(report.unattributed, 1);
  });




  test("production eval attribution groups interleaved cases without position", () => {
    const evalA = { caseId: "read-before-write", variantId: "sha256:fixture", run: 1 };
    const evalB = { caseId: "approval-hold", variantId: "sha256:fixture", run: 1 };
    const rewardB = record({ caseId: "approval-hold", passed: false });
    const chain = [
      entry(1, { tool: "read", klass: "r0", decision: "execute:completed", harnessEval: evalA }),
      entry(2, { tool: "edit", klass: "r1", decision: "execute:refused", harnessEval: evalB }),
      entry(3, { tool: "write", klass: "r1", decision: "execute:completed", harnessEval: evalA }),
      entry(4, rewardB),
      entry(5, record()),
    ].map((line) => JSON.stringify(line)).join("\n");
    const report = exportTrajectories(chain);
    assert.deepEqual(report.trajectories[0], {
      schema: TRAJECTORY_SCHEMA,
      caseId: "approval-hold",
      variantId: "sha256:fixture",
      toolCalls: [{ name: "edit", klass: "r1", ok: false }],
      verifier: { passed: false, source: "harness-eval" },
      reward: rewardB.reward,
    });
    assert.deepEqual(report.trajectories[1].toolCalls, [
      { name: "read", klass: "r0", ok: true },
      { name: "write", klass: "r1", ok: true },
    ]);
    assert.equal(report.unattributed, 0);
    assert.equal(report.refused, 0);
  });


  test("production eval attribution separates repeated runs of the same case and variant", () => {
    const evalOne = { caseId: "read-before-write", variantId: "sha256:fixture", run: 1 };
    const evalTwo = { caseId: "read-before-write", variantId: "sha256:fixture", run: 2 };
    const rewardOne = { ...record(), harnessEval: evalOne };
    const rewardTwo = { ...record({ passed: false }), harnessEval: evalTwo };
    const chain = [
      entry(1, { tool: "read", klass: "r0", decision: "execute:completed", harnessEval: evalOne }),
      entry(2, { tool: "write", klass: "r1", decision: "execute:refused", harnessEval: evalTwo }),
      entry(3, { tool: "edit", klass: "r1", decision: "execute:completed", harnessEval: evalOne }),
      entry(4, rewardTwo),
      entry(5, rewardOne),
    ].map((line) => JSON.stringify(line)).join("\n");
    const report = exportTrajectories(chain);
    assert.equal(report.trajectories.length, 2);
    assert.deepEqual(report.trajectories[0].toolCalls, [
      { name: "write", klass: "r1", ok: false },
    ]);
    assert.equal(report.trajectories[0].reward, rewardTwo.reward);
    assert.deepEqual(report.trajectories[1].toolCalls, [
      { name: "read", klass: "r0", ok: true },
      { name: "edit", klass: "r1", ok: true },
    ]);
    assert.equal(report.trajectories[1].reward, rewardOne.reward);
    assert.equal(report.unattributed, 0);
    assert.equal(report.refused, 0);
  });


  test("an exact eval reward never adopts unrelated positional tool entries", () => {
    const evalOne = { caseId: "read-before-write", variantId: "sha256:fixture", run: 1 };
    const chain = [
      entry(1, { tool: "legacy", klass: "r1", decision: "execute:completed" }),
      entry(2, { ...record(), harnessEval: evalOne }),
    ].map((line) => JSON.stringify(line)).join("\n");
    const report = exportTrajectories(chain);
    assert.equal(report.trajectories.length, 1);
    assert.deepEqual(report.trajectories[0].toolCalls, []);
    assert.equal(report.unattributed, 1);
  });

  test("a reward without run metadata does not merge repeated pending runs", () => {
    const evalOne = { caseId: "read-before-write", variantId: "sha256:fixture", run: 1 };
    const evalTwo = { caseId: "read-before-write", variantId: "sha256:fixture", run: 2 };
    const chain = [
      entry(1, { tool: "read", klass: "r0", decision: "execute:completed", harnessEval: evalOne }),
      entry(2, { tool: "write", klass: "r1", decision: "execute:completed", harnessEval: evalTwo }),
      entry(3, record()),
    ].map((line) => JSON.stringify(line)).join("\n");
    const report = exportTrajectories(chain);
    assert.equal(report.trajectories.length, 0);
    assert.equal(report.refused, 1);
    assert.equal(report.unattributed, 2);
  });

  test("malformed reward harnessEval refuses the reward instead of guessing a run", () => {
    const evalOne = { caseId: "read-before-write", variantId: "sha256:fixture", run: 1 };
    const chain = [
      entry(1, { tool: "read", klass: "r0", decision: "execute:completed", harnessEval: evalOne }),
      entry(2, { ...record(), harnessEval: { ...evalOne, run: 0 } }),
    ].map((line) => JSON.stringify(line)).join("\n");
    const report = exportTrajectories(chain);
    assert.equal(report.trajectories.length, 0);
    assert.equal(report.refused, 1);
    assert.equal(report.unattributed, 1);
  });


  test("mismatched reward harnessEval identity refuses the reward instead of importing another case", () => {
    const evalOne = { caseId: "read-before-write", variantId: "sha256:fixture", run: 1 };
    const chain = [
      entry(1, { tool: "read", klass: "r0", decision: "execute:completed", harnessEval: evalOne }),
      entry(2, { ...record({ caseId: "approval-hold", passed: false }), harnessEval: evalOne }),
    ].map((line) => JSON.stringify(line)).join("\n");
    const report = exportTrajectories(chain);
    assert.equal(report.trajectories.length, 0);
    assert.equal(report.refused, 1);
    assert.equal(report.unattributed, 1);
  });

  test("malformed production eval attribution refuses the affected case", () => {
    const chain = [
      entry(1, { tool: "read", klass: "r0", decision: "execute:completed", harnessEval: { caseId: "bad", variantId: "sha256:fixture", run: 0 } }),
      entry(2, record()),
    ].map((line) => JSON.stringify(line)).join("\n");
    const report = exportTrajectories(chain);
    assert.equal(report.trajectories.length, 0);
    assert.equal(report.refused, 2);
  });

  test("explicit eval-tool measurements beat positional grouping and match ingestion provenance", () => {
    const digest = "b".repeat(64);
    const ingestion = { fileDigest: digest, index: 0, count: 2 };
    const tool = {
      schema: "nomo.eval-tool.v1",
      caseId: "read-before-write",
      variantId: "sha256:fixture",
      run: 1,
      toolName: "void_workspace_read",
      toolClass: "r0",
      ok: true,
      execution: "managed-workspace-fixture",
      rewardIngestion: ingestion,
      tool: "harness.eval-tool",
      decision: "eval-tool:recorded",
      result: OUTPUT,
    };
    const ingestedReward = {
      ...record(),
      rewardIngestion: { ...ingestion, index: 1 },
    };
    const chain = [
      entry(1, { tool: "unrelated", klass: "r1", decision: "execute:completed" }),
      entry(2, tool),
      entry(3, ingestedReward),
    ].map((line) => JSON.stringify(line)).join("\n");
    const report = exportTrajectories(chain);
    assert.equal(report.trajectories.length, 1);
    assert.deepEqual(report.trajectories[0].toolCalls, [
      { name: "void_workspace_read", klass: "r0", ok: true },
    ]);
    assert.equal(report.unattributed, 1);
    assert.ok(!JSON.stringify(report.trajectories).includes("unrelated"));
    assert.ok(!JSON.stringify(report.trajectories).includes("SECRET"));
  });

  test("an eval-tool measurement with the wrong ingestion file is not adopted", () => {
    const tool = {
      schema: "nomo.eval-tool.v1",
      caseId: "read-before-write",
      variantId: "sha256:fixture",
      run: 1,
      toolName: "void_workspace_read",
      toolClass: "r0",
      ok: true,
      execution: "managed-workspace-fixture",
      rewardIngestion: { fileDigest: "c".repeat(64), index: 0, count: 2 },
    };
    const chain = [tool, { ...record(), rewardIngestion: { fileDigest: "d".repeat(64), index: 1, count: 2 } }]
      .map((line) => JSON.stringify(line)).join("\n");
    const report = exportTrajectories(chain);
    assert.deepEqual(report.trajectories[0].toolCalls, []);
  });

  test("a hostile eval-tool measurement is refused without copying its content", () => {
    const tool = {
      schema: "nomo.eval-tool.v1",
      caseId: PROMPT,
      variantId: "sha256:fixture",
      run: 1,
      toolName: "void_workspace_read",
      toolClass: "r0",
      ok: true,
      execution: "managed-workspace-fixture",
    };
    const report = exportTrajectories(`${JSON.stringify(tool)}\n${JSON.stringify(record())}\n`);
    assert.equal(report.refused, 1);
    assert.equal(report.trajectories.length, 1);
    assert.deepEqual(report.trajectories[0].toolCalls, []);
    assert.ok(!JSON.stringify(report.trajectories).includes("SECRET"));
  });

  test("no prompt text or tool output reaches the export", () => {
    const text = JSON.stringify(exportTrajectories(fixtureChain()).trajectories);
    for (const secret of [PROMPT, OUTPUT, "SECRET", "/etc/passwd", "root:x"]) assert.ok(!text.includes(secret), secret);
    for (const trajectory of exportTrajectories(fixtureChain()).trajectories) {
      assert.deepEqual(Object.keys(trajectory), ["schema", "caseId", "variantId", "toolCalls", "verifier", "reward"]);
      for (const call of trajectory.toolCalls) assert.deepEqual(Object.keys(call), ["name", "klass", "ok"]);
    }
  });

  test("a prompt smuggled into a tool name or class is refused with its case, not copied", () => {
    const chain = [
      entry(1, { tool: PROMPT, klass: "r0", decision: "execute:completed" }),
      entry(2, record()),
      entry(3, { tool: "read", klass: `r0\n${OUTPUT}`, decision: "execute:completed" }),
      entry(4, record()),
      entry(5, { tool: "read", klass: "r0", decision: "execute:completed" }),
      entry(6, record()),
    ].map((line) => JSON.stringify(line)).join("\n");
    const report = exportTrajectories(chain);
    assert.equal(report.refused, 4);
    assert.equal(report.trajectories.length, 1);
    assert.ok(!JSON.stringify(report.trajectories).includes("SECRET"));
  });

  test("a tampered reward or an unreadable line is refused, never exported", () => {
    const tampered = { ...record(), reward: 1 };
    const report = exportTrajectories(`{not json\n${JSON.stringify(tampered)}\n`);
    assert.equal(report.trajectories.length, 0);
    assert.equal(report.refused, 1);
    assert.equal(report.unreadable, 1);
  });

  test("the CLI writes only records to --out and prints counts only", () => {
    const dir = mkdtempSync(join(tmpdir(), "trajectory-export-"));
    try {
      const chain = join(dir, "chain.jsonl");
      const out = join(dir, "trajectories.jsonl");
      writeFileSync(chain, fixtureChain());
      const result = spawnSync(process.execPath, [script, chain, "--out", out], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stdout, "");
      assert.match(
        result.stderr,
        /trajectory-export: 2 trajectories, 0 refused, 0 unreadable, 1 unattributed tool calls, 2 other entries skipped/,
      );
      const written = readFileSync(out, "utf8");
      assert.ok(!(written + result.stderr).includes("SECRET"));
      const lines = written.trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(lines.map((line) => [line.schema, line.caseId]), [
        [TRAJECTORY_SCHEMA, "read-before-write"],
        [TRAJECTORY_SCHEMA, "approval-hold"],
      ]);

      const empty = join(dir, "empty.jsonl");
      writeFileSync(empty, JSON.stringify(entry(1, { tool: "read", decision: "execute:completed" })) + "\n");
      assert.equal(spawnSync(process.execPath, [script, empty], { encoding: "utf8" }).status, 1);
      assert.equal(spawnSync(process.execPath, [script, join(dir, "absent.jsonl")], { encoding: "utf8" }).status, 2);
      assert.equal(spawnSync(process.execPath, [script], { encoding: "utf8" }).status, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
