import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { parseInvocation, withDefaultTui } from "./index.ts";

describe("@nomo/cli", () => {
  test("bare command and leading TUI flags default to the live workspace", () => {
    assert.deepEqual(withDefaultTui([]), ["tui"]);
    assert.deepEqual(withDefaultTui(["--once", "--view", "runs"]), [
      "tui",
      "--once",
      "--view",
      "runs",
    ]);
    assert.deepEqual(withDefaultTui(["doctor"]), ["doctor"]);
    assert.deepEqual(withDefaultTui(["--help"]), ["--help"]);
    assert.deepEqual(withDefaultTui(["--version"]), ["--version"]);
  });

  test("parses a command and keeps the rest of argv intact", () => {
    const parsed = parseInvocation(["ledger", "verify", "--workspace", "demo"]);
    assert.deepEqual(parsed, {
      ok: true,
      command: "ledger",
      args: ["verify", "--workspace", "demo"],
    });
  });

  test("an unknown command is refused and the refusal names the alternatives", () => {
    // Standards rule 10: a generic error teaches the caller to reword and try
    // again. Naming what was expected is the cheapest version of that rule.
    const parsed = parseInvocation(["verfiy"]);
    assert.equal(parsed.ok, false);
    assert.match(
      parsed.ok ? "" : parsed.reason,
      /unknown command "verfiy".*run, classify, feed, watch, approvals, approve, ledger, replay, recovery, policy, export, attest, taint, verify/,
    );
  });

  test("no arguments is a usage line, not a crash", () => {
    const parsed = parseInvocation([]);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? "" : parsed.reason, /^usage: nomo /);
  });

  test("the barrel tracks the live command list, including update", () => {
    // argv.ts gained "update" while this barrel carried a stale copy without
    // it. Parsing through ./index.ts proves the public entry cannot drift
    // from the parser the binary runs again.
    const parsed = parseInvocation(["update", "--check"]);
    assert.deepEqual(parsed, {
      ok: true,
      command: "update",
      args: ["--check"],
    });
  });
});
