#!/usr/bin/env node
/**
 * Read-only factorial bandit measurement report (H18).
 *
 * This command inspects an existing append-only factorial history. It does not
 * sample a treatment, approve exploration, train a model or deploy an arm.
 */
import { readFileSync, statSync } from "node:fs";
import {
  factorialEffects,
  readFactorialBandit,
} from "../../packages/workbench/src/harness-factorial-bandit.ts";

const usage = "usage: node scripts/src/harness-factorial-bandit-report.mjs <history.jsonl>";
const maxFileBytes = 1024 * 1024;

const numberText = (value) => value === null ? "unmeasured" : String(Number(value.toPrecision(12)));

export function formatFactorialReport(state) {
  const effects = factorialEffects(state);
  const lines = [
    `factorial-bandit: schema ${state.schema}, axes ${state.axes.join(" x ")}, budget ${state.budgetTokens}, spentTokens ${state.spentTokens}, stop ${state.stopReason ?? "running"}`,
  ];
  for (const treatment of state.treatments) {
    lines.push(
      `cell: ${treatment.armId}, samples ${effects.cellSamples[treatment.armId] ?? 0}, mean ${numberText(effects.cellMeans[treatment.armId] ?? null)}`,
    );
  }
  for (const axis of state.axes)
    lines.push(`main-effect: ${axis}, estimate ${numberText(effects.main[axis] ?? null)}`);
  lines.push(`interaction: estimate ${numberText(effects.interaction)}`);
  lines.push(`unmeasured: ${effects.unmeasured.length ? effects.unmeasured.join(", ") : "none"}`);
  lines.push("measurement only: no treatment sampled, no model trained, no arm deployed");
  return lines.join("\n");
}

export function main(argv, io = { out: console.log, err: console.error }) {
  if (argv.length !== 1) {
    io.err(usage);
    return 2;
  }
  const [path] = argv;
  try {
    if (statSync(path).size > maxFileBytes)
      throw new TypeError(`factorial history is over ${maxFileBytes} bytes`);
    readFileSync(path, "utf8");
    io.out(formatFactorialReport(readFactorialBandit(path)));
    return 0;
  } catch (error) {
    io.err(`harness-factorial-bandit-report: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
