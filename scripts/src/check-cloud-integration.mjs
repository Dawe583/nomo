import assert from "node:assert/strict";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { configureCloudTest } from "./cloud-test-config.mjs";

await configureCloudTest(); // Refuse unsafe configuration before importing the store.
process.env.VOID_GUI_DATABASE_TEST = "1";
process.env.VOID_RECOVERY_DATABASE_TEST = "1";
process.env.VOID_CONTROL_TOKEN = randomBytes(32).toString("hex");
process.env.VOID_SECRET_KEY = randomBytes(32).toString("base64");
process.env.VOID_SIGNING_KEY = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "der" })
  .toString("base64");
const root = fileURLToPath(new URL("../../", import.meta.url));
const { database } = await import("../../cloud/store.mjs");
try {
  await database().query(
    await readFile(new URL("../../cloud/schema.sql", import.meta.url), "utf8"),
  );
} finally {
  await database().end();
}

function run(args) {
  const result = spawnSync(
    process.execPath,
    ["--import", "./scripts/src/cloud-test-preload.mjs", ...args],
    {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      timeout: 180000,
    },
  );
  // All credentials here are disposable; still redact them from failure output.
  let output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  for (const key of [
    "DATABASE_URL",
    "VOID_CONTROL_TOKEN",
    "VOID_SECRET_KEY",
    "VOID_SIGNING_KEY",
  ])
    output = output.replaceAll(process.env[key], "[redacted]");
  process.stdout.write(output);
  assert.equal(
    result.status,
    0,
    "Cloud integration subprocess failed or timed out",
  );
  return output;
}
const output = run([
  "--test",
  "--test-reporter=tap",
  "cloud/gui.test.mjs",
  "cloud/recovery.test.mjs",
]);
assert.match(output, /^# tests 2$/m, "Both target scenarios must execute");
assert.match(output, /^# pass 2$/m);
assert.match(
  output,
  /^# skipped 0$/m,
  "Skipped integration tests cannot pass the gate",
);
run(["scripts/src/check-managed-cloud.mjs"]);
run(["scripts/src/verify-managed-postgres.mjs"]);
