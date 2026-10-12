import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import { devKeyIdFromSpki, devKeyProvider } from "./sign.ts";
import { ledgerDir } from "./store.ts";
import { resolveVerificationKey } from "./verify-key.ts";
import {
  configuredEnvEntry,
  configuredEnvValue,
  envValue,
  legacyEnvKey,
  OWNED_NOMO_ENV_KEYS,
  type OwnedNomoEnvKey,
} from "./env-compat.ts";

test("NOMO value wins without mutating an injected environment", () => {
  const env = Object.freeze({ NOMO_MODEL: "current-model", VOID_MODEL: "legacy-model" });
  assert.equal(envValue(env, "NOMO_MODEL"), "current-model");
  assert.deepEqual(env, { NOMO_MODEL: "current-model", VOID_MODEL: "legacy-model" });
});

test("an explicitly empty NOMO value wins over its VOID alias", () => {
  assert.equal(envValue({ NOMO_HOME: "", VOID_HOME: "/legacy" }, "NOMO_HOME"), "");
});

test("a VOID value is used only when its NOMO spelling is absent", () => {
  assert.equal(envValue({ VOID_MODEL: "legacy-model" }, "NOMO_MODEL"), "legacy-model");
  assert.equal(envValue({}, "NOMO_MODEL"), undefined);
});

test("every owned NOMO setting falls back to its exact VOID spelling", () => {
  for (const key of OWNED_NOMO_ENV_KEYS) {
    const legacy = legacyEnvKey(key);
    assert.equal(envValue({ [legacy]: "legacy-value" }, key), "legacy-value", key);
  }
});

test("recovery config names accept either spelling and keep NOMO precedence", () => {
  const env = { NOMO_RECOVERY_KEY: "current-key", VOID_RECOVERY_KEY: "old-key" };
  assert.equal(configuredEnvValue(env, "VOID_RECOVERY_KEY"), "current-key");
  assert.equal(configuredEnvValue({ VOID_DATABASE_URL: "legacy-url" }, "NOMO_DATABASE_URL"), "legacy-url");
});

test("selected environment metadata names the source and preserves empty input", () => {
  assert.deepEqual(
    configuredEnvEntry({ NOMO_MODEL: "", VOID_MODEL: "legacy-model" }, "VOID_MODEL"),
    { name: "NOMO_MODEL", value: "" },
  );
  assert.deepEqual(configuredEnvEntry({ VOID_MODEL: "legacy-model" }, "NOMO_MODEL"), {
    name: "VOID_MODEL",
    value: "legacy-model",
  });
});

test("unowned configured names are read exactly without prefix aliasing", () => {
  const env = { NOMO_CUSTOM: "new", VOID_CUSTOM: "old", DATABASE_URL: "postgres://test" };
  assert.equal(configuredEnvValue(env, "VOID_CUSTOM"), "old");
  assert.equal(configuredEnvValue(env, "DATABASE_URL"), "postgres://test");
});

test("inherited properties are not treated as environment values", () => {
  const env = Object.create({ NOMO_MODEL: "inherited", VOID_MODEL: "legacy" }) as Record<string, string | undefined>;
  assert.equal(envValue(env, "NOMO_MODEL"), undefined);
  assert.equal(configuredEnvValue(env, "NOMO_MODEL"), undefined);
});

test("ledger directory uses NOMO before VOID and preserves an empty NOMO value", () => {
  assert.equal(ledgerDir({ NOMO_LEDGER_DIR: "/new-ledger", VOID_LEDGER_DIR: "/old-ledger" }), "/new-ledger");
  assert.equal(ledgerDir({ NOMO_LEDGER_DIR: "", VOID_LEDGER_DIR: "/old-ledger" }), "");
  assert.equal(ledgerDir({ VOID_LEDGER_DIR: "/old-ledger" }), "/old-ledger");
});

test("signing key uses NOMO before VOID", async () => {
  const current = generateKeyPairSync("ed25519");
  const legacy = generateKeyPairSync("ed25519");
  const currentPkcs8 = current.privateKey.export({ format: "der", type: "pkcs8" });
  const legacyPkcs8 = legacy.privateKey.export({ format: "der", type: "pkcs8" });
  const currentSpki = current.publicKey.export({ format: "der", type: "spki" });
  const provider = await devKeyProvider({
    dir: "/unused-nomo-signing-key-test",
    env: {
      NOMO_SIGNING_KEY: currentPkcs8.toString("base64"),
      VOID_SIGNING_KEY: legacyPkcs8.toString("base64"),
    },
  });
  assert.equal(await provider.currentKeyId(), devKeyIdFromSpki(currentSpki));
});

test("verification key uses NOMO before VOID", async () => {
  const current = generateKeyPairSync("ed25519");
  const legacy = generateKeyPairSync("ed25519");
  const currentSpki = current.publicKey.export({ format: "der", type: "spki" });
  const legacySpki = legacy.publicKey.export({ format: "der", type: "spki" });
  const resolved = await resolveVerificationKey({
    env: {
      NOMO_VERIFY_KEY: currentSpki.toString("base64"),
      VOID_VERIFY_KEY: legacySpki.toString("base64"),
    },
  });
  assert.equal(resolved?.keyId, devKeyIdFromSpki(currentSpki));
  assert.equal(resolved?.source, "pinned-env");
});

test("direct alias lookup refuses a name outside the owned allowlist", () => {
  assert.throws(() => envValue({}, "NOMO_CUSTOM" as OwnedNomoEnvKey), /not an owned NOMO environment name/);
  assert.throws(() => legacyEnvKey("HOME"), /must start with NOMO_/);
});
