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
 * misattributed. A reward ingested from a bare eval file carries no positional
 * tool attribution evidence, so it exports empty toolCalls unless explicit
 * `nomo.eval-tool.v1` measurements for the same case and ingestion file are
 * present. Production chain attribution matches the exact case, variant and
 * run when the reward carries `harnessEval`. A reward without that metadata can
 * adopt only one unambiguous pending run for the case and variant; repeated
 * runs are refused rather than merged. Explicit eval-tool measurements use the
 * same unambiguous-run rule inside their case, variant and ingestion file
 * family; bare files without provenance have only that case/variant family, a
 * documented limit.
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
import {
  EVAL_TOOL_SCHEMA,
  evalCaseAttribution,
  evalToolRecord,
} from "../../packages/workbench/src/harness-eval-tools.ts";

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

function attributionFamily(record, caseId, variantId) {
  const ingestion = isObject(record.rewardIngestion) ? record.rewardIngestion : null;
  const prefix = typeof ingestion?.fileDigest === "string" && /^[a-f0-9]{64}$/.test(ingestion.fileDigest)
    ? `file:${ingestion.fileDigest}`
    : "case";
  return `${prefix}\u0000${caseId}\u0000${variantId}`;
}

function exportedEvalTool(record) {
  const extracted = {
    schema: record.schema,
    caseId: record.caseId,
    variantId: record.variantId,
    run: record.run,
    toolName: record.toolName,
    toolClass: record.toolClass,
    ok: record.ok,
    execution: record.execution,
  };
  return evalToolRecord(extracted);
}

/** Exports every trajectory in JSONL text. Pure; never throws on content. */
export function exportTrajectories(raw) {
  const trajectories = [];
  const counts = { refused: 0, unreadable: 0, skipped: 0, unattributed: 0 };
  let positionalPending = [];
  let pendingRefused = false;
  const evalPending = new Map();
  const evalRuns = new Map();
  const attributed = new Map();
  const attributedRuns = new Map();
  const addAttributed = (key, family, call) => {
    const list = attributed.get(key) ?? [];
    list.push(call);
    attributed.set(key, list);
    const runs = attributedRuns.get(family) ?? new Set();
    runs.add(key);
    attributedRuns.set(family, runs);
  };
  const takeAttributed = (key, family) => {
    const list = attributed.get(key);
    if (list === undefined) return undefined;
    attributed.delete(key);
    const runs = attributedRuns.get(family);
    runs?.delete(key);
    if (runs?.size === 0) attributedRuns.delete(family);
    return list;
  };
  const evalPairKey = (caseId, variantId) => `${caseId}\u0000${variantId}`;
  const evalRunKey = (caseId, variantId, run) => `${evalPairKey(caseId, variantId)}\u0000${run}`;
  const addEvalPending = (key, pairKey, call) => {
    const list = evalPending.get(key) ?? [];
    list.push(call);
    evalPending.set(key, list);
    const runs = evalRuns.get(pairKey) ?? new Set();
    runs.add(key);
    evalRuns.set(pairKey, runs);
  };
  const takeEvalPending = (key, pairKey) => {
    const list = evalPending.get(key);
    if (list === undefined) return undefined;
    evalPending.delete(key);
    const runs = evalRuns.get(pairKey);
    runs?.delete(key);
    if (runs?.size === 0) evalRuns.delete(pairKey);
    return list;
  };
  const readEvalAttribution = (value) => {
    if (value === undefined) return { key: null };
    try {
      const parsed = evalCaseAttribution(value);
      return {
        key: evalRunKey(parsed.caseId, parsed.variantId, parsed.run),
        pairKey: evalPairKey(parsed.caseId, parsed.variantId),
      };
    } catch {
      return { malformed: true };
    }
  };
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
    if (record.schema === EVAL_TOOL_SCHEMA) {
      try {
        const measurement = exportedEvalTool(record);
        const family = attributionFamily(record, measurement.caseId, measurement.variantId);
        const key = `${family}\u0000${measurement.run}`;
        addAttributed(key, family, { name: measurement.toolName, klass: measurement.toolClass, ok: measurement.ok });
      } catch {
        counts.refused += 1;
      }
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
        const family = attributionFamily(record, record.caseId, record.variantId);
        const explicitCandidates = attributedRuns.get(family);
        let explicit;
        let explicitAmbiguous = false;
        if (explicitCandidates?.size === 1)
          explicit = takeAttributed([...explicitCandidates][0], family);
        else if (explicitCandidates && explicitCandidates.size > 1)
          explicitAmbiguous = true;
        const rewardEval = readEvalAttribution(record.harnessEval);
        let direct;
        let attributionRefused = rewardEval.malformed === true || explicitAmbiguous;
        if (
          !attributionRefused &&
          rewardEval.key &&
          rewardEval.pairKey !== evalPairKey(record.caseId, record.variantId)
        )
          attributionRefused = true;
        if (!attributionRefused && explicit === undefined && !ingestedBareEval) {
          if (rewardEval.key) {
            direct = takeEvalPending(rewardEval.key, rewardEval.pairKey);
          } else {
            const candidates = evalRuns.get(evalPairKey(record.caseId, record.variantId));
            if (candidates?.size === 1)
              direct = takeEvalPending([...candidates][0], evalPairKey(record.caseId, record.variantId));
            else if (candidates && candidates.size > 1) attributionRefused = true;
          }
        }
        if (explicit !== undefined || ingestedBareEval || rewardEval.key) counts.unattributed += positionalPending.length;
        if (attributionRefused) {
          counts.refused += 1;
        } else {
          trajectories.push({
            schema: TRAJECTORY_SCHEMA,
            caseId: record.caseId,
            variantId: record.variantId,
            toolCalls:
              explicit !== undefined
                ? explicit
                : ingestedBareEval
                  ? []
                  : rewardEval.key
                    ? (direct ?? [])
                    : direct !== undefined
                      ? direct
                      : positionalPending,
            verifier: { passed: record.passed, source: "harness-eval" },
            reward: record.reward,
          });
        }
      }
      positionalPending = [];
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
    const evalContext = readEvalAttribution(record.harnessEval);
    if (evalContext.malformed) {
      counts.refused += 1;
      pendingRefused = true;
      continue;
    }
    const call = {
      name: record.tool,
      klass: record.klass === undefined ? "unmeasured" : record.klass,
      ok: outcome(record.decision),
    };
    if (evalContext.key === null) {
      positionalPending.push(call);
      continue;
    }
    addEvalPending(evalContext.key, evalContext.pairKey, call);
  }
  counts.unattributed += positionalPending.length;
  for (const calls of evalPending.values()) counts.unattributed += calls.length;
  for (const calls of attributed.values()) counts.unattributed += calls.length;
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
