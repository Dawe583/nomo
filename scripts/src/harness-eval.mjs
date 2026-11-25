#!/usr/bin/env node
/**
 * Frozen local evaluation set for the harness.
 *
 * The learning loop needs a number that means the same thing twice. A hosted
 * benchmark is not available to this repository and a model grading another
 * model is not a measurement, so this script does the only thing that can be
 * reproduced: it feeds a frozen taskset to a runner you supply, parses the
 * decision the runner printed, and compares it to the frozen expectation.
 *
 * Taskset JSON (the file is the fixture; freeze it and change it deliberately):
 *
 *   {
 *     "id": "harness-core-v1",           // optional, printed in the header
 *     "tasks": [
 *       {
 *         "id": "read-before-edit",      // required, unique, never a prompt
 *         "prompt": "…",                 // required, sent to the runner on stdin
 *         "expectedTool": "read",        // required, exact string match
 *         "expectedClass": "inspect"     // required, exact string match
 *       }
 *     ]
 *   }
 *
 * Runner contract: the runner is a command you name after `--`. It receives one
 * prompt on stdin and must print its decision as a single line of JSON:
 *
 *   {"tool":"read","class":"inspect"}
 *
 * Anything else the runner writes is discarded unread: the decision line is the
 * only thing this script parses and the only thing it prints. Raw stdout is
 * never echoed, so a runner that dumps a prompt or a transcript cannot leak it
 * through this report.
 *
 * Paired runs: each task runs `--runs` times (default 2). A task passes only
 * when every run's decision matches, so a runner that agrees with itself once
 * and disagrees once cannot buy a pass. Scoring is string equality on
 * `expectedTool` and `expectedClass`. The scorer uses no model or network.
 *
 * Offline by construction: with no runner the script prints SKIP and exits 0,
 * so a gate can call it without inventing a green.
 *
 *   node scripts/src/harness-eval.mjs <taskset.json> [--runs <n>]
 *     [--timeout <ms>] -- <runner argv...>
 *
 * Reward records: with `--records <path> --weights breach=<n>,cost=<n>,latency=<n>`
 * the script also writes one `nomo.reward.v1` JSON line per task (see
 * `packages/workbench/src/harness-scores.ts`). Latency is the mean wall-clock
 * time of the runner process across the paired runs, spawn included. Cost,
 * approval time and guardrails have no producer here, so they are written as
 * "unmeasured" (guardrails as `{}`), and any weighted term among them makes the
 * reward "unmeasured". The weights are required: there is no built-in default.
 * Records carry ids and numbers only, never a prompt or runner output.
 *
 * Variant identity: records also need `--variant <variant.json>`, a file of
 * `{"model": "...", "promptPreamble": "...", "settings": {...}}` describing the
 * harness the runner was configured with. Its sha256 identity (see
 * `variantIdentity` in `packages/workbench/src/harness-settings.ts`) is written
 * as `variantId`. With `--baseline <variant.json>` the record also names the
 * baseline and the one axis that separates them; a baseline that differs in
 * more than one axis is refused before anything runs. The script cannot prove
 * the runner honoured the variant: the file is the operator's declaration.
 *
 * Exit codes: 0 = every task passed, or skipped; 1 = a task failed, produced no
 * decision, or the runner did not start; 2 = usage or taskset error.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import {
  parseRewardWeights,
  rewardRecord,
} from "../../packages/workbench/src/harness-scores.ts";
import {
  compareVariants,
  variantIdentity,
} from "../../packages/workbench/src/harness-settings.ts";

const usage =
  "usage: node scripts/src/harness-eval.mjs <taskset.json> [--runs <n>] " +
  "[--timeout <ms>] [--records <path> --weights breach=<n>,cost=<n>,latency=<n> " +
  "--variant <variant.json> [--baseline <variant.json>]] " +
  "-- <runner argv...>";

const DEFAULT_RUNS = 2;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RUNS = 20;

/** A non-empty trimmed string, or "" so callers can test truthiness once. */
function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * Validates a taskset document. Errors name the field and the index only: a
 * prompt is fixture content and never belongs in a report.
 */
export function parseTaskset(raw) {
  const errors = [];
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { id: "", tasks: [], errors: ["taskset: not valid JSON"] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      id: "",
      tasks: [],
      errors: ["taskset: must be an object with a tasks array"],
    };
  }
  const id = text(value.id);
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
    return { id, tasks: [], errors: ["tasks: must be a non-empty array"] };
  }
  const tasks = [];
  const seen = new Set();
  value.tasks.forEach((task, index) => {
    const where = `tasks[${index}]`;
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      errors.push(`${where}: must be an object`);
      return;
    }
    const taskId = text(task.id);
    const prompt = text(task.prompt);
    const expectedTool = text(task.expectedTool);
    const expectedClass = text(task.expectedClass);
    if (!taskId) errors.push(`${where}.id: required`);
    else if (seen.has(taskId)) errors.push(`${where}.id: duplicate "${taskId}"`);
    else seen.add(taskId);
    if (!prompt) errors.push(`${where}.prompt: required`);
    if (!expectedTool) errors.push(`${where}.expectedTool: required`);
    if (!expectedClass) errors.push(`${where}.expectedClass: required`);
    if (!taskId || !prompt || !expectedTool || !expectedClass) return;
    tasks.push({ id: taskId, prompt, expectedTool, expectedClass });
  });
  return { id, tasks, errors };
}

/**
 * Extracts the decision from runner stdout.
 *
 * The last line that parses as an object carrying both a tool and a class wins,
 * so a runner may log freely before its answer. A multi-line object is not
 * accepted: the contract is one line, and guessing at brace spans would make
 * the parse depend on whatever else the runner printed.
 */
export function parseDecision(stdout) {
  if (typeof stdout !== "string") return null;
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const tool = text(value.tool);
    const decisionClass = text(value.class);
    if (tool && decisionClass) return { tool, class: decisionClass };
  }
  return null;
}

/**
 * Scores one task across its paired runs.
 *
 * `attempts` entries are `{ decision, code }` from one runner invocation, or
 * `{ error: true }` when the process never started. The first run that is not
 * a clean match decides the row, so the report names the run that broke the
 * pair rather than a summary of the pair.
 */
export function scoreTask(task, attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return { id: task.id, status: "no-decision", run: 0, detail: "no run" };
  }
  for (const [index, attempt] of attempts.entries()) {
    const run = index + 1;
    if (attempt?.error) {
      return {
        id: task.id,
        status: "runner-error",
        run,
        detail: "runner could not start",
      };
    }
    const decision = attempt?.decision ?? null;
    if (!decision) {
      const code = attempt?.code === null || attempt?.code === undefined
        ? "unknown"
        : String(attempt.code);
      return {
        id: task.id,
        status: "no-decision",
        run,
        detail: `no decision line on stdout (exit ${code})`,
      };
    }
    if (attempt.code !== 0)
      return { id: task.id, status: "runner-error", run, detail: "runner did not exit successfully" };
    if (
      decision.tool !== task.expectedTool ||
      decision.class !== task.expectedClass
    ) {
      return {
        id: task.id,
        status: "fail",
        run,
        decision,
        detail:
          `expected tool=${task.expectedTool} class=${task.expectedClass}, ` +
          `got tool=${decision.tool} class=${decision.class}`,
      };
    }
  }
  const last = attempts[attempts.length - 1].decision;
  return { id: task.id, status: "pass", run: attempts.length, decision: last };
}

/** Runs one task once. Never throws, never returns stdout. */
export function runAttempt(task, runner, timeoutMs) {
  const [command, ...args] = runner;
  const started = performance.now();
  const result = spawnSync(command, args, {
    input: task.prompt,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    killSignal: "SIGKILL",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) {
    // The message can name a path or echo an argument, so only the fact is
    // reported. ENOENT is the common case and it is still just "did not start".
    return { error: true };
  }
  return {
    decision: parseDecision(result.stdout),
    code: result.status,
    elapsedMs: performance.now() - started,
  };
}

/** Parses `breach=<n>,cost=<n>,latency=<n>` into validated reward weights. */
export function parseWeightsArg(raw) {
  const weights = {};
  for (const part of String(raw ?? "").split(",")) {
    const match = /^([a-z]+)=(\d+(?:\.\d+)?)$/.exec(part.trim());
    if (!match) throw new TypeError(`weights: unusable entry "${part}"`);
    weights[match[1]] = Number(match[2]);
  }
  return parseRewardWeights(weights);
}

/** Reads a variant file into its identity. Errors name the file, not content. */
export function loadVariant(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new TypeError(`variant could not be read as JSON: ${path}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`variant must be an object: ${path}`);
  return variantIdentity({
    settings: value.settings ?? {},
    promptPreamble: value.promptPreamble,
    model: value.model,
  });
}

/** The variant fields every record carries, or a refusal when the baseline
 * differs in more than one axis. */
export function resolveVariant(variantPath, baselinePath) {
  const identity = loadVariant(variantPath);
  if (!baselinePath)
    return { variantId: identity.variantId, baselineVariantId: null, changedAxis: null };
  const baseline = loadVariant(baselinePath);
  const comparison = compareVariants(baseline, identity);
  if (!comparison.comparable) throw new TypeError(`baseline refused: ${comparison.reason}`);
  return {
    variantId: identity.variantId,
    baselineVariantId: baseline.variantId,
    changedAxis: comparison.changedAxis,
  };
}

/**
 * One reward record for one task, built from its paired attempts. A runner
 * that did not start has no latency, so the case latency is then unmeasured.
 */
export function caseRewardRecord(task, attempts, result, weights, variant) {
  const timed = attempts.every((attempt) => typeof attempt?.elapsedMs === "number");
  const latencyMs =
    timed && attempts.length > 0
      ? Math.round(
          attempts.reduce((sum, attempt) => sum + attempt.elapsedMs, 0) / attempts.length,
        )
      : "unmeasured";
  return rewardRecord({
    caseId: task.id,
    variantId: variant.variantId,
    baselineVariantId: variant.baselineVariantId,
    changedAxis: variant.changedAxis,
    passed: result.status === "pass",
    guardrails: {},
    costUsd: "unmeasured",
    latencyMs,
    approvalMs: "unmeasured",
    weights,
  });
}

function row(result, width) {
  const id = result.id.padEnd(width);
  if (result.status === "pass") {
    return `PASS  ${id}  tool=${result.decision.tool} class=${result.decision.class}`;
  }
  return `FAIL  ${id}  run ${result.run}: ${result.detail}`;
}

function parseArgs(argv) {
  const options = {
    tasksetPath: "",
    runs: DEFAULT_RUNS,
    timeout: DEFAULT_TIMEOUT_MS,
    runner: [],
    records: "",
    weights: "",
    variant: "",
    baseline: "",
    help: false,
    unknown: [],
  };
  let passthrough = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (passthrough) {
      options.runner.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--runs" || arg === "--timeout") {
      const raw = argv[index + 1];
      index += 1;
      if (!/^\d+$/.test(raw ?? "")) {
        options.unknown.push(`${arg} needs a whole number, got "${raw ?? ""}"`);
        continue;
      }
      if (arg === "--runs") options.runs = Number(raw);
      else options.timeout = Number(raw);
      continue;
    }
    if (arg === "--records" || arg === "--weights" || arg === "--variant" || arg === "--baseline") {
      const raw = argv[index + 1];
      index += 1;
      if (!raw) {
        options.unknown.push(`${arg} needs a value`);
        continue;
      }
      options[arg.slice(2)] = raw;
      continue;
    }
    if (!options.tasksetPath && !arg.startsWith("-")) {
      options.tasksetPath = arg;
      continue;
    }
    options.unknown.push(arg);
  }
  return options;
}

export function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage);
    return 0;
  }
  if (options.unknown.length > 0) {
    console.error(`harness-eval: unusable argument: ${options.unknown[0]}`);
    console.error(usage);
    return 2;
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > MAX_RUNS) {
    console.error(
      `harness-eval: --runs must be a whole number from 1 to ${MAX_RUNS}.`,
    );
    return 2;
  }
  if (!Number.isInteger(options.timeout) || options.timeout < 1) {
    console.error("harness-eval: --timeout must be a positive whole number of ms.");
    return 2;
  }
  if (Boolean(options.records) !== Boolean(options.weights)) {
    console.error("harness-eval: --records and --weights are required together.");
    return 2;
  }
  if (Boolean(options.records) !== Boolean(options.variant)) {
    console.error("harness-eval: --records and --variant are required together.");
    return 2;
  }
  if (options.baseline && !options.variant) {
    console.error("harness-eval: --baseline needs --variant.");
    return 2;
  }
  let weights = null;
  let variant = null;
  if (options.weights) {
    try {
      weights = parseWeightsArg(options.weights);
      variant = resolveVariant(options.variant, options.baseline);
    } catch (error) {
      console.error(`harness-eval: ${error.message}`);
      return 2;
    }
  }
  if (options.runner.length === 0) {
    // Mirrors provider-smoke: the check is callable without the thing it
    // checks, and says so instead of reporting a pass nobody earned.
    console.log(
      "SKIP harness-eval: no runner command was given after --, so nothing was run.",
    );
    return 0;
  }
  if (!options.tasksetPath) {
    console.error("harness-eval: a taskset path is required with a runner.");
    console.error(usage);
    return 2;
  }

  let raw;
  try {
    raw = readFileSync(options.tasksetPath, "utf8");
  } catch {
    console.error(
      `harness-eval: taskset could not be read: ${options.tasksetPath}`,
    );
    return 2;
  }
  const taskset = parseTaskset(raw);
  if (taskset.errors.length > 0) {
    console.error(`harness-eval: taskset rejected: ${options.tasksetPath}`);
    for (const error of taskset.errors) console.error(`  ${error}`);
    return 2;
  }

  const runnerName = basename(options.runner[0]) || options.runner[0];
  const label = taskset.id ? ` (${taskset.id})` : "";
  console.log(
    `harness-eval: ${taskset.tasks.length} tasks from ${options.tasksetPath}${label}, ` +
      `${options.runs} run(s) each, runner=${runnerName}`,
  );

  const width = Math.max(...taskset.tasks.map((task) => task.id.length));
  const results = [];
  const records = [];
  for (const task of taskset.tasks) {
    const attempts = [];
    for (let run = 0; run < options.runs; run += 1) {
      attempts.push(runAttempt(task, options.runner, options.timeout));
    }
    const result = scoreTask(task, attempts);
    results.push(result);
    if (weights) records.push(caseRewardRecord(task, attempts, result, weights, variant));
  }
  for (const result of results) console.log(row(result, width));
  if (weights) {
    try {
      writeFileSync(
        options.records,
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
    } catch {
      console.error(`harness-eval: records could not be written: ${options.records}`);
      return 1;
    }
    console.log(`records: ${records.length} written to ${options.records}`);
    console.log(
      `variant: ${variant.variantId}` +
        (variant.baselineVariantId
          ? ` baseline=${variant.baselineVariantId} changedAxis=${variant.changedAxis ?? "none"}`
          : ""),
    );
  }

  const count = (status) =>
    results.filter((result) => result.status === status).length;
  const failed = count("fail");
  const noDecision = count("no-decision");
  const runnerError = count("runner-error");
  const passed = count("pass");
  console.log(
    `total: ${passed}/${results.length} passed, ${failed} failed, ` +
      `${noDecision} no-decision, ${runnerError} runner-error`,
  );
  return failed + noDecision + runnerError === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
