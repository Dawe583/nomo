import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { replayRewards } from "./harness-replay.mjs";
import { rewardRecord } from "../../packages/workbench/src/harness-scores.ts";

const script = fileURLToPath(new URL("./harness-replay.mjs", import.meta.url));

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

const entry = (seq, body) => ({
  workspace: "replay-ws",
  seq,
  body,
  prev_hash: "0".repeat(64),
  hash: "1".repeat(64),
  key_id: "fixture",
  alg: "ed25519",
  signature: "fixture",
});

/** One good record, one tampered record, one unrelated tool entry. */
function fixtureChain() {
  const good = record();
  const tampered = { ...record({ caseId: "approval-hold" }), passed: false };
  return [
    entry(1, { tool: "read", klass: "r0", decision: "execute:completed" }),
    entry(2, good),
    entry(3, tampered),
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
}

describe("harness-replay", () => {
  test("an untouched record matches and a tampered one is named", () => {
    const report = replayRewards(fixtureChain());
    assert.equal(report.records, 2);
    assert.equal(report.matched, 1);
    assert.equal(report.skipped, 1);
    assert.deepEqual(
      report.results.map((result) => [result.where, result.caseId, result.status]),
      [
        ["seq 2", "read-before-write", "match"],
        ["seq 3", "approval-hold", "mismatch"],
      ],
    );
    assert.equal(report.results[1].stored, 1 - 0.001 - 400 * 0.001);
    assert.equal(report.results[1].recomputed, 0 - 0.5 * 0 - 0.001 - 400 * 0.001);
  });

  test("bare eval record lines replay like chain entries", () => {
    const report = replayRewards(`${JSON.stringify(record())}\n${JSON.stringify({ ...record(), reward: 1 })}\n`);
    assert.deepEqual(report.results.map((result) => [result.where, result.status]), [
      ["line 1", "match"],
      ["line 2", "mismatch"],
    ]);
  });

  test("an unmeasured reward must stay unmeasured, and an invented number is a mismatch", () => {
    const unmeasured = record({ costUsd: "unmeasured" });
    assert.equal(unmeasured.reward, "unmeasured");
    const report = replayRewards(
      [unmeasured, { ...unmeasured, reward: 1 }].map((line) => JSON.stringify(line)).join("\n"),
    );
    assert.deepEqual(report.results.map((result) => result.status), ["match", "mismatch"]);
  });

  test("an unreadable line or an invalid record is reported, never skipped", () => {
    const invalid = { ...record(), weights: { breach: 0.5, cost: 1 } };
    const report = replayRewards(`{not json\n${JSON.stringify(invalid)}\n`);
    assert.deepEqual(report.results.map((result) => [result.where, result.status]), [
      ["line 1", "unreadable"],
      ["line 2", "invalid"],
    ]);
    assert.equal(report.matched, 0);
  });

  test("the CLI exits 1 on the tampered fixture, names it and prints no prompt field", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-replay-"));
    try {
      const chain = join(dir, "chain.jsonl");
      writeFileSync(chain, fixtureChain());
      const result = spawnSync(process.execPath, [script, chain], { encoding: "utf8" });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /^OK {7}seq 2 {2}case=read-before-write variant=sha256:fixture$/m);
      assert.match(result.stdout, /^MISMATCH seq 3 {2}case=approval-hold variant=sha256:fixture stored=-?[\d.]+ recomputed=-?[\d.]+$/m);
      assert.match(result.stdout, /replay: 2 reward records, 1 match, 1 mismatch, 0 invalid, 0 unreadable, 1 other entries skipped/);

      const clean = join(dir, "clean.jsonl");
      writeFileSync(clean, JSON.stringify(entry(1, record())) + "\n");
      assert.equal(spawnSync(process.execPath, [script, clean], { encoding: "utf8" }).status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a chain with no reward record is not a pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-replay-"));
    try {
      const chain = join(dir, "chain.jsonl");
      writeFileSync(chain, JSON.stringify(entry(1, { tool: "read" })) + "\n");
      const result = spawnSync(process.execPath, [script, chain], { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /replay: no reward records found/);
      const missing = spawnSync(process.execPath, [script, join(dir, "absent.jsonl")], { encoding: "utf8" });
      assert.equal(missing.status, 2);
      const usage = spawnSync(process.execPath, [script], { encoding: "utf8" });
      assert.equal(usage.status, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
