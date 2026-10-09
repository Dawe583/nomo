import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DATA_DIR_NAME, LEGACY_DATA_DIR_NAME, dataDir } from "../../ledger/src/paths.ts";
import { devKeyProvider } from "../../ledger/src/sign.ts";
import { jsonlStore } from "../../ledger/src/store.ts";
import { readLedgerEntries, verifyChain } from "../../ledger/src/verify.ts";
import { LocalStorage } from "../../workbench/src/storage.ts";
import { migrateState, runMigrateStateCommand, stateSummary } from "./migrate-state.ts";

const withHome = async (t: TestContext): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), "nomo-migrate-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
};

/** The shapes that matter in a legacy tree: a ledger, keys, and approvals. */
const LEGACY_FIXTURE: Record<string, string> = {
  [join("ledger", "default.jsonl")]: '{"workspace":"default","seq":1}\n',
  [join("keys", "dev-ed25519.pkcs8")]: "synthetic-private-key-bytes",
  [join("approvals", "default", "hold-1.json")]: '{"holdId":"hold-1","by":"operator"}\n',
  [join("workbench", "workspace.enc")]: "synthetic-encrypted-state",
};

const seedLegacy = async (home: string): Promise<void> => {
  const legacy = join(home, LEGACY_DATA_DIR_NAME);
  for (const [path, content] of Object.entries(LEGACY_FIXTURE)) {
    const full = join(legacy, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, { mode: 0o600 });
  }
};

const hashTree = async (root: string): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.set(relative(root, path), createHash("sha256").update(await readFile(path)).digest("hex"));
    }
  };
  await walk(root);
  return out;
};

test("a legacy tree migrates and every file arrives byte for byte", async (t) => {
  const home = await withHome(t);
  await seedLegacy(home);

  const result = await migrateState(home);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.from, join(home, LEGACY_DATA_DIR_NAME));
  assert.equal(result.to, join(home, DATA_DIR_NAME));
  assert.equal(result.verified, true);

  const legacy = await hashTree(join(home, LEGACY_DATA_DIR_NAME));
  const current = await hashTree(join(home, DATA_DIR_NAME));
  assert.deepEqual([...current.entries()].sort(), [...legacy.entries()].sort());
});

test("the source survives the migration with identical bytes", async (t) => {
  const home = await withHome(t);
  await seedLegacy(home);
  await migrateState(home);

  for (const [path, content] of Object.entries(LEGACY_FIXTURE))
    assert.equal(await readFile(join(home, LEGACY_DATA_DIR_NAME, path), "utf8"), content, path);
});

test("the resolver switches to the migrated tree afterwards", async (t) => {
  const home = await withHome(t);
  await seedLegacy(home);
  assert.equal(dataDir(home), join(home, LEGACY_DATA_DIR_NAME));

  await migrateState(home);
  assert.equal(dataDir(home), join(home, DATA_DIR_NAME));
});

test("a home with no legacy tree is refused with a reason", async (t) => {
  const home = await withHome(t);
  const result = await migrateState(home);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /No legacy/);
});

test("two populated trees are refused and neither is touched", async (t) => {
  const home = await withHome(t);
  await seedLegacy(home);
  const current = join(home, DATA_DIR_NAME);
  await mkdir(join(current, "ledger"), { recursive: true });
  await writeFile(join(current, "ledger", "default.jsonl"), "different\n");

  const result = await migrateState(home);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /may differ/);
  assert.equal(await readFile(join(current, "ledger", "default.jsonl"), "utf8"), "different\n");
  assert.equal(
    await readFile(join(home, LEGACY_DATA_DIR_NAME, "ledger", "default.jsonl"), "utf8"),
    '{"workspace":"default","seq":1}\n',
  );
});

test("an interrupted run leaves no staging directory and no destination", async (t) => {
  const home = await withHome(t);
  await seedLegacy(home);
  // A staging directory from a killed run is the state an operator retries
  // from, so it must not be mistaken for either tree.
  const staging = join(home, `.${DATA_DIR_NAME}.migrating`);
  await mkdir(join(staging, "ledger"), { recursive: true });
  await writeFile(join(staging, "ledger", "half.jsonl"), '{"partial":');

  const result = await migrateState(home);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // The stale staging copy is gone, replaced by the verified one.
  await assert.rejects(readFile(join(current(home), "ledger", "half.jsonl"), "utf8"));
  assert.deepEqual(await readdir(join(home, DATA_DIR_NAME, "ledger")), ["default.jsonl"]);
});

const current = (home: string): string => join(home, DATA_DIR_NAME);

test("the command prints what it did and exits zero", async (t) => {
  const home = await withHome(t);
  await seedLegacy(home);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMigrateStateCommand([], {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  }, { home });
  assert.equal(code, 0);
  assert.match(out.join("\n"), /verified byte for byte/);
  assert.match(out.join("\n"), /untouched/);
  assert.deepEqual(err, []);
});

test("the command refuses on stderr and exits one", async (t) => {
  const home = await withHome(t);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMigrateStateCommand([], {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  }, { home });
  assert.equal(code, 1);
  assert.deepEqual(out, []);
  assert.match(err.join("\n"), /No legacy/);
});

test("the command refuses an unknown flag with usage and exit two", async (t) => {
  const home = await withHome(t);
  const err: string[] = [];
  const code = await runMigrateStateCommand(["--force"], {
    stdout: () => {},
    stderr: (line) => err.push(line),
  }, { home });
  assert.equal(code, 2);
  assert.match(err.join("\n"), /usage: nomo state migrate/);
});

test("there is no flag that skips the conflict refusal", async (t) => {
  const home = await withHome(t);
  await seedLegacy(home);
  await mkdir(join(home, DATA_DIR_NAME), { recursive: true });

  for (const flag of ["--force", "--overwrite", "--merge"]) {
    const err: string[] = [];
    const code = await runMigrateStateCommand([flag], {
      stdout: () => {},
      stderr: (line) => err.push(line),
    }, { home });
    assert.equal(code, 2, flag);
  }
  assert.equal(stateSummary(home).migrationSafe, false);
});

test("the command reports JSON on request without printing a path it did not use", async (t) => {
  const home = await withHome(t);
  await seedLegacy(home);
  const out: string[] = [];
  const code = await runMigrateStateCommand(["--json"], {
    stdout: (line) => out.push(line),
    stderr: () => {},
  }, { home });
  assert.equal(code, 0);
  const report = JSON.parse(out.join("\n")) as Record<string, unknown>;
  assert.equal(report.ok, true);
  assert.equal(report.currentName, DATA_DIR_NAME);
  assert.equal(report.legacyName, LEGACY_DATA_DIR_NAME);
});

test("a migrated ledger still verifies with the existing verifier", async (t) => {
  const home = await withHome(t);
  // A copy that passed a hash comparison against the source proves the bytes
  // moved, not that the product can still read them. This signs a real chain
  // into the legacy tree, migrates, and puts the existing verifier over the
  // migrated copy.
  const dir = join(home, LEGACY_DATA_DIR_NAME);
  await mkdir(join(dir, "ledger"), { recursive: true, mode: 0o700 });
  const keyDir = join(dir, "keys");
  await mkdir(keyDir, { recursive: true, mode: 0o700 });
  const key = await devKeyProvider({ dir: keyDir, env: {} });
  const store = jsonlStore(key, { dir: join(dir, "ledger") });
  await store.append({
    workspace: "default",
    at: "2026-10-08T00:00:00.000Z",
    tool: "fixture.write",
    klass: "r1",
    decision: "allow",
    argsDigest: "b".repeat(64),
  });
  const before = await verifyChain(
    await readLedgerEntries(join(dir, "ledger", "default.jsonl")),
    { publicKey: (id) => key.publicKey(id) },
  );
  assert.equal(before.ok, true);

  const result = await migrateState(home);
  assert.equal(result.ok, true);

  const after = await verifyChain(
    await readLedgerEntries(join(home, DATA_DIR_NAME, "ledger", "default.jsonl")),
    { publicKey: (id) => key.publicKey(id) },
  );
  assert.equal(after.ok, true, "the migrated chain no longer verifies");
});

test("a migrated workspace state is still readable with the key beside it", async (t) => {
  const home = await withHome(t);
  // A real encrypted snapshot and its key file, written under the legacy name
  // by the same storage the product uses, then read back after the copy
  // through that same reader. This is the key continuity the spec asks for:
  // the key moved with the state, so the state still opens.
  const legacyWorkbench = join(home, LEGACY_DATA_DIR_NAME, "workbench");
  const storage = new LocalStorage(legacyWorkbench);
  storage.save({ preferences: { theme: "dark" } });
  const encrypted = await readFile(join(legacyWorkbench, "workspace.enc"));
  const key = await readFile(join(legacyWorkbench, "workspace.key"));

  await seedLegacy(home);
  await writeFile(join(legacyWorkbench, "workspace.enc"), encrypted);
  await writeFile(join(legacyWorkbench, "workspace.key"), key, { mode: 0o600 });

  assert.equal((await migrateState(home)).ok, true);

  const migrated = new LocalStorage(join(home, DATA_DIR_NAME, "workbench"));
  assert.deepEqual(migrated.read(), { preferences: { theme: "dark" } });
});