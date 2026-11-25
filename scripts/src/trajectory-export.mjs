#!/usr/bin/env node
/**
 * Trajectory export: turn a chain of tool entries and `nomo.reward.v1` records
 * into `nomo.trajectory.v1` lines (H9, plan section 2.5).
 *
 * Input is JSONL, either ledger chain entries (record in `body`) or bare
 * lines. A tool entry is a body with a `tool` name and a terminal `decision`
 * (`execute:*` other than `execute:dispatched`, or `deny*`); `harness.*`
 * entries are the harness's own bookkeeping and are skipped. The tool entries
 * since the previous reward record belong to the case that record names.
 * shortcut: segmentation is by position, so interleaved cases in one chain are
 * misattributed. A reward ingested from a bare eval file carries no tool
 * attribution evidence, so it exports with empty toolCalls rather than
 * adopting whatever positional tool entries happen to precede it.
 *
 * Each record is built field by field from an allowlist: the tool name, its
 * reversibility class (`klass`) and whether it completed. Arguments, results,
 * digests, prompts and any other body field are never read into the output. A
 * name or class that is not an identifier (spaces, newlines, over 128
 * characters) is refused rather than copied, so a prompt smuggled into a name
 * cannot reach the file. `ok` is `true` for `execute:completed`, `"unmeasured"`
 * for `execute:unknown` (the tool ran, its outcome is not known) and `false`
 * otherwise. A missing class is `"unmeasured"`.
 *
 * The reward must recompute through `computeReward` from
 * `packages/workbench/src/harness-scores.ts`; a tampered or invalid record is
 * refused and its pending tool calls are dropped with it. This is an export
 * for later offline analysis; it trains nothing.
 *
 *   node scripts/src/trajectory-export.mjs <chain.jsonl> [--out <path>]
 *
 * Without `--out` the records go to stdout. The summary goes to stderr and
 * prints counts only.
 *
 * Exit codes: 0 = at least one trajectory and nothing refused; 1 = a refused
 * record or tool entry, an unreadable line, or no trajectory; 2 = usage or
 * file error.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { REWARD_SCHEMA, computeReward } from "../../packages/workbench/src/harness-scores.ts";

export const TRAJECTORY_SCHEMA = "nomo.trajectory.v1";

const usage = "usage: node scripts/src/trajectory-export.mjs <chain.jsonl> [--out <path>]";
const IDENTIFIER = /^[A-Za-z0-9_.:\/-]{1,128}$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value) => typeof value === "string" && IDENTIFIER.test(value);

function outcome(decision) {
  if (decision === "execute:completed") return true;
  if (decision === "execute:unknown") return "unmeasured";
  return false;
}

const terminal = (decision) =>
  typeof decision === "string" &&
  ((decision.startsWith("execute:") && decision !== "execute:dispatched") || decision.startsWith("deny"));

/** Exports every trajectory in JSONL text. Pure; never throws on content. */
export function exportTrajectories(raw) {
  const trajectories = [];
  const counts = { refused: 0, unreadable: 0, skipped: 0, unattributed: 0 };
  let pending = [];
  let pendingRefused = false;
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      counts.unreadable += 1;
      continue;
    }
    const record = isObject(value) && isObject(value.body) ? value.body : value;
    if (!isObject(record)) {
      counts.skipped += 1;
      continue;
    }
    if (record.schema === REWARD_SCHEMA) {
      let recomputed;
      try {
        recomputed = computeReward(record);
      } catch {
        recomputed = Symbol("invalid");
      }
      if (
        pendingRefused ||
        recomputed !== record.reward ||
        !identifier(record.caseId) ||
        typeof record.variantId !== "string" ||
        !identifier(record.variantId) ||
        typeof record.passed !== "boolean"
      ) {
        counts.refused += 1;
      } else {
        const ingestedBareEval = isObject(record.rewardIngestion);
        if (ingestedBareEval) counts.unattributed += pending.length;
        trajectories.push({
          schema: TRAJECTORY_SCHEMA,
          caseId: record.caseId,
          variantId: record.variantId,
          toolCalls: ingestedBareEval ? [] : pending,
          verifier: { passed: record.passed, source: "harness-eval" },
          reward: record.reward,
        });
      }
      pending = [];
      pendingRefused = false;
      continue;
    }
    if (typeof record.tool !== "string" || record.tool.startsWith("harness.") || !terminal(record.decision)) {
      counts.skipped += 1;
      continue;
    }
    if (!identifier(record.tool) || (record.klass !== undefined && !identifier(record.klass))) {
      counts.refused += 1;
      pendingRefused = true;
      continue;
    }
    pending.push({
      name: record.tool,
      klass: record.klass === undefined ? "unmeasured" : record.klass,
      ok: outcome(record.decision),
    });
  }
  counts.unattributed += pending.length;
  return { trajectories, ...counts };
}

export function main(argv) {
  let input = "";
  let out = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out" && argv[index + 1] && !out) {
      out = argv[++index];
      continue;
    }
    if (input || arg.startsWith("-")) {
      console.error(usage);
      return 2;
    }
    input = arg;
  }
  if (!input) {
    console.error(usage);
    return 2;
  }
  let raw;
  try {
    raw = readFileSync(input, "utf8");
  } catch {
    console.error(`trajectory-export: chain could not be read: ${input}`);
    return 2;
  }
  const report = exportTrajectories(raw);
  const jsonl = report.trajectories.map((record) => JSON.stringify(record) + "\n").join("");
  if (out) {
    try {
      writeFileSync(out, jsonl);
    } catch {
      console.error(`trajectory-export: output could not be written: ${out}`);
      return 2;
    }
  } else {
    process.stdout.write(jsonl);
  }
  console.error(
    `trajectory-export: ${report.trajectories.length} trajectories, ${report.refused} refused, ` +
      `${report.unreadable} unreadable, ${report.unattributed} unattributed tool calls, ` +
      `${report.skipped} other entries skipped`,
  );
  return report.trajectories.length > 0 && report.refused === 0 && report.unreadable === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
