import { test } from "node:test";
import assert from "node:assert/strict";
import { envValue, legacyEnvKey, normalizeEnv } from "./env-compat.ts";

test("NOMO wins over VOID without mutating the input", () => {
  const env = { NOMO_HOME: "/nomo", VOID_HOME: "/void" };
  assert.equal(envValue(env, "NOMO_HOME"), "/nomo");
  assert.deepEqual(env, { NOMO_HOME: "/nomo", VOID_HOME: "/void" });
});

test("a legacy only key still resolves", () => {
  assert.equal(envValue({ VOID_MODEL: "legacy-model" }, "NOMO_MODEL"), "legacy-model");
});

test("an explicitly empty NOMO value wins over a set legacy value", () => {
  assert.equal(envValue({ NOMO_HOME: "", VOID_HOME: "/void" }, "NOMO_HOME"), "");
});

test("neither spelling returns undefined", () => {
  assert.equal(envValue({}, "NOMO_WORKSPACE"), undefined);
});

test("the lookup ignores a prefix that is only partly ours", () => {
  const env = { VOID_HOME: "/void", NOMO_NOT_HOME: "/other" };
  assert.equal(envValue(env, "NOMO_HOME"), "/void");
});

test("a key that is not NOMO prefixed is refused by name", () => {
  assert.throws(
    () => envValue({}, "HOME" as `NOMO_${string}`),
    /must start with NOMO_/,
  );
  assert.throws(() => legacyEnvKey("home" as `NOMO_${string}`), /must start with NOMO_/);
});

test("legacyEnvKey maps only the prefix", () => {
  assert.equal(legacyEnvKey("NOMO_VERIFY_KEY"), "VOID_VERIFY_KEY");
  assert.equal(legacyEnvKey("NOMO_A_B"), "VOID_A_B");
});

test("normalizeEnv copies the legacy spelling under the NOMO name", () => {
  const source = { PATH: "/bin", VOID_MODEL: "legacy" } as NodeJS.ProcessEnv;
  const normalized = normalizeEnv(source, ["NOMO_MODEL"]);
  assert.equal(normalized.NOMO_MODEL, "legacy");
  assert.equal(normalized.VOID_MODEL, "legacy");
  assert.equal(source.NOMO_MODEL, undefined);
});

test("normalizeEnv leaves a set NOMO value alone", () => {
  const normalized = normalizeEnv(
    { NOMO_MODEL: "current", VOID_MODEL: "legacy" } as NodeJS.ProcessEnv,
    ["NOMO_MODEL"],
  );
  assert.equal(normalized.NOMO_MODEL, "current");
});

test("normalizeEnv keeps an empty NOMO value empty rather than falling back", () => {
  const normalized = normalizeEnv(
    { NOMO_MODEL: "", VOID_MODEL: "legacy" } as NodeJS.ProcessEnv,
    ["NOMO_MODEL"],
  );
  assert.equal(normalized.NOMO_MODEL, "");
});

test("normalizeEnv returns the same object when nothing has to change", () => {
  const source = { NOMO_MODEL: "current" } as NodeJS.ProcessEnv;
  assert.equal(normalizeEnv(source, ["NOMO_MODEL"]), source);
});
test("normalizeEnv does not invent an unowned alias", () => {
  const source = { VOID_UNOWNED_X: "legacy" } as NodeJS.ProcessEnv;
  const normalized = normalizeEnv(source, ["NOMO_MODEL"]);
  assert.equal(normalized.NOMO_UNOWNED_X, undefined);
  assert.equal(normalized.VOID_UNOWNED_X, "legacy");
});

test("the owned list is read through the same rule as a single lookup", () => {
  const owned = [
    "NOMO_DATA_DIR",
    "NOMO_HOME",
    "NOMO_MODEL",
    "NOMO_POLICY_PATH",
    "NOMO_SIGNING_KEY",
    "NOMO_UPSTREAM_COMMAND",
    "NOMO_VERIFY_KEY",
    "NOMO_WORKSPACE",
  ] as const;
  for (const key of owned) {
    const legacy = key.replace(/^NOMO_/, "VOID_");
    assert.equal(envValue({ [key]: "current", [legacy]: "legacy" }, key), "current", key);
    assert.equal(envValue({ [legacy]: "legacy" }, key), "legacy", key);
  }
});
