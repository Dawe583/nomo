import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { OWNED_ENV_KEYS, normalizeOwnedEnv } from "./env-keys.ts";
import { resolveConfig } from "./config.ts";
import { legacyEnvKey } from "../../ledger/src/env-compat.ts";

test("every owned key is a current spelling and covers its legacy twin", () => {
  for (const key of OWNED_ENV_KEYS) {
    assert.match(key, /^NOMO_[A-Z0-9_]+$/, key);
    assert.match(legacyEnvKey(key), /^VOID_[A-Z0-9_]+$/, key);
  }
});

test("the settings the plan names are owned", () => {
  for (const key of [
    "NOMO_DATA_DIR",
    "NOMO_LEDGER_DIR",
    "NOMO_MODEL",
    "NOMO_PROVIDER_URL",
    "NOMO_WORKSPACE",
    "NOMO_APPROVALS_DIR",
  ] as const)
    assert.ok(OWNED_ENV_KEYS.includes(key), key);
});

test("normalizeOwnedEnv copies a legacy value under the current name", () => {
  const source = { PATH: "/bin", VOID_MODEL: "legacy-model" } as NodeJS.ProcessEnv;
  const normalized = normalizeOwnedEnv(source);
  assert.equal(normalized.NOMO_MODEL, "legacy-model");
  assert.equal(source.NOMO_MODEL, undefined);
});

test("normalizeOwnedEnv never overwrites a current value", () => {
  const normalized = normalizeOwnedEnv({
    NOMO_DATA_DIR: "/current",
    VOID_DATA_DIR: "/legacy",
  } as NodeJS.ProcessEnv);
  assert.equal(normalized.NOMO_DATA_DIR, "/current");
});

test("normalizeOwnedEnv keeps an explicitly empty current value", () => {
  const normalized = normalizeOwnedEnv({
    NOMO_DATA_DIR: "",
    VOID_DATA_DIR: "/legacy",
  } as NodeJS.ProcessEnv);
  assert.equal(normalized.NOMO_DATA_DIR, "");
});

test("normalizeOwnedEnv returns the same object when nothing is legacy", () => {
  const source = { NOMO_MODEL: "current" } as NodeJS.ProcessEnv;
  assert.equal(normalizeOwnedEnv(source), source);
});

test("config resolves a legacy data directory and names its source", () => {
  const entries = resolveConfig({ HOME: "/home/op", VOID_DATA_DIR: "/legacy/wb" });
  assert.deepEqual(
    entries.find((entry) => entry.key === "data-dir"),
    { key: "data-dir", value: "/legacy/wb", source: "VOID_DATA_DIR" },
  );
});

test("config resolves a legacy ledger directory", () => {
  const entries = resolveConfig({ HOME: "/home/op", VOID_LEDGER_DIR: "/legacy/ledger" });
  assert.equal(entries.find((entry) => entry.key === "ledger-dir")?.value, "/legacy/ledger");
});

test("config prefers the current spelling and says so", () => {
  const entries = resolveConfig({
    HOME: "/home/op",
    NOMO_LEDGER_DIR: "/current/ledger",
    VOID_LEDGER_DIR: "/legacy/ledger",
  });
  const entry = entries.find((e) => e.key === "ledger-dir");
  assert.equal(entry?.value, "/current/ledger");
  assert.equal(entry?.source, "NOMO_LEDGER_DIR");
});

test("config resolves a legacy approvals directory under a legacy workspace", () => {
  const entries = resolveConfig({
    HOME: "/home/op",
    VOID_APPROVALS_DIR: "/legacy/approvals",
    VOID_WORKSPACE: "billing",
  });
  assert.equal(
    entries.find((entry) => entry.key === "approvals-dir")?.value,
    "/legacy/approvals",
  );
});

test("config still defaults the approvals directory under the resolved data directory", () => {
  const entries = resolveConfig({ HOME: "/home/op" });
  assert.equal(
    entries.find((entry) => entry.key === "approvals-dir")?.value,
    join("/home/op", ".nomo", "approvals", "default"),
  );
});

test("config never prints a secret, under either spelling", () => {
  for (const env of [
    { HOME: "/home/op", NOMO_VERIFY_KEY: "ed25519:secret" },
    { HOME: "/home/op", VOID_VERIFY_KEY: "ed25519:secret" },
  ]) {
    const entries = resolveConfig(env as NodeJS.ProcessEnv);
    const verify = entries.find((entry) => entry.key === "verify-key");
    assert.equal(verify?.value, "set");
    assert.ok(!JSON.stringify(entries).includes("secret"));
  }
});

test("a legacy pinned key reports itself as set and names its source", () => {
  const entries = resolveConfig({ HOME: "/home/op", VOID_VERIFY_KEY: "ed25519:secret" });
  const verify = entries.find((entry) => entry.key === "verify-key");
  assert.equal(verify?.value, "set");
  assert.equal(verify?.source, "VOID_VERIFY_KEY");
});

test("config honours a legacy terminal colour setting", () => {
  const entries = resolveConfig({ HOME: "/home/op", VOID_TUI_COLOR: "0" });
  const color = entries.find((entry) => entry.key === "tui-color");
  assert.equal(color?.value, "off");
  assert.equal(color?.source, "VOID_TUI_COLOR");
});