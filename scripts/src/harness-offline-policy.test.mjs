import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatOfflinePolicyReport, parseArgs, parseLoggedRounds } from "./harness-offline-policy.mjs";
import { evaluateOfflinePolicy } from "../../packages/workbench/src/offline-policy.ts";

const script = fileURLToPath(new URL("./harness-offline-policy.mjs", import.meta.url));

const roundsText = [
  { armId: "candidate", reward: 1, propensity: 0.5 },
  { armId: "incumbent", reward: 0, propensity: 0.5 },
  { armId: "candidate", reward: 0, propensity: 0.25 },
  { armId: "incumbent", reward: 1, propensity: 0.5 },
].map((line) => JSON.stringify(line)).join("\n") + "\n";

test("the measurement contract parses exact bounded rounds", () => {
  const rounds = parseLoggedRounds(roundsText);
  assert.equal(rounds.length, 4);
  assert.deepEqual(parseArgs(["rounds.jsonl", "--arm", "candidate", "--arm", "incumbent", "--arm", "candidate"]), {
    file: "rounds.jsonl",
    arms: ["candidate", "incumbent"],
  });
});

test("the report names measured values and unsupported arms without deploying anything", () => {
  const report = evaluateOfflinePolicy(parseLoggedRounds(roundsText), ["candidate", "new-arm"]);
  const text = formatOfflinePolicyReport(report);
  assert.match(text, /offline-policy: schema nomo\.offline-policy\.v1, rounds 4/);
  assert.match(text, /candidate: matched 2, coverage 0\.500, estimate 0\.5, effectiveSamples 1.8/);
  assert.match(text, /new-arm: matched 0, coverage 0\.000, estimate unmeasured, effectiveSamples 0/);
  assert.match(text, /unmeasured: new-arm/);
  assert.match(text, /measurement only: no model trained, no arm deployed/);
});

test("the CLI prints a report for a valid measurement file", () => {
  const dir = mkdtempSync(join(tmpdir(), "offline-policy-"));
  try {
    const file = join(dir, "rounds.jsonl");
    writeFileSync(file, roundsText);
    const result = spawnSync(process.execPath, [script, file, "--arm", "candidate", "--arm", "incumbent"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /candidate: matched 2, coverage 0\.500, estimate 0\.5/);
    assert.match(result.stdout, /incumbent: matched 2, coverage 0\.500, estimate 0\.5/);
    assert.match(result.stdout, /unmeasured: none/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI refuses malformed input before printing a partial report", () => {
  const dir = mkdtempSync(join(tmpdir(), "offline-policy-"));
  try {
    const file = join(dir, "rounds.jsonl");
    writeFileSync(file, JSON.stringify({ armId: "a", reward: 1, propensity: 0.5, extra: true }) + "\n");
    const malformed = spawnSync(process.execPath, [script, file, "--arm", "a"], { encoding: "utf8" });
    assert.equal(malformed.status, 2);
    assert.match(malformed.stderr, /unknown field extra/);
    assert.equal(malformed.stdout, "");

    writeFileSync(file, JSON.stringify({ armId: "a", reward: 1, propensity: 0 }) + "\n");
    const badPropensity = spawnSync(process.execPath, [script, file, "--arm", "a"], { encoding: "utf8" });
    assert.equal(badPropensity.status, 2);
    assert.match(badPropensity.stderr, /propensity/);

    const missingArm = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
    assert.equal(missingArm.status, 2);
    assert.match(missingArm.stderr, /at least one --arm/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
