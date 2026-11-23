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
import {
  interpretSwiftRun,
  isSwiftMacroFlake,
} from "./check-tests-swift-result.mjs";

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
 * `NOMO_SUITE_TIMEOUT_MS` overrides it, and accepts `0` to disable the bound
 * for a deliberate long run.
 */
const DEFAULT_SUITE_TIMEOUT_MS = 15 * 60 * 1000;
const suiteTimeoutMs = (() => {
  const raw = process.env.NOMO_SUITE_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_SUITE_TIMEOUT_MS;
  // Digits only. `parseInt` alone would truncate "1.5" to 1 and "12abc" to 12,
  // and a ceiling silently turned into a different number is worse than one
  // refused: it looks configured and is not what anybody asked for.
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new Error(
      `NOMO_SUITE_TIMEOUT_MS is not a non-negative integer: ${raw}`,
    );
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
    .map((name) => ({
      name,
      dir: join(packagesDir, name),
      runner: "packages",
    })),
  // `apps/*` suites carry a label naming the directory they actually live in.
  // Printing them under `packages/` would send a reader chasing a failure to
  // the wrong tree.
  // `apps/control-plane` bare discovery already reaches ui/src, so a
  // dedicated entry here would run those 123 tests twice in one gate run and
  // double-count them in the totals. Listed in the log so a reader does not
  // re-add it.
  {
    name: "control-plane",
    dir: join(root, "apps", "control-plane"),
    runner: "apps",
  },
  { name: "desktop", dir: join(root, "apps", "desktop"), runner: "apps" },
  { name: "scripts", dir: join(root, "scripts"), runner: "scripts" },
];

for (const { name, dir, runner } of suites) {
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
    runSuite(name, runner === "scripts" ? root : dir, files, runner),
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
      "python3 -m venv /tmp/nomo-mcp-venv",
      "/tmp/nomo-mcp-venv/bin/python -m pip install -r apps/appwrite-mcp/requirements.txt",
    ],
  },
  {
    name: "nomo-transport",
    dir: join(root, "python", "nomo-transport"),
    startDir: "python/nomo-transport/tests",
    topDir: "python/nomo-transport",
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
 * meant. `NOMO_MCP_PYTHON` relocates the SDK environment and `NOMO_PYTHON`
 * overrides the interpreter outright; both exist so a machine that has the
 * SDK somewhere else, and a run that needs to reach the `UNRUN` branch, are
 * both expressible without editing this file.
 */
const pythonCandidates = [
  ...(process.env.NOMO_PYTHON ? [process.env.NOMO_PYTHON] : []),
  process.env.NOMO_MCP_PYTHON ?? "/tmp/nomo-mcp-venv/bin/python",
  "python3",
];

function runPythonSuite(suite) {
  const started = Date.now();
  const tried = [];
  for (const python of pythonCandidates) {
    const available = spawnSync(python, ["--version"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (available.error || available.status !== 0) {
      tried.push(`${python} (not a working interpreter)`);
      continue;
    }
    if (suite.probe) {
      const probe = spawnSync(python, ["-c", suite.probe], {
        encoding: "utf8",
        timeout: 60_000,
      });
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
    const pass = Number.parseInt(
      output.match(/^Ran (\d+) tests?/m)?.[1] ?? "-1",
      10,
    );
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

function unrunResult(name, runner = "python", reason) {
  return {
    name,
    runner,
    pass: 0,
    fail: 0,
    code: 0,
    timedOut: false,
    elapsed: 0,
    output: "",
    unrun: true,
    reason,
  };
}

for (const suite of pythonSuites) {
  if (!existsSync(join(suite.dir, "tests"))) continue;
  results.push(runPythonSuite(suite));
}

/**
 * The Swift suite runs under the pinned toolchain, not a simulator.
 *
 * The Apple selection is Command Line Tools (DECISIONS 2026-09-24), and the
 * 6.4 CLT ships Swift Testing while it does not ship XCTest at all: a package
 * still importing XCTest fails at compile time with "unable to resolve module
 * dependency: XCTest", which is how this suite was silently unrun on the
 * primary machine while its root script looked healthy. The design system's
 * suites import Testing, so the suite runs where the operator works and a
 * toolchain that loses the module fails closed, with the compile signature
 * mapped to UNRUN rather than to a lie.
 */
const swiftSuites = [
  {
    name: "apple-design",
    cwd: join(root, "apps", "apple", "NomoDesignSystem"),
  },
];

/**
 * The Command Line Tools 6.4 swiftbuild backend resolves the Swift Testing
 * macro plugins nondeterministically: the same package, the same tree and the
 * same environment measured green, red, green in three back to back runs, and
 * the red runs compile every test file against a plugin server that never
 * receives the TestingMacros plugin, so zero tests execute (measured 2026-10-
 * 17, recorded in the workstream graph as D-25).
 *
 * The earlier note here claimed that neither the deprecated native build
 * system nor `-j 1` makes it deterministic. Measured again on 2026-10-20 on
 * this host, the claim holds for the native build system and does not hold
 * for `-j 1`: the default parallel build failed 3 of 8 runs under load and 4
 * of 6 with a cleared .build, while `-j 1` failed 1 of 8 under load and 0 of 6
 * without it. The plugin server races the parallel compile; a single build
 * job gives it no race to lose. The suite therefore builds with one job.
 *
 * The remaining flake is bounded by a retry that acts only through the pure
 * predicate in check-tests-swift-result.mjs: a run that executed no test at
 * all and carries exactly the plugin-not-found signature. Real test failures
 * pass through unremarked. The retry keeps the build directory, because the
 * measurement shows a cleared one does not help: the failure is the plugin
 * resolution, not the cached state.
 */
const SWIFT_FLAKE_ATTEMPTS = 5;

function runSwiftSuite(suite) {
  const started = Date.now();
  const available = spawnSync("swift", ["--version"], { encoding: "utf8" });
  const attempted = !available.error && available.status === 0;
  if (!attempted) {
    return {
      ...unrunResult(suite.name, "swift"),
      tried: ["swift (not a working toolchain)"],
      elapsed: Date.now() - started,
    };
  }
  let run;
  let retryNotes = [];
  for (let attempt = 0; attempt < SWIFT_FLAKE_ATTEMPTS; attempt++) {
    // The build directory is kept across attempts. Measured on 2026-10-20, a
    // cleared one did not change the outcome: the failing runs are the ones
    // where the plugin server never received the plugin, not the ones that
    // read a stale cache.
    run = spawnSync("swift", ["test", "-j", "1"], {
      cwd: suite.cwd,
      encoding: "utf8",
      timeout: suiteTimeoutMs > 0 ? suiteTimeoutMs : undefined,
      killSignal: "SIGKILL",
    });
    const timedOut = run.error?.code === "ETIMEDOUT";
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const mapped = interpretSwiftRun({
      output,
      status: run.status ?? 1,
      timedOut,
      attempted,
    });
    // The retry gate is deliberately inside the loop, not around it: each
    // flake attempt ends the preceding process, and the cleared .build is the
    // only state the next attempt bases its plan on.
    if (isSwiftMacroFlake({ output, status: run.status ?? 1, timedOut })) {
      retryNotes.push(
        `attempt ${attempt + 1}: macro plugin flake, no tests ran`,
      );
      continue;
    }
    if (mapped.verdict === "unrun") {
      return {
        ...unrunResult(suite.name, "swift"),
        tried: [...(retryNotes.length ? retryNotes : []), mapped.tried].flat(),
        elapsed: Date.now() - started,
      };
    }
    return {
      ...mapped,
      name: suite.name,
      runner: "swift",
      pass: mapped.pass,
      fail: mapped.fail,
      code: run.status ?? 1,
      timedOut,
      elapsed: Date.now() - started,
      output,
      tried: retryNotes.length ? retryNotes : undefined,
    };
  }
  const finalOutput = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  return {
    name: suite.name,
    runner: "swift",
    pass: -1,
    fail: 1,
    code: run.status ?? 1,
    elapsed: Date.now() - started,
    output: finalOutput,
    tried: retryNotes,
  };
}

for (const suite of swiftSuites) {
  results.push(runSwiftSuite(suite));
}

/**
 * One script suite: a repository check that is a process, not a test file.
 *
 * `apple:project:check` proves the committed Xcode project is what project.yml
 * generates, and the release matrix records that drift as exactly the failure
 * the gate must catch, so the check belongs in every gate run. It is spawned
 * rather than imported, its pass count is the generated file count it reports,
 * and its one environment absence (xcodegen, a brew install) maps to UNRUN
 * with the script's own message, the same judgement the Swift suite makes for
 * a missing module. Any other failing exit fails the gate with the script's
 * output carried for the reader.
 */
const scriptSuites = [
  {
    name: "apple-project",
    file: "scripts/src/check-apple-project.mjs",
  },
  // The PTY regression launches the active Node workspace renderer.
  {
    name: "tui-pty",
    command: ["python3", "scripts/src/verify-tui-terminal.py"],
    unrunPattern: /ModuleNotFoundError: (?:pty|termios|fcntl|select)/,
    passes: "lines",
    unrunReason: "no python3 or the POSIX pty modules it needs",
  },
  // The desktop shell's inline Rust tests (keychain naming, diagnostics
  // allowlist, runtime readiness) compile the real Tauri app, which needs the
  // icon set that prepare.mjs generates; an unprepared checkout is UNRUN with
  // the setup steps named instead of a red gate for missing artifacts.
  {
    name: "desktop-rust",
    command: ["node", "scripts/src/check-desktop-rust.mjs"],
    passRegex: /desktop-rust: (\d+) rust tests passed/,
    unrunPattern: /desktop-rust: UNRUN/,
    unrunReason: "no cargo or the desktop icons were never prepared",
  },
];

function runScriptSuite(suite) {
  const started = Date.now();
  const [command, ...args] = suite.command ?? [
    process.execPath,
    join(root, suite.file),
  ];
  const run = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: suiteTimeoutMs > 0 ? suiteTimeoutMs : undefined,
    killSignal: "SIGKILL",
  });
  const timedOut = run.error?.code === "ETIMEDOUT";
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  // Toolchain absence is this gate's honest UNRUN: the command or a module it
  // needs is missing on this runner, and that is not a failing assertion.
  if (run.error?.code === "ENOENT") {
    return {
      ...unrunResult(suite.name, "script", suite.unrunReason),
      tried: [`${command}: not found`],
      elapsed: Date.now() - started,
    };
  }
  if (!timedOut && suite.unrunPattern?.test(output)) {
    return {
      ...unrunResult(suite.name, "script", suite.unrunReason),
      tried: [
        output.split("\n").find((line) => suite.unrunPattern.test(line)) ?? "",
      ],
      elapsed: Date.now() - started,
    };
  }
  if (!timedOut && /is not on PATH/.test(output)) {
    return {
      ...unrunResult(suite.name, "script"),
      tried: [
        output.split("\n").find((line) => /is not on PATH/.test(line)) ??
          "not on PATH",
      ],
      elapsed: Date.now() - started,
    };
  }
  const generated = output.match(/\((\d+) generated files\)/);
  const suitePass = suite.passRegex ? output.match(suite.passRegex) : undefined;
  const pass =
    suite.passRegex && suitePass
      ? Number.parseInt(suitePass[1], 10)
      : suite.passes === "lines"
        ? (output.match(/^PASS:/gm) ?? []).length
        : generated
          ? Number.parseInt(generated[1], 10)
          : -1;
  return {
    name: suite.name,
    runner: "script",
    pass,
    fail: pass > 0 && run.status === 0 ? 0 : 1,
    code: run.status ?? 1,
    timedOut,
    elapsed: Date.now() - started,
    output,
  };
}

for (const suite of scriptSuites) {
  results.push(runScriptSuite(suite));
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
  // Node defaults to availableParallelism() - 1 concurrent test files.
  // Keep the gate serial to bound local CPU use.
  const run = spawnSync(
    "node",
    ["--test", "--test-concurrency=1", "--test-reporter=tap", ...files],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: suiteTimeoutMs > 0 ? suiteTimeoutMs : undefined,
      killSignal: "SIGKILL",
    },
  );
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
const width = Math.max(
  ...results.map((r) => `${r.runner}/${r.name}`.length),
  7,
);

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
      `  ${`${r.runner}/${r.name}`.padEnd(width)}  --- pass    0 fail  UNRUN: ${r.reason ?? "no interpreter could import the SDK it needs"}`,
    );
    console.log(`      tried: ${(r.tried ?? []).join(", ")}`);
    if (!suite) continue;
    for (const step of suite.setup ?? [])
      console.log(`      then run: ${step}`);
    console.log(
      `      ${process.env.NOMO_MCP_PYTHON ?? "/tmp/nomo-mcp-venv/bin/python"} -m unittest discover -s ${suite.startDir} -t ${suite.topDir}`,
    );
    continue;
  }

  console.log(
    `  ${`${r.runner}/${r.name}`.padEnd(width)}  ${String(r.pass).padStart(3)} pass  ${String(r.fail).padStart(3)} fail  ${reasons.length ? "FAIL: " + reasons.join(", ") : "ok"}${r.interpreter ? ` (${r.interpreter})` : ""}`,
  );
  if (reasons.length) {
    failed = true;
    // A `not ok` line alone names the test; the cause is the indented TAP
    // diagnostic block that follows it (actual vs expected, the file and
    // line). Without that block the remote-runner reader gets a name like
    // "commit refuses shallow without writes" and no way to know whether
    // the cause is a version, a platform, or the code under review. The
    // block is bounded so one verbose crash cannot drown the other suites.
    const detail = [];
    const lines = r.output.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (
        line &&
        (line.startsWith("not ok") ||
          line.includes("Error") ||
          line.startsWith("# suite exceeded") ||
          line.startsWith("FAIL:") ||
          line.startsWith("ERROR:"))
      ) {
        detail.push(line);
        for (let j = i + 1; j < lines.length && detail.length < 80; j++) {
          const next = lines[j];
          if (!next || !/^\s/.test(next)) break;
          detail.push(next.slice(0, 160));
        }
      }
    }
    console.log(
      detail
        .slice(0, 80)
        .map((l) => `      ${l}`)
        .join("\n") || "      (no failure detail in suite output)",
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
  // Reads product env vars out of every test file and compares them against
  // the names the source actually reads, so a rename that leaves the tests
  // setting a variable nothing consumes is a red instead of a green suite
  // writing into the operator's real home directory.
  "env-var-truth.test.mjs",
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
