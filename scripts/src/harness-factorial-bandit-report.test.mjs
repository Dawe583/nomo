import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineFactorialArms,
  openFactorialBandit,
  recordFactorialReward,
} from "../../packages/workbench/src/harness-factorial-bandit.ts";
import { formatFactorialReport } from "./harness-factorial-bandit-report.mjs";

const treatments = defineFactorialArms(
  "autoCompactMessages",
  [
    { armId: "compact75", value: 75 },
    { armId: "compact150", value: 150 },
  ],
  "maxToolResultCharacters",
  [
    { armId: "tool1000", value: 1000 },
    { armId: "tool4000", value: 4000 },
  ],
);

function withFile(run) {
  const dir = mkdtempSync(join(tmpdir(), "nomo-factorial-report-"));
  try {
    run(join(dir, "factorial.jsonl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function completeHistory(path) {
  openFactorialBandit(path, { treatments, budgetTokens: 1000 });
  [0.2, 0.4, 0.5, 0.9].forEach((reward, index) =>
    recordFactorialReward(path, { armId: treatments[index].armId, reward, tokens: 10 }),
  );
}

test("the report prints measured cell, main-effect and interaction estimates", () => {
  withFile((path) => {
    completeHistory(path);
    const text = execFileSync(process.execPath, ["scripts/src/harness-factorial-bandit-report.mjs", path], { encoding: "utf8" });
    assert.match(text, /compact75__tool1000, samples 1, mean 0\.2/);
    assert.match(text, /main-effect: autoCompactMessages, estimate 0\.4/);
    assert.match(text, /main-effect: maxToolResultCharacters, estimate 0\.3/);
    assert.match(text, /interaction: estimate 0\.2/);
    assert.match(text, /unmeasured: none/);
    assert.match(text, /measurement only: no treatment sampled, no model trained, no arm deployed/);
  });
});

test("an incomplete history reports unmeasured cells rather than zero", () => {
  withFile((path) => {
    openFactorialBandit(path, { treatments, budgetTokens: 1000 });
    recordFactorialReward(path, { armId: treatments[0].armId, reward: 1, tokens: 10 });
    const text = execFileSync(process.execPath, ["scripts/src/harness-factorial-bandit-report.mjs", path], { encoding: "utf8" });
    assert.match(text, /compact150__tool4000, samples 0, mean unmeasured/);
    assert.match(text, /main-effect: autoCompactMessages, estimate unmeasured/);
    assert.match(text, /interaction: estimate unmeasured/);
  });
});

test("the formatter never samples even when the search is still running", () => {
  withFile((path) => {
    const state = openFactorialBandit(path, { treatments, budgetTokens: 1000 });
    const text = formatFactorialReport(state);
    assert.match(text, /stop running/);
    assert.match(text, /no treatment sampled/);
  });
});

test("malformed history is refused before a report", () => {
  withFile((path) => {
    writeFileSync(path, "not json\n");
    assert.throws(
      () => execFileSync(process.execPath, ["scripts/src/harness-factorial-bandit-report.mjs", path], { encoding: "utf8", stdio: "pipe" }),
      /Command failed/,
    );
  });
});
