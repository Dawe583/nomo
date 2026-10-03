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

/**
 * A hard ceiling on any one package suite, so a suite that stops making
 * progress reports itself as a named failure instead of freezing this gate
 * with no output until something upstream kills it.
 *
 * The default is generous on purpose. `packages/cli` runs the git.managed
 * conformance matrix against real repositories on disk and costs minutes
 * rather than seconds, which `.github/workflows/ci.yml` already budgets for
 * per step, so a bound tight enough to trip on that suite would report a
 * failure that never was. The job budget for the whole `pnpm test` step is 25
 * minutes across every suite, so no single suite can legitimately approach
 * this, and anything that does is wedged rather than slow.
 *
 * `VOID_SUITE_TIMEOUT_MS` overrides it, and accepts `0` to disable the bound
 * for a deliberate long run.
 */
const DEFAULT_SUITE_TIMEOUT_MS = 15 * 60 * 1000;
const suiteTimeoutMs = (() => {
  const raw = process.env.VOID_SUITE_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_SUITE_TIMEOUT_MS;
  // Digits only. `parseInt` alone would truncate "1.5" to 1 and "12abc" to 12,
  // and a ceiling silently turned into a different number is worse than one
  // refused: it looks configured and is not what anybody asked for.
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new Error(`VOID_SUITE_TIMEOUT_MS is not a non-negative integer: ${raw}`);
  return Number(raw);
})();

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
  results.push(
    runSuite(name, name === "scripts" ? root : dir, files, "packages"),
  );
}

// The cloud suites are the second half of `pnpm test` and used to run entirely
// outside this file, as a bare `node --test cloud/*.test.mjs` with no deadline.
// That is the same silent freeze the per-package bound exists to prevent, and it
// is worse here: this branch added owner.test.mjs, account.test.mjs and
// account-routes.test.mjs, so a stall in exactly the code under review printed
// nothing at all. The suite is reported as `cloud` so a failure names the
// invocation that produced it, because "the cloud suite exceeded its budget"
// sends a reader to different files than a package exceeding its.
const cloudDir = join(root, "cloud");
if (existsSync(cloudDir)) {
  const cloudFiles = readdirSync(cloudDir)
    .filter((file) => file.endsWith(".test.mjs"))
    .sort()
    .map((file) => join(cloudDir, file));
  if (cloudFiles.length === 0) throw new Error("cloud suite has no tests");
  results.push(runSuite("cloud", root, cloudFiles, "cloud"));
}

// The paid suites are the same shape as the cloud ones: a closed top-level
// directory that is not a pnpm workspace package, so `runSuite` is called
// directly rather than through the package loop. `paid/channels/slack.test.ts`
// is collected recursively because the implementation lives one level down,
// where `cloud/` keeps its suites flat.
//
// The runner label is `paid` for the reason the cloud one is: a failure has to
// name the invocation that produced it, because "the paid suite exceeded its
// budget" sends a reader to a different directory than "packages/policy did".
const paidDir = join(root, "paid");
if (existsSync(paidDir)) {
  const paidFiles = [];
  const collect = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.name.endsWith(".test.ts")) paidFiles.push(path);
    }
  };
  collect(paidDir);
  paidFiles.sort();
  if (paidFiles.length === 0) throw new Error("paid suite has no tests");
  results.push(runSuite("paid", root, paidFiles, "paid"));
}

/**
 * The two Python suites, which until now no local gate and no CI job ran.
 *
 * They are separate from every suite above because they are a different kind
 * of evidence. The Node suites read the repository with the interpreter that
 * is already installed; these two need a decision about which Python runs
 * them, and one of them needs the `mcp` SDK, which is a build requirement of
 * the hosted function rather than a test-only dependency. So the runner
 * probes for a usable interpreter and records what it tried.
 *
 * A suite that cannot run is reported as `UNRUN`, never as a pass, and is
 * excluded from the passing total. That distinction is the whole point: a
 * number in the summary that quietly counts a suite nobody executed is worse
 * than no number, because it is read as evidence by every document that
 * quotes it.
 *
 * `UNRUN` is a named warning and does not fail the gate. The alternative,
 * failing, produces a gate that cannot pass on any machine lacking a build
 * dependency of the hosted function, and a gate that is always red is a gate
 * nobody runs. What is refused is the dishonest version: a suite that never
 * executed must never be counted as a pass, which is why it prints in its own
 * column and is subtracted from the total.
 */
const pythonSuites = [
  {
    name: "appwrite-mcp",
    dir: join(root, "apps", "appwrite-mcp"),
    startDir: "apps/appwrite-mcp/tests",
    topDir: "apps/appwrite-mcp",
    // The SDK is a build requirement of the deployed function, so an ordinary
    // checkout cannot import it and a failing gate on every such machine
    // would be a gate nobody runs.
    probe: "import mcp",
    setup: [
      "python3 -m venv /tmp/void-mcp-venv",
      "/tmp/void-mcp-venv/bin/python -m pip install -r apps/appwrite-mcp/requirements.txt",
    ],
  },
  {
    name: "void-transport",
    dir: join(root, "python", "void-transport"),
    startDir: "python/void-transport/tests",
    topDir: "python/void-transport",
    probe: null,
    setup: [],
  },
];

/**
 * The interpreters tried, in order.
 *
 * An explicit override comes first so a machine with the SDK somewhere else
 * than /tmp is not told it cannot run, and so CI can name the interpreter it
 * built. The documented virtual environment is next, then the system `python3`
 * for the suite that needs nothing. Each is reported with the reason it was
 * rejected, so a reader is never left guessing which interpreter the gate
 * meant. `VOID_MCP_PYTHON` relocates the SDK environment and `VOID_PYTHON`
 * overrides the interpreter outright; both exist so a machine that has the
 * SDK somewhere else, and a run that needs to reach the `UNRUN` branch, are
 * both expressible without editing this file.
 */
const pythonCandidates = [
  ...(process.env.VOID_PYTHON ? [process.env.VOID_PYTHON] : []),
  process.env.VOID_MCP_PYTHON ?? "/tmp/void-mcp-venv/bin/python",
  "python3",
];

function runPythonSuite(suite) {
  const started = Date.now();
  const tried = [];
  for (const python of pythonCandidates) {
    const available = spawnSync(python, ["--version"], { encoding: "utf8", timeout: 30_000 });
    if (available.error || available.status !== 0) {
      tried.push(`${python} (not a working interpreter)`);
      continue;
    }
    if (suite.probe) {
      const probe = spawnSync(python, ["-c", suite.probe], { encoding: "utf8", timeout: 60_000 });
      if (probe.status !== 0) {
        tried.push(`${python} (no ${suite.probe.replace("import ", "")})`);
        continue;
      }
    }
    const run = spawnSync(
      python,
      ["-m", "unittest", "discover", "-s", suite.startDir, "-t", suite.topDir],
      {
        cwd: root,
        encoding: "utf8",
        timeout: suiteTimeoutMs > 0 ? suiteTimeoutMs : undefined,
        killSignal: "SIGKILL",
      },
    );
    const timedOut = run.error?.code === "ETIMEDOUT";
    // unittest reports on stderr, and the count line is the only machine
    // readable result it emits.
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const pass = Number.parseInt(output.match(/^Ran (\d+) tests?/m)?.[1] ?? "-1", 10);
    const fail = output.match(/^(FAILED|OK)/m)?.[1] === "FAILED" ? 1 : 0;
    return {
      name: suite.name,
      runner: "python",
      pass,
      fail: run.status === 0 ? 0 : fail || 1,
      code: run.status ?? 1,
      timedOut,
      elapsed: Date.now() - started,
      output,
      interpreter: python,
    };
  }
  return { ...unrunResult(suite.name), tried };
}

function unrunResult(name) {
  return {
    name,
    runner: "python",
    pass: 0,
    fail: 0,
    code: 0,
    timedOut: false,
    elapsed: 0,
    output: "",
    unrun: true,
  };
}

for (const suite of pythonSuites) {
  if (!existsSync(join(suite.dir, "tests"))) continue;
  results.push(runPythonSuite(suite));
}

/**
 * Runs one suite under the ceiling and returns its result.
 *
 * The runner label travels with the result. `packages` and `cloud` are two
 * separate `node --test` invocations over disjoint files, and a report that
 * cannot tell them apart sends the reader to the wrong directory to look for
 * the reason.
 */
function runSuite(name, dir, files, runner) {
  const started = Date.now();
  // `killSignal: SIGKILL` rather than the default SIGTERM: a suite wedged in
  // native code or holding a child that ignores SIGTERM would otherwise keep
  // the event loop alive past the timeout and defeat the bound entirely.
  const run = spawnSync("node", ["--test", "--test-reporter=tap", ...files], {
    cwd: dir,
    encoding: "utf8",
    timeout: suiteTimeoutMs > 0 ? suiteTimeoutMs : undefined,
    killSignal: "SIGKILL",
  });
  // `spawnSync` reports its own deadline as a null status with an ETIMEDOUT
  // error, and the status is mapped to 1 further down, so without this the
  // timeout would print as an ordinary crash and name neither the cause nor
  // the ceiling that fired.
  const timedOut = run.error?.code === "ETIMEDOUT";
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}${
    timedOut
      ? `\n# suite exceeded its ${Math.round(suiteTimeoutMs / 1000)}s budget and was killed\n`
      : ""
  }`;

  const read = (key) =>
    Number.parseInt(
      output.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1] ?? "-1",
      10,
    );

  return {
    name,
    runner,
    pass: read("pass"),
    fail: read("fail"),
    code: run.status ?? 1,
    timedOut,
    elapsed: Date.now() - started,
    output,
  };
}

let failed = false;
const width = Math.max(...results.map((r) => `${r.runner}/${r.name}`.length), 7);

for (const r of results) {
  const reasons = [];
  if (r.code !== 0) reasons.push(`exit ${r.code}`);
  // A suite that ran out of time is a distinct failure from one that failed an
  // assertion: the first is this gate's bound firing, and printing it as a bare
  // non-zero exit would point the reader at a test that may well be green. It
  // leads the reasons, because it is the fact that explains the rest. The runner
  // is in the reason too, because `cloud` and `packages` are separate
  // invocations and only one of them contains the code under review.
  if (r.timedOut)
    reasons.unshift(
      `${r.runner} suite exceeded its budget, no completion in ${Math.round(r.elapsed / 1000)}s`,
    );
  if (r.fail > 0) reasons.push(`${r.fail} failing`);
  if (r.pass <= 0) reasons.push("ran no tests");

  // A suite with no usable interpreter is reported in its own column and
  // names the commands that run it, so nobody reads an absent suite as a
  // passing one. It is deliberately not `ok`: an unrun suite is not evidence.
  if (r.unrun) {
    const suite = pythonSuites.find((s) => s.name === r.name);
    console.log(
      `  ${`${r.runner}/${r.name}`.padEnd(width)}  --- pass    0 fail  UNRUN: no interpreter could import the SDK it needs`,
    );
    console.log(
      `      tried: ${(r.tried ?? []).join(", ")}`,
    );
    for (const step of suite?.setup ?? [])
      console.log(`      then run: ${step}`);
    console.log(
      `      ${process.env.VOID_MCP_PYTHON ?? "/tmp/void-mcp-venv/bin/python"} -m unittest discover -s ${suite?.startDir} -t ${suite?.topDir}`,
    );
    continue;
  }

  console.log(
    `  ${`${r.runner}/${r.name}`.padEnd(width)}  ${String(r.pass).padStart(3)} pass  ${String(r.fail).padStart(3)} fail  ${reasons.length ? "FAIL: " + reasons.join(", ") : "ok"}${r.interpreter ? ` (${r.interpreter})` : ""}`,
  );
  if (reasons.length) {
    failed = true;
    console.log(
      r.output
        .split("\n")
        // A timed-out suite has no `not ok` line to find, so the injected
        // budget line is matched explicitly or the detail block prints nothing
        // at all for the one failure that most needs explaining.
        .filter(
          (l) =>
            l.startsWith("not ok") ||
            l.includes("Error") ||
            l.startsWith("# suite exceeded") ||
            l.startsWith("FAIL:") ||
            l.startsWith("ERROR:"),
        )
        .slice(0, 8)
        .map((l) => `      ${l}`)
        .join("\n"),
    );
  }
}

// The total counts only what ran. An unrun suite contributes nothing, and the
// count of those is printed beside it so a reader comparing this line with a
// document that quotes a test count can see the difference rather than
// inferring it.
const total = results.reduce((sum, r) => sum + Math.max(r.pass, 0), 0);
const unrun = results.filter((r) => r.unrun).length;
console.log(
  `\n  ${results.length} suites, ${total} tests${unrun ? `, ${unrun} could not run` : ""}`,
);

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
