/**
 * The legacy file vault's collection surface is reachable through
 * `nomo recovery collect --surface file`. These tests pin the operator
 * surface end to end: a dry run that predicts and deletes nothing, a real
 * run that deletes exactly the released unpinned artifact the policy
 * proves expired, and the evidence rules both runs share.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

import { runRecoveryCommand } from "./recovery.ts";
import { markVaultLifecycle } from "../../runtime/src/retention.ts";
import { devKeyProvider } from "../../ledger/src/sign.ts";

const fixture = async (t: { after: (fn: () => unknown) => void }) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-file-collect-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { TEST_KEY: randomBytes(32).toString("base64") },
    config = join(dir, "nomo-recovery.json");
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
  // The command reads its signing key from retained state, so the fixture
  // writes the development key the way a first recovery run would have.
  await devKeyProvider({
    dir: join(dir, "state", "keys"),
    env: {},
    createIfMissing: true,
  });
  const root = join(dir, "state", "vault"),
    index = join(dir, "state", "retention-index");
  const put = async (value: string) => {
    const bytes = Buffer.from(value, "utf8"),
      digest = createHash("sha256").update(bytes).digest("hex"),
      path = join(root, "test", digest);
    await mkdir(join(root, "test"), { recursive: true });
    await writeFile(path, bytes);
    return { digest, size: bytes.byteLength, path };
  };
  const age = async (reference: { digest: string }, ms: number) => {
    const when = new Date(Date.now() - ms);
    await utimes(join(root, "test", reference.digest), when, when);
  };
  const release = (reference: { digest: string; size: number }) =>
    markVaultLifecycle({
      root,
      index,
      workspace: "test",
      reference: { digest: reference.digest, keyId: "local", bytes: reference.size },
    });
  const exists = async (path: string) => !!(await stat(path).catch(() => null));
  return {
    dir,
    env,
    config,
    put,
    age,
    release,
    exists,
    journalDir: join(dir, "state", "journal"),
    policyFile: async (policy: unknown) => {
      const path = join(dir, "retention.json");
      await writeFile(path, JSON.stringify(policy));
      return path;
    },
    run: async (...argv: readonly string[]) => {
      const lines: string[] = [];
      const code = await runRecoveryCommand([...argv, "--config", config], env, (line) =>
        lines.push(line),
      );
      return { code, lines };
    },
  };
};

const agePolicy = { version: 1, mode: "age", ttlByKind: { unpinned: 1000, recovery: null, operator: null } } as const;

test("a file-surface dry run predicts the expired released artifact and deletes nothing", async (t) => {
  const f = await fixture(t),
    released = await f.put("released"),
    unmarked = await f.put("unmarked");
  await f.release(released);
  await f.age(released, 60_000);
  await f.age(unmarked, 60_000);
  const policy = await f.policyFile(agePolicy);

  const { code, lines } = await f.run("collect", "--surface", "file", "--retention-policy", policy, "--dry-run");

  assert.equal(code, 0);
  const report = JSON.parse(lines.at(-1)!) as {
    dryRun: boolean;
    surface: string;
    mode: string;
    file: { deleted: number; digests: string[]; skippedPinned: number };
  };
  assert.equal(report.dryRun, true);
  assert.equal(report.surface, "file");
  assert.equal(report.mode, "age");
  assert.equal(report.file.deleted, 1);
  assert.deepEqual(report.file.digests, [released.digest]);
  // The prediction keeps the collector's counts verbatim: the released file
  // is predicted for deletion and the expired protected file is a skip.
  assert.equal(report.file.skippedPinned, 1);
  // A prediction deletes nothing and opens no journal chain.
  assert.equal(await f.exists(released.path), true);
  assert.equal(await f.exists(unmarked.path), true);
  assert.equal(await f.exists(f.journalDir), false);
});

test("a file-surface collection deletes exactly the released expired artifact and signs the run", async (t) => {
  const f = await fixture(t),
    released = await f.put("released"),
    unmarked = await f.put("unmarked");
  await f.release(released);
  await f.age(released, 60_000);
  await f.age(unmarked, 60_000);
  const policy = await f.policyFile(agePolicy);

  const { code, lines } = await f.run("collect", "--surface", "file", "--retention-policy", policy);

  assert.equal(code, 0);
  const report = JSON.parse(lines.at(-1)!) as {
    surface: string;
    mode: string;
    deleted: number;
    freedBytes: number;
    skippedPinned: number;
    retained: number;
  };
  assert.equal(report.surface, "file");
  assert.equal(report.mode, "age");
  assert.deepEqual(
    { deleted: report.deleted, freedBytes: report.freedBytes, skippedPinned: report.skippedPinned, retained: report.retained },
    { deleted: 1, freedBytes: released.size, skippedPinned: 1, retained: 0 },
  );
  assert.equal(await f.exists(released.path), false);
  assert.equal(await f.exists(unmarked.path), true);
  // The run is a signed journal chain like a runtime capture is.
  const chains = await readdir(f.journalDir).catch(() => [] as string[]);
  assert.equal(chains.length > 0, true);
});

test("a file-surface refusal without a policy still deletes nothing", async (t) => {
  const f = await fixture(t),
    artifact = await f.put("kept");
  await f.age(artifact, 60_000);

  const { code, lines } = await f.run("collect", "--surface", "file");

  assert.equal(code, 0);
  const report = JSON.parse(lines.at(-1)!) as { mode: string; deleted: number; file?: unknown };
  assert.equal(report.mode, "manual");
  assert.equal(report.deleted, 0);
  assert.equal("file" in report, false);
  assert.equal(await f.exists(artifact.path), true);
});
