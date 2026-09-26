/**
 * Runs every package test suite and refuses to report green on a suite that ran
 * nothing.
 *
 * `node --test` exits 0 when it finds no test files, so `pnpm -r run test` would
 * pass for a package whose tests were deleted, renamed out of the glob, or never
 * written. The first exit criterion of every work package is "the tests pass",
 * and that criterion is only honest if a suite of zero is a failure.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..", "..");
const packagesDir = join(root, "packages");

if (!existsSync(packagesDir)) {
  console.error("no packages/ directory, nothing to check");
  process.exit(1);
}

const results = [];

const suites = [
  ...readdirSync(packagesDir)
    .sort()
    .map((name) => ({ name, dir: join(packagesDir, name) })),
  { name: "control-plane", dir: join(root, "apps", "control-plane") },
  { name: "scripts", dir: join(root, "scripts") },
];

for (const { name, dir } of suites) {
  const manifestPath = join(dir, "package.json");
  const required = name === "control-plane" || name === "scripts";
  if (!existsSync(manifestPath)) {
    if (required) throw new Error(`${name} suite manifest is missing`);
    continue;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest.scripts?.test && name !== "scripts") {
    if (required) throw new Error(`${name} suite test script is missing`);
    continue;
  }

  // TAP, not the runtime's default reporter: the default switched from
  // machine readable lines to a human spec format in Node 23, which broke the
  // counts this script parses. Asking for TAP keeps the output a contract on
  // every engine version the workspace may run on.
  // Script fixtures resolve repository-relative paths, so run them from root.
  const files =
    name === "scripts"
      ? readdirSync(join(dir, "src"))
          .filter((file) => file.endsWith(".test.mjs"))
          .sort()
          .map((file) => join(dir, "src", file))
      : [];
  if (name === "scripts" && files.length === 0)
    throw new Error("scripts suite has no tests");
  const run = spawnSync("node", ["--test", "--test-reporter=tap", ...files], {
    cwd: name === "scripts" ? root : dir,
    encoding: "utf8",
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const read = (key) =>
    Number.parseInt(
      output.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1] ?? "-1",
      10,
    );

  results.push({
    name,
    pass: read("pass"),
    fail: read("fail"),
    code: run.status ?? 1,
    output,
  });
}

let failed = false;
const width = Math.max(...results.map((r) => r.name.length), 7);

for (const r of results) {
  const reasons = [];
  if (r.code !== 0) reasons.push(`exit ${r.code}`);
  if (r.fail > 0) reasons.push(`${r.fail} failing`);
  if (r.pass <= 0) reasons.push("ran no tests");

  console.log(
    `  ${r.name.padEnd(width)}  ${String(r.pass).padStart(3)} pass  ${String(r.fail).padStart(3)} fail  ${reasons.length ? "FAIL: " + reasons.join(", ") : "ok"}`,
  );
  if (reasons.length) {
    failed = true;
    console.log(
      r.output
        .split("\n")
        .filter((l) => l.startsWith("not ok") || l.includes("Error"))
        .slice(0, 8)
        .map((l) => `      ${l}`)
        .join("\n"),
    );
  }
}

const total = results.reduce((sum, r) => sum + Math.max(r.pass, 0), 0);
console.log(`\n  ${results.length} suites, ${total} tests`);

if (results.length === 0) {
  console.error("  no package declared a test script");
  process.exit(1);
}

// A named manifest, because deleting a guard is not a defect that guard can
// observe. Nothing inside a test file can stop that file being deleted, and a
// bare count floor is too coarse: this suite runs many files, so removing one
// leaves the total comfortably above any threshold worth setting. Naming the
// files catches the realistic accident, which is someone tidying up a gate they
// think is redundant.
//
// The limit is stated rather than papered over: deleting this manifest line, or
// one test() block inside a guarded file, is not observable from inside this
// repository at all. That class of change is review, and a test that claimed to
// catch it would be a false guarantee.
const REQUIRED_SCRIPT_TESTS = [
  "doc-truth.test.mjs",
  "design-token.test.mjs",
  "handbook.test.mjs",
  "licence-line.test.mjs",
];
const present = new Set(
  readdirSync(join(root, "scripts", "src"))
    .filter((file) => file.endsWith(".test.mjs"))
    .map((file) => file),
);
const absent = REQUIRED_SCRIPT_TESTS.filter((file) => !present.has(file));
if (absent.length > 0) {
  console.error(
    `  scripts suite is missing required test files: ${absent.join(", ")}`,
  );
  process.exit(1);
}

process.exit(failed ? 1 : 0);
