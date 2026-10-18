import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { jsonlStore } from "../../ledger/src/store.ts";
import { devKeyProvider } from "../../ledger/src/sign.ts";
import { inspectRecoveryHealth } from "./recovery-health.ts";
import { runRecoveryCommand } from "./recovery.ts";
import { reservedRecoveryVault } from "../../runtime/src/reserved-vault.ts";


async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "nomo-health-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const signer = await devKeyProvider({
    dir: join(stateDir, "keys"),
    env: {},
  });
  const store = jsonlStore(signer, { dir: join(stateDir, "journal") });
  await store.append({
    schema: "void.operation.v1",
    workspace: "test",
    operationId: "op",
    requestDigest: "a".repeat(64),
    adapterId: "filesystem.managed",
    adapterVersion: "1",
    agentId: "agent",
    runId: "run",
    at: new Date().toISOString(),
    stage: "received",
    data: null,
  });
  const key = randomBytes(32);
  const vault = reservedRecoveryVault(
    join(stateDir, "vault"),
    { local: key },
    "local",
    { maxArtifactBytes: 1024, maxTotalBytes: 4096 },
  );
  await vault.put("test", "evidence");
  return { root, stateDir, key, store };
}

test("health reports verified history, vault capacity and retained unknown work", async (t) => {
  const f = await fixture(t);
  await f.store.append({
    schema: "void.operation.v1",
    workspace: "test",
    operationId: "op",
    requestDigest: "a".repeat(64),
    adapterId: "filesystem.managed",
    adapterVersion: "1",
    agentId: "agent",
    runId: "run",
    at: new Date().toISOString(),
    stage: "unknown",
    data: null,
  });
  await f.store.append({
    schema: "void.recovery-job.v1",
    workspace: "test",
    jobId: "job",
    planDigest: "b".repeat(64),
    at: new Date().toISOString(),
    stage: "paused",
    data: null,
  });
  const report = await inspectRecoveryHealth({
    stateDir: f.stateDir,
    workspace: "test",
    adapter: { id: "filesystem.managed", version: "1" },
    encryptionKey: f.key,
  });
  assert.equal(report.status, "degraded");
  assert.equal(report.state.signingKey, "available");
  assert.equal(report.state.journal, "verified");
  assert.equal(report.state.vault, "verified");
  assert.equal(report.jobs.paused, 1);
  assert.equal(report.jobs.unknown, 1);
  assert.equal(report.capacity.artifacts, 1);
  assert.ok(report.capacity.usedBytes > 0);
  // Schema 2 carries the retention surface, and an artifact with no recorded
  // lifecycle is the protected-but-unprovable case the summary names.
  assert.deepEqual(report.retention, {
    present: true,
    evidence: 0,
    pinned: 0,
    released: 0,
    withoutEvidence: 1,
  });
  assert.deepEqual(report.repairs, ["review-retained-unknown-work"]);
});

test("health reports the vault's retention evidence in one summary", async (t) => {
  const f = await fixture(t);
  const vault = reservedRecoveryVault(
    join(f.stateDir, "vault"),
    { local: f.key },
    "local",
    { maxArtifactBytes: 1024, maxTotalBytes: 4096 },
  );
  const orphan = await vault.put("test", "orphan");
  const pinned = await vault.put("test", "pinned");
  const released = await vault.put("test", "released");
  await vault.markVaultLifecycle("test", pinned, {
    pin: { ownerId: "operator-1", kind: "recovery" },
  });
  await vault.markVaultLifecycle("test", released, {
    pin: { ownerId: "operator-1", kind: "recovery" },
  });
  await vault.releaseVaultPin("test", released, {
    pin: { ownerId: "operator-1", kind: "recovery" },
    operatorId: "operator-2",
  });
  const report = await inspectRecoveryHealth({
    stateDir: f.stateDir,
    workspace: "test",
    adapter: { id: "filesystem.managed", version: "1" },
    encryptionKey: f.key,
  });
  assert.equal(report.state.vault, "verified");
  assert.deepEqual(report.retention, {
    present: true,
    evidence: 2,
    pinned: 1,
    released: 1,
    withoutEvidence: /* fixture seed + orphan */ 2,
  });
  assert.equal(await vault.get("test", orphan), "orphan");
});

test("health is read-only and refuses missing or mismatched retained keys", async (t) => {
  const f = await fixture(t);
  const keyPath = join(f.stateDir, "keys", "dev-ed25519.pkcs8");
  const before = await readFile(keyPath);
  const wrong = await inspectRecoveryHealth({
    stateDir: f.stateDir,
    workspace: "test",
    adapter: { id: "filesystem.managed", version: "1" },
    encryptionKey: randomBytes(32),
  });
  assert.equal(wrong.status, "unsafe");
  assert.equal(wrong.state.vault, "mismatch");
  assert.match(wrong.repairs.join(","), /restore-matching-vault-state/);
  assert.deepEqual(await readFile(keyPath), before);

  await rm(keyPath);
  const missing = await inspectRecoveryHealth({
    stateDir: f.stateDir,
    workspace: "test",
    adapter: { id: "filesystem.managed", version: "1" },
    encryptionKey: f.key,
  });
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.state.signingKey, "missing");
  assert.match(missing.repairs.join(","), /restore-original-signing-key/);
});

test("health reports fresh unavailable state without creating recovery files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-health-cli-fresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      workspace: "test",
      stateDir: "state",
      encryptionKeyEnv: "NOMO_HEALTH_KEY",
      filesystem: { root: "managed", cooperative: true },
    }),
  );
  const before = await readdir(root);
  let output = "";
  const code = await runRecoveryCommand(
    ["health", "--config", config],
    {},
    (line) => {
      output = line;
    },
  );
  const report = JSON.parse(output);
  assert.equal(code, 1);
  assert.equal(report.status, "unavailable");
  assert.deepEqual(report.adapter, {
    id: "filesystem.managed",
    version: "1",
  });
  assert.deepEqual(report.state, {
    present: false,
    signingKey: "missing",
    journal: "missing",
    vault: "missing",
  });
  assert.equal(output.includes("\n"), false);
  assert.equal(output.includes(root), false);
  assert.deepEqual(await readdir(root), before);
  await assert.rejects(lstat(join(root, "state")), { code: "ENOENT" });
});

test("health reports a retained vault unavailable when its encryption key is missing", async (t) => {
  const f = await fixture(t);
  const config = join(f.root, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      workspace: "test",
      stateDir: "state",
      encryptionKeyEnv: "NOMO_HEALTH_KEY",
      filesystem: { root: "managed", cooperative: true },
    }),
  );
  const keyPath = join(f.stateDir, "keys", "dev-ed25519.pkcs8");
  const before = await readFile(keyPath);
  let output = "";
  const code = await runRecoveryCommand(
    ["health", "--config", config],
    {},
    (line) => {
      output = line;
    },
  );
  const report = JSON.parse(output);
  assert.equal(code, 1);
  assert.equal(report.status, "unavailable");
  assert.equal(report.state.signingKey, "available");
  assert.equal(report.state.journal, "verified");
  assert.equal(report.state.vault, "unavailable");
  assert.match(report.repairs.join(","), /provide-original-encryption-key/);
  assert.equal(output.includes(f.key.toString("base64")), false);
  assert.equal(output.includes(f.root), false);
  assert.deepEqual(await readFile(keyPath), before);
});

test("health does not call a retained vault healthy without its encryption key", async (t) => {
  const f = await fixture(t);
  const report = await inspectRecoveryHealth({
    stateDir: f.stateDir,
    workspace: "test",
    adapter: { id: "filesystem.managed", version: "1" },
  });
  assert.equal(report.status, "unavailable");
  assert.equal(report.state.vault, "unavailable");
  assert.match(report.repairs.join(","), /provide-original-encryption-key/);
});
