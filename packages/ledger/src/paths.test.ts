import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DATA_DIR_NAME,
  LEGACY_DATA_DIR_NAME,
  dataDir,
  describeState,
} from "./paths.ts";

const withHome = async (t: TestContext): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), "nomo-paths-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
};

test("with neither directory present the current name is the default", async (t) => {
  const home = await withHome(t);
  assert.equal(dataDir(home), join(home, DATA_DIR_NAME));
});

test("a machine holding only legacy state keeps using it", async (t) => {
  const home = await withHome(t);
  await mkdir(join(home, LEGACY_DATA_DIR_NAME));
  assert.equal(dataDir(home), join(home, LEGACY_DATA_DIR_NAME));
});

test("the current directory wins whenever it exists", async (t) => {
  const home = await withHome(t);
  await mkdir(join(home, LEGACY_DATA_DIR_NAME));
  await mkdir(join(home, DATA_DIR_NAME));
  assert.equal(dataDir(home), join(home, DATA_DIR_NAME));
});

test("resolution never creates anything", async (t) => {
  const home = await withHome(t);
  await mkdir(join(home, LEGACY_DATA_DIR_NAME));
  dataDir(home);
  dataDir(home);
  // A resolver that mkdirs turns a read into a write, and a first run on a
  // read-only home then fails for a reason the operator cannot act on.
  assert.deepEqual(await readdir(home), [LEGACY_DATA_DIR_NAME]);
});

test("describeState names both directories and which one is in force", async (t) => {
  const home = await withHome(t);
  await mkdir(join(home, LEGACY_DATA_DIR_NAME));
  const legacyOnly = describeState(home);
  assert.equal(legacyOnly.active, join(home, LEGACY_DATA_DIR_NAME));
  assert.equal(legacyOnly.currentExists, false);
  assert.equal(legacyOnly.legacyExists, true);
  assert.equal(legacyOnly.migrationSafe, true);

  await mkdir(join(home, DATA_DIR_NAME));
  const both = describeState(home);
  assert.equal(both.active, join(home, DATA_DIR_NAME));
  assert.equal(both.migrationSafe, false);
  assert.match(both.reason ?? "", /already exists/);
});

test("describeState on a fresh machine offers nothing to migrate", async (t) => {
  const home = await withHome(t);
  const fresh = describeState(home);
  assert.equal(fresh.currentExists, false);
  assert.equal(fresh.legacyExists, false);
  assert.equal(fresh.migrationSafe, false);
  assert.match(fresh.reason ?? "", /No legacy/);
});

test("describeState refuses a migration when the two trees differ", async (t) => {
  const home = await withHome(t);
  await mkdir(join(home, LEGACY_DATA_DIR_NAME, "ledger"), { recursive: true });
  await writeFile(join(home, LEGACY_DATA_DIR_NAME, "ledger", "default.jsonl"), "legacy\n");
  await mkdir(join(home, DATA_DIR_NAME, "ledger"), { recursive: true });
  await writeFile(join(home, DATA_DIR_NAME, "ledger", "default.jsonl"), "current\n");

  const state = describeState(home);
  assert.equal(state.migrationSafe, false);
  assert.match(state.reason ?? "", /may differ/);
});

test("describeState refuses when the current tree exists but holds no state", async (t) => {
  const home = await withHome(t);
  await mkdir(join(home, LEGACY_DATA_DIR_NAME, "ledger"), { recursive: true });
  await writeFile(join(home, LEGACY_DATA_DIR_NAME, "ledger", "default.jsonl"), "legacy\n");
  await mkdir(join(home, DATA_DIR_NAME));

  const state = describeState(home);
  assert.equal(state.migrationSafe, false);
  assert.match(state.reason ?? "", /already exists/);
});