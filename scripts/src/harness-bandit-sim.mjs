#!/usr/bin/env node
/**
 * Deterministic contextual-bandit simulation report (R6).
 *
 * No model or network is involved. Two fixture compaction arms receive
 * Bernoulli rewards from fixed fixture rates, `sampleArm` chooses the next arm,
 * and the report prints cumulative simple regret, samples per arm and the stop
 * reason. This is measurement of the sampler, not RL training.
 *
 *   node scripts/src/harness-bandit-sim.mjs [--budget <tokens>] [--seed <n>]
 *
 * Exit codes: 0 = report printed; 2 = usage or fixture error.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineArms } from "../../packages/workbench/src/harness-arms.ts";
import { openBandit, recordReward, sampleArm } from "../../packages/workbench/src/harness-bandit.ts";

const usage = "usage: node scripts/src/harness-bandit-sim.mjs [--budget <tokens>] [--seed <n>]";
const rates = { "compaction-75": 0.8, "compaction-150": 0.3 };
const tokensPerObservation = 1000;

export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function simulate({ budgetTokens = 200000, seed = 7 } = {}) {
  const arms = defineArms("autoCompactMessages", [
    { armId: "compaction-75", value: 75 },
    { armId: "compaction-150", value: 150 },
  ]);
  const dir = mkdtempSync(join(tmpdir(), "nomo-bandit-sim-"));
  const path = join(dir, "bandit.jsonl");
  try {
    openBandit(path, { arms, budgetTokens });
    const random = seeded(seed);
    let state;
    let regret = 0;
    const bestRate = Math.max(...Object.values(rates));
    for (let armId = sampleArm(openBandit(path, { arms, budgetTokens }), random); armId; armId = sampleArm(state, random)) {
      const reward = random() < rates[armId] ? 1 : 0;
      regret += bestRate - rates[armId];
      state = recordReward(path, { armId, reward, tokens: tokensPerObservation });
    }
    state = state ?? openBandit(path, { arms, budgetTokens });
    return { state, regret, bestRate, rates };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function integer(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${name}: expected a positive integer`);
  return number;
}

export function main(argv) {
  let budgetTokens = 200000;
  let seed = 7;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--budget" && argv[index + 1]) budgetTokens = integer(argv[++index], "budget");
    else if (argv[index] === "--seed" && argv[index + 1]) seed = integer(argv[++index], "seed");
    else {
      console.error(usage);
      return 2;
    }
  }
  let report;
  try {
    report = simulate({ budgetTokens, seed });
  } catch (error) {
    console.error(`harness-bandit-sim: ${error.message}`);
    return 2;
  }
  console.log("arm             samples  rate   simple-regret");
  for (const arm of report.state.arms) {
    console.log(`${arm.armId.padEnd(15)} ${String(arm.samples).padStart(7)}  ${report.rates[arm.armId].toFixed(2)}   ${(report.bestRate - report.rates[arm.armId]).toFixed(2)}`);
  }
  console.log(`regret=${report.regret.toFixed(2)} spentTokens=${report.state.spentTokens} budgetTokens=${report.state.budgetTokens} stop=${report.state.stopReason}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
