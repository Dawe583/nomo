import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
const binary = fileURLToPath(new URL("../../bin/void.mjs", import.meta.url));
const checkoutLauncher = fileURLToPath(
  new URL("../../../../void", import.meta.url),
);

test("root help succeeds without opening workspace data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-terminal-help-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await exec(process.execPath, [binary, "--help"], {
    env: { PATH: process.env.PATH, HOME: root, VOID_DATA_DIR: root },
  });
  assert.deepEqual(await readdir(root), []);
  assert.match(result.stdout, /usage: void/);
  assert.match(result.stdout, /recovery/);
  assert.equal(result.stderr, "");
});

test("version prints without opening workspace data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-terminal-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await exec(process.execPath, [binary, "--version"], {
    env: { PATH: process.env.PATH, HOME: root, VOID_DATA_DIR: root },
  });
  assert.deepEqual(await readdir(root), []);
  assert.match(result.stdout, /^void \d+\.\d+\.\d+\n$/);
  assert.equal(result.stderr, "");
});

test("bare void and TUI flags open the real workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-terminal-default-tui-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bare = await exec(process.execPath, [binary], {
    env: { PATH: process.env.PATH, HOME: root, VOID_DATA_DIR: root },
  });
  assert.match(bare.stdout, /Welcome to VOID|VOID \/ local workspace/);
  assert.doesNotMatch(bare.stdout, /usage: void/);
  const result = await exec(
    process.execPath,
    [binary, "--once", "--view", "runs"],
    {
      env: { PATH: process.env.PATH, HOME: root, VOID_DATA_DIR: root },
    },
  );
  assert.match(result.stdout, /Runs: 0/);
  assert.doesNotMatch(result.stdout, /usage: void/);
  assert.equal(result.stderr, "");
});

test("checkout launcher exposes the same bare void command on POSIX", async (t) => {
  if (process.platform === "win32") {
    t.skip("the POSIX launcher is not used on Windows");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "void-checkout-launcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await exec(checkoutLauncher, ["--version"], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root },
  });
  assert.match(result.stdout, /^void 0\.1\.0\n$/);
  assert.equal(result.stderr, "");
  const tui = await exec(
    checkoutLauncher,
    ["--once", "--view", "runs"],
    {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root, VOID_DATA_DIR: root },
    },
  );
  assert.match(tui.stdout, /Runs: 0/);
  assert.doesNotMatch(tui.stdout, /usage: void/);
});

test("one-shot TUI exits unsuccessfully for a corrupt proxy ledger", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-terminal-proof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "ledger"));
  await writeFile(join(root, "ledger", "broken.jsonl"), "not JSON\n");
  await assert.rejects(
    exec(process.execPath, [binary, "tui", "--once", "--view", "ledger"], {
      env: { PATH: process.env.PATH, HOME: root, VOID_DATA_DIR: root },
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
  const root = await mkdtemp(join(tmpdir(), "void-terminal-runs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await exec(
    process.execPath,
    [binary, "tui", "--once", "--view", "runs"],
    {
      env: { PATH: process.env.PATH, HOME: root, VOID_DATA_DIR: root },
    },
  );
  assert.match(result.stdout, /Runs: 0/);
  assert.match(result.stdout, /setup-required/);
  assert.doesNotMatch(result.stdout, /\x1b/);
});
