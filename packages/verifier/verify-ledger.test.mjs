import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The verifier's own suite, kept out of the published tarball by the `files`
 * field. It exists because the release runner requires every package to report a
 * non-zero test count, and the selftest alone emits plain lines rather than TAP.
 * The assertions here are deliberately thin: the real coverage is the selftest,
 * and duplicating it would be a second implementation of the thing this package
 * exists to keep independent.
 */

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "verify-ledger.mjs");

test("the selftest proves roundtrip, tamper refusal and wrong key refusal", () => {
  const out = execFileSync(process.execPath, [script, "--selftest"], {
    encoding: "utf8",
  });
  assert.match(out, /SELFTEST PASS roundtrip: 3 entries/);
  assert.match(out, /SELFTEST PASS tamper refused/);
  assert.match(out, /SELFTEST PASS wrong key refused/);
  assert.match(out, /SELFTEST PASS integrity-only/);
  assert.match(out, /SELFTEST PASS attestation/);
});

test("invocation with no bundle prints usage rather than crashing", () => {
  let stderr = "";
  let code = 0;
  try {
    execFileSync(process.execPath, [script], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    code = error.status;
    stderr = error.stderr ?? "";
  }
  assert.notEqual(code, 0, "an empty invocation must not exit zero");
  assert.match(stderr, /Usage: void-verify/);
});

test("the package imports nothing that would need installing", () => {
  // A verifier that pulls in a dependency tree inherits that tree's supply chain,
  // which is the thing an independent audit is supposed to be free of.
  const source = execFileSync(
    process.execPath,
    [
      "-e",
      "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8'))",
      script,
    ],
    { encoding: "utf8" },
  );
  const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith("node:"),
      `${specifier} is not a Node built-in, so this file is no longer self contained`,
    );
  }
});
