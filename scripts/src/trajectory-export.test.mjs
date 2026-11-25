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
