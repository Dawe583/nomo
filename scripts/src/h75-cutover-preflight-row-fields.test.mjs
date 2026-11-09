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
  const common = {
    owner: "Gate Owner",
    independentVerifier: "Independent Reviewer",
    decision: "accepted",
    recordRef: "change://cutover-42",
  };
  return {
    schemaVersion: 1,
    inventory: {
      ...common,
      coverageMethod: "managed invocation search",
      entrypoints: [
        {
          id: "nomo-cli",
          executable: "/opt/nomo/bin/nomo",
          releaseHash: "abc123",
          runtime: "Node 24",
          launchMechanism: "managed launcher",
          configSource: "service config",
          lockProtocol: "legacy-pid",
          owner: "Runtime Owner",
          rootIds: ["workspace"],
        },
      ],
      roots: [
        {
          id: "workspace",
          canonicalPath: "/var/lib/nomo/workbench",
          filesystemIdentity: "device:inode",
          owner: "Data Owner",
        },
      ],
    },
    fence: {
      ...common,
      mechanism: "host maintenance fence",
      scope: "all roots and entrypoints",
      activationRef: "artifact://fence-activation",
      activatedAt: "2026-11-09T11:59:00Z",
      entrypointResults: [
        {
          entrypointId: "nomo-cli",
          denied: true,
          evidenceRef: "artifact://fence-check",
        },
      ],
    },
    drain: {
      ...common,
      graceIntervalMs: 600_000,
      firstObservationAt: "2026-11-09T12:00:00Z",
      secondObservationAt: "2026-11-09T12:10:00Z",
      firstObservationRef: "artifact://drain-before",
      secondObservationRef: "artifact://drain-after",
      rootResults: [
        {
          rootId: "workspace",
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
      rootResults: [
        {
          rootId: "workspace",
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
      candidateReleaseHash: "def456",
      runtimeVersion: "Node 24",
      conversionPlanRef: "artifact://conversion-plan",
      rootResults: [
        {
          rootId: "workspace",
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
      owner: "Rollback Owner",
      separateApprovalRef: "approval://rollback-7",
      trigger: "first-writer integrity failure",
      priorRelease: "abc123",
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

for (const [gate, rows] of [
  ["fence", "entrypointResults"],
  ["drain", "rootResults"],
  ["preservation", "rootResults"],
  ["restart", "rootResults"],
]) {
  test(`preflight rejects unknown ${gate} coverage row fields`, (t) => {
    const value = manifest();
    value[gate][rows][0].unexpected = true;
    const result = run(t, value);
    assert.equal(result.status, 1);
    assert.ok(
      result.stdout.includes(
        `${gate}.${rows}[0].unexpected: unknown row field`,
      ),
    );
  });
}
