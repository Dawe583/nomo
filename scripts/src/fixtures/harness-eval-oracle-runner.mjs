#!/usr/bin/env node
/**
 * Oracle fixture runner for harness-eval: it answers each prompt with the
 * taskset's own expectation. It proves the eval plumbing (taskset, paired runs,
 * records), not any model's ability, so its pass rate is 100% by construction
 * and must never be reported as a capability measurement. No network, no model.
 *
 *   node scripts/src/harness-eval.mjs <taskset.json> -- \
 *     node scripts/src/fixtures/harness-eval-oracle-runner.mjs <taskset.json>
 */
import { readFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8").trim();
const taskset = JSON.parse(readFileSync(process.argv[2], "utf8"));
const task = taskset.tasks.find((candidate) => candidate.prompt.trim() === prompt);
if (!task) process.exit(1);
console.log(JSON.stringify({ tool: task.expectedTool, class: task.expectedClass }));
