import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FACTORIAL_BANDIT_SCHEMA,
  defineFactorialArms,
  factorialArmsDigest,
  factorialEffects,
  openFactorialBandit,
  readFactorialBandit,
  recordFactorialReward,
  sampleFactorialArm,
} from "./harness-factorial-bandit.ts";

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

function withFile(run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "nomo-factorial-bandit-"));
  try {
    run(join(dir, "factorial.jsonl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a two-axis factorial design composes four verifiable treatment arms", () => {
  assert.equal(treatments.length, 4);
  assert.deepEqual(
    treatments.map((treatment) => treatment.armId),
    [
      "compact75__tool1000",
      "compact75__tool4000",
      "compact150__tool1000",
      "compact150__tool4000",
    ],
  );
  assert.equal(new Set(treatments.map((treatment) => treatment.digest)).size, 4);
  assert.ok(treatments.every((treatment) => treatment.axes[0] !== treatment.axes[1]));
});

test("factorial rewards report main effects and an interaction only from measured cells", () => {
  withFile((path) => {
    const state = openFactorialBandit(path, { treatments, budgetTokens: 1000 });
    assert.equal(state.schema, FACTORIAL_BANDIT_SCHEMA);
    assert.equal(state.stopReason, null);
    const rewards = [0.2, 0.4, 0.5, 0.9];
    treatments.forEach((treatment, index) => {
      recordFactorialReward(path, { armId: treatment.armId, reward: rewards[index]!, tokens: 10 });
    });
    const measured = readFactorialBandit(path);
    assert.equal(measured.spentTokens, 40);
    assert.equal(measured.stopReason, null);
    const effects = factorialEffects(measured);
    assert.deepEqual(effects.unmeasured, []);
    assert.ok(Math.abs(effects.main.autoCompactMessages! - 0.4) < 1e-12);
    assert.ok(Math.abs(effects.main.maxToolResultCharacters! - 0.3) < 1e-12);
    assert.ok(Math.abs(effects.interaction! - 0.2) < 1e-12);
    assert.deepEqual(effects.cellSamples, {
      compact75__tool1000: 1,
      compact75__tool4000: 1,
      compact150__tool1000: 1,
      compact150__tool4000: 1,
    });
  });
});

test("an empty factorial cell makes main effects and interaction unmeasured rather than zero", () => {
  withFile((path) => {
    openFactorialBandit(path, { treatments, budgetTokens: 1000 });
    recordFactorialReward(path, { armId: treatments[0]!.armId, reward: 1, tokens: 10 });
    const effects = factorialEffects(readFactorialBandit(path));
    assert.equal(effects.interaction, null);
    assert.equal(effects.main.autoCompactMessages, null);
    assert.equal(effects.main.maxToolResultCharacters, null);
    assert.deepEqual(effects.unmeasured, treatments.slice(1).map((treatment) => treatment.armId));
  });
});

test("the factorial bandit persists append-only state, samples only known treatments and stops at budget", () => {
  withFile((path) => {
    openFactorialBandit(path, { treatments, budgetTokens: 20 });
    const before = readFileSync(path, "utf8");
    const chosen = sampleFactorialArm(readFactorialBandit(path));
    assert.ok(treatments.some((treatment) => treatment.armId === chosen));
    recordFactorialReward(path, { armId: chosen!, reward: 1, tokens: 10 });
    assert.ok(readFileSync(path, "utf8").startsWith(before));
    const stopped = recordFactorialReward(path, { armId: chosen!, reward: 0, tokens: 10 });
    assert.equal(stopped.stopReason, "budget");
    assert.equal(sampleFactorialArm(stopped), null);
    assert.throws(
      () => recordFactorialReward(path, { armId: chosen!, reward: 1, tokens: 1 }),
      /stopped: budget/,
    );
    assert.deepEqual(openFactorialBandit(path, { treatments, budgetTokens: 20 }), stopped);
  });
});

test("a guardrail axis needs approval bound to the exact factorial treatments and never stores prompt text", () => {
  const guarded = defineFactorialArms(
    "promptPreamble",
    [
      { armId: "terse", value: "Be terse." },
      { armId: "careful", value: "Be careful." },
    ],
    "autoCompactMessages",
    [
      { armId: "compact75", value: 75 },
      { armId: "compact150", value: 150 },
    ],
  );
  withFile((path) => {
    const refused = openFactorialBandit(path, { treatments: guarded, budgetTokens: 100 });
    assert.equal(refused.stopReason, "unapproved-guardrail");
    assert.equal(sampleFactorialArm(refused), null);
    const text = readFileSync(path, "utf8");
    assert.match(text, /includes a guardrail axis/);
    assert.ok(!text.includes("Be terse.") && !text.includes("Be careful."));
  });
  withFile((path) => {
    const approval = { approvedBy: "operator", armsDigest: factorialArmsDigest(guarded) };
    const approved = openFactorialBandit(path, { treatments: guarded, budgetTokens: 100, approval });
    assert.equal(approved.stopReason, null);
    assert.ok(sampleFactorialArm(approved));
  });
});

test("tampered treatments and bad observations are refused", () => {
  withFile((path) => {
    const tampered = treatments.map((treatment, index) =>
      index === 0 ? { ...treatment, digest: treatments[1]!.digest } : treatment,
    );
    assert.throws(
      () => openFactorialBandit(path, { treatments: tampered, budgetTokens: 100 }),
      /digest mismatch/,
    );
    const incomplete = treatments.map((treatment, index) =>
      index === 3 ? { ...treatments[2]!, armId: "duplicate-cell" } : treatment,
    );
    assert.throws(
      () => openFactorialBandit(path, { treatments: incomplete, budgetTokens: 100 }),
      /complete 2x2 factorial/,
    );
    openFactorialBandit(path, { treatments, budgetTokens: 100 });
    assert.throws(
      () => recordFactorialReward(path, { armId: treatments[0]!.armId, reward: 2, tokens: 1 }),
      /reward/,
    );
    assert.throws(
      () => recordFactorialReward(path, { armId: "unknown", reward: 1, tokens: 1 }),
      /Unknown treatment/,
    );
  });
});
