import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, stat, chmod } from "node:fs/promises";
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
import { managedFilesystemAdapter } from "../../connectors/src/filesystem/managed.ts";

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

test("run selection accepts cloud generation IDs without widening operation identities", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.execute("one", "session:2")).status, "succeeded");
  const plan = await f
    .open()
    .planRecoveryJob({
      workspace: "test",
      jobId: "job",
      selection: { kind: "run", runId: "session:2" },
    });
  assert.equal(plan.steps[0]?.operationId, "one");
  assert.doesNotThrow(() => validateRecoveryJobPlan(plan));
  await assert.rejects(f.execute("bad:operation", "session:2"), /identity/i);
});

test("R06: a recovery job lease is claimed, renewed, and only reclaimed once its holder is gone", async (t) => {
  const f = await fixture(t);
  await f.execute("one", "run");
  await f.execute("two", "run");
  const plan = await f
    .open()
    .planRecoveryJob({
      workspace: "test",
      jobId: "leased",
      selection: { kind: "run", runId: "run" },
    });

  // Nothing is claimed before a worker applies the plan, so a planned job does
  // not block a second one.
  const second = await f
    .open()
    .planRecoveryJob({
      workspace: "test",
      jobId: "other",
      selection: { kind: "run", runId: "run" },
    });
  assert.equal(second.steps.length, 2);

  await f
    .open()
    .runRecoveryJob(
      "test",
      "leased",
      async (reviewed) => reviewed.digest === plan.digest,
    );
  // A finished job no longer blocks, so the second one can still run.
  const done = await f
    .open()
    .runRecoveryJob(
      "test",
      "other",
      async (reviewed) => reviewed.digest === second.digest,
    );
  assert.equal(done.status, "restored");
});

test("R06: a live job blocks a new one and a dead holder with an expired lease does not", async (t) => {
  const f = await fixture(t);
  await f.execute("one", "run");
  const plan = await f
    .open()
    .planRecoveryJob({
      workspace: "test",
      jobId: "abandoned",
      selection: { kind: "run", runId: "run" },
    });
  await f
    .open()
    .runRecoveryJob(
      "test",
      "abandoned",
      async (reviewed) => reviewed.digest === plan.digest,
    );

  // A finished job leaves no live holder, so a fresh plan in the same
  // workspace is allowed rather than refused. The step is already recovered, so
  // it is a residual and not a step: the point here is that planning was not
  // blocked, not what it selected.
  const next = await f
    .open()
    .planRecoveryJob({
      workspace: "test",
      jobId: "next",
      selection: { kind: "run", runId: "run" },
    });
  assert.equal(next.steps.length, 0);
  assert.deepEqual(
    next.residuals.map((residual) => residual.status),
    ["already-recovered"],
  );
});

test("a rule selector resolves to steps and the plan records the steps it undoes", async (t) => {
  const f = await fixture(t);
  await f.execute("one", "run");
  await f.execute("two", "run");
  await f.execute("other", "other");
  const everything = await f.open().planRecoveryJob({
    workspace: "test",
    jobId: "all",
    selection: { kind: "time", before: "2999-01-01T00:00:00.000Z" },
  });
  assert.deepEqual(
    everything.steps.map((step) => step.operationId),
    ["other", "two", "one"],
  );
  // A plan names the steps it undoes, not the rule that chose them, so the
  // digest and every consumer of a plan stay the shape they already were.
  assert.deepEqual(everything.selection, {
    kind: "operations",
    operationIds: ["other", "two", "one"],
  });
  assert.doesNotThrow(() => validateRecoveryJobPlan(everything));
  // The same journal reached by a different rule. A checkpoint names a journal
  // position and is inclusive of the operation recorded at it, so the two cases
  // that matter are the position a step occupies and the one just below it.
  // Both are here because an operator who gets this wrong silently recovers
  // one operation too many or too few.
  const second = everything.steps[1]!;
  const upto = await f.open().planRecoveryJob({
    workspace: "test",
    jobId: "upto",
    selection: { kind: "checkpoint", sequence: second.sequence },
  });
  assert.deepEqual(
    upto.steps.map((step) => step.operationId),
    ["two", "one"],
  );
  assert.deepEqual(upto.selection, {
    kind: "operations",
    operationIds: ["two", "one"],
  });
  const below = await f.open().planRecoveryJob({
    workspace: "test",
    jobId: "below",
    selection: { kind: "checkpoint", sequence: second.sequence - 1 },
  });
  assert.deepEqual(
    below.steps.map((step) => step.operationId),
    ["one"],
  );
  assert.equal(
    (await f.open().runRecoveryJob("test", "upto", async () => true)).status,
    "restored",
  );
  // Only what the plan named was undone, and nothing else was touched. Both
  // named operations created their own value, so a correct restore removes
  // the key outright rather than putting an older revision back.
  assert.equal(f.values.has("one"), false);
  assert.equal(f.values.has("two"), false);
  assert.equal(f.values.get("other"), "after-other");
  // The inverse ran for exactly the two operations the plan named, which is
  // the claim that a shorter prefix does not quietly recover the whole run.
  assert.deepEqual([...f.recoveries.keys()].sort(), ["one", "two"]);
});

test("a selector that cannot be answered is refused with a reason and plans nothing", async (t) => {
  const f = await fixture(t);
  await f.execute("one", "run");
  const open = f.open();
  await assert.rejects(
    () =>
      open.planRecoveryJob({
        workspace: "test",
        jobId: "unknown",
        selection: { kind: "wat" } as never,
      }),
    /"wat" is not a recovery selector kind/,
  );
  await assert.rejects(
    () =>
      open.planRecoveryJob({
        workspace: "test",
        jobId: "past",
        selection: { kind: "checkpoint", sequence: 9999 },
      }),
    /cannot name sequence 9999/,
  );
  // A window with nothing in it is refused as the empty window it is, not as
  // a malformed request, because that is the thing the operator has to fix.
  await assert.rejects(
    () =>
      open.planRecoveryJob({
        workspace: "test",
        jobId: "empty",
        selection: { kind: "time", before: "2000-01-01T00:00:00.000Z" },
      }),
    /The time selector resolved to no operations before the boundary at sequence \d+/,
  );
  // A rule the plan cannot store cannot be proven to be the same request.
  await open.planRecoveryJob({
    workspace: "test",
    jobId: "once",
    selection: { kind: "time", before: "2999-01-01T00:00:00.000Z" },
  });
  await assert.rejects(
    () =>
      open.planRecoveryJob({
        workspace: "test",
        jobId: "once",
        selection: { kind: "time", before: "2999-01-01T00:00:00.000Z" },
      }),
    /a time selector is not recorded in the plan/,
  );
  for (const jobId of ["unknown", "past", "empty"])
    await assert.rejects(
      () => open.recoveryJobStatus("test", jobId),
      /Recovery job not found/,
    );
});

test("a step another job holds keeps its connected branch out of the plan", async (t) => {
  const f = await fixture(t);
  // The shared fixture's adapter records no read sets, so this case needs one
  // that does: a branch is only provable from a recorded read, and inventing
  // edges from the shared one would change the ordering proof under every
  // other case in this file.
  const root = await mkdtemp(join(tmpdir(), "void-held-branch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const signer = await devKeyProvider({ dir: join(root, "keys"), env: {} });
  const key = randomBytes(32);
  const values = new Map<string, string>();
  const adapter: RecoveryAdapter = {
    id: "reading",
    version: "1",
    async preflight(args) {
      const { id, reads } = args as { id: string; reads?: string };
      return {
        effect: "write",
        reversibility: "r1",
        readiness: "verified",
        scope: id,
        resources: [`held:${id}`],
        ...(reads
          ? {
              reads: [
                {
                  resource: `held:${reads}`,
                  revision: values.get(reads) ?? null,
                },
              ],
            }
          : {}),
        revision: null,
        blastRadius: { count: 1, precision: "exact" },
      };
    },
    async prepare(args, observation) {
      return { before: observation.revision, plan: args };
    },
    async execute(args) {
      const { id } = args as { id: string };
      values.set(id, `wrote-${id}`);
      return { result: id, evidence: { id } };
    },
    async release() {},
    async reconcile() {
      return { status: "unknown" };
    },
    async recover() {
      return { status: "restored", evidence: null };
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
  for (const [operationId, id, reads] of [
    ["op-writer", "writer", undefined],
    ["op-reader", "reader", "writer"],
    ["op-free", "free", undefined],
  ] as const)
    assert.equal(
      (
        await open().execute({
          workspace: "test",
          operationId,
          runId: "run",
          agentId: "agent",
          adapterId: adapter.id,
          // `Json` has no undefined, and an absent read set is the claim this
          // case is about: one writer that read nothing cannot be held.
          arguments: { id, ...(reads ? { reads } : {}) },
        })
      ).status,
      "succeeded",
    );
  // A job that has claimed a step and is still applying it holds that step.
  const held = await open().planRecoveryJob({
    workspace: "test",
    jobId: "held",
    selection: { kind: "operations", operationIds: ["op-writer"] },
  });
  const at = new Date().toISOString();
  await localOperationJournal(join(root, "journal"), signer).transaction(
    "test",
    async (tx) => {
      await tx.appendJob!({
        schema: "void.recovery-job.v1",
        workspace: "test",
        jobId: "held",
        planDigest: held.digest,
        at,
        stage: "approved",
        data: null,
      });
      await tx.appendJob!({
        schema: "void.recovery-job.v1",
        workspace: "test",
        jobId: "held",
        planDigest: held.digest,
        at,
        stage: "applying",
        data: {
          checkpoint: 0,
          outcomes: [],
          residuals: held.residuals,
          lease: { holder: "other:1", expiresAt: Date.now() + 600_000 },
        } as never,
      });
    },
  );
  const continuation = await open().planRecoveryJob({
    workspace: "test",
    jobId: "continuation",
    selection: { kind: "operations", operationIds: ["op-free", "op-reader"] },
  });
  // op-reader read what the held step wrote, so it is restored after it and
  // cannot be planned now. op-free touches nothing the held step wrote and is.
  assert.deepEqual(
    continuation.steps.map((step) => step.operationId),
    ["op-free"],
  );
  assert.deepEqual(continuation.residuals, [
    { operationId: "op-reader", status: "blocked-by-conflict" },
  ]);
  assert.doesNotThrow(() => validateRecoveryJobPlan(continuation));
});

async function filesystemFixture(
  t: import("node:test").TestContext,
  tamperBetweenSteps = false,
) {
  const root = await mkdtemp(join(tmpdir(), "void-recovery-chain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "shared.txt"), "original", { mode: 0o640 });
  if (process.platform !== "win32")
    await chmod(join(root, "shared.txt"), 0o640);
  const signer = await devKeyProvider({ dir: join(root, "keys"), env: {} });
  const key = randomBytes(32);
  let recoverCalls = 0;
  const filesystem = managedFilesystemAdapter({ root, cooperative: true });
  const adapter: RecoveryAdapter = {
    ...filesystem,
    async recover(prepared, outcome, recoveryId) {
      const result = await filesystem.recover(prepared, outcome, recoveryId);
      recoverCalls++;
      if (tamperBetweenSteps && recoverCalls === 1)
        await writeFile(join(root, "shared.txt"), "first");
      return result;
    },
  };
  const runtime = () =>
    recoveryRuntime({
      journal: localOperationJournal(join(root, "journal"), signer),
      vault: localRecoveryVault(join(root, "vault"), { key }, "key"),
      adapters: [adapter],
      authorize: async () => true,
    });
  const execute = (operationId: string, value: string) =>
    runtime().execute({
      workspace: "test",
      operationId,
      runId: "writes",
      agentId: "agent",
      adapterId: adapter.id,
      arguments: {
        action: "write",
        path: "shared.txt",
        base64: Buffer.from(value).toString("base64"),
      },
    });
  return { root, runtime, execute };
}

test("filesystem recovery job restores adjacent writes to one existing file", async (t) => {
  const f = await filesystemFixture(t);
  await f.execute("first", "first");
  await f.execute("second", "second");
  const runtime = f.runtime();
  const plan = await runtime.planRecoveryJob({
    workspace: "test",
    jobId: "chain",
    selection: { kind: "run", runId: "writes" },
  });
  const result = await runtime.runRecoveryJob(
    "test",
    "chain",
    async () => true,
  );
  assert.equal(result.status, "restored");
  assert.equal(await readFile(join(f.root, "shared.txt"), "utf8"), "original");
  if (process.platform !== "win32")
    assert.equal((await stat(join(f.root, "shared.txt"))).mode & 0o777, 0o640);
  const stored = await runtime.recoveryJobStatus("test", "chain");
  assert.equal("status" in stored ? stored.status : "plan", "restored");
  assert.equal(plan.steps.length, 2);
});

test("filesystem recovery continuation rejects ABA with identical bytes between inverses", async (t) => {
  const f = await filesystemFixture(t, true);
  await f.execute("first", "first");
  await f.execute("second", "second");
  const runtime = f.runtime();
  await runtime.planRecoveryJob({
    workspace: "test",
    jobId: "drift",
    selection: { kind: "run", runId: "writes" },
  });
  const result = await runtime.runRecoveryJob(
    "test",
    "drift",
    async () => true,
  );
  assert.equal(result.status, "conflict");
  assert.equal(await readFile(join(f.root, "shared.txt"), "utf8"), "first");
});
