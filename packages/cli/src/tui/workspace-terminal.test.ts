import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
const binary = fileURLToPath(new URL("../../bin/nomo.mjs", import.meta.url));
const checkoutLauncher = fileURLToPath(
  new URL("../../../../nomo", import.meta.url),
);

test("root help succeeds without opening workspace data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-terminal-help-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await exec(process.execPath, [binary, "--help"], {
    env: { PATH: process.env.PATH, HOME: root, NOMO_DATA_DIR: root },
  });
  assert.deepEqual(await readdir(root), []);
  assert.match(result.stdout, /usage: nomo/);
  assert.match(result.stdout, /recovery/);
  assert.equal(result.stderr, "");
});

test("version prints without opening workspace data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-terminal-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await exec(process.execPath, [binary, "--version"], {
    env: { PATH: process.env.PATH, HOME: root, NOMO_DATA_DIR: root },
  });
  assert.deepEqual(await readdir(root), []);
  assert.match(result.stdout, /^nomo \d+\.\d+\.\d+\n$/);
  assert.equal(result.stderr, "");
});

test("bare nomo and TUI flags open the real workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-terminal-default-tui-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bare = await exec(process.execPath, [binary], {
    env: { PATH: process.env.PATH, HOME: root, NOMO_DATA_DIR: root },
  });
  assert.match(bare.stdout, /Welcome to NOMO|NOMO \/ local workspace/);
  assert.doesNotMatch(bare.stdout, /usage: nomo/);
  const result = await exec(
    process.execPath,
    [binary, "--once", "--view", "runs"],
    {
      env: { PATH: process.env.PATH, HOME: root, NOMO_DATA_DIR: root },
    },
  );
  // The overview leads with whether anything needs attention, then counts.
  assert.match(result.stdout, /Runs 0/);
  assert.doesNotMatch(result.stdout, /usage: nomo/);
  assert.equal(result.stderr, "");
});

test("checkout launcher exposes the same bare nomo command on POSIX", async (t) => {
  if (process.platform === "win32") {
    t.skip("the POSIX launcher is not used on Windows");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "nomo-checkout-launcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await exec(checkoutLauncher, ["--version"], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root },
  });
  assert.match(result.stdout, /^nomo 0\.1\.0\n$/);
  assert.equal(result.stderr, "");
  const tui = await exec(
    checkoutLauncher,
    ["--once", "--view", "runs"],
    {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root, NOMO_DATA_DIR: root },
    },
  );
  assert.match(tui.stdout, /Runs 0/);
  assert.doesNotMatch(tui.stdout, /usage: nomo/);
});

test("one-shot TUI exits unsuccessfully for a corrupt proxy ledger", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-terminal-proof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "ledger"));
  await writeFile(join(root, "ledger", "broken.jsonl"), "not JSON\n");
  await assert.rejects(
    exec(process.execPath, [binary, "tui", "--once", "--view", "ledger"], {
      env: { PATH: process.env.PATH, HOME: root, NOMO_DATA_DIR: root },
    }),
    (error: unknown) => {
      const result = error as { code: number; stdout: string };
      assert.equal(result.code, 1);
      assert.match(result.stdout, /Invalid proxy ledger: broken.jsonl/);
      assert.doesNotMatch(result.stdout, /\x1b/);
      return true;
    },
  );
});

test("shared runs view is available in plain one-shot output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-terminal-runs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await exec(
    process.execPath,
    [binary, "tui", "--once", "--view", "runs"],
    {
      env: { PATH: process.env.PATH, HOME: root, NOMO_DATA_DIR: root },
    },
  );
  // The overview leads with whether anything needs attention, then counts.
  assert.match(result.stdout, /Runs 0/);
  assert.match(result.stdout, /setup-required/);
  assert.doesNotMatch(result.stdout, /\x1b/);
});
