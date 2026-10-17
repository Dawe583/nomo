/**
 * The Swift suite's verdict, mapped in one pure place so the gate-on-gate can
 * test the mapping without executing a compiler.
 *
 * The suite is `swift test` under the pinned toolchain. Three inputs decide its
 * row in the report: the process result, the timeout flag, and the output text.
 * Everything the mapping refuses has to carry the reason, because an UNRUN
 * suite whose reason is unnamed sends the reader hunting through a toolchain
 * instead of telling them what is missing.
 *
 * The absence set is exactly the two testing modules the Apple surfaces use,
 * Swift Testing and XCTest. A missing own module is a real failing suite, and
 * is deliberately outside this set so a broken target can never hide behind a
 * toolchain judgement.
 */

/** The compile signature of a toolchain where the module is simply absent. */
const TOOLCHAIN_ABSENCE =
  /unable to resolve module dependency: '(Testing|XCTest)'|no such module '(Testing|XCTest)'/;

/** The name the compiled error named, so the row's reason names it too. */
function absentModule(output) {
  return output.match(/unable to resolve module dependency: '([^']+)'|no such module '([^']+)'/);
}

/** The swift-testing summary verdict covers both exits. */
const VERDICT = /Test run with (\d+) tests? in \d+ suites? (passed|failed)/m;

/**
 * Maps one `swift test` result to the row the gate reports.
 *
 * `attempted` is false when the toolchain itself was missing, so no swift
 * process ever ran and the row is UNRUN with that reason rather than a fake
 * counting failure. A result whose output carries the module-absence signature
 * is likewise UNRUN: that machine cannot run this suite at all and a clean
 * clone must not go red for it. Any other failing exit fails the gate; a
 * verdict that never appears with a zero exit is also a failure, because a
 * suite that stops producing its summary is the same silent stop the ceiling
 * exists to prevent.
 */
export function interpretSwiftRun(result) {
  const { output, status, timedOut, attempted = true, toolchainReason } = result;
  const tried = [];
  if (!attempted || TOOLCHAIN_ABSENCE.test(output)) {
    const named = absentModule(output);
    const module = named?.[1] ?? named?.[2];
    tried.push(
      toolchainReason ??
        (module
          ? `swift (the ${module} module is not in this toolchain)`
          : "swift (the Testing module is not in this toolchain)"),
    );
    return { pass: -1, fail: 0, verdict: "unrun", tried };
  }
  const verdict = output.match(VERDICT);
  if (verdict) {
    return {
      pass: Number.parseInt(verdict[1], 10),
      fail: verdict[2] === "failed" ? 1 : 0,
      verdict: verdict[2],
      tried,
    };
  }
  // No verdict and a zero exit is a quiet stop, not a success: the runner
  // prints a summary it can see before the process ends.
  return { pass: -1, fail: 1, verdict: "stopped", tried };
}
