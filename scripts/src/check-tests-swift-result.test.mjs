import test from "node:test";
import assert from "node:assert/strict";

import { interpretSwiftRun, isSwiftMacroFlake } from "./check-tests-swift-result.mjs";

/**
 * The Swift suite's row in the root gate is a mapping, not a parser glued
 * onto the suite: the gate that runs it should be able to state, in tests,
 * which record a given `swift test` output produces. These cases quote the
 * outputs the mapping was built against, the passing summary, the failing
 * verdict, the measured compile signature of a toolchain without the module,
 * and the quiet stop the ceiling exists to prevent.
 */

const SUMMARY =
  "Test run with 31 tests in 7 suites passed after 0.025 seconds.";
const FAILED =
  "Test run with 31 tests in 7 suites failed after 0.190 seconds.";
const ABSENCE =
  "error: /tests/XTests.swift:1:8 unable to resolve module dependency: 'XCTest'\nerror: Build failed";

test("a passing summary counts its tests and passes", () => {
  const mapped = interpretSwiftRun({ output: SUMMARY, status: 0, timedOut: false });
  assert.deepEqual(
    { pass: mapped.pass, fail: mapped.fail, verdict: mapped.verdict, tried: mapped.tried },
    { pass: 31, fail: 0, verdict: "passed", tried: [] },
  );
});

test("a failed verdict fails the gate even though it names a count", () => {
  const mapped = interpretSwiftRun({ output: FAILED, status: 1, timedOut: false });
  assert.equal(mapped.fail, 1);
  assert.equal(mapped.verdict, "failed");
});

test("a missing module maps to unrun with the reason named after the module", () => {
  const mapped = interpretSwiftRun({
    output: ABSENCE,
    status: 1,
    timedOut: false,
  });
  assert.equal(mapped.verdict, "unrun");
  assert.deepEqual(mapped.tried, ["swift (the XCTest module is not in this toolchain)"]);
  assert.equal(mapped.fail, 0, "a clean clone without full Xcode must not go red");
});

test("a host where swift never ran is unrun with the toolchain reason", () => {
  const mapped = interpretSwiftRun({
    output: "",
    status: 1,
    timedOut: false,
    attempted: false,
    toolchainReason: "swift (not a working toolchain)",
  });
  assert.equal(mapped.verdict, "unrun");
  assert.match(mapped.tried[0], /not a working toolchain/);
});

test("a zero exit without a verdict is a quiet stop, and stops are failures", () => {
  const mapped = interpretSwiftRun({
    output: "some early output",
    status: 0,
    timedOut: false,
  });
  assert.equal(mapped.verdict, "stopped");
  assert.equal(mapped.fail, 1);
});

test("NomoDesignSystem fails loudly, and the gate's mapping refuses to call that unrun", () => {
  // The absence signature must be module specific. A compile failure of the
  // suite itself, where the module the suite imports IS present, is a real
  // failing run and not a toolchain judgement.
  const failing = interpretSwiftRun({
    output: "error: cannot find 'NomoContrastPairs' in scope\n" + FAILED,
    status: 1,
    timedOut: false,
  });
  assert.equal(failing.verdict, "failed", "a type error is the suite failing, not the toolchain");
});

/**
 * The macro plugin flake predicate is the other half of the module: the retry
 * in runSwiftSuite acts only through it, so the two facts that make the retry
 * honest are asserted in two directions. The quoted compile output is the
 * measured signature of the CLT 6.4 swiftbuild backend, where the red runs
 * compile every test file against a plugin server that never receives the
 * TestingMacros plugin and no test ever executes.
 */
test("the macro plugin signature with no tests run is the only retryable shape", () => {
  const output =
    "error: external macro implementation type 'TestingMacros.TestDeclarationMacro' could not be found for macro 'Test'; plugin for module 'TestingMacros' not found\nerror: Build failed\nerror: fatalError";
  assert.equal(
    isSwiftMacroFlake({ output, status: 1, timedOut: false }),
    true,
    "a red run that executed no test and carries the plugin signature is the toolchain scheduler, not the suite",
  );
});

test("the same signature after tests ran is final, never retryable", () => {
  // The whole point of the second factor: a run that executed tests has real
  // results, and re-running it could only manufacture green.
  const output =
    "plugin for module 'TestingMacros' not found\nTest run with 31 tests in 7 suites failed after 0.190 seconds.";
  assert.equal(
    isSwiftMacroFlake({ output, status: 1, timedOut: false }),
    false,
  );
});

test("an ordinary compile failure is not retryable even without a verdict", () => {
  assert.equal(
    isSwiftMacroFlake({
      output: "error: cannot find 'NomoContrastPairs' in scope\nerror: Build failed",
      status: 1,
      timedOut: false,
    }),
    false,
  );
  assert.equal(
    isSwiftMacroFlake({ output: SUMMARY, status: 0, timedOut: false }),
    false,
  );
  // A killed run's row belongs to the ceiling, whose reason prints before the
  // mapping sees it, so a timeout must never take the retry path.
  assert.equal(
    isSwiftMacroFlake({
      output: "plugin for module 'TestingMacros' not found\nerror: fatalError",
      status: 1,
      timedOut: true,
    }),
    false,
  );
});
