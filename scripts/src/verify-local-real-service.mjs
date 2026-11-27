#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const STEPS = [
  {
    name: "cloud integration on disposable PostgreSQL",
    command: process.execPath,
    args: ["scripts/src/disposable-postgres.mjs", "--", process.execPath, "scripts/src/check-cloud-integration.mjs"],
  },
  {
    name: "legacy PostgreSQL replay on disposable PostgreSQL",
    command: process.execPath,
    args: ["scripts/src/disposable-postgres.mjs", "--", process.execPath, "scripts/src/verify-postgres-replay-wire.mjs"],
  },
  {
    name: "S3 loopback wire replay",
    command: process.execPath,
    args: ["scripts/src/verify-s3-wire.mjs"],
  },
];

/** Sequential on purpose: the disposable PostgreSQL harness owns fixed loopback ports. */
export function runLocalRealServiceVerification({ cwd = process.cwd(), spawn = spawnSync } = {}) {
  const results = [];
  for (const step of STEPS) {
    const started = Date.now();
    const result = spawn(step.command, step.args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env },
    });
    const status = result.status ?? 1;
    results.push({
      name: step.name,
      status,
      durationMs: Date.now() - started,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      spawnError: result.error instanceof Error ? result.error.message : undefined,
    });
    if (status !== 0) break;
  }
  return { passed: results.length === STEPS.length && results.every((result) => result.status === 0), results };
}

function printSummary(summary) {
  for (const result of summary.results) {
    const line = `${result.status === 0 ? "PASS" : "FAIL"} ${result.name} (${result.durationMs} ms)`;
    if (result.status === 0) console.log(line);
    else {
      console.error(line);
      if (result.spawnError) console.error(`spawn error: ${result.spawnError}`);
      console.error(tail("stdout", result.stdout));
      console.error(tail("stderr", result.stderr));
    }
  }
  console.log(`${summary.passed ? "PASS" : "FAIL"} local real-service verification: ${summary.results.length}/${STEPS.length} steps completed`);
}

function tail(label, text) {
  const lines = text.trim().split("\n").filter(Boolean);
  return `--- ${label} tail ---\n${lines.slice(-30).join("\n")}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = runLocalRealServiceVerification();
  printSummary(summary);
  process.exitCode = summary.passed ? 0 : 1;
}
