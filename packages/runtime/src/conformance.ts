import assert from "node:assert/strict";
import { recoveryRuntime, type RuntimeOptions } from "./execute.ts";
import type { Json, RecoveryAdapter } from "../../connectors/src/recovery.ts";

/** A factory must allocate disposable, independently owned resources per case.
 * Never point a fixture at user data. read() must inspect actual target state,
 * not an adapter result. options() reopens the same persisted journal/vault. */
export type ConformanceFixture = {
  adapter(): RecoveryAdapter;
  options(): Omit<RuntimeOptions, "adapters" | "authorize">;
  arguments: Json;
  changedArguments: Json;
  before: Json;
  after: Json;
  human: Json;
  read(): Promise<Json>;
  writeHuman(): Promise<void>;
  dispose(): Promise<void>;
};
export const CONFORMANCE_CASES = [
  "restart-and-idempotence",
  "changed-request-refused",
  "authorization-refusal",
  "capture-failure",
  "human-drift",
  "changed-plan-refused",
  "lost-execution-response",
  "lost-recovery-response",
] as const;
export type ConformanceReport = {
  schema: "void.adapter-conformance.v1";
  adapter: { id: string; version: string };
  environment: { platform: string; node: string };
  passed: boolean;
  checks: { id: string; passed: boolean }[];
};

/** Checks the shared runtime boundary. Passing is evidence for these cases only,
 * not provider certification, process-death testing or a physical power-loss test.
 * Failure output deliberately excludes provider errors and captured state. */
export async function runAdapterConformance(
  adapter: { id: string; version: string },
  createFixture: () => Promise<ConformanceFixture>,
): Promise<ConformanceReport> {
  const checks: ConformanceReport["checks"] = [];
  for (const id of CONFORMANCE_CASES) {
    let fixture: ConformanceFixture | undefined;
    let passed = false;
    try {
      fixture = await createFixture();
      const f = fixture;
      assert.deepEqual(await f.read(), f.before);
      assert.notDeepEqual(f.before, f.after);
      assert.notDeepEqual(f.human, f.after);
      assert.notDeepEqual(f.human, f.before);
      assert.notDeepEqual(f.arguments, f.changedArguments);
      let executions = 0,
        recoveries = 0,
        releases = 0;
      const runtime = (
        settings: {
          deny?: boolean;
          captureFailure?: boolean;
          loseExecution?: boolean;
          loseRecovery?: boolean;
        } = {},
      ) => {
        const actual = f.adapter();
        assert.equal(actual.id, adapter.id);
        assert.equal(actual.version, adapter.version);
        const wrapped: RecoveryAdapter = {
          id: actual.id,
          version: actual.version,
          preflight: actual.preflight.bind(actual),
          prepare: actual.prepare.bind(actual),
          reconcile: actual.reconcile.bind(actual),
          ...(actual.reconcileRecovery
            ? { reconcileRecovery: actual.reconcileRecovery.bind(actual) }
            : {}),
          async execute(...args) {
            executions++;
            const outcome = await actual.execute(...args);
            if (settings.loseExecution)
              throw new Error("Injected response loss");
            return outcome;
          },
          async recover(...args) {
            recoveries++;
            const outcome = await actual.recover(...args);
            if (settings.loseRecovery)
              throw new Error("Injected response loss");
            return outcome;
          },
          async release(...args) {
            releases++;
            await actual.release(...args);
          },
        };
        const options = f.options();
        return recoveryRuntime({
          ...options,
          adapters: [wrapped],
          authorize: async () => !settings.deny,
          vault: settings.captureFailure
            ? {
                ...options.vault,
                put: async () => {
                  throw new Error("Injected capture failure");
                },
              }
            : options.vault,
        });
      };
      const request = {
        workspace: "conformance",
        operationId: "operation",
        runId: "run",
        agentId: "conformance",
        adapterId: adapter.id,
        arguments: f.arguments,
      };
      if (id === "authorization-refusal" || id === "capture-failure") {
        const result = await runtime({
          deny: id === "authorization-refusal",
          captureFailure: id === "capture-failure",
        }).execute(request);
        assert.equal(
          result.status,
          id === "authorization-refusal" ? "denied" : "failed",
        );
        assert.equal(executions, 0);
        if (id === "capture-failure") assert.equal(releases, 1);
        assert.deepEqual(await f.read(), f.before);
      } else if (id === "lost-execution-response") {
        assert.equal(
          (await runtime({ loseExecution: true }).execute(request)).status,
          "unknown",
        );
        assert.deepEqual(await f.read(), f.after);
        assert.equal((await runtime().execute(request)).status, "unknown");
        assert.equal(executions, 1);
        assert.deepEqual(await f.read(), f.after);
      } else {
        assert.equal((await runtime().execute(request)).status, "succeeded");
        assert.deepEqual(await f.read(), f.after);
        const restarted = runtime({
          loseRecovery: id === "lost-recovery-response",
        });
        const plan = await restarted.planRecovery(
          request.workspace,
          request.operationId,
        );
        if (id === "changed-request-refused") {
          await assert.rejects(
            restarted.execute({ ...request, arguments: f.changedArguments }),
          );
          assert.equal(executions, 1);
          assert.deepEqual(await f.read(), f.after);
        } else if (id === "human-drift") {
          await f.writeHuman();
          assert.deepEqual(await f.read(), f.human);
          assert.equal(
            (await restarted.recover(plan, async () => true)).status,
            "conflict",
          );
          assert.deepEqual(await f.read(), f.human);
        } else if (id === "changed-plan-refused") {
          await assert.rejects(
            restarted.recover(
              {
                ...plan,
                resources: [...plan.resources, "unapproved:resource"],
              },
              async () => true,
            ),
          );
          assert.equal(recoveries, 0);
          assert.deepEqual(await f.read(), f.after);
        } else if (id === "lost-recovery-response") {
          assert.equal(
            (await restarted.recover(plan, async () => true)).status,
            "unknown",
          );
          assert.deepEqual(await f.read(), f.before);
          assert.equal(
            (await runtime().recover(plan, async () => true)).status,
            "unknown",
          );
          assert.equal(recoveries, 1);
          assert.deepEqual(await f.read(), f.before);
        } else {
          assert.equal((await restarted.execute(request)).status, "succeeded");
          assert.equal(executions, 1);
          await assert.rejects(
            restarted.recover(plan, async () => false),
            /not authorized/,
          );
          assert.equal(recoveries, 0);
          assert.deepEqual(await f.read(), f.after);
          assert.equal(
            (await restarted.recover(plan, async () => true)).status,
            "restored",
          );
          assert.deepEqual(await f.read(), f.before);
          assert.equal(
            (await runtime().recover(plan, async () => true)).status,
            "restored",
          );
          assert.equal(recoveries, 1);
        }
      }
      passed = true;
    } catch {
      passed = false;
    } finally {
      try {
        await fixture?.dispose();
      } catch {
        passed = false;
      }
    }
    checks.push({ id, passed });
  }
  return {
    schema: "void.adapter-conformance.v1",
    adapter,
    environment: { platform: process.platform, node: process.version },
    passed: checks.every((check) => check.passed),
    checks,
  };
}
