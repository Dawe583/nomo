/**
 * The two Linux and Windows Node jobs budget every step out of a measured
 * runtime, and each job budget covers the steps it contains.
 *
 * A job-level `timeout-minutes` on its own is a shared deadline: whichever step
 * happens to be slow is killed and reported as a failure that never was, while
 * the fast steps get time they never spend. That is not hypothetical here. The
 * `git.managed` conformance gate costs minutes rather than seconds, and the step
 * that runs it shared a 10 minute job deadline with steps that finish in one, so
 * a loaded runner could kill the only slow gate and report the result as a
 * failure. A per-step budget makes the slow step name itself.
 *
 * `pages.yml` and the Windows and cloud-integration jobs are outside this
 * check. They deploy a static artifact, build and install a signed Windows
 * installer, and drive a Go wire-protocol proxy against a live Postgres service;
 * none of those runtimes can be measured on this host without a Windows runner
 * and a disposable database, and a budget invented rather than measured is the
 * thing this test exists to prevent. Their job-level deadlines are still
 * required below.
 *
 * The check is deliberately structural rather than a YAML round trip: this
 * workspace has no YAML dependency, and a line scan is enough to see whether a
 * step and its job declare a budget.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const everyWorkflow = [
  ".github/workflows/ci.yml",
  ".github/workflows/manifest.yml",
  ".github/workflows/cloud-integration.yml",
  ".github/workflows/pages.yml",
  ".github/workflows/desktop-windows.yml",
];

/** Jobs whose step runtimes are measured, so every step of theirs is budgeted. */
const perStepBudgeted = [".github/workflows/ci.yml", ".github/workflows/manifest.yml"];

/**
 * The jobs of one workflow and what each of their steps budgets. Jobs sit at
 * two spaces, their keys at four, step entries at six and step keys at eight,
 * and the scan starts at `jobs:` so trigger keys are not read as job names.
 */
function jobs(source) {
  const found = [];
  let current = null;
  let insideJobs = false;
  source.split("\n").forEach((line, index) => {
    const number = index + 1;
    if (/^jobs:\s*$/.test(line)) {
      insideJobs = true;
      return;
    }
    if (insideJobs && /^\S/.test(line)) {
      insideJobs = false;
    }
    if (!insideJobs) return;
    if (/^ {2}[A-Za-z_][\w-]*:\s*$/.test(line)) {
      current = { name: line.trim().slice(0, -1), line: number, timeout: 0, steps: [] };
      found.push(current);
      return;
    }
    if (current === null) return;
    const jobKey = /^ {4}timeout-minutes:\s*(\d+)/.exec(line);
    if (jobKey !== null) {
      current.timeout = Number.parseInt(jobKey[1], 10);
      return;
    }
    if (/^ {6}-\s+(?:run|uses|name):/.test(line)) {
      current.steps.push({ line: number, runsCommand: /-\s+run:/.test(line), timeout: 0 });
      return;
    }
    const stepKey = /^ {8}timeout-minutes:\s*(\d+)/.exec(line);
    if (stepKey !== null && current.steps.length > 0) {
      current.steps[current.steps.length - 1].timeout = Number.parseInt(stepKey[1], 10);
    }
  });
  return found;
}

for (const workflow of everyWorkflow) {
  const budgetEveryStep = perStepBudgeted.includes(workflow);
  test(`${workflow} budgets its job, and ${budgetEveryStep ? "each step" : "no step runtime is claimed unmeasured"}`, () => {
    const entries = jobs(readFileSync(workflow, "utf8"));
    assert.ok(entries.length > 0, `${workflow} declares no jobs`);
    for (const entry of entries) {
      assert.ok(entry.timeout > 0, `${workflow}: job ${entry.name} has no timeout-minutes`);
      if (!budgetEveryStep) continue;
      const unbudgeted = entry.steps.filter((step) => step.runsCommand && step.timeout === 0);
      assert.deepEqual(
        unbudgeted.map((step) => step.line),
        [],
        `${workflow}: job ${entry.name} runs commands with no budget of their own`,
      );
      const total = entry.steps.reduce((sum, step) => sum + step.timeout, 0);
      assert.ok(
        entry.timeout >= total,
        `${workflow}: job ${entry.name} allows ${entry.timeout} minutes for steps totalling ${total}`,
      );
    }
  });
}
