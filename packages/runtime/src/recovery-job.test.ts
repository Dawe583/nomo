import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { devKeyProvider } from "../../ledger/src/sign.ts";
import { jsonlStore } from "../../ledger/src/store.ts";
import {
  localOperationJournal,
  localRecoveryVault,
  recoveryRuntime,
  type RecoveryAdapter,
  type RecoveryJobPlan,
  type OperationJournal,
  validateRecoveryJobPlan,
  completeRecoveryJobPlan,
} from "./index.ts";

async function fixture(t: import("node:test").TestContext) {
  const root = await mkdtemp(join(tmpdir(), "void-recovery-job-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const signer = await devKeyProvider({ dir: join(root, "keys"), env: {} });
  const key = randomBytes(32);
  const values = new Map<string, string>();
  const recoveries = new Map<string, number>();
  let loseRecoveryFor: string | undefined;
  const compensated = new Set<string>();
  const adapter: RecoveryAdapter = {
    id: "fixture",
    version: "1",
    async preflight(args) {
      const { id } = args as { id: string };
      return {
        effect: "write",
        reversibility: compensated.has(id) ? "r2" : "r1",
        readiness: "verified",
        scope: id,
        resources: [`fixture:${id}`],
        revision: values.get(id) ?? null,
        blastRadius: { count: 1, precision: "exact" },
      };
    },
    async prepare(args, observation) {
      return { before: observation.revision, plan: args };
    },
    async execute(args) {
      const { id, value } = args as { id: string; value: string };
      values.set(id, value);
      return { result: value, evidence: { id } };
    },
    async release() {},
    async reconcile() {
      return { status: "unknown" };
    },
    async recover(prepared, outcome) {
      const { id } = prepared.plan as { id: string };
      recoveries.set(id, (recoveries.get(id) ?? 0) + 1);
      if (values.get(id) !== outcome.result)
        return { status: "conflict", evidence: null };
      if (prepared.before === null) values.delete(id);
      else values.set(id, prepared.before as string);
      if (loseRecoveryFor === id) throw new Error("response lost");
      return {
        status: compensated.has(id) ? "compensated" : "restored",
        evidence: { id },
      };
    },
    async reconcileRecovery(prepared) {
      const { id } = prepared.plan as { id: string };
      return (
        prepared.before === null
          ? !values.has(id)
          : values.get(id) === prepared.before
      )
        ? {
            status: compensated.has(id) ? "compensated" : "restored",
            evidence: { id },
          }
        : { status: "unknown" };
    },
  };
  const open = () =>
    recoveryRuntime({
      journal: localOperationJournal(join(root, "journal"), signer),
      vault: localRecoveryVault(join(root, "vault"), { key }, "key"),
      adapters: [adapter],
      authorize: async () => true,
      requireRecoverable: false,
    });
  const execute = async (
    operationId: string,
    runId: string,
    id = operationId,
  ) =>
    open().execute({
      workspace: "test",
      operationId,
      runId,
      agentId: "agent",
      adapterId: "fixture",
      arguments: { id, value: `after-${operationId}` },
    });
  return {
    root,
    signer,
    key,
    values,
    recoveries,
    adapter,
    open,
    execute,
    lose(id: string | undefined) {
      loseRecoveryFor = id;
    },
    compensate(id: string) {
      compensated.add(id);
    },
  };
}

test("run job persists a full boundary digest and restores in reverse sequence once across restart", async (t) => {
  const f = await fixture(t);
  await f.execute("one", "run");
  await f.execute("two", "run");
  await f.execute("other", "other");
  await f.execute("three", "run");
  const plan = await f.open().planRecoveryJob({
    workspace: "test",
    jobId: "job",
    selection: { kind: "run", runId: "run" },
  });
  assert.deepEqual(
    plan.steps.map((step) => step.operationId),
    ["three", "two", "one"],
  );
  assert.match(plan.boundary.digest, /^[a-f0-9]{64}$/);
  const result = await f
    .open()
    .runRecoveryJob(
      "test",
      "job",
      async (reviewed) => reviewed.digest === plan.digest,
    );
  assert.equal(result.status, "restored");
  assert.equal(result.checkpoint, 3);
  assert.deepEqual([...f.values.keys()], ["other"]);
  assert.equal(
    (await f.open().runRecoveryJob("test", "job", async () => false)).status,
    "restored",
  );
  assert.deepEqual([...f.recoveries.entries()].sort(), [
    ["one", 1],
    ["three", 1],
    ["two", 1],
  ]);
});

test("job identity, full digest, explicit residuals and stale boundary fail closed", async (t) => {
  const f = await fixture(t);
  await f.execute("one", "run");
  await assert.rejects(
    f.open().planRecoveryJob({
      workspace: "test",
      jobId: "dupe",
      selection: { kind: "operations", operationIds: ["one", "one"] },
    }),
    /unique/,
  );
  const plan = await f.open().planRecoveryJob({
    workspace: "test",
    jobId: "job",
    selection: { kind: "operations", operationIds: ["one", "missing"] },
  });
  assert.deepEqual(plan.residuals, [
    { operationId: "missing", status: "missing" },
  ]);
  await assert.rejects(
    f.open().planRecoveryJob({
      workspace: "test",
      jobId: "job",
      selection: { kind: "run", runId: "run" },
    }),
    /another selection/,
  );
  const changed = structuredClone(plan) as RecoveryJobPlan;
  (changed.steps[0]!.plan.resources as string[])[0] = "other";
  assert.throws(() => validateRecoveryJobPlan(changed), /digest/);
  await assert.rejects(
    f.open().runRecoveryJob("test", "job", async () => false),
    /authorized/,
  );
  await f.execute("later", "later");
  await assert.rejects(
    f
      .open()
      .runRecoveryJob(
        "test",
        "job",
        async (stored) => stored.digest === plan.digest,
      ),
    /boundary is stale/,
  );
  await f.execute("still-open", "later");
  assert.equal(f.recoveries.size, 0);
});

test("conflict preserves human state and records blocked residuals", async (t) => {
  const f = await fixture(t);
  await f.execute("one", "run", "a");
  await f.execute("two", "run", "b");
  await f.execute("three", "run", "c");
  const plan = await f.open().planRecoveryJob({
    workspace: "test",
    jobId: "job",
    selection: { kind: "run", runId: "run" },
  });
  f.values.set("b", "human");
  const result = await f.open().runRecoveryJob("test", "job", async () => true);
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.outcomes, [
    { operationId: "three", status: "restored" },
  ]);
  assert.deepEqual(result.residuals, [
    { operationId: "two", status: "conflict" },
    { operationId: "one", status: "blocked-by-conflict" },
  ]);
  assert.equal(f.values.get("b"), "human");
  assert.equal(f.values.get("a"), "after-one");
  assert.equal(
    ((await f.open().recoveryJobStatus("test", "job")) as { status: string })
      .status,
    "conflict",
  );
  void plan;
});

test("unknown job resumes after reconciliation without a second inverse", async (t) => {
  const f = await fixture(t);
  await f.execute("one", "run");
  await f.open().planRecoveryJob({
    workspace: "test",
    jobId: "job",
    selection: { kind: "run", runId: "run" },
  });
  f.lose("one");
  assert.equal(
    (await f.open().runRecoveryJob("test", "job", async () => true)).status,
    "unknown",
  );
  assert.equal(f.recoveries.get("one"), 1);
  f.lose(undefined);
  assert.equal(
    (await f.open().reconcileRecovery("test", "one")).status,
    "restored",
  );
  const result = await f
    .open()
    .runRecoveryJob("test", "job", async () => false);
  assert.equal(result.status, "restored");
  assert.deepEqual(result.residuals, []);
  assert.equal(f.recoveries.get("one"), 1);
});

test("compensation completes its step but keeps the job partial", async (t) => {
  const f = await fixture(t);
  f.compensate("one");
  await f.execute("one", "run");
  await f.open().planRecoveryJob({
    workspace: "test",
    jobId: "job",
    selection: { kind: "run", runId: "run" },
  });
  const result = await f.open().runRecoveryJob("test", "job", async () => true);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.outcomes, [
    { operationId: "one", status: "compensated" },
  ]);
  assert.deepEqual(result.residuals, [
    { operationId: "one", status: "compensated" },
  ]);
});

test("restart after inverse receipt but before job checkpoint continues without duplicate effect", async (t) => {
  const f = await fixture(t);
  await f.execute("one", "run");
  await f.execute("two", "run");
  const base = localOperationJournal(join(f.root, "journal"), f.signer);
  const planned = recoveryRuntime({
    journal: base,
    vault: localRecoveryVault(join(f.root, "vault"), { key: f.key }, "key"),
    adapters: [f.adapter],
    authorize: async () => true,
    requireRecoverable: false,
  });
  await planned.planRecoveryJob({
    workspace: "test",
    jobId: "job",
    selection: { kind: "run", runId: "run" },
  });
  let fail = true;
  const interrupted: OperationJournal = {
    transaction: (workspace, run) =>
      base.transaction(workspace, (tx) =>
        run({
          ...tx,
          appendJob: async (event) => {
            if (fail && event.stage === "checkpoint") {
              fail = false;
              throw new Error("checkpoint unavailable");
            }
            await tx.appendJob!(event);
          },
        }),
      ),
  };
  const crashing = recoveryRuntime({
    journal: interrupted,
    vault: localRecoveryVault(join(f.root, "vault"), { key: f.key }, "key"),
    adapters: [f.adapter],
    authorize: async () => true,
    requireRecoverable: false,
  });
  await assert.rejects(
    crashing.runRecoveryJob("test", "job", async () => true),
    /checkpoint unavailable/,
  );
  assert.equal(f.recoveries.get("two"), 1);
  const result = await f
    .open()
    .runRecoveryJob("test", "job", async () => false);
  assert.equal(result.status, "restored");
  assert.equal(f.recoveries.get("two"), 1);
  assert.equal(f.recoveries.get("one"), 1);
});

test("missing adapter pauses with redacted status, blocks forwards, and resumes after repair", async (t) => {
  const f = await fixture(t);
  await f.execute("one", "run");
  await f.open().planRecoveryJob({
    workspace: "test",
    jobId: "job",
    selection: { kind: "run", runId: "run" },
  });
  const unavailable = recoveryRuntime({
    journal: localOperationJournal(join(f.root, "journal"), f.signer),
    vault: localRecoveryVault(join(f.root, "vault"), { key: f.key }, "key"),
    adapters: [],
    authorize: async () => true,
  });
  const paused = await unavailable.runRecoveryJob(
    "test",
    "job",
    async () => true,
  );
  assert.deepEqual(paused, {
    jobId: "job",
    status: "paused",
    checkpoint: 0,
    outcomes: [],
    residuals: [],
    pause: { code: "step-unavailable", operationId: "one" },
  });
  assert.equal(JSON.stringify(paused).includes("adapter"), false);
  assert.deepEqual(await unavailable.recoveryJobStatus("test", "job"), paused);
  await assert.rejects(f.execute("blocked", "other"), /blocks new forward/);
  const restored = await f
    .open()
    .runRecoveryJob("test", "job", async () => false);
  assert.equal(restored.status, "restored");
  assert.equal(f.recoveries.get("one"), 1);
});

test("only one recovery job can become active in a workspace", async (t) => {
  const f = await fixture(t);
  await f.execute("one", "run");
  await f.open().planRecoveryJob({
    workspace: "test",
    jobId: "first",
    selection: { kind: "run", runId: "run" },
  });
  await f.open().planRecoveryJob({
    workspace: "test",
    jobId: "second",
    selection: { kind: "run", runId: "run" },
  });
  const unavailable = recoveryRuntime({
    journal: localOperationJournal(join(f.root, "journal"), f.signer),
    vault: localRecoveryVault(join(f.root, "vault"), { key: f.key }, "key"),
    adapters: [],
    authorize: async () => true,
  });
  assert.equal(
    (await unavailable.runRecoveryJob("test", "first", async () => true))
      .status,
    "paused",
  );
  await assert.rejects(
    f.open().runRecoveryJob("test", "second", async () => true),
    /Another recovery job/,
  );
  assert.equal(
    (await f.open().runRecoveryJob("test", "first", async () => false)).status,
    "restored",
  );
});

test("concurrent runners share one job checkpoint and one inverse", async (t) => {
  const f = await fixture(t);
  await f.execute("one", "run");
  await f.open().planRecoveryJob({
    workspace: "test",
    jobId: "job",
    selection: { kind: "run", runId: "run" },
  });
  const results = await Promise.all([
    f.open().runRecoveryJob("test", "job", async () => true),
    f.open().runRecoveryJob("test", "job", async () => true),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["restored", "restored"],
  );
  assert.equal(f.recoveries.get("one"), 1);
});

test("job journal rejects malformed payloads on append and signed read", async (t) => {
  const f = await fixture(t);
  await f.execute("one", "run");
  const plan = await f.open().planRecoveryJob({
    workspace: "test",
    jobId: "job",
    selection: { kind: "run", runId: "run" },
  });
  const journal = localOperationJournal(join(f.root, "journal"), f.signer);
  await assert.rejects(
    journal.transaction("test", (tx) =>
      tx.appendJob!({
        schema: "void.recovery-job.v1",
        workspace: "test",
        jobId: "other",
        planDigest: plan.digest,
        at: new Date().toISOString(),
        stage: "planned",
        data: { plan } as never,
      }),
    ),
    /does not match embedded plan/,
  );
  await journal.transaction("test", async (tx) => {
    await tx.appendJob!({
      schema: "void.recovery-job.v1",
      workspace: "test",
      jobId: "job",
      planDigest: plan.digest,
      at: new Date().toISOString(),
      stage: "approved",
      data: null,
    });
    await tx.appendJob!({
      schema: "void.recovery-job.v1",
      workspace: "test",
      jobId: "job",
      planDigest: plan.digest,
      at: new Date().toISOString(),
      stage: "applying",
      data: { checkpoint: 0, outcomes: [], residuals: [] },
    });
    await assert.rejects(
      tx.appendJob!({
        schema: "void.recovery-job.v1",
        workspace: "test",
        jobId: "job",
        planDigest: plan.digest,
        at: new Date().toISOString(),
        stage: "checkpoint",
        data: {
          checkpoint: 1,
          outcomes: [{ operationId: "wrong", status: "restored" }],
          residuals: [],
        } as never,
      }),
      /outcome prefix/,
    );
  });
  await jsonlStore(f.signer, { dir: join(f.root, "journal") }).append({
    schema: "void.recovery-job.v1",
    workspace: "test",
    jobId: "job",
    planDigest: plan.digest,
    at: new Date().toISOString(),
    stage: "checkpoint",
    data: {
      checkpoint: 9,
      outcomes: [],
      residuals: [{ operationId: "one", status: "made-up" }],
    },
  });
  await assert.rejects(
    journal.transaction("test", async () => {}),
    /checkpoint|residual/,
  );
});

test("apply rejects a well-formed plan whose boundary record does not exist, including genesis rules", async (t) => {
  const f = await fixture(t);
  const plan = completeRecoveryJobPlan({
    schema: "void.recovery-plan.v1",
    workspace: "test",
    jobId: "job",
    selection: { kind: "run", runId: "run" },
    boundary: { sequence: 9, digest: "1".repeat(64) },
    steps: [],
    residuals: [],
  });
  await localOperationJournal(join(f.root, "journal"), f.signer).transaction(
    "test",
    (tx) =>
      tx.appendJob!({
        schema: "void.recovery-job.v1",
        workspace: "test",
        jobId: "job",
        planDigest: plan.digest,
        at: new Date().toISOString(),
        stage: "planned",
        data: { plan } as never,
      }),
  );
  await assert.rejects(
    f.open().runRecoveryJob("test", "job", async () => true),
    /boundary is invalid/,
  );
  const empty = recoveryRuntime({
    journal: localOperationJournal(join(f.root, "journal"), f.signer),
    vault: localRecoveryVault(join(f.root, "vault"), { key: f.key }, "key"),
    adapters: [f.adapter],
    authorize: async () => true,
  });
  const genesis = await empty.planRecoveryJob({
    workspace: "empty",
    jobId: "genesis",
    selection: { kind: "run", runId: "run" },
  });
  assert.deepEqual(genesis.boundary, { sequence: 0, digest: "0".repeat(64) });
  assert.equal(
    (await empty.runRecoveryJob("empty", "genesis", async () => true)).status,
    "restored",
  );
});

test("run selection accepts cloud generation IDs without widening operation identities", async t=>{
 const f=await fixture(t);
 assert.equal((await f.execute("one","session:2")).status,"succeeded");
 const plan=await f.open().planRecoveryJob({workspace:"test",jobId:"job",selection:{kind:"run",runId:"session:2"}});
 assert.equal(plan.steps[0]?.operationId,"one");
 assert.doesNotThrow(()=>validateRecoveryJobPlan(plan));
 await assert.rejects(f.execute("bad:operation","session:2"),/identity/i);
});
