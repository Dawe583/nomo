/**
 * The per-suite ceiling in `check-tests.mjs` is a gate on the gate, so it needs
 * a test of its own: a bound nothing observes is a bound somebody deletes.
 *
 * The failure it exists to prevent is specific and has happened here. A suite
 * that stops making progress does not fail, it stops: `spawnSync` has no
 * deadline, so the runner sat inside one call and printed nothing at all, and
 * the gate looked like a freeze rather than a red. That is worse than a failing
 * test, because every later failure hides behind it.
 *
 * The test drives the real runner with the ceiling turned down to a
 * millisecond rather than against a fixture, so what is asserted is the shipped
 * behaviour: the process exits non-zero and it says why.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const runner = join(root, "scripts", "src", "check-tests.mjs");

/** Runs the real gate with the given ceiling and returns status plus output. */
const runGate = (env) =>
  spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, ...env },
  });

const outputOf = (run) => `${run.stdout ?? ""}${run.stderr ?? ""}`;

test("a suite that exceeds its budget is reported as itself, not as a crash", () => {
  // 1ms cannot be met by a real suite, so every package is killed as it starts.
  // That is the point: this asserts the path that used to be silent, on the
  // real runner, rather than a copy of its logic.
  const run = runGate({ VOID_SUITE_TIMEOUT_MS: "1" });
  const output = outputOf(run);

  assert.notEqual(run.status, 0, "a gate whose ceiling fired must not report green");
  assert.match(
    output,
    /no completion in \d+s/,
    "the timeout has to name itself, or the reader is sent to a test that may well be green",
  );
  assert.match(output, /FAIL:.*no completion/, "the suite's own line has to carry the reason");
});

test("the default ceiling stays far above the measured cost of the slowest suite", () => {
  // A bound that fires on a healthy suite is worse than no bound, so the
  // default cannot be tightened casually. Measured on this host: packages/cli,
  // the slowest, completes 294 tests in about three minutes, because it runs
  // the git.managed conformance matrix against real repositories on disk.
  const source = readFileSync(runner, "utf8");
  // The declaration is an arithmetic expression (`15 * 60 * 1000`), so it is
  // evaluated rather than read as one literal: parsing the leading `15` and
  // comparing it against a millisecond count would compare minutes to
  // milliseconds and pass or fail for the wrong reason.
  const expression = source.match(/DEFAULT_SUITE_TIMEOUT_MS = ([^;]+);/)?.[1];
  assert.ok(expression, "the default ceiling has to be declared in the runner");
  const declared = Function(`"use strict"; return (${expression});`)();
  assert.equal(typeof declared, "number", "the default ceiling has to be a number");
  assert.ok(
    declared >= 15 * 60 * 1000,
    `the default ceiling must not drop below the measured ~3 minute packages/cli suite, got ${declared}ms`,
  );
});

test("an unparseable ceiling is refused rather than silently ignored", () => {
  // Falling back to the default on garbage would hide a typo in CI
  // configuration behind a bound that looks enabled and is not the one asked
  // for, so this has to be an error naming the variable.
  for (const bad of ["-1", "abc", "1.5"]) {
    const run = runGate({ VOID_SUITE_TIMEOUT_MS: bad });
    assert.notEqual(run.status, 0, `VOID_SUITE_TIMEOUT_MS=${bad} must not be accepted`);
    assert.match(
      outputOf(run),
      /VOID_SUITE_TIMEOUT_MS is not a non-negative integer/,
      `VOID_SUITE_TIMEOUT_MS=${bad} must say why it was refused`,
    );
  }
});

test("a ceiling of zero disables the bound instead of killing every suite", () => {
  // The documented escape hatch for a deliberately long local run. If zero
  // were passed to spawnSync as a timeout it would mean "no time at all" and
  // kill everything instantly, which is the opposite of what it says.
  const source = readFileSync(runner, "utf8");
  assert.match(
    source,
    /timeout: suiteTimeoutMs > 0 \? suiteTimeoutMs : undefined/,
    "zero must be translated to no timeout, not to an immediate kill",
  );
});
