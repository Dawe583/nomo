#!/usr/bin/env node
/**
 * Offline deterministic-arm policy evaluation (R8).
 *
 * Input is a bounded JSONL measurement file. Every line is exactly:
 *
 *   {"armId":"compaction-75","reward":1,"propensity":0.5}
 *
 * `propensity` is the probability the logging policy gave the arm it actually
 * chose in that round. It cannot be reconstructed from a bandit history that
 * did not record it, so this command refuses to infer one. Candidate arms are
 * named explicitly with repeated `--arm` options.
 *
 * The report is inverse-propensity measurement only. It trains nothing,
 * deploys nothing and never treats an unsupported arm as zero.
 *
 *   node scripts/src/harness-offline-policy.mjs <rounds.jsonl> --arm <id> [--arm <id>...]
 *
 * Exit codes: 0 = report printed, including truthful unmeasured arms;
 * 2 = usage, file or measurement-contract error.
 */
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { evaluateOfflinePolicy } from "../../packages/workbench/src/offline-policy.ts";

const usage = "usage: node scripts/src/harness-offline-policy.mjs <rounds.jsonl> --arm <id> [--arm <id>...]";
const maxFileBytes = 1024 * 1024;
const maxRounds = 10000;
const maxArmIdChars = 128;
const roundFields = new Set(["armId", "reward", "propensity"]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function validArmId(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxArmIdChars && !/\s/.test(value);
}

/** Parse the JSONL measurement contract. Throws before any report is printed. */
export function parseLoggedRounds(raw) {
  const rounds = String(raw)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        throw new TypeError(`line ${index + 1}: not valid JSON`);
      }
      if (!isObject(value)) throw new TypeError(`line ${index + 1}: expected an object`);
      for (const key of Object.keys(value))
        if (!roundFields.has(key)) throw new TypeError(`line ${index + 1}: unknown field ${key}`);
      for (const key of roundFields)
        if (!Object.prototype.hasOwnProperty.call(value, key)) throw new TypeError(`line ${index + 1}: missing ${key}`);
      if (!validArmId(value.armId)) throw new TypeError(`line ${index + 1}: invalid armId`);
      if (typeof value.reward !== "number" || !Number.isFinite(value.reward) || value.reward < 0 || value.reward > 1)
        throw new TypeError(`line ${index + 1}: reward must be in [0, 1]`);
      if (typeof value.propensity !== "number" || !Number.isFinite(value.propensity) || value.propensity <= 0 || value.propensity > 1)
        throw new TypeError(`line ${index + 1}: propensity must be in (0, 1]`);
      return { armId: value.armId, reward: value.reward, propensity: value.propensity };
    });
  if (rounds.length === 0) throw new TypeError("no logged rounds");
  if (rounds.length > maxRounds) throw new TypeError(`too many logged rounds: maximum is ${maxRounds}`);
  return rounds;
}

/** Parse one file path plus repeated explicit candidate arms. */
export function parseArgs(argv) {
  let file = "";
  const arms = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--arm") {
      const arm = argv[index + 1];
      if (!validArmId(arm)) throw new TypeError("--arm needs a non-empty id without whitespace");
      arms.push(arm);
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new TypeError(`unknown option ${arg}`);
    } else if (!file) {
      file = arg;
    } else {
      throw new TypeError("only one rounds JSONL file may be named");
    }
  }
  if (!file) throw new TypeError("a rounds JSONL file is required");
  if (arms.length === 0) throw new TypeError("at least one --arm is required");
  return { file, arms: [...new Set(arms)] };
}

const numberText = (value) => value === null ? "unmeasured" : String(value);

export function formatOfflinePolicyReport(report) {
  const lines = [`offline-policy: schema ${report.schema}, rounds ${report.rounds}`];
  for (const arm of report.arms)
    lines.push(
      `${arm.armId}: matched ${arm.matchedRounds}, coverage ${arm.coverage.toFixed(3)}, ` +
        `estimate ${numberText(arm.estimate)}, effectiveSamples ${String(arm.effectiveSamples)}`,
    );
  lines.push(`unmeasured: ${report.unmeasured.length ? report.unmeasured.join(",") : "none"}`);
  lines.push("measurement only: no model trained, no arm deployed");
  return lines.join("\n");
}

export function main(argv) {
  let input;
  try {
    input = parseArgs(argv);
  } catch (error) {
    console.error(`harness-offline-policy: ${error.message}`);
    console.error(usage);
    return 2;
  }
  let raw;
  try {
    if (statSync(input.file).size > maxFileBytes) throw new TypeError(`rounds file exceeds ${maxFileBytes} bytes`);
    raw = readFileSync(input.file, "utf8");
  } catch (error) {
    console.error(`harness-offline-policy: rounds could not be read: ${error instanceof TypeError ? error.message : input.file}`);
    return 2;
  }
  try {
    const report = evaluateOfflinePolicy(parseLoggedRounds(raw), input.arms);
    console.log(formatOfflinePolicyReport(report));
    return 0;
  } catch (error) {
    console.error(`harness-offline-policy: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
