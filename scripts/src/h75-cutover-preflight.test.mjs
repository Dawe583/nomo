import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./h75-cutover-preflight.mjs", import.meta.url),
);

function manifest() {
  const root = {
    id: "workspace",
    canonicalPath: "/var/lib/nomo/workbench",
    filesystemIdentity: "device:inode",
    owner: "Data Owner",
    checkedAt: "2026-11-09T11:57:00Z",
  };
  const entrypoint = {
    id: "nomo-cli",
    executable: "/opt/nomo/bin/nomo",
    releaseHash: "abc123",
    runtime: "Node 24",
    launchMechanism: "managed launcher",
    configSource: "service config",
    lockProtocol: "legacy-pid",
    owner: "Runtime Owner",
    rootIds: [root.id],
    checkedAt: "2026-11-09T11:57:30Z",
  };
  const common = {
    owner: "Gate Owner",
    independentVerifier: "Independent Reviewer",
    decision: "accepted",
    decisionAt: "2026-11-09T12:00:00Z",
    recordRef: "change://cutover-42",
  };
  return {
    schemaVersion: 1,
    inventory: {
      ...common,
      decisionAt: "2026-11-09T11:58:00Z",
      coverageMethod: "managed and direct invocation search",
      entrypoints: [entrypoint],
      roots: [root],
    },
    fence: {
      ...common,
      mechanism: "host maintenance fence",
      scope: "all roots and entrypoints",
      activationRef: "artifact://fence-activation",
      activatedAt: "2026-11-09T11:59:00Z",
      entrypointResults: [
        {
          entrypointId: entrypoint.id,
          checkedAt: "2026-11-09T12:00:00Z",
          denied: true,
          evidenceRef: "artifact://fence-check",
        },
      ],
      rootResults: [
        {
          rootId: root.id,
          checkedAt: "2026-11-09T12:00:00Z",
          denied: true,
          evidenceRef: "artifact://root-fence-check",
        },
      ],
    },
    drain: {
      ...common,
      decisionAt: "2026-11-09T12:11:00Z",
      graceIntervalMs: 600_000,
      firstObservationAt: "2026-11-09T12:00:00Z",
      secondObservationAt: "2026-11-09T12:10:00Z",
      firstObservationRef: "artifact://drain-before",
      secondObservationRef: "artifact://drain-after",
      rootResults: [
        {
          rootId: root.id,
          checkedAt: "2026-11-09T12:10:30Z",
          staleReaperBarrierAt: "2026-11-09T12:10:15Z",
          admittedWritersDrained: true,
          processCensusBeforeRef: "artifact://census-before",
          processCensusAfterRef: "artifact://census-after",
          staleReaperBarrierRef: "artifact://reaper-barrier",
          evidenceRef: "artifact://root-drain",
        },
      ],
    },
    preservation: {
      ...common,
      decisionAt: "2026-11-09T12:12:00Z",
      rootResults: [
        {
          rootId: root.id,
          checkedAt: "2026-11-09T12:11:30Z",
          backupId: "snapshot-1",
          destinationRootId: "backup-root-1",
          fileManifestRef: "artifact://file-hashes",
          offlineIntegrityCheckRef: "artifact://offline-check",
          sourceUnchanged: true,
        },
      ],
    },
    restart: {
      ...common,
      decisionAt: "2026-11-09T12:13:00Z",
      candidateReleaseHash: "def456",
      runtimeVersion: "Node 24",
      conversionPlanRef: "artifact://conversion-plan",
      rootResults: [
        {
          rootId: root.id,
          checkedAt: "2026-11-09T12:12:30Z",
          runtimeVersion: "Node 24",
          candidateReleaseHash: "def456",
          lockLayout: "workspace.enc.lock/lifecycle.sqlite",
          firstWriterReadRef: "artifact://first-read",
          reversibleWriteRef: "artifact://local-write",
          freshProcessRereadRef: "artifact://fresh-read",
          backupUnchanged: true,
        },
      ],
    },
    rollback: {
      ...common,
      approver: "Deployment Approver",
      stopConditions: ["integrity mismatch", "legacy writer detected"],
      owner: "Rollback Owner",
      decisionAt: "2026-11-09T12:16:00Z",
      separateApprovalRef: "approval://rollback-7",
      fenceRetainedDuringRehearsal: true,
      fenceRetentionRef: "artifact://rollback-fence-retention",
      rollbackFenceAt: "2026-11-09T12:15:05Z",
      rollbackDrainAt: "2026-11-09T12:15:08Z",
      rootResults: [
        {
          rootId: root.id,
          checkedAt: "2026-11-09T12:15:30Z",
          restoredReleaseHash: "abc123",
          runtimeVersion: "Node 22",
          integrityRef: "artifact://rollback-root-integrity",
          encryptedStateRestorePointRef:
            "artifact://rollback-root-restore-point",
          staleReaperBarrierAt: "2026-11-09T12:15:12Z",
          legacyWritersAbsent: true,
          admittedWritersDrained: true,
          writersDrainedAt: "2026-11-09T12:15:10Z",
          lockCompatibleWithPriorRuntime: true,
          lockCompatibilityRef: "artifact://rollback-lock-compatibility",
          lockCompatibilityCheckedAt: "2026-11-09T12:15:15Z",
        },
      ],
      failedStatePreserved: true,
      failedStatePreservedAt: "2026-11-09T12:15:10Z",
      failedStateRef: "artifact://rollback-failed-state",
      approvalAt: "2026-11-09T12:15:30Z",
      cutoverAt: "2026-11-09T12:17:00Z",
      rehearsalAt: "2026-11-09T12:15:20Z",
      trigger: "first-writer integrity failure",
      lockRepresentation: "directory sentinel compatible with restored runtime",
      candidateReleaseHash: "def456",
      encryptedStateRestorePointRef: "artifact://encrypted-state-restore-point",
      priorRelease: "abc123",
      priorRuntime: "Node 22",
      fenceRef: "artifact://rollback-fence",
      drainRef: "artifact://rollback-drain",
      restoreProcedureRef: "artifact://restore-procedure",
      rehearsalRef: "artifact://copy-rehearsal",
      restartRef: "artifact://rollback-restart",
      integrityRef: "artifact://rollback-integrity",
    },
  };
}

function run(t, value) {
  const directory = mkdtempSync(join(tmpdir(), "nomo-h75-preflight-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "evidence.json");
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return spawnSync(process.execPath, [script, file], {
    encoding: "utf8",
    timeout: 5_000,
  });
}

test("preflight requires an explicit evidence register", () => {
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /usage: node .*h75-cutover-preflight\.mjs <evidence\.json>/,
  );
  assert.match(
    result.stderr,
    /does not verify referenced evidence or authorize cutover/i,
  );
});

test("preflight rejects malformed JSON without echoing input", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nomo-h75-preflight-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "evidence.json");
  writeFileSync(file, '{ secret-marker: "do-not-echo"', { mode: 0o600 });
  const result = spawnSync(process.execPath, [script, file], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not be read as JSON/);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /secret-marker|do-not-echo/,
  );
});

test("preflight fails closed and names missing gate evidence", (t) => {
  const result = run(t, { schemaVersion: 1 });
  assert.equal(result.status, 1);
  for (const gate of [
    "inventory",
    "fence",
    "drain",
    "preservation",
    "restart",
    "rollback",
  ])
    assert.match(result.stdout, new RegExp(`^${gate}\.`, "m"));
  assert.match(result.stdout, /NO GO/);
  assert.match(
    result.stdout,
    /does not verify referenced evidence or authorize cutover/i,
  );
});

test("preflight requires a UTC timestamp for every restart root result", (t) => {
  const value = manifest();
  value.restart.rootResults[0].checkedAt = "2026-02-30T12:00:00Z";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /restart\.rootResults\[0\]\.checkedAt: must be a real UTC date-time/,
  );
});

test("preflight requires preservation root checks after drain and before gate acceptance", (t) => {
  const value = manifest();
  value.preservation.rootResults[0].checkedAt = "2026-11-09T12:11:30Z";
  value.preservation.decisionAt = "2026-11-09T12:12:00Z";
  value.restart.rootResults[0].checkedAt = "2026-11-09T12:12:30Z";
  value.restart.decisionAt = "2026-11-09T12:13:00Z";
  value.drain.decisionAt = "2026-11-09T12:11:00Z";
  const beforeDrain = structuredClone(value);
  beforeDrain.preservation.rootResults[0].checkedAt = "2026-11-09T12:10:30Z";
  const early = run(t, beforeDrain);
  assert.equal(early.status, 1, early.stderr || String(early.error));
  assert.match(
    early.stdout,
    /preservation\.rootResults\[0\]\.checkedAt: must be at or after drain acceptance/,
  );
  const afterDecision = structuredClone(value);
  afterDecision.preservation.rootResults[0].checkedAt = "2026-11-09T12:12:30Z";
  const late = run(t, afterDecision);
  assert.equal(late.status, 1);
  assert.match(
    late.stdout,
    /preservation\.decisionAt: must be at or after every root check/,
  );
});

test("preflight rejects rollback target matching the candidate runtime or release", (t) => {
  const sameRuntime = manifest();
  sameRuntime.rollback.priorRuntime = sameRuntime.restart.runtimeVersion;
  const runtimeResult = run(t, sameRuntime);
  assert.equal(runtimeResult.status, 1);
  assert.match(
    runtimeResult.stdout,
    /rollback\.priorRuntime: must differ from candidate runtime/,
  );

  const paddedRuntime = manifest();
  paddedRuntime.rollback.priorRuntime = ` ${paddedRuntime.restart.runtimeVersion} `;
  const paddedResult = run(t, paddedRuntime);
  assert.equal(paddedResult.status, 1);
  assert.match(
    paddedResult.stdout,
    /rollback\.priorRuntime: must differ from candidate runtime/,
  );

  const paddedRelease = manifest();
  paddedRelease.rollback.priorRelease = ` ${paddedRelease.restart.candidateReleaseHash} `;
  const paddedReleaseResult = run(t, paddedRelease);
  assert.equal(paddedReleaseResult.status, 1);
  assert.match(
    paddedReleaseResult.stdout,
    /rollback\.priorRelease: must differ from candidate release hash/,
  );

  const sameRelease = manifest();
  sameRelease.rollback.priorRelease = sameRelease.restart.candidateReleaseHash;
  const releaseResult = run(t, sameRelease);
  assert.equal(releaseResult.status, 1);
  assert.match(
    releaseResult.stdout,
    /rollback\.priorRelease: must differ from candidate release hash/,
  );
});

test("preflight binds rollback root rows to prior release and runtime", (t) => {
  const value = manifest();
  value.rollback.rootResults[0].restoredReleaseHash = "wrong-release";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /restoredReleaseHash: must match rollback\.priorRelease/,
  );

  const wrongRuntime = manifest();
  wrongRuntime.rollback.rootResults[0].runtimeVersion = "Node 20";
  const runtimeResult = run(t, wrongRuntime);
  assert.equal(runtimeResult.status, 1);
  assert.match(
    runtimeResult.stdout,
    /runtimeVersion: must match rollback\.priorRuntime/,
  );
});

test("preflight requires each stale-reaper barrier before the root drain check", (t) => {
  const value = manifest();
  value.drain.rootResults[0].staleReaperBarrierAt = "2026-11-09T12:10:15Z";
  value.drain.rootResults[0].checkedAt = "2026-11-09T12:10:30Z";
  const beforeObservation = structuredClone(value);
  beforeObservation.drain.rootResults[0].staleReaperBarrierAt =
    "2026-11-09T12:09:30Z";
  const early = run(t, beforeObservation);
  assert.equal(early.status, 1);
  assert.match(
    early.stdout,
    /staleReaperBarrierAt: must be at or after the second observation/,
  );
  const afterCheck = structuredClone(value);
  afterCheck.drain.rootResults[0].staleReaperBarrierAt = "2026-11-09T12:10:45Z";
  const late = run(t, afterCheck);
  assert.equal(late.status, 1);
  assert.match(
    late.stdout,
    /staleReaperBarrierAt: must be at or before the root drain check/,
  );
});

test("preflight requires rollback validation for every canonical root", (t) => {
  const value = manifest();
  delete value.rollback.rootResults;
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /rollback\.rootResults: must be an array/);
});

test("preflight requires each restart root result to name its candidate release and runtime", (t) => {
  const mismatch = manifest();
  mismatch.restart.rootResults[0].runtimeVersion = "Node 22";
  const mismatchResult = run(t, mismatch);
  assert.equal(mismatchResult.status, 1);
  assert.match(
    mismatchResult.stdout,
    /restart\.rootResults\[0\]\.runtimeVersion: must match restart\.runtimeVersion/,
  );
  const value = manifest();
  delete value.restart.rootResults[0].runtimeVersion;
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /restart\.rootResults\[0\]\.runtimeVersion: required/,
  );
});

test("preflight rejects drain observations in reverse chronological order", (t) => {
  const value = manifest();
  value.drain.firstObservationAt = "2026-11-09T12:10:00Z";
  value.drain.secondObservationAt = "2026-11-09T12:00:00Z";
  value.drain.decisionAt = "2026-11-09T12:11:00Z";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /drain\.secondObservationAt: must be after first observation/,
  );
});

test("preflight requires each root drain result after the second observation", (t) => {
  const value = manifest();
  value.drain.rootResults[0].checkedAt = "2026-11-09T12:10:30Z";
  value.drain.decisionAt = "2026-11-09T12:11:00Z";
  const beforeSecondObservation = structuredClone(value);
  beforeSecondObservation.drain.rootResults[0].checkedAt =
    "2026-11-09T12:09:30Z";
  const early = run(t, beforeSecondObservation);
  assert.equal(early.status, 1);
  assert.match(
    early.stdout,
    /drain\.rootResults\[0\]\.checkedAt: must be at or after the second observation/,
  );
  const afterDecision = structuredClone(value);
  afterDecision.drain.rootResults[0].checkedAt = "2026-11-09T12:11:30Z";
  const late = run(t, afterDecision);
  assert.equal(late.status, 1);
  assert.match(
    late.stdout,
    /drain\.decisionAt: must be at or after every root drain check/,
  );
});

test("preflight requires timestamped inventory rows before inventory acceptance", (t) => {
  const value = manifest();
  value.inventory.roots[0].checkedAt = "2026-11-09T11:57:00Z";
  value.inventory.entrypoints[0].checkedAt = "2026-11-09T11:57:30Z";
  const missing = structuredClone(value);
  delete missing.inventory.roots[0].checkedAt;
  const missingResult = run(t, missing);
  assert.equal(missingResult.status, 1);
  assert.match(
    missingResult.stdout,
    /inventory\.roots\[0\]\.checkedAt: required/,
  );
  const late = structuredClone(value);
  late.inventory.roots[0].checkedAt = "2026-11-09T11:58:30Z";
  const lateResult = run(t, late);
  assert.equal(lateResult.status, 1);
  assert.match(
    lateResult.stdout,
    /inventory\.roots\[0\]\.checkedAt: must be at or before inventory acceptance/,
  );
});

test("preflight rejects fence activation before inventory acceptance", (t) => {
  const value = manifest();
  value.fence.activatedAt = "2026-11-09T11:57:30Z";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /fence\.activatedAt: must be at or after inventory acceptance/,
  );
});

test("preflight requires fence denial checks for every canonical data root", (t) => {
  const value = manifest();
  delete value.fence.rootResults;
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /fence\.rootResults: must be an array/);
});

test("preflight rejects whitespace-padded duplicate gate identities", (t) => {
  const value = manifest();
  value.fence.independentVerifier = ` ${value.fence.owner} `;
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /fence\.independentVerifier: must differ from evidence owner/,
  );
});

test("preflight rejects rollback rehearsal before restart acceptance", (t) => {
  const value = manifest();
  value.rollback.rehearsalAt = "2026-11-09T12:12:30Z";
  value.rollback.decisionAt = "2026-11-09T12:16:00Z";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /rollback\.rehearsalAt: must be at or after restart acceptance/,
  );
});

test("preflight compares normalized rollback approval and maintenance references", (t) => {
  const value = manifest();
  value.rollback.separateApprovalRef = ` ${value.rollback.recordRef} `;
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /rollback\.separateApprovalRef: must be distinct from the maintenance change record/,
  );
});

test("preflight requires evidence fence remained active during rollback rehearsal", (t) => {
  const value = manifest();
  value.rollback.fenceRetainedDuringRehearsal = false;
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /rollback\.fenceRetainedDuringRehearsal: must be true/,
  );
  delete value.rollback.fenceRetentionRef;
  const missingReference = run(t, value);
  assert.match(
    missingReference.stdout,
    /rollback\.fenceRetentionRef: required/,
  );
});

test("preflight requires failed rollback state preservation before rehearsal", (t) => {
  const value = manifest();
  value.rollback.failedStatePreserved = false;
  const falseClaim = run(t, value);
  assert.equal(falseClaim.status, 1);
  assert.match(
    falseClaim.stdout,
    /rollback\.failedStatePreserved: must be true/,
  );
  value.rollback.failedStatePreserved = true;
  value.rollback.failedStatePreservedAt = "2026-11-09T12:15:21Z";
  const latePreservation = run(t, value);
  assert.equal(latePreservation.status, 1);
  assert.match(
    latePreservation.stdout,
    /rollback\.failedStatePreservedAt: must be at or before rollback rehearsal/,
  );
  delete value.rollback.failedStateRef;
  const missingRef = run(t, value);
  assert.match(missingRef.stdout, /rollback\.failedStateRef: required/);
});

test("preflight orders rollback fence, drain, failed-state preservation, and rehearsal", (t) => {
  const value = manifest();
  value.rollback.rollbackDrainAt = "2026-11-09T12:15:04Z";
  const earlyDrain = run(t, value);
  assert.equal(earlyDrain.status, 1);
  assert.match(
    earlyDrain.stdout,
    /rollback\.rollbackDrainAt: must be at or after rollback fence/,
  );
  value.rollback.rollbackDrainAt = "2026-11-09T12:15:08Z";
  value.rollback.failedStatePreservedAt = "2026-11-09T12:15:07Z";
  const stateBeforeDrain = run(t, value);
  assert.equal(stateBeforeDrain.status, 1);
  assert.match(
    stateBeforeDrain.stdout,
    /rollback\.failedStatePreservedAt: must be at or after rollback drain/,
  );
});

test("preflight binds rollback rehearsal candidate build to restart candidate", (t) => {
  const value = manifest();
  value.rollback.candidateReleaseHash = "other-candidate";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /rollback\.candidateReleaseHash: must match restart\.candidateReleaseHash/,
  );
});

test("preflight requires encrypted-state restore point for every rollback root", (t) => {
  const value = manifest();
  delete value.rollback.rootResults[0].encryptedStateRestorePointRef;
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /rollback\.rootResults\[0\]\.encryptedStateRestorePointRef: required/,
  );
});

test("preflight requires encrypted-state restore point separate from procedure", (t) => {
  const value = manifest();
  delete value.rollback.encryptedStateRestorePointRef;
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /rollback\.encryptedStateRestorePointRef: required/,
  );
});

test("preflight requires lock compatibility check after reaper barrier and before restore", (t) => {
  const value = manifest();
  value.rollback.rootResults[0].lockCompatibilityCheckedAt =
    "2026-11-09T12:15:11Z";
  const beforeBarrier = run(t, value);
  assert.equal(beforeBarrier.status, 1);
  assert.match(
    beforeBarrier.stdout,
    /rollback\.rootResults\[0\]\.lockCompatibilityCheckedAt: must be at or after stale-reaper barrier/,
  );
  value.rollback.rootResults[0].lockCompatibilityCheckedAt =
    "2026-11-09T12:15:31Z";
  const afterRestore = run(t, value);
  assert.equal(afterRestore.status, 1);
  assert.match(
    afterRestore.stdout,
    /rollback\.rootResults\[0\]\.lockCompatibilityCheckedAt: must be at or before root restore check/,
  );
});

test("preflight requires per-root lock compatibility assertion and evidence", (t) => {
  const value = manifest();
  value.rollback.rootResults[0].lockCompatibleWithPriorRuntime = false;
  const incompatible = run(t, value);
  assert.equal(incompatible.status, 1);
  assert.match(
    incompatible.stdout,
    /rollback\.rootResults\[0\]\.lockCompatibleWithPriorRuntime: must be true/,
  );
  delete value.rollback.rootResults[0].lockCompatibilityRef;
  const missingEvidence = run(t, value);
  assert.match(
    missingEvidence.stdout,
    /rollback\.rootResults\[0\]\.lockCompatibilityRef: required/,
  );
});

test("preflight orders rollback writer drain before reaper barrier", (t) => {
  const value = manifest();
  value.rollback.rootResults[0].writersDrainedAt = "2026-11-09T12:15:13Z";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /rollback\.rootResults\[0\]\.staleReaperBarrierAt: must be at or after writer drain/,
  );
  value.rollback.rootResults[0].staleReaperBarrierAt = "2026-11-09T12:15:12Z";
  value.rollback.rootResults[0].admittedWritersDrained = false;
  const notDrained = run(t, value);
  assert.match(
    notDrained.stdout,
    /rollback\.rootResults\[0\]\.admittedWritersDrained: must be true/,
  );
});

test("preflight requires per-root rollback reaper barrier and no legacy writers", (t) => {
  const value = manifest();
  value.rollback.rootResults[0].staleReaperBarrierAt = "2026-11-09T12:15:07Z";
  const earlyBarrier = run(t, value);
  assert.equal(earlyBarrier.status, 1);
  assert.match(
    earlyBarrier.stdout,
    /rollback\.rootResults\[0\]\.staleReaperBarrierAt: must be at or after rollback drain/,
  );
  value.rollback.rootResults[0].staleReaperBarrierAt = "2026-11-09T12:15:12Z";
  value.rollback.rootResults[0].legacyWritersAbsent = false;
  const legacyWriter = run(t, value);
  assert.equal(legacyWriter.status, 1);
  assert.match(
    legacyWriter.stdout,
    /rollback\.rootResults\[0\]\.legacyWritersAbsent: must be true/,
  );
});

test("preflight requires an explicit rollback lock representation", (t) => {
  const value = manifest();
  delete value.rollback.lockRepresentation;
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /rollback\.lockRepresentation: required/);
});

test("preflight requires rollback owner distinct from release operator after trimming", (t) => {
  const value = manifest();
  value.rollback.owner = ` ${value.restart.owner} `;
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /rollback\.owner: must differ from release operator/,
  );
});

test("preflight requires rollback verifier distinct from rollback author after trimming", (t) => {
  const value = manifest();
  value.rollback.independentVerifier = ` ${value.rollback.owner} `;
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /rollback\.independentVerifier: must differ from rollback owner/,
  );
});

test("preflight requires rollback verifier distinct from release operator", (t) => {
  const value = manifest();
  value.rollback.independentVerifier = ` ${value.restart.owner} `;
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /rollback\.independentVerifier: must differ from release operator/,
  );
});

test("preflight rejects case-only duplicates across rollback roles", (t) => {
  for (const [owner, verifier, releaseOwner, expected] of [
    [
      "Rollback Owner",
      "Independent Reviewer",
      "rollback owner",
      /rollback\.owner: must differ from release operator/,
    ],
    [
      "Rollback Owner",
      "rollback owner",
      "Gate Owner",
      /rollback\.independentVerifier: must differ from rollback owner/,
    ],
    [
      "Rollback Owner",
      "gate owner",
      "Gate Owner",
      /rollback\.independentVerifier: must differ from release operator/,
    ],
  ]) {
    const value = manifest();
    value.rollback.owner = owner;
    value.rollback.independentVerifier = verifier;
    value.restart.owner = releaseOwner;
    const result = run(t, value);
    assert.equal(result.status, 1);
    assert.match(result.stdout, expected);
  }
});

test("preflight rejects case-only duplicate gate identities", (t) => {
  const value = manifest();
  value.fence.owner = "Fence Owner";
  value.fence.independentVerifier = "fence owner";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /fence\.independentVerifier: must differ from evidence owner/,
  );
});

test("preflight requires rollback approver distinct from rollback roles after trimming", (t) => {
  for (const identity of [
    "Rollback Owner",
    "Independent Reviewer",
    "Gate Owner",
  ]) {
    const value = manifest();
    value.rollback.approver = ` ${identity} `;
    const result = run(t, value);
    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /rollback\.approver: must differ from rollback owner, verifier, and release operator/,
    );
  }
});

test("preflight rejects case-only rollback approver role collisions", (t) => {
  for (const identity of [
    "rollback owner",
    "independent reviewer",
    "gate owner",
  ]) {
    const value = manifest();
    value.rollback.approver = ` ${identity.toUpperCase()} `;
    const result = run(t, value);
    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /rollback\.approver: must differ from rollback owner, verifier, and release operator/,
    );
  }
});

test("preflight rejects non-string rollback role names without throwing", (t) => {
  for (const [path, setInvalid] of [
    ["fence.owner", (value) => (value.fence.owner = 42)],
    ["rollback.owner", (value) => (value.rollback.owner = {})],
    [
      "rollback.independentVerifier",
      (value) => (value.rollback.independentVerifier = false),
    ],
    ["rollback.approver", (value) => (value.rollback.approver = 42)],
    ["restart.owner", (value) => (value.restart.owner = null)],
  ]) {
    const value = manifest();
    setInvalid(value);
    const result = run(t, value);
    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /NO GO: evidence register is incomplete or inconsistent\./,
    );
    assert.match(
      result.stdout,
      new RegExp(`${path.replaceAll(".", "\\.")}: required`),
    );
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      /TypeError|\bat\s+file:\/\//,
    );
  }
});
test("preflight rejects malformed compared text fields without throwing", (t) => {
  for (const [path, setInvalid] of [
    ["inventory.recordRef", (value) => (value.inventory.recordRef = 42)],
    ["restart.runtimeVersion", (value) => (value.restart.runtimeVersion = 42)],
    [
      "restart.rootResults[0].runtimeVersion",
      (value) => (value.restart.rootResults[0].runtimeVersion = {}),
    ],
    [
      "restart.rootResults[0].candidateReleaseHash",
      (value) => (value.restart.rootResults[0].candidateReleaseHash = false),
    ],
    ["rollback.priorRuntime", (value) => (value.rollback.priorRuntime = 42)],
    [
      "rollback.candidateReleaseHash",
      (value) => (value.rollback.candidateReleaseHash = {}),
    ],
    [
      "rollback.separateApprovalRef",
      (value) => (value.rollback.separateApprovalRef = 42),
    ],
    [
      "rollback.rootResults[0].restoredReleaseHash",
      (value) => (value.rollback.rootResults[0].restoredReleaseHash = {}),
    ],
    [
      "rollback.rootResults[0].runtimeVersion",
      (value) => (value.rollback.rootResults[0].runtimeVersion = false),
    ],
  ]) {
    const value = manifest();
    setInvalid(value);
    const result = run(t, value);
    assert.equal(result.status, 1, `${path} must fail closed`);
    assert.match(
      result.stdout,
      new RegExp(
        `${path.replaceAll("[", "\\[").replaceAll("]", "\\]").replaceAll(".", "\\.")}: required`,
      ),
    );
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      /TypeError|\bat\s+file:\/\//,
    );
  }
});

test("preflight requires rollback approval after rehearsal and before planned cutover", (t) => {
  const value = manifest();
  value.rollback.approvalAt = "2026-11-09T12:14:59Z";
  const beforeRehearsal = run(t, value);
  assert.equal(beforeRehearsal.status, 1);
  assert.match(
    beforeRehearsal.stdout,
    /rollback\.approvalAt: must be at or after rollback rehearsal/,
  );
  value.rollback.approvalAt = "2026-11-09T12:15:25Z";
  value.rollback.decisionAt = "2026-11-09T12:15:15Z";
  const beforeApprovalDecision = run(t, value);
  assert.equal(beforeApprovalDecision.status, 1);
  assert.match(
    beforeApprovalDecision.stdout,
    /rollback\.decisionAt: must be at or after rollback approval/,
  );
  value.rollback.decisionAt = "2026-11-09T12:16:00Z";
  value.rollback.approvalAt = "2026-11-09T12:15:25Z";
  const beforeRootChecks = run(t, value);
  assert.equal(beforeRootChecks.status, 1);
  assert.match(
    beforeRootChecks.stdout,
    /rollback\.approvalAt: must be at or after every root check/,
  );
  value.rollback.approvalAt = "2026-11-09T12:17:01Z";
  const afterCutover = run(t, value);
  assert.equal(afterCutover.status, 1);
  assert.match(
    afterCutover.stdout,
    /rollback\.approvalAt: must be at or before planned cutover/,
  );
  delete value.rollback.approvalAt;
  const missing = run(t, value);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /rollback\.approvalAt: required/);
});

test("preflight requires a named rollback approver", (t) => {
  const value = manifest();
  delete value.rollback.approver;
  const missing = run(t, value);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /rollback\.approver: required/);

  value.rollback.approver = "  ";
  const blank = run(t, value);
  assert.equal(blank.status, 1);
  assert.match(blank.stdout, /rollback\.approver: required/);
});

test("preflight requires rollback stop conditions", (t) => {
  const value = manifest();
  delete value.rollback.stopConditions;
  const missing = run(t, value);
  assert.equal(missing.status, 1);
  assert.match(
    missing.stdout,
    /rollback\.stopConditions: must be a non-empty array/,
  );

  value.rollback.stopConditions = [];
  const empty = run(t, value);
  assert.equal(empty.status, 1);
  assert.match(
    empty.stdout,
    /rollback\.stopConditions: must be a non-empty array/,
  );

  value.rollback.stopConditions = [" "];
  const blank = run(t, value);
  assert.equal(blank.status, 1);
  assert.match(blank.stdout, /rollback\.stopConditions\[0\]: required/);
});

test("preflight requires exact prior runtime for rollback", (t) => {
  const value = manifest();
  delete value.rollback.priorRuntime;
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /rollback\.priorRuntime: required/);
});

test("preflight rejects rollback rehearsal before drain acceptance", (t) => {
  const value = manifest();
  value.rollback.rehearsalAt = "2026-11-09T12:10:30Z";
  value.rollback.decisionAt = "2026-11-09T12:16:00Z";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /rollback\.rehearsalAt: must be at or after drain acceptance/,
  );
});

test("preflight rejects rollback rehearsal before fence activation", (t) => {
  const value = manifest();
  value.rollback.rehearsalAt = "2026-11-09T11:58:00Z";
  value.rollback.decisionAt = "2026-11-09T12:16:00Z";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /rollback\.rehearsalAt: must be at or after fence activation/,
  );
});

test("preflight rejects rollback approval before rollback rehearsal", (t) => {
  const value = manifest();
  value.rollback.rehearsalAt = "2026-11-09T12:15:00Z";
  value.rollback.decisionAt = "2026-11-09T12:14:59Z";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /rollback\.decisionAt: must be at or after rollback rehearsal/,
  );
});

test("preflight rejects restart root checks before preservation acceptance", (t) => {
  const value = manifest();
  value.preservation.decisionAt = "2026-11-09T12:12:00Z";
  value.restart.rootResults[0].checkedAt = "2026-11-09T12:11:30Z";
  value.restart.decisionAt = "2026-11-09T12:13:00Z";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /restart\.rootResults\[0\]\.checkedAt: must be at or after preservation acceptance/,
  );
});

test("preflight rejects restart root checks before drain acceptance", (t) => {
  const value = manifest();
  value.drain.decisionAt = "2026-11-09T12:11:00Z";
  value.restart.rootResults[0].checkedAt = "2026-11-09T12:10:00Z";
  value.restart.decisionAt = "2026-11-09T12:12:00Z";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /restart\.rootResults\[0\]\.checkedAt: must be at or after drain acceptance/,
  );
});

test("preflight rejects drain observation before fence acceptance", (t) => {
  const value = manifest();
  value.fence.decisionAt = "2026-11-09T12:01:00Z";
  value.drain.firstObservationAt = "2026-11-09T12:00:00Z";
  value.drain.secondObservationAt = "2026-11-09T12:10:00Z";
  value.drain.decisionAt = "2026-11-09T12:11:00Z";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /drain\.firstObservationAt: must be at or after fence acceptance/,
  );
});

test("preflight rejects drain decision before the second observation", (t) => {
  const value = manifest();
  value.drain.decisionAt = "2026-11-09T12:09:59Z";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /drain\.decisionAt: must be at or after the second observation/,
  );
});

test("preflight rejects fence decision before an entrypoint denial check", (t) => {
  const value = manifest();
  value.fence.decisionAt = "2026-11-09T11:59:00Z";
  value.fence.entrypointResults[0].checkedAt = "2026-11-09T12:01:00Z";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /fence\.decisionAt: must be at or after every entrypoint check/,
  );
});

test("preflight requires each fence denial check to occur after activation", (t) => {
  const value = manifest();
  value.fence.entrypointResults[0].checkedAt = "2026-11-09T11:58:00Z";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /fence\.entrypointResults\[0\]\.checkedAt: must be at or after fence activation/,
  );
});

test("preflight rejects restart decision before the last root check", (t) => {
  const value = manifest();
  value.restart.decisionAt = "2026-11-09T12:11:00Z";
  value.restart.rootResults[0].checkedAt = "2026-11-09T12:11:30Z";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /restart\.decisionAt: must be at or after every root check/,
  );
});

test("preflight rejects restart approval before a per-root restart check", (t) => {
  const value = manifest();
  value.restart.decisionAt = "2026-11-09T12:00:00Z";
  value.restart.rootResults[0].checkedAt = "2026-11-09T12:01:00Z";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /restart\.decisionAt: must be at or after every root check/,
  );
});

test("preflight requires a UTC decision timestamp for every gate", (t) => {
  const value = manifest();
  delete value.fence.decisionAt;
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /fence\.decisionAt: required/);
});

test("preflight rejects invalid gate decision timestamps", (t) => {
  const value = manifest();
  value.rollback.decisionAt = "2026-02-30T12:00:00Z";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /rollback\.decisionAt: must be a real UTC date-time/,
  );
});

test("preflight rejects preservation destination equal to the source root", (t) => {
  const value = manifest();
  value.preservation.rootResults[0].destinationRootId =
    value.preservation.rootResults[0].rootId;
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /preservation\.rootResults\[0\]\.destinationRootId: must differ from source root/,
  );
});

test("preflight rejects unknown inventory root fields", (t) => {
  const value = manifest();
  value.inventory.roots[0].canonicalPathh =
    value.inventory.roots[0].canonicalPath;
  delete value.inventory.roots[0].canonicalPath;
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /inventory.roots\[0\]\.canonicalPathh: unknown inventory row field/,
  );
});

test("preflight rejects unknown inventory entrypoint fields", (t) => {
  const value = manifest();
  value.inventory.entrypoints[0].runtimee =
    value.inventory.entrypoints[0].runtime;
  delete value.inventory.entrypoints[0].runtime;
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /inventory.entrypoints\[0\]\.runtimee: unknown inventory row field/,
  );
});

test("preflight rejects misspelled gate fields", (t) => {
  const value = manifest();
  value.fence.activatedAtUtc = value.fence.activatedAt;
  delete value.fence.activatedAt;
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /fence\.activatedAtUtc: unknown gate field/);
});

test("preflight requires each gate to reference the same change record", (t) => {
  const value = manifest();
  value.rollback.recordRef = "change://different-window";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /rollback.recordRef: must match the maintenance change record/,
  );
});

test("preflight rejects malformed register shapes without a stack trace", (t) => {
  const result = run(t, null);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /evidence: must be an object/);
  assert.doesNotMatch(result.stderr, /TypeError|at validate/);
});

test("preflight rejects unknown sections instead of ignoring misspelled gates", (t) => {
  const value = manifest();
  value.rollbak = value.rollback;
  delete value.rollback;
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /rollbak: unknown evidence register section/);
  assert.match(result.stdout, /rollback: must be an object/);
});

test("preflight rejects file URIs for required evidence references", (t) => {
  const value = manifest();
  value.fence.activationRef = "file:///tmp/fence-evidence.json";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /fence.activationRef: must be a non-file URI evidence reference/,
  );
});

test("preflight rejects evidence URIs without a nonempty authority", (t) => {
  const value = manifest();
  value.fence.activationRef = "artifact:///fence-evidence";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /fence.activationRef: must be a non-file URI evidence reference/,
  );
});

test("preflight rejects file paths for required evidence references", (t) => {
  const value = manifest();
  value.fence.activationRef = "/tmp/fence-evidence.json";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /fence.activationRef: must be a non-file URI evidence reference/,
  );
});

test("preflight rejects impossible calendar dates", (t) => {
  const value = manifest();
  value.fence.activatedAt = "2026-02-30T11:59:00Z";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /fence.activatedAt: must be a real UTC date-time/,
  );
});

test("preflight rejects a drain observation taken before the fence is active", (t) => {
  const value = manifest();
  value.drain.firstObservationAt = "2026-11-09T11:58:00Z";
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /drain.firstObservationAt: must be at or after fence activation/,
  );
});

test("preflight rejects duplicate canonical root paths", (t) => {
  const value = manifest();
  value.inventory.roots.push({
    ...value.inventory.roots[0],
    id: "workspace-alias",
  });
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /inventory\.roots\[1\]\.canonicalPath: duplicates canonical root workspace/,
  );
});

test("preflight rejects lexically equivalent canonical root paths", (t) => {
  const value = manifest();
  value.inventory.roots.push({
    ...value.inventory.roots[0],
    id: "workspace-alias",
    canonicalPath: "/var/lib/nomo/./workbench",
  });
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /inventory\.roots\[1\]\.canonicalPath: duplicates canonical root workspace/,
  );
});

test("preflight rejects inventory roots with no entrypoint association", (t) => {
  const value = manifest();
  value.inventory.roots.push({
    ...value.inventory.roots[0],
    id: "orphan-root",
    canonicalPath: "/var/lib/nomo/orphan",
  });
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /inventory\.roots\[1\]\.id: not associated with any entrypoint/,
  );
});

test("preflight rejects duplicate root associations in an entrypoint", (t) => {
  const value = manifest();
  value.inventory.entrypoints[0].rootIds.push("workspace");
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /inventory.entrypoints\[0\]\.rootIds: duplicate root association/,
  );
});

test("preflight rejects duplicate fence coverage", (t) => {
  const value = manifest();
  value.fence.entrypointResults.push({ ...value.fence.entrypointResults[0] });
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /fence.entrypointResults\[1\]\.entrypointId: duplicate coverage/,
  );
});

test("preflight checks per-entrypoint and per-root coverage", (t) => {
  const value = manifest();
  value.fence.entrypointResults = [];
  value.drain.rootResults = [];
  const result = run(t, value);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /fence\.entrypointResults: missing coverage for inventory entrypoint/,
  );
  assert.match(
    result.stdout,
    /drain\.rootResults: missing coverage for inventory root/,
  );
});

test("complete evidence register passes only for independent review, never as cutover approval", (t) => {
  const result = run(t, manifest());
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /complete for independent review/i);
  assert.match(
    result.stdout,
    /does not verify referenced evidence or authorize cutover/i,
  );
  assert.doesNotMatch(result.stdout, /\bGO\b/);
});
