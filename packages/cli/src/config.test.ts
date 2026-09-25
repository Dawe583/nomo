import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { resolveConfig, runConfigCommand } from "./config.ts";

// A POSIX-looking HOME on purpose: the printed default is a joined path, so a
// hardcoded expectation would be the platform's own separator baked in.
const HOME = "/home/op";

function collect() {
  const out: string[] = [], err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (line: string) => { out.push(line); },
      stderr: (line: string) => { err.push(line); },
    },
  };
}

test("config resolves explicit environment with sources", async () => {
  const c = collect();
  const code = await runConfigCommand([], c.io, {
    version: "0.1.0-test",
    env: {
      HOME,
      VOID_DATA_DIR: "/data/wb",
      VOID_TUI_COLOR: "0",
      VOID_VERIFY_KEY: "ed25519:abc",
    },
  });
  assert.equal(code, 0);
  assert.ok(c.out.includes("version: 0.1.0-test (package)"));
  assert.ok(c.out.includes("data-dir: /data/wb (VOID_DATA_DIR)"));
  // A default path is joined by the platform, so the expectation is derived
  // with the same join rather than written in one platform's separators.
  const ledgerDir = join(HOME, ".void", "ledger");
  const approvalsDir = join(HOME, ".void", "approvals", "default");
  assert.ok(c.out.includes(`ledger-dir: ${ledgerDir} (default)`), c.out.join());
  assert.ok(
    c.out.includes(`approvals-dir: ${approvalsDir} (default)`),
    c.out.join(),
  );
  // A derived expectation also accepts a path that merely echoed HOME, so the
  // components the default has to contain are asserted on their own.
  assert.ok(
    c.out.some((line) => line.startsWith("ledger-dir: ") && line.endsWith(`${join(".void", "ledger")} (default)`)),
    c.out.join(),
  );
  assert.ok(c.out.includes("tui-color: off (VOID_TUI_COLOR)"));
  assert.ok(c.out.includes("verify-key: set (VOID_VERIFY_KEY)"));
  assert.ok(!c.out.some((line) => line.includes("ed25519:abc")));
  assert.equal(c.err.length, 0);
});

test("config marks defaults and an unset key", () => {
  const entries = resolveConfig({ HOME });
  const byKey = new Map(entries.map((e) => [e.key, e]));
  assert.equal(byKey.get("data-dir")?.source, "default");
  assert.equal(byKey.get("verify-key")?.value, "unset");
  assert.equal(byKey.get("term")?.value, "unset");
});

test("config rejects arguments with usage and exit two", async () => {
  const c = collect();
  const code = await runConfigCommand(["--data-dir", "x"], c.io, {});
  assert.equal(code, 2);
  assert.match(c.err[0] ?? "", /usage: void config/);
});
