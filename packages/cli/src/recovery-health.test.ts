import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { jsonlStore } from "../../ledger/src/store.ts";
import { devKeyProvider } from "../../ledger/src/sign.ts";
import {
  inspectRecoveryHealth,
  recoveryHealthExitCode,
} from "./recovery-health.ts";
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
    filePresent: false,
    fileEvidence: 0,
    filePinned: 0,
    fileReleased: 0,
    fileWithoutEvidence: 0,
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
  const unpinned = await vault.put("test", "unpinned");
  await vault.markVaultLifecycle("test", pinned, {
    pin: { ownerId: "operator-1", kind: "recovery" },
  });
  await vault.markVaultLifecycle("test", released, {
    pin: { ownerId: "operator-1", kind: "recovery" },
  });
  // The mark-unpinned record is the case the two halves used to count
  // differently: the file half read a pinless lifecycle as released and the
  // reserved summary counted it in neither bucket.
  await vault.markVaultLifecycle("test", unpinned, {});
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
    evidence: 3,
    pinned: 1,
    released: 2,
    withoutEvidence: /* fixture seed + orphan */ 2,
    filePresent: false,
    fileEvidence: 0,
    filePinned: 0,
    fileReleased: 0,
    fileWithoutEvidence: 0,
  });
  assert.equal(await vault.get("test", orphan), "orphan");
});

test("health counts the legacy file half beside the reserved store", async (t) => {
  const f = await fixture(t);
  const vault = reservedRecoveryVault(
    join(f.stateDir, "vault"),
    { local: f.key },
    "local",
    { maxArtifactBytes: 1024, maxTotalBytes: 4096 },
  );
  await vault.put("test", "reserved side");
  // The file half: one released artifact with evidence, one file with none.
  const released = Buffer.from("file released", "utf8"),
    releasedDigest = createHash("sha256").update(released).digest("hex"),
    fileRoot = join(f.stateDir, "vault", "test"),
    fileIndex = join(f.stateDir, "retention-index", "test");
  // The reader enforces the private mode the collector creates its dirs
  // with, so the fixture does the same instead of a looser mkdir default.
  await mkdir(fileRoot, { recursive: true, mode: 0o700 });
  // The health reader counts these through the reserved vault's legacy
  // namespace, whose writer leaves private artifacts at 0600, so the
  // fixture does too: a looser file mode is a refusal the detail names.
  await writeFile(join(fileRoot, releasedDigest), released, { mode: 0o600 });
  await mkdir(fileIndex, { recursive: true, mode: 0o700 });
  // A recorded release names the protection it removed: who, when, and which
  // pin, which is the exact shape a real operator release leaves behind.
  await writeFile(
    join(fileIndex, `${releasedDigest}.meta`),
    JSON.stringify({
      release: {
        operatorId: "operator",
        at: new Date(0).toISOString(),
        released: { ownerId: "operator-1", kind: "recovery" },
      },
    }),
  );
  const orphan = Buffer.from("file unrecorded", "utf8");
  await writeFile(
    join(fileRoot, createHash("sha256").update(orphan).digest("hex")),
    orphan,
    // Same private mode the legacy writer leaves artifacts at.
    { mode: 0o600 },
  );
  const report = await inspectRecoveryHealth({
    stateDir: f.stateDir,
    workspace: "test",
    adapter: { id: "filesystem.managed", version: "1" },
    encryptionKey: f.key,
  });
  assert.deepEqual(
    {
      filePresent: report.retention.filePresent,
      fileEvidence: report.retention.fileEvidence,
      filePinned: report.retention.filePinned,
      fileReleased: report.retention.fileReleased,
      fileWithoutEvidence: report.retention.fileWithoutEvidence,
    },
    {
      filePresent: true,
      fileEvidence: 1,
      filePinned: 0,
      fileReleased: 1,
      fileWithoutEvidence: 1,
    },
  );
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

test("health names what it could not prove about an unprovable vault", async (t) => {
  const f = await fixture(t);
  // A vault directory anyone else can read is exactly the condition the
  // report exists to name: invalid, with the message that says which check
  // failed and on which path, rather than a bare status.
  await chmod(join(f.stateDir, "vault"), 0o755);
  const report = await inspectRecoveryHealth({
    stateDir: f.stateDir,
    workspace: "test",
    adapter: { id: "filesystem.managed", version: "1" },
    encryptionKey: f.key,
  });
  assert.equal(report.state.vault, "invalid");
  assert.equal(
    typeof report.vaultDetail === "string" && report.vaultDetail.includes("0700"),
    true,
  );
});

test("the health exit is a gate: healthy is the only zero", () => {
  // The metrics rule, carried one surface over: a report that names a real
  // condition and then exits zero is a false pass an automation records
  // forever.
  assert.equal(recoveryHealthExitCode("healthy"), 0);
  assert.equal(recoveryHealthExitCode("degraded"), 1);
  assert.equal(recoveryHealthExitCode("unsafe"), 1);
  assert.equal(recoveryHealthExitCode("unavailable"), 1);
});
