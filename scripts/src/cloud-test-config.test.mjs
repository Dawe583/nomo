import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCloudTestEnvironment,
  validateCloudTestProxy,
} from "./cloud-test-config.mjs";
const url =
  "postgresql://void_test:fixture@127.0.0.1:5432/void_gui_upgrade_preview";
test("cloud integration refuses missing, remote, production and ambiguous database targets", () => {
  const valid = {
    NOMO_TEST_DATABASE_ISOLATED: "1",
    NOMO_TEST_DATABASE_URL: url,
  };
  assert.equal(validateCloudTestEnvironment(valid), url);
  for (const env of [
    {},
    { ...valid, NOMO_TEST_DATABASE_ISOLATED: "0" },
    { ...valid, DATABASE_URL: "postgresql://production.invalid/db" },
    ...[
      "invalid",
      url.replace("127.0.0.1", "production.invalid"),
      url.replace("void_gui_upgrade_preview", "production"),
      url + "?host=production.invalid",
      url.replace("void_test:", "postgres:"),
    ].map((NOMO_TEST_DATABASE_URL) => ({ ...valid, NOMO_TEST_DATABASE_URL })),
  ])
    assert.throws(
      () => validateCloudTestEnvironment(env),
      /explicitly isolated/,
    );
});

test("cloud integration runs the managed PostgreSQL crash verifier", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("./check-cloud-integration.mjs", import.meta.url), "utf8"),
  );
  assert.match(source, /NOMO_RECOVERY_DATABASE_TEST\s*=\s*["']1["']/);
  assert.match(source, /verify-managed-postgres\.mjs/);
});

test("cloud integration accepts only an explicit loopback WebSocket proxy", () => {
  assert.equal(validateCloudTestProxy({}), "127.0.0.1:5433/v1");
  assert.equal(
    validateCloudTestProxy({ NOMO_TEST_WS_PROXY: "127.0.0.1:5434/v1" }),
    "127.0.0.1:5434/v1",
  );
  for (const value of [
    "localhost:5434/v1",
    "production.invalid:5433/v1",
    "127.0.0.1:5434",
    "127.0.0.1:5434/v2",
    "127.0.0.1:0/v1",
    "127.0.0.1:65536/v1",
    "127.0.0.1:99999/v1",
  ])
    assert.throws(
      () => validateCloudTestProxy({ NOMO_TEST_WS_PROXY: value }),
      /loopback WebSocket proxy/,
    );
});
