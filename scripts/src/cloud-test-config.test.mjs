import test from "node:test";
import assert from "node:assert/strict";
import { validateCloudTestEnvironment } from "./cloud-test-config.mjs";
const url =
  "postgresql://void_test:fixture@127.0.0.1:5432/void_gui_upgrade_preview";
test("cloud integration refuses missing, remote, production and ambiguous database targets", () => {
  const valid = {
    VOID_TEST_DATABASE_ISOLATED: "1",
    VOID_TEST_DATABASE_URL: url,
  };
  assert.equal(validateCloudTestEnvironment(valid), url);
  for (const env of [
    {},
    { ...valid, VOID_TEST_DATABASE_ISOLATED: "0" },
    { ...valid, DATABASE_URL: "postgresql://production.invalid/db" },
    ...[
      "invalid",
      url.replace("127.0.0.1", "production.invalid"),
      url.replace("void_gui_upgrade_preview", "production"),
      url + "?host=production.invalid",
      url.replace("void_test:", "postgres:"),
    ].map((VOID_TEST_DATABASE_URL) => ({ ...valid, VOID_TEST_DATABASE_URL })),
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
  assert.match(source, /VOID_RECOVERY_DATABASE_TEST\s*=\s*["']1["']/);
  assert.match(source, /verify-managed-postgres\.mjs/);
});
