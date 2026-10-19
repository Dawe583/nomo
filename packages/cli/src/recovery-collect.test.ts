/**
 * The retention collector became reachable through `nomo recovery collect`.
 * These tests pin the operator surface: a manual default that deletes
 * nothing, an age policy that deletes only what the recorded lifecycle
 * proves unpinned, and refusals that name the file or field they came from.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { runRecoveryCommand } from "./recovery.ts";
import {
  reservedRecoveryVault,
} from "../../runtime/src/index.ts";
import { devKeyProvider } from "../../ledger/src/sign.ts";

const fixture = async (t: { after: (fn: () => unknown) => void }) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-recovery-collect-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { TEST_KEY: randomBytes(32).toString("base64") },
    config = join(dir, "nomo-recovery.json");
  // A collect configuration is the workspace's recovery configuration, so it
  // carries the adapter block every other action requires too.
  await mkdir(join(dir, "project"), { recursive: true });
  await writeFile(
    config,
    JSON.stringify({
      workspace: "test",
      stateDir: "state",
      encryptionKeyEnv: "TEST_KEY",
      filesystem: { root: "project", cooperative: true },
    }),
  );
  const key = Buffer.from(env.TEST_KEY, "base64"),
    vault = reservedRecoveryVault(join(dir, "state", "vault"), { local: key }, "local");
  // The command reads its signing key from retained state, so the fixture
  // writes the development key the way a first recovery run would have.
  await devKeyProvider({
    dir: join(dir, "state", "keys"),
    env: {},
    createIfMissing: true,
  });
  const put = (value: string) => vault.put("test", value);
  const age = async (reference: { digest: string }, ms: number) => {
    const database = new DatabaseSync(join(dir, "state", "vault", "vault.sqlite"));
    try {
      database
        .prepare("UPDATE artifacts SET at=? WHERE workspace=? AND digest=?")
        .run(new Date(Date.UTC(2026, 0, 2) - ms).toISOString(), "test", reference.digest);
    } finally {
      database.close();
    }
  };
  const policyFile = async (policy: unknown) => {
    const path = join(dir, "retention.json");
    await writeFile(path, typeof policy === "string" ? policy : JSON.stringify(policy));
    return path;
  };
  return {
    dir,
    env,
    config,
    put,
    age,
    policyFile,
    run: async (...argv: readonly string[]) => {
      const lines: string[] = [];
      const code = await runRecoveryCommand([...argv, "--config", config], env, (line) =>
        lines.push(line),
      );
      return { code, lines };
    },
  };
};

test("the default manual policy is a dry run: it reports and deletes nothing", async (t) => {
  const f = await fixture(t);
  const artifact = await f.put("kept");
  await f.age(artifact, 60_000);

  const { code, lines } = await f.run("collect");

  assert.equal(code, 0);
  const report = JSON.parse(lines.at(-1)!) as {
    mode: string;
    deleted: number;
    retained: number;
    skippedPinned: number;
    freedBytes: number;
  };
  assert.equal(report.mode, "manual");
  assert.deepEqual(
    { deleted: report.deleted, retained: report.retained, skippedPinned: report.skippedPinned },
    { deleted: 0, retained: 1, skippedPinned: 0 },
  );
  // No policy means no deletes, so the artifact survives the dry run.
  assert.equal(await requireVault(f, artifact), "kept");
});

test("an age policy deletes what the recorded lifecycle leaves unpinned", async (t) => {
  const f = await fixture(t);
  const released = await f.put("released"),
    unmarked = await f.put("unmarked");
  // Marking with no pin is the documented release-for-retention record.
  const key = Buffer.from(f.env.TEST_KEY, "base64");
  const vault = reservedRecoveryVault(
    join(f.dir, "state", "vault"),
    { local: key },
    "local",
  );
  await vault.markVaultLifecycle("test", released, {});
  await f.age(released, 60_000);
  await f.age(unmarked, 60_000);
  const policy = await f.policyFile({
    version: 1,
    mode: "age",
    ttlByKind: { unpinned: 1000, recovery: null, operator: null },
  });

  const { code, lines } = await f.run("collect", "--retention-policy", policy);

  assert.equal(code, 0);
  const report = JSON.parse(lines.at(-1)!) as {
    mode: string;
    deleted: number;
    freedBytes: number;
  };
  assert.equal(report.mode, "age");
  assert.equal(report.deleted, 1);
  assert.equal(report.freedBytes, released.bytes);
  assert.equal(await requireVault(f, unmarked), "unmarked");
  await assert.rejects(requireVault(f, released), /unavailable|ENOENT/);
});

test("a retention policy that is not valid JSON is refused by name", async (t) => {
  const f = await fixture(t);
  const policy = await f.policyFile("{not json");

  const lines: string[] = [];
  await assert.rejects(
    runRecoveryCommand(
      ["collect", "--config", f.config, "--retention-policy", policy],
      f.env,
      (line) => lines.push(line),
    ),
    (error: Error) => {
      assert.match(error.message, /not valid JSON/);
      assert.match(error.message, /retention\.json/);
      return true;
    },
  );
});

test("a retention policy that fails the schema is refused with its rule", async (t) => {
  const f = await fixture(t);
  const policy = await f.policyFile({
    version: 1,
    mode: "age",
    ttlByKind: { unpinned: 1000 },
  });

  await assert.rejects(
    runRecoveryCommand(
      ["collect", "--config", f.config, "--retention-policy", policy],
      f.env,
      () => {},
    ),
    /ttl block is missing recovery/,
  );
});

test("collect --dry-run predicts the deletes and leaves every artifact in place", async (t) => {
  const f = await fixture(t);
  const released = await f.put("released"),
    unmarked = await f.put("unmarked");
  const key = Buffer.from(f.env.TEST_KEY, "base64");
  const vault = reservedRecoveryVault(
    join(f.dir, "state", "vault"),
    { local: key },
    "local",
  );
  await vault.markVaultLifecycle("test", released, {});
  await f.age(released, 60_000);
  await f.age(unmarked, 60_000);
  const policy = await f.policyFile({
    version: 1,
    mode: "age",
    ttlByKind: { unpinned: 1000, recovery: null, operator: null },
  });

  const { code, lines } = await f.run(
    "collect",
    "--dry-run",
    "--retention-policy",
    policy,
  );

  assert.equal(code, 0);
  const report = JSON.parse(lines.at(-1)!) as {
    dryRun: boolean;
    mode: string;
    deleted: number;
    freedBytes: number;
    digests: string[];
  };
  assert.equal(report.dryRun, true);
  assert.equal(report.mode, "age");
  assert.deepEqual(report.digests, [released.digest]);
  assert.equal(report.freedBytes, released.bytes);
  // Nothing was collected: both artifacts are still readable.
  assert.equal(await requireVault(f, released), "released");
  assert.equal(await requireVault(f, unmarked), "unmarked");
  // A prediction is not an operation, so no journal directory was created.
  const writes = await readdir(join(f.dir, "state", "journal")).catch(
    (error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? [] : Promise.reject(error),
  );
  assert.deepEqual(writes, []);
});
async function requireVault(
  f: Awaited<ReturnType<typeof fixture>>,
  reference: { digest: string; keyId: string; bytes: number },
): Promise<string> {
  const key = Buffer.from(f.env.TEST_KEY, "base64");
  const vault = reservedRecoveryVault(join(f.dir, "state", "vault"), { local: key }, "local");
  const value = await vault.get("test", reference);
  return typeof value === "string" ? value : JSON.stringify(value);
}
