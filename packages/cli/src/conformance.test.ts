import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  filesystemConformanceFixture,
  filesystemConformanceProfile,
  gitConformanceProfile,
  gitConformanceFixture,
  managedDocumentsConformanceFixture,
  managedDocumentsConformanceProfile,
  managedPostgresConformanceProfile,
  runConformanceCommand,
} from "./conformance.ts";
import {
  runAdapterConformance,
  recoveryRuntime,
  CONFORMANCE_CASES,
} from "../../runtime/src/index.ts";
import { canonicalJson } from "../../ledger/src/canonical.ts";
import {
  managedPostgresConformanceFixture,
  managedPostgresConformanceIdentity,
} from "../../connectors/src/postgres/conformance-fixture.ts";

test("actual CLI runs every conformance case and emits a scoped JSON report", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL("../bin/void.mjs", import.meta.url)),
      "recovery",
      "conformance",
    ],
    {
      windowsHide: true,
      timeout: process.platform === "win32" ? 15 * 60_000 : 60_000,
    },
  );
  const report = JSON.parse(stdout);
  assert.equal(report.passed, true);
  assert.deepEqual(
    report.scenarios.map(
      (scenario: { operation: string }) => scenario.operation,
    ),
    process.platform === "win32"
      ? ["create", "write", "delete"]
      : ["create", "write", "delete", "rename"],
  );
  for (const scenario of report.scenarios) {
    assert.deepEqual(
      scenario.checks.map((check: { id: string }) => check.id),
      CONFORMANCE_CASES,
    );
    assert.ok(
      scenario.checks.every((check: { passed: boolean }) => check.passed),
    );
  }
  assert.equal(report.capability.durableExecutionReceipt, false);
  assert.equal(
    report.capability.conformance.fixture,
    process.platform === "win32"
      ? "disposable-local-file-create-write-delete"
      : "disposable-local-file-create-write-delete-rename",
  );
});

test("conformance refuses production config and unknown adapters before running", async () => {
  for (const args of [
    ["--config", "production.json"],
    ["--adapter", "unknown"],
    ["--adapter"],
    ["--adapter", "filesystem.managed", "extra"],
  ])
    await assert.rejects(
      runConformanceCommand(args, () => assert.fail("Unexpected report")),
      /usage:/,
    );
});

test("conformance catches an adapter that reports success without changing state", async () => {
  let disposed = 0;
  const report = await runAdapterConformance(
    filesystemConformanceProfile.adapter,
    async () => {
      const f = await filesystemConformanceFixture();
      return {
        ...f,
        adapter: () => ({
          ...f.adapter(),
          execute: async () => ({ result: null, evidence: null }),
        }),
        dispose: async () => {
          await f.dispose();
          disposed++;
        },
      };
    },
  );
  assert.equal(report.passed, false);
  assert.equal(
    report.checks.find((check) => check.id === "restart-and-idempotence")
      ?.passed,
    false,
  );
  assert.equal(disposed, CONFORMANCE_CASES.length);
});

test("conformance detects a destructive inverse and never exposes provider error text", async () => {
  const report = await runAdapterConformance(
    filesystemConformanceProfile.adapter,
    async () => {
      const f = await filesystemConformanceFixture();
      return {
        ...f,
        adapter: () => ({
          ...f.adapter(),
          recover: async () => {
            await f.writeHuman();
            throw new Error("secret-provider-token");
          },
        }),
      };
    },
  );
  assert.equal(report.passed, false);
  assert.equal(
    report.checks.find((check) => check.id === "lost-recovery-response")
      ?.passed,
    false,
  );
  assert.ok(!JSON.stringify(report).includes("secret-provider-token"));
});

test("cleanup failure and fixture setup failure cannot produce green reports", async () => {
  const report = await runAdapterConformance(
    filesystemConformanceProfile.adapter,
    async () => {
      const f = await filesystemConformanceFixture();
      return {
        ...f,
        dispose: async () => {
          await f.dispose();
          throw new Error("cleanup failed");
        },
      };
    },
  );
  assert.equal(report.passed, false);
  assert.ok(report.checks.every((check) => !check.passed));
  const failed = await runAdapterConformance(
    filesystemConformanceProfile.adapter,
    async () => {
      throw new Error("credential in setup error");
    },
  );
  assert.equal(failed.passed, false);
  assert.equal(failed.checks.length, CONFORMANCE_CASES.length);
  assert.ok(!JSON.stringify(failed).includes("credential"));
});


test("managed documents publish a capability profile and pass every runtime check", async () => {
  assert.equal(managedDocumentsConformanceProfile.adapter.id, "managed-documents");
  assert.equal(managedDocumentsConformanceProfile.certification, false);
  assert.deepEqual(managedDocumentsConformanceProfile.operations, ["write", "delete"]);
  const lines: string[] = [];
  assert.equal(
    await runConformanceCommand(["--adapter", "managed-documents"], (line) => lines.push(line)),
    0,
  );
  const report = JSON.parse(lines[0]!);
  assert.equal(report.passed, true);
  assert.deepEqual(
    report.scenarios.map((scenario: { operation: string }) => scenario.operation),
    ["write", "delete"],
  );
  for (const scenario of report.scenarios) {
    assert.deepEqual(
      scenario.checks.map((check: { id: string }) => check.id),
      CONFORMANCE_CASES,
    );
    assert.ok(scenario.checks.every((check: { passed: boolean }) => check.passed));
  }
});

test("managed document preflight states class, readiness and radius per call", async () => {
  const fixture = await managedDocumentsConformanceFixture("write");
  try {
    const observation = await fixture.adapter().preflight(fixture.arguments);
    assert.equal(observation.effect, "write");
    assert.equal(observation.reversibility, "r1");
    assert.equal(observation.readiness, "verified");
    assert.deepEqual(observation.blastRadius, { count: 1, precision: "exact" });
    assert.deepEqual(observation.resources, ["document:sample.md"]);
  } finally {
    await fixture.dispose();
  }
});

test("Git profile distinguishes create scenario from write action and stays scoped", async () => {
  assert.deepEqual(gitConformanceProfile.operations, process.platform === "win32" ? [] : ["create", "write", "delete", "rename", "stage", "unstage", "commit"]);
  // Published because the commit lifecycle reconciles from
  // `refs/void/operations/`, and limited to commit in the same breath: the
  // worktree and index actions reconcile to unknown by design.
  assert.equal(gitConformanceProfile.durableExecutionReceipt, true);
  assert.equal(gitConformanceProfile.durableRecoveryReceipt, true);
  assert.ok(gitConformanceProfile.excluded.includes("durable-receipt-outside-commit"));
  assert.ok(!(gitConformanceProfile.excluded as readonly string[]).includes("commits"));
  assert.equal(gitConformanceProfile.certification, false);
  if (process.platform !== "win32") {
    const fixture = await gitConformanceFixture("create");
    try { assert.equal((fixture.arguments as { action: string }).action, "write"); }
    finally { await fixture.dispose(); }
  }
  const lines: string[] = [];
  assert.equal(await runConformanceCommand(["--adapter", "git.managed"], (line) => lines.push(line)), process.platform === "win32" ? 1 : 0);
  const report = JSON.parse(lines[0]!);
  assert.equal(report.capability.adapter.id, "git.managed");
  assert.equal(report.capability.conformance.sharedRuntimeChecksOnly, true);
  if (process.platform === "win32") assert.deepEqual(report.scenarios, [{ operation: "platform-refusal", passed: false, checks: [{ id: "posix-only", passed: true }] }]);
  else {
    // The published operation list is the report's scenario list, and the
    // commit scenario has to be one of them with all eight shared checks.
    const commit = report.scenarios.find(
      (scenario: { operation: string }) => scenario.operation === "commit",
    );
    assert.ok(commit, "the git.managed profile publishes a commit scenario");
    assert.equal(commit.passed, true);
    assert.deepEqual(
      commit.checks.map((check: { id: string }) => check.id),
      CONFORMANCE_CASES,
    );
  }
});

test("a managed Git commit reconciles from its durable ref receipt after a lost response", async () => {
  if (process.platform === "win32") return;

  // The published durable flags are only honest if a lost response is
  // survivable without a second commit, so the receipts are measured rather
  // than read off the profile: an execute that commits and then loses its
  // response reconciles to succeeded from the ref, and a recovery that
  // restores and then loses its response reconciles to restored from its own
  // ref.
  const fixture = await gitConformanceFixture("commit");
  try {
    const request = {
      workspace: "conformance",
      operationId: "operation",
      runId: "run",
      agentId: "conformance",
      adapterId: "git.managed",
      arguments: fixture.arguments,
    };
    const losing = (lose: "execute" | "recover") => {
      const real = fixture.adapter();
      return {
        ...real,
        ...(lose === "execute"
          ? {
              execute: async (...args: Parameters<typeof real.execute>) => {
                await real.execute(...args);
                throw new Error("Injected response loss");
              },
            }
          : {
              recover: async (...args: Parameters<typeof real.recover>) => {
                await real.recover(...args);
                throw new Error("Injected response loss");
              },
            }),
      };
    };
    const host = (lose: "execute" | "recover") =>
      recoveryRuntime({
        ...fixture.options(),
        adapters: [losing(lose)],
        authorize: async () => true,
      });
    const dispatched = host("execute");
    assert.equal((await dispatched.execute(request)).status, "unknown");
    const reconciled = await host("execute").reconcile("conformance", "operation");
    assert.equal(reconciled.status, "succeeded");
    const committed = host("recover");
    assert.equal((await committed.execute(request)).status, "succeeded");
    const plan = await committed.planRecovery("conformance", "operation");
    assert.equal((await committed.recover(plan, async () => true)).status, "unknown");
    const recovery = (await host("recover").reconcileRecovery("conformance", "operation")) as {
      status: string;
      evidence: { receiptRef: string } | null;
    };
    assert.equal(recovery.status, "restored");
    assert.match(
      String(recovery.evidence?.receiptRef),
      /^refs\/void\/recoveries\//,
    );
    assert.deepEqual(await fixture.read(), fixture.before);
  } finally {
    await fixture.dispose();
  }
});

test("managed PostgreSQL publishes a profile bound to the adapter the factory builds, and passes every runtime check", async () => {
  assert.deepEqual(managedPostgresConformanceProfile.adapter, managedPostgresConformanceIdentity());
  assert.equal(managedPostgresConformanceProfile.certification, false);
  assert.deepEqual(managedPostgresConformanceProfile.operations, ["insert", "update", "delete", "delete-cascade", "tenant-update"]);
  const lines: string[] = [];
  assert.equal(
    await runConformanceCommand(["--adapter", managedPostgresConformanceProfile.adapter.id], (line) => lines.push(line)),
    0,
  );
  const report = JSON.parse(lines[0]!);
  assert.equal(report.passed, true);
  assert.deepEqual(
    report.scenarios.map((scenario: { operation: string }) => scenario.operation),
    ["insert", "update", "delete", "delete-cascade", "tenant-update"],
  );
  for (const scenario of report.scenarios) {
    assert.deepEqual(
      scenario.checks.map((check: { id: string }) => check.id),
      CONFORMANCE_CASES,
    );
    assert.ok(scenario.checks.every((check: { passed: boolean }) => check.passed));
  }
  // The row-level policy is what keeps the other tenant invisible, so the
  // measurement is only real if the read that succeeds sees exactly the
  // bound tenant's rows and never the other tenant's.
  const tenant = await managedPostgresConformanceFixture("tenant-update");
  try {
    const ledger = (await tenant.read()) as { ledger: { id: number }[] };
    assert.deepEqual(ledger.ledger.map((entry) => entry.id), [1, 3]);
  } finally {
    await tenant.dispose();
  }
});

test("the managed PostgreSQL cascade delete captures the descendants the foreign key removed", async () => {
  const cascade = await managedPostgresConformanceFixture("delete-cascade");
  try {
    const adapter = cascade.adapter();
    const observation = await adapter.preflight(cascade.arguments);
    // The parent and both of its children are in the blast radius; the other
    // parent's child is not, which is what "captured cascade descendants"
    // means rather than "the whole table".
    assert.equal(observation.blastRadius.count, 3);
    assert.equal(observation.blastRadius.precision, "exact");
    await adapter.release("blast-radius");
  } finally {
    await cascade.dispose();
  }
});

test("the managed PostgreSQL capture the profile publishes stays inside maxDecodedBytes", async () => {
  for (const build of [
    () => managedPostgresConformanceFixture("insert"),
    () => managedPostgresConformanceFixture("update"),
    () => managedPostgresConformanceFixture("delete"),
    () => managedPostgresConformanceFixture("delete-cascade"),
    () => managedPostgresConformanceFixture("tenant-update"),
  ]) {
    const fixture = await build();
    try {
      const adapter = fixture.adapter();
      const observation = await adapter.preflight(fixture.arguments);
      const prepared = await adapter.prepare(fixture.arguments, observation, "capture-measurement");
      assert.ok(
        Buffer.byteLength(canonicalJson(prepared)) <= managedPostgresConformanceProfile.maxDecodedBytes,
        "a published capture exceeded the profile's maxDecodedBytes",
      );
      await adapter.release("capture-measurement");
    } finally {
      await fixture.dispose();
    }
  }
});

test("a managed PostgreSQL operation reconciles from its durable metadata receipt after a lost response", async () => {
  const fixture = await managedPostgresConformanceFixture("update");
  try {
    const request = {
      workspace: "conformance",
      operationId: "operation",
      runId: "run",
      agentId: "conformance",
      adapterId: managedPostgresConformanceProfile.adapter.id,
      arguments: fixture.arguments,
    };
    const real = fixture.adapter();
    const losing = {
      ...real,
      execute: async (...args: Parameters<typeof real.execute>) => {
        await real.execute(...args);
        throw new Error("Injected response loss");
      },
    };
    const host = () =>
      recoveryRuntime({
        ...fixture.options(),
        adapters: [losing],
        authorize: async () => true,
      });
    assert.equal((await host().execute(request)).status, "unknown");
    // The commit is durable in the managed metadata, so a restarted host
    // learns the outcome instead of re-running the row update.
    assert.equal(
      (await host().reconcile("conformance", "operation")).status,
      "succeeded",
    );
    assert.deepEqual(await fixture.read(), fixture.after);
  } finally {
    await fixture.dispose();
  }
});
