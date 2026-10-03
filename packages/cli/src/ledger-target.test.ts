/**
 * The four ledger situations that used to collapse into one raw errno, and the
 * exit code `void metrics` reports for each.
 *
 * The suites here all passed while the bug was live because every fixture held
 * a ledger. Nothing asked what happens when the directory an operator passed is
 * readable and empty, which is the case `void doctor` had already reported on a
 * different line and nothing else repeated.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveLedgerTarget } from "./ledger-target.ts";
import { runVerifyCommand } from "./verify.ts";
import { runOperation } from "./operations.ts";

const scratch = async (t: { after: (fn: () => unknown) => void }) => {
  const dir = await mkdtemp(join(tmpdir(), "void-ledger-diagnostics-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

/** `EACCES` is meaningless as root, and a root run must not pass vacuously. */
const canDenyAccess = async (): Promise<boolean> => process.getuid?.() !== 0;

const run = async (
  argv: readonly string[],
): Promise<{ code: number; out: string; err: string }> => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runVerifyCommand(argv, {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    env: {},
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

const metrics = async (
  argv: readonly string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runOperation(
    "metrics",
    argv,
    env,
    (line) => out.push(line),
    (line) => err.push(line),
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
};

describe("resolveLedgerTarget", () => {
  test("an empty directory is named as the directory, not a file inside it", async (t) => {
    const dir = await scratch(t);
    const resolution = await resolveLedgerTarget({
      mode: "workspace",
      ledger: dir,
      env: {},
    });

    if (resolution.ok) assert.fail("an empty directory must not resolve to a ledger");
    assert.equal(resolution.kind, "empty-directory");
    assert.match(resolution.message, new RegExp(dir));
    // The caller's own words back to them: the file they never named is not
    // the subject of the sentence, and neither is an errno.
    assert.doesNotMatch(resolution.message, /default\.jsonl/);
    assert.doesNotMatch(resolution.message, /ENOENT/);
  });

  test("a directory that does not exist reads differently from an empty one", async (t) => {
    const dir = await scratch(t);
    const missing = join(dir, "absent");
    const absent = await resolveLedgerTarget({ mode: "workspace", ledger: missing, env: {} });
    const empty = await resolveLedgerTarget({ mode: "workspace", ledger: dir, env: {} });

    if (absent.ok || empty.ok)
      assert.fail("an absent path and an empty directory must both be refused");
    assert.notEqual(absent.kind, empty.kind);
    assert.match(absent.message, /does not exist/);
    assert.match(empty.message, /is empty/);
    // Both name the path they were given, so the two sentences are comparable.
    assert.match(absent.message, new RegExp(missing));
    assert.match(empty.message, new RegExp(dir));
  });

  test("an unreadable path is a third case, not a second spelling of missing", async (t) => {
    const dir = await scratch(t);
    if (!(await canDenyAccess())) {
      t.skip("running as root: file modes do not deny access, so this proves nothing");
      return;
    }
    const sealed = join(dir, "sealed");
    await mkdir(sealed);
    await chmod(sealed, 0o000);
    const missing = join(dir, "absent");
    const unreadable = await resolveLedgerTarget({ mode: "workspace", ledger: sealed, env: {} });
    const absent = await resolveLedgerTarget({ mode: "workspace", ledger: missing, env: {} });

    if (unreadable.ok || absent.ok)
      assert.fail("an unreadable path must be refused, not resolved");
    assert.equal(unreadable.kind, "unreadable");
    assert.match(unreadable.message, /permissions problem/);
    assert.notEqual(unreadable.kind, absent.kind);
    assert.match(unreadable.message, new RegExp(sealed));
  });

  test("a directory holding other workspaces names the workspace it wanted", async (t) => {
    const dir = await scratch(t);
    await writeFile(join(dir, "other.jsonl"), "");

    const resolution = await resolveLedgerTarget({ mode: "workspace", ledger: dir, env: {} });

    if (resolution.ok) assert.fail("a directory without this workspace must not resolve");
    assert.equal(resolution.kind, "workspace-absent");
    assert.match(resolution.message, /default\.jsonl/);
    assert.match(resolution.message, /other\.jsonl/);
  });

  test("a scan of an empty directory is a measurement, not a refusal", async (t) => {
    const dir = await scratch(t);

    const resolution = await resolveLedgerTarget({ mode: "scan", ledger: dir, env: {} });

    assert.equal(resolution.ok, true);
    assert.equal(resolution.directory, true);
    assert.equal(resolution.path, dir);
  });
});

describe("void verify on a ledger it cannot read", () => {
  test("an empty directory names the directory and exits non-zero", async (t) => {
    const dir = await scratch(t);

    const result = await run(["--ledger", dir]);

    assert.equal(result.code, 1);
    assert.match(result.err, new RegExp(dir));
    assert.doesNotMatch(result.err, /ENOENT/);
    assert.doesNotMatch(result.err, /default\.jsonl/);
  });

  test("a missing path is not reported as an empty directory", async (t) => {
    const dir = await scratch(t);

    const result = await run(["--ledger", join(dir, "absent")]);

    assert.equal(result.code, 1);
    assert.match(result.err, /does not exist/);
    assert.doesNotMatch(result.err, /is empty/);
  });

  test("--file pointed at a directory says so instead of failing to read", async (t) => {
    const dir = await scratch(t);

    const result = await run(["--file", dir]);

    assert.equal(result.code, 1);
    assert.match(result.err, /is a directory, not a ledger file/);
    assert.match(result.err, new RegExp(dir));
  });
});

describe("void metrics exit code", () => {
  test("it exits non-zero when it cannot measure, and says what it passed", async (t) => {
    const dir = await scratch(t);
    const missing = join(dir, "absent");

    const result = await metrics(["--ledger", missing]);

    assert.equal(result.code, 1, "a probe must not record a healthy pipeline when nothing was counted");
    assert.match(result.err, new RegExp(missing));
    assert.doesNotMatch(result.err, /ENOENT/);
    // Nothing was measured, so no counters were printed on stdout where a
    // scraper would read them as a healthy reading.
    assert.doesNotMatch(result.out, /void_ledger_entries_total/);
  });

  test("it exits zero for an empty directory, which is a real measurement", async (t) => {
    const dir = await scratch(t);

    const result = await metrics(["--ledger", dir]);

    assert.equal(result.code, 0);
    assert.match(result.out, /void_ledger_files_total 0/);
    assert.match(result.out, /void_ledger_entries_total 0/);
  });

  test("it exits zero when it counted a ledger, in either format", async (t) => {
    const dir = await scratch(t);
    await writeFile(join(dir, "broken.jsonl"), "not json\n");

    const text = await metrics(["--ledger", dir]);
    const json = await metrics(["--ledger", dir, "--format", "json"]);

    assert.equal(text.code, 0);
    assert.match(text.out, /void_ledger_files_unreadable_total 1/);
    assert.equal(json.code, 0);
    assert.match(JSON.parse(json.out).schema, /void\.metrics\.v1/);
  });
});