import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  disposablePostgresUrl,
  parseDisposablePostgresInvocation,
  redactDisposablePostgresSecrets,
} from "./disposable-postgres.mjs";

test("the disposable database URL keeps the exact isolated cloud contract", () => {
  assert.equal(
    disposablePostgresUrl("plain"),
    "postgresql://void_test:plain@127.0.0.1:5432/void_gui_upgrade_preview",
  );
  assert.equal(
    disposablePostgresUrl("p@ss/word"),
    "postgresql://void_test:p%40ss%2Fword@127.0.0.1:5432/void_gui_upgrade_preview",
  );
});

test("the wrapper requires an explicit child command after an optional separator", () => {
  assert.deepEqual(
    parseDisposablePostgresInvocation(["node", "scripts/src/verify-managed-postgres.mjs"]),
    { command: "node", args: ["scripts/src/verify-managed-postgres.mjs"] },
  );
  assert.deepEqual(
    parseDisposablePostgresInvocation(["--", "node", "-e", "process.exit(0)"]),
    { command: "node", args: ["-e", "process.exit(0)"] },
  );
  for (const argv of [[], ["--"]])
    assert.throws(() => parseDisposablePostgresInvocation(argv), /usage/i);
});

test("secret redaction removes both the full URL and its password", () => {
  const password = "p@ss/word";
  const url = disposablePostgresUrl(password);
  const output = `before ${url} middle ${password} after`;
  const redacted = redactDisposablePostgresSecrets(output, { url, password });
  assert.equal(redacted, "before [redacted] middle [redacted] after");
  assert.doesNotMatch(redacted, /p@ss|p%40ss/);
});

test("the child environment opts only the child into the isolated recovery database", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("./disposable-postgres.mjs", import.meta.url), "utf8"),
  );
  assert.match(source, /NOMO_RECOVERY_DATABASE_TEST:\s*"1"/);
  assert.match(source, /NOMO_TEST_DATABASE_ISOLATED:\s*"1"/);
  assert.match(source, /DATABASE_URL:\s*url/);
  assert.match(source, /NOMO_TEST_WS_PROXY:/);
  assert.match(source, /startLocalPostgresWsproxy/);
});

test("the command line reports usage without starting postgres", () => {
  const script = fileURLToPath(new URL("./disposable-postgres.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(`${result.stdout}\n${result.stderr}`, /usage/i);
});
