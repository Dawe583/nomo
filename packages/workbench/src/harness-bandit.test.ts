import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineArms } from "./harness-arms.ts";
import {
  BANDIT_SCHEMA,
  armsDigest,
  openBandit,
  readBandit,
  recordReward,
  resetBandit,
  sampleArm,
  type BanditState,
} from "./harness-bandit.ts";

const arms = defineArms("autoCompactMessages", [
  { armId: "compaction-75", value: 75 },
  { armId: "compaction-150", value: 150 },
]);

/** Deterministic PRNG so the simulation is reproducible. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function withFile(run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "nomo-bandit-"));
  try {
    run(join(dir, "nested", "bandit.jsonl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function simulate(path: string, reward: (armId: string, random: () => number) => number, tokens: number) {
  const random = seeded(7);
  let state: BanditState = readBandit(path);
  let steps = 0;
  for (let armId = sampleArm(state, random); armId; armId = sampleArm(state, random)) {
    state = recordReward(path, { armId, reward: reward(armId, random), tokens });
    steps += 1;
    assert.ok(steps < 10_000, "simulation must stop");
  }
  return state;
}

test("a fresh bandit starts every arm at the uniform prior and persists a start event", () => {
  withFile((path) => {
    const state = openBandit(path, { arms, budgetTokens: 200_000 });
    assert.deepEqual(state, {
      schema: BANDIT_SCHEMA,
      axis: "autoCompactMessages",
      arms: [
        { armId: "compaction-75", alpha: 1, beta: 1, samples: 0 },
        { armId: "compaction-150", alpha: 1, beta: 1, samples: 0 },
      ],
      budgetTokens: 200_000,
      spentTokens: 0,
      stopReason: null,
    });
    const [line] = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(JSON.parse(line!).type, "start");
    assert.deepEqual(openBandit(path, { arms, budgetTokens: 200_000 }), state);
  });
});

test("simulation over fixture rewards prefers the better arm and stops when the posteriors separate", () => {
  withFile((path) => {
    openBandit(path, { arms, budgetTokens: 200_000 });
    const rate: Record<string, number> = { "compaction-75": 0.8, "compaction-150": 0.3 };
    const state = simulate(path, (armId, random) => (random() < rate[armId]! ? 1 : 0), 1_000);
    const [better, worse] = state.arms;
    assert.equal(state.stopReason, "separated");
    assert.ok(state.spentTokens < state.budgetTokens);
    assert.ok(better!.samples > worse!.samples, `${better!.samples} > ${worse!.samples}`);
    assert.ok(better!.alpha / (better!.alpha + better!.beta) > worse!.alpha / (worse!.alpha + worse!.beta));
    assert.equal(sampleArm(state, seeded(1)), null);
    assert.throws(() => recordReward(path, { armId: "compaction-75", reward: 1, tokens: 1 }), /stopped: separated/);
  });
});

test("arms that never separate stop at the token budget", () => {
  withFile((path) => {
    openBandit(path, { arms, budgetTokens: 10_000 });
    const state = simulate(path, () => 0.5, 700);
    assert.equal(state.stopReason, "budget");
    assert.ok(state.spentTokens >= state.budgetTokens);
    assert.ok(state.spentTokens - 700 < state.budgetTokens, "stops on the first observation that reaches the budget");
    assert.equal(state.arms.reduce((sum, arm) => sum + arm.samples, 0), 15);
  });
});

test("state is append-only: a restart replays the history instead of resetting the posterior", () => {
  withFile((path) => {
    openBandit(path, { arms, budgetTokens: 50_000 });
    recordReward(path, { armId: "compaction-75", reward: 1, tokens: 100 });
    const before = readFileSync(path, "utf8");
    const after = recordReward(path, { armId: "compaction-150", reward: 0.25, tokens: 100 });
    assert.ok(readFileSync(path, "utf8").startsWith(before), "earlier lines are never rewritten");
    const reopened = openBandit(path, { arms, budgetTokens: 50_000 });
    assert.deepEqual(reopened, after);
    assert.deepEqual(reopened.arms[1], { armId: "compaction-150", alpha: 1.25, beta: 1.75, samples: 1 });
    assert.equal(reopened.spentTokens, 200);
  });
});

test("a reset needs a recorded reason and keeps the tokens already spent", () => {
  withFile((path) => {
    openBandit(path, { arms, budgetTokens: 50_000 });
    recordReward(path, { armId: "compaction-75", reward: 1, tokens: 300 });
    assert.throws(() => resetBandit(path, "  "), /reason/);
    const state = resetBandit(path, "fixture changed");
    assert.deepEqual(state.arms[0], { armId: "compaction-75", alpha: 1, beta: 1, samples: 0 });
    assert.equal(state.spentTokens, 300);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.at(-1), { type: "reset", reason: "fixture changed" });
  });
});

test("the boundary refuses bad arms, rewards, tokens and tampered history", () => {
  withFile((path) => {
    assert.throws(() => openBandit(path, { arms: [], budgetTokens: 1 }), /at least one arm/);
    assert.throws(() => openBandit(path, { arms: [{ ...arms[0]!, value: 76 }], budgetTokens: 1 }), /does not verify/);
    const mixed = [...arms, ...defineArms("maxToolResultCharacters", [{ armId: "small", value: 1000 }])];
    assert.throws(() => openBandit(path, { arms: mixed, budgetTokens: 1 }), /one axis/);
    assert.throws(() => openBandit(path, { arms, budgetTokens: 0 }), /budgetTokens/);
    openBandit(path, { arms, budgetTokens: 1_000 });
    assert.throws(() => openBandit(path, { arms: arms.slice(0, 1), budgetTokens: 1_000 }), /different arms/);
    assert.throws(() => openBandit(path, { arms, budgetTokens: 2_000 }), /budget/);
    assert.throws(() => recordReward(path, { armId: "nope", reward: 1, tokens: 1 }), /Unknown arm nope/);
    assert.throws(() => recordReward(path, { armId: "compaction-75", reward: 1.5, tokens: 1 }), /reward/);
    assert.throws(() => recordReward(path, { armId: "compaction-75", reward: Number.NaN, tokens: 1 }), /reward/);
    assert.throws(() => recordReward(path, { armId: "compaction-75", reward: 1, tokens: -1 }), /tokens/);
    appendFileSync(path, "{not json\n");
    assert.throws(() => readBandit(path), /line 2/);
  });
});

const preambles = defineArms("promptPreamble", [
  { armId: "terse", value: "Be terse." },
  { armId: "careful", value: "Be careful." },
]);

test("a guardrail axis is refused without an approval and the refusal is in the record", () => {
  withFile((path) => {
    const state = openBandit(path, { arms: preambles, budgetTokens: 10_000 });
    assert.equal(state.stopReason, "unapproved-guardrail");
    assert.equal(sampleArm(state, seeded(1)), null);
    assert.throws(() => recordReward(path, { armId: "terse", reward: 1, tokens: 1 }), /stopped: unapproved-guardrail/);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines[1], {
      type: "refusal",
      axis: "promptPreamble",
      reason: "promptPreamble changes a guardrail and no approval was given",
    });
    assert.ok(!readFileSync(path, "utf8").includes("Be terse."), "the preamble text never enters the record");
    // A reset cannot lift the refusal, and neither can deleting the refusal line.
    assert.equal(resetBandit(path, "try again").stopReason, "unapproved-guardrail");
    const approval = { approvedBy: "operator", armsDigest: armsDigest(preambles) };
    assert.throws(() => openBandit(path, { arms: preambles, budgetTokens: 10_000, approval }), /different approval/);
  });
  withFile((path) => {
    openBandit(path, { arms: preambles, budgetTokens: 10_000 });
    const [start] = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, `${start}\n`);
    assert.equal(readBandit(path).stopReason, "unapproved-guardrail");
  });
});

test("an approval bound to other arms is refused; one bound to these arms allows exploration", () => {
  withFile((path) => {
    const other = { approvedBy: "operator", armsDigest: armsDigest(preambles.slice(0, 1)) };
    const state = openBandit(path, { arms: preambles, budgetTokens: 10_000, approval: other });
    assert.equal(state.stopReason, "unapproved-guardrail");
    assert.match(JSON.parse(readFileSync(path, "utf8").trim().split("\n")[1]!).reason, /approval names sha256:/);
  });
  withFile((path) => {
    const approval = { approvedBy: "operator", armsDigest: armsDigest(preambles) };
    const state = openBandit(path, { arms: preambles, budgetTokens: 10_000, approval });
    assert.equal(state.stopReason, null);
    assert.ok(sampleArm(state, seeded(1)));
    assert.equal(recordReward(path, { armId: "careful", reward: 1, tokens: 10 }).arms[1]!.samples, 1);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 2, "no refusal line");
    assert.throws(() => openBandit(path, { arms: preambles, budgetTokens: 10_000 }), /different approval/);
  });
  withFile((path) => {
    assert.throws(
      () => openBandit(path, { arms: preambles, budgetTokens: 1, approval: { approvedBy: " ", armsDigest: armsDigest(preambles) } }),
      /approvedBy/,
    );
    assert.throws(
      () => openBandit(path, { arms: preambles, budgetTokens: 1, approval: { approvedBy: "op", armsDigest: "x" } }),
      /sha256/,
    );
  });
});

test("a non-guardrail axis explores without an approval", () => {
  withFile((path) => {
    assert.equal(openBandit(path, { arms, budgetTokens: 1_000 }).stopReason, null);
  });
});
