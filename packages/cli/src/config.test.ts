import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, runConfigCommand } from "./config.ts";

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
      HOME: "/home/op",
      VOID_DATA_DIR: "/data/wb",
      VOID_TUI_COLOR: "0",
      VOID_VERIFY_KEY: "ed25519:abc",
    },
  });
  assert.equal(code, 0);
  assert.ok(c.out.includes("version: 0.1.0-test (package)"));
  assert.ok(c.out.includes("data-dir: /data/wb (VOID_DATA_DIR)"));
  assert.ok(
    c.out.some((line) => line.startsWith("ledger-dir: /home/op/.void/ledger (default)")),
  );
  assert.ok(c.out.includes("tui-color: off (VOID_TUI_COLOR)"));
  assert.ok(c.out.includes("verify-key: set (VOID_VERIFY_KEY)"));
  assert.ok(!c.out.some((line) => line.includes("ed25519:abc")));
  assert.equal(c.err.length, 0);
});

test("config marks defaults and an unset key", () => {
  const entries = resolveConfig({ HOME: "/home/op" });
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
