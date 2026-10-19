import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
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
  assert.match(stderr, /Usage: nomo-verify/);
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

/**
 * A third party runs this file to check an export without trusting us, so the
 * failure text is part of what it is for. Every way the argument can fail to
 * name a bundle gets its own sentence: the case that produced `cannot read
 * bundle <dir>` for a readable, empty directory is the one an audit script is
 * most likely to meet first.
 */
const invoke = (args, options = {}) => {
  let stdout = "";
  let stderr = "";
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      stdio: "pipe",
      ...options,
    });
  } catch (error) {
    status = error.status;
    stdout = error.stdout ?? "";
    stderr = error.stderr ?? "";
  }
  return { stdout, stderr, status };
};

const scratchDir = () =>
  mkdtempSync(join(tmpdir(), "nomo-verify-args-"));

test("an empty directory is answered as an empty directory", (t) => {
  const dir = scratchDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = invoke(["--dir", dir]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is an empty directory/);
  assert.doesNotMatch(result.stderr, /cannot read bundle/);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});

test("a path that does not exist is a different sentence from an empty directory", (t) => {
  const dir = scratchDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = join(dir, "export.jsonl");

  const absent = invoke([missing]);
  const empty = invoke([dir]);

  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /does not exist/);
  assert.doesNotMatch(absent.stderr, /is an empty directory/);
  assert.notEqual(absent.stderr, empty.stderr);
});

test("a malformed bundle is answered as malformed, not as a missing path", (t) => {
  const dir = scratchDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundle = join(dir, "export.jsonl");
  writeFileSync(bundle, "{ this is not json\n");

  const result = invoke([bundle]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ledger line 1 is not JSON/);
  assert.doesNotMatch(result.stderr, /does not exist|is an empty directory/);
});

test("a directory holding one bundle is read, and the file read is echoed", (t) => {
  const dir = scratchDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // An empty file is a bundle with no entries: that is a verdict about content,
  // and it must not be confused with a verdict about the argument.
  writeFileSync(join(dir, "export.jsonl"), "");

  const result = invoke(["--dir", dir]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bundle holds no entries/);
  assert.doesNotMatch(result.stderr, /is an empty directory|does not exist/);
});

test("a directory holding several bundles refuses to guess which one was meant", (t) => {
  const dir = scratchDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "a.jsonl"), "");
  writeFileSync(join(dir, "b.jsonl"), "");

  const result = invoke(["--dir", dir]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /holds 2 bundles \(a\.jsonl, b\.jsonl\)/);
});

test("a bundle over the byte limit is refused", (t) => {
  const dir = scratchDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundle = join(dir, "large.jsonl");
  writeFileSync(bundle, "");
  truncateSync(bundle, 64 * 1024 * 1024 + 1);

  const result = invoke([bundle]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bundle exceeds the 67108864 byte read limit/);
});

test("a FIFO bundle is refused without waiting for data", (t) => {
  if (process.platform === "win32") {
    t.skip("mkfifo is a POSIX utility");
    return;
  }
  const dir = scratchDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fifo = join(dir, "pipe.jsonl");
  execFileSync("mkfifo", [fifo]);

  const result = invoke([fifo], { timeout: 1000 });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a regular file/);
});
