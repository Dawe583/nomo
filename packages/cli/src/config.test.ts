import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
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
    // join, not a literal: the separator is the platform's, so a POSIX-shaped
    // expectation would fail on Windows for a path that is actually correct.
    c.out.some((line) => line.startsWith(`ledger-dir: ${join("/home/op", ".void", "ledger")} (default)`)),
  );
  assert.ok(c.out.includes("tui-color: off (VOID_TUI_COLOR)"));
  assert.ok(c.out.includes("verify-key: set (VOID_VERIFY_KEY)"));
  assert.ok(!c.out.some((line) => line.includes("ed25519:abc")));
  assert.equal(c.err.length, 0);
});

test("NOMO values win over VOID aliases, including empty values", () => {
  const entries = resolveConfig({
    HOME: "/home/op",
    NOMO_DATA_DIR: "",
    VOID_DATA_DIR: "/legacy/data",
    NOMO_VERIFY_KEY: "",
    VOID_VERIFY_KEY: "legacy-secret",
    NOMO_TUI_COLOR: "",
    VOID_TUI_COLOR: "0",
    NOMO_TUI_MOTION: "",
    VOID_TUI_MOTION: "0",
  });
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  assert.deepEqual(byKey.get("data-dir"), { key: "data-dir", value: "", source: "NOMO_DATA_DIR" });
  assert.deepEqual(byKey.get("verify-key"), { key: "verify-key", value: "unset", source: "NOMO_VERIFY_KEY" });
  assert.deepEqual(byKey.get("tui-color"), { key: "tui-color", value: "on", source: "NOMO_TUI_COLOR" });
  assert.deepEqual(byKey.get("tui-motion"), { key: "tui-motion", value: "on", source: "NOMO_TUI_MOTION" });
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
