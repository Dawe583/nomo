#!/usr/bin/env node
/**
 * Reward replay: recompute every stored `nomo.reward.v1` record and report the
 * ones whose stored reward does not match (H4).
 *
 * Input is JSONL: either a ledger chain (`<workspace>.jsonl`, one entry per
 * line with the record in `body`) or the bare record lines `harness-eval.mjs
 * --records` writes. Lines that are neither a reward record nor unreadable are
 * other chain entries and are counted as skipped.
 *
 * The recomputation is `computeReward` from
 * `packages/workbench/src/harness-scores.ts`, the function that produced the
 * record, so a stored value that differs was not produced by it: an edited
 * reward, or an edited input such as `passed`, both show up. An unmeasured
 * reward must recompute to "unmeasured"; a number in its place is a mismatch.
 *
 * Replay checks rewards only. It does not verify hashes or signatures; use the
 * ledger verifier for the chain itself. The report prints ids and numbers,
 * never record bodies.
 *
 *   node scripts/src/harness-replay.mjs <chain.jsonl>
 *
 * Exit codes: 0 = at least one record and every record matches; 1 = a
 * mismatch, an invalid or unreadable line, or no reward record at all;
 * 2 = usage or file error.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { REWARD_SCHEMA, computeReward } from "../../packages/workbench/src/harness-scores.ts";

const usage = "usage: node scripts/src/harness-replay.mjs <chain.jsonl>";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Replays every reward record in JSONL text. Pure; never throws on content. */
export function replayRewards(raw) {
  const results = [];
  let skipped = 0;
  String(raw).split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      results.push({ where: `line ${index + 1}`, status: "unreadable" });
      return;
    }
    const chained = isObject(value) && isObject(value.body);
    const record = chained ? value.body : value;
    if (!isObject(record) || record.schema !== REWARD_SCHEMA) {
      skipped += 1;
      return;
    }
    const where = chained && Number.isInteger(value.seq) ? `seq ${value.seq}` : `line ${index + 1}`;
    const ids = {
      where,
      caseId: typeof record.caseId === "string" ? record.caseId : "",
      variantId: typeof record.variantId === "string" ? record.variantId : "",
    };
    let recomputed;
    try {
      recomputed = computeReward(record);
    } catch {
      results.push({ ...ids, status: "invalid" });
      return;
    }
    results.push({
      ...ids,
      status: recomputed === record.reward ? "match" : "mismatch",
      stored: record.reward,
      recomputed,
    });
  });
  const records = results.filter((result) => result.status !== "unreadable").length;
  const count = (status) => results.filter((result) => result.status === status).length;
  return {
    results,
    records,
    matched: count("match"),
    mismatched: count("mismatch"),
    invalid: count("invalid"),
    unreadable: count("unreadable"),
    skipped,
  };
}

function row(result) {
  if (result.status === "unreadable") return `UNREADABLE ${result.where}`;
  const ids = `${result.where}  case=${result.caseId} variant=${result.variantId}`;
  if (result.status === "match") return `OK       ${ids}`;
  if (result.status === "invalid") return `INVALID  ${ids}`;
  return `MISMATCH ${ids} stored=${result.stored} recomputed=${result.recomputed}`;
}

export function main(argv) {
  if (argv.length !== 1 || argv[0].startsWith("-")) {
    console.error(usage);
    return 2;
  }
  let raw;
  try {
    raw = readFileSync(argv[0], "utf8");
  } catch {
    console.error(`harness-replay: chain could not be read: ${argv[0]}`);
    return 2;
  }
  const report = replayRewards(raw);
  for (const result of report.results) console.log(row(result));
  if (report.records === 0 && report.unreadable === 0) {
    console.log(`replay: no reward records found (${report.skipped} other entries skipped)`);
    return 1;
  }
  console.log(
    `replay: ${report.records} reward records, ${report.matched} match, ` +
      `${report.mismatched} mismatch, ${report.invalid} invalid, ` +
      `${report.unreadable} unreadable, ${report.skipped} other entries skipped`,
  );
  return report.records > 0 && report.matched === report.records && report.unreadable === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
