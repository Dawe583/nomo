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
  runConformanceCommand,
} from "./conformance.ts";
import {
  runAdapterConformance,
  CONFORMANCE_CASES,
} from "../../runtime/src/index.ts";

test("actual CLI runs every conformance case and emits a scoped JSON report", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL("../bin/void.mjs", import.meta.url)),
      "recovery",
      "conformance",
    ],
    { windowsHide: true, timeout: 60_000 },
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


test("Git profile distinguishes create scenario from write action and stays scoped", async () => {
  assert.deepEqual(gitConformanceProfile.operations, process.platform === "win32" ? [] : ["create", "write", "delete", "rename", "stage", "unstage"]);
  assert.equal(gitConformanceProfile.durableExecutionReceipt, false);
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
});
