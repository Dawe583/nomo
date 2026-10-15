import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { devKeyProvider } from "../../ledger/src/sign.ts";
import {
  localOperationJournal,
  localRecoveryVault,
  recoveryRuntime,
  type OperationEvent,
  type RecoveryAdapter,
} from "./index.ts";
import {
  orderRecoverySteps,
  provenanceEdges,
  provenanceOf,
  type ProvenanceFact,
} from "./recovery/provenance.ts";
import type { Json, Observation } from "../../connectors/src/recovery.ts";

const observation = (over: Partial<Observation>): Observation => ({
  effect: "write",
  reversibility: "r1",
  readiness: "verified",
  scope: "cooperative",
  resources: [],
  revision: null,
  blastRadius: { count: 1, precision: "exact" },
  ...over,
});

const fact = (
  operationId: string,
  sequence: number,
  writes: string[],
  reads?: { resource: string; revision: string }[],
): ProvenanceFact => ({
  operationId,
  sequence,
  resources: writes.map((resource) => `file:${resource}`),
  reads: reads?.map((read) => ({ resource: `file:${read.resource}`, revision: read.revision })),
});

test("a read of what an earlier step wrote is a proven-safe reverse order", () => {
  // op-1 writes a.bin, op-2 reads a.bin and writes b.bin. Undo is op-2 then
  // op-1, which is reverse sequence, so the consumer goes first.
  const verdict = orderRecoverySteps([
    fact("op-1", 1, ["a.bin"]),
    fact("op-2", 2, ["b.bin"], [{ resource: "a.bin", revision: "r1" }]),
  ]);
  // op-1 reported no read set, so it claims nothing; only the one proven edge
  // is counted and it is proven safe.
  assert.deepEqual(verdict, { safe: true, independent: ["op-1"], edges: 1 });
});

test("a read of what a LATER step wrote refuses the plan", () => {
  // op-1 reads b.bin, which op-2 writes. Undo is op-2 first, so the producer is
  // restored before its consumer and the consumer is rebuilt against a value
  // the undo just replaced. op-1 does not write b.bin itself, so this is a
  // consultation, and a writer that comes later could have produced what it saw.
  const verdict = orderRecoverySteps([
    fact("op-1", 1, ["a.bin"], [{ resource: "b.bin", revision: "r1" }]),
    fact("op-2", 2, ["b.bin"]),
  ]);
  assert.equal(verdict.safe, false);
  if (verdict.safe) throw new Error("unreachable");
  assert.match(verdict.reason, /op-1 read file:b\.bin from op-2/);
});

test("two steps that read each other are a cycle, not an order", () => {
  const verdict = orderRecoverySteps([
    fact("op-1", 3, ["a.bin"], [{ resource: "b.bin", revision: "r1" }]),
    fact("op-2", 3, ["b.bin"], [{ resource: "a.bin", revision: "r1" }]),
  ]);
  assert.equal(verdict.safe, false);
  if (verdict.safe) throw new Error("unreachable");
  assert.match(verdict.reason, /share a journal sequence/);
});

test("a step that reports no reads claims nothing in either direction", () => {
  const verdict = orderRecoverySteps([
    fact("op-1", 1, ["a.bin"]),
    // No read set: the adapter proved nothing, so it contributes no edge.
    fact("op-2", 2, ["b.bin"]),
    fact("op-3", 3, ["c.bin"], [{ resource: "b.bin", revision: "r1" }]),
  ]);
  assert.deepEqual(verdict, { safe: true, independent: ["op-1", "op-2"], edges: 1 });
});

test("an absent read set is not an empty one", () => {
  assert.equal(
    provenanceOf("op-1", 1, observation({ resources: ["file:a.bin"] })).reads,
    undefined,
  );
  assert.deepEqual(
    provenanceOf("op-2", 2, observation({
      resources: ["file:b.bin"],
      reads: [{ resource: "file:a.bin", revision: "r1" }],
    })).reads,
    [{ resource: "file:a.bin", revision: "r1" }],
  );
});

test("a step's read of what it wrote is its own before-image, not a later step's work", () => {
  // Two writes to one file, which is what a retry or a reformat is, and one
  // step that only consulted it. Each write read the file it was about to
  // write, at the revision it started from, so neither read names the step
  // that came after it. Reading a before-image as a read of the later step's
  // output is what used to refuse this plan, with a claim that was true of
  // neither step.
  const facts = [
    fact("op-1", 1, ["a.bin"], [{ resource: "a.bin", revision: "v1" }]),
    fact("op-2", 2, ["a.bin"], [{ resource: "a.bin", revision: "v2" }]),
    fact("op-3", 3, ["b.bin"], [{ resource: "a.bin", revision: "v2" }]),
  ];
  // op-3 consulted a.bin rather than writing it, so every writer of it is a
  // candidate producer and the proof checks all of them. They are all earlier,
  // which is the order reverse sequence already gives.
  assert.deepEqual(provenanceEdges(facts), [
    { consumer: "op-2", producer: "op-1", resource: "file:a.bin" },
    { consumer: "op-3", producer: "op-1", resource: "file:a.bin" },
    { consumer: "op-3", producer: "op-2", resource: "file:a.bin" },
  ]);
  assert.deepEqual(orderRecoverySteps(facts), {
    safe: true,
    independent: [],
    edges: 3,
  });
});

test("two steps that wrote one resource cannot both have started at the revision they recorded", () => {
  // Both steps wrote a.bin and both recorded v1 for it. The second started from
  // a state the first write had already moved past, so one of the two claimed a
  // revision it cannot have had. Neither step consults anything the other
  // produced, so the closure is empty and this is the only thing left to
  // refuse the plan.
  const verdict = orderRecoverySteps([
    fact("op-1", 1, ["a.bin"], [{ resource: "a.bin", revision: "v1" }]),
    fact("op-2", 2, ["a.bin"], [{ resource: "a.bin", revision: "v1" }]),
  ]);
  assert.equal(verdict.safe, false);
  if (verdict.safe) throw new Error("unreachable");
  assert.match(verdict.reason, /op-2 recorded file:a\.bin at the revision op-1/);
  assert.match(verdict.reason, /cannot have read/);
});

test("an adapter that cannot version what it writes makes no revision claim", () => {
  // The same two writes with no revision recorded: nothing contradicts
  // anything, and nothing is claimed either. The steps are ordered by the
  // journal, which is all the record supports.
  const verdict = orderRecoverySteps([
    fact("op-1", 1, ["a.bin"]),
    fact("op-2", 2, ["a.bin"]),
  ]);
  assert.deepEqual(verdict, { safe: true, independent: ["op-1", "op-2"], edges: 0 });
});

/** An adapter that observed what it read, and one that could not. */
const observing = (observes: boolean): RecoveryAdapter => {
  const versions = new Map<string, string>();
  return {
    id: observes ? "observing" : "blind",
    version: "1",
    async preflight(args) {
      const { id, consulted } = args as { id: string; consulted?: string };
      return {
        effect: "write" as const,
        reversibility: "r1" as const,
        readiness: "verified" as const,
        scope: "probe",
        // The resource it will write is the one it observed, which is not
        // necessarily the one the caller named.
        resources: [`observed:${id}`],
        ...(observes && consulted !== undefined
          ? {
              reads: [
                {
                  resource: `observed:${consulted}`,
                  revision: versions.get(consulted) ?? "v0",
                },
              ],
            }
          : {}),
        revision: versions.get(id) ?? null,
        blastRadius: { count: 1, precision: "exact" as const },
      };
    },
    async prepare(args: Json) {
      return { before: null, plan: args };
    },
    async execute(args: Json) {
      const { id } = args as { id: string };
      versions.set(id, `v-${id}`);
      return { result: id, evidence: null };
    },
    async release() {},
    async reconcile() {
      return { status: "unknown" as const };
    },
    async recover() {
      return { status: "restored" as const, evidence: null };
    },
  };
};

/** An adapter whose observation carries no revision field at all. The type
 * says `revision` is required, and an adapter that breaks its own type is
 * exactly how this reaches the journal, so the runtime has to survive it. */
const unversioned = (): RecoveryAdapter => ({
  ...observing(false),
  id: "unversioned",
  async preflight(args) {
    const { revision: _absent, ...rest } = await observing(false).preflight(args);
    return rest as unknown as Observation;
  },
});

const probe = async (t: TestContext, adapter: RecoveryAdapter) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-provenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const signer = await devKeyProvider({ dir: join(root, "keys"), env: {} });
  // One key for every runtime over this workspace: a second key would make the
  // durable capture unreadable and the steps unavailable, which is a property
  // of the test rather than of the ordering.
  const key = randomBytes(32);
  const runtime = () =>
    recoveryRuntime({
      journal: localOperationJournal(join(root, "journal"), signer),
      vault: localRecoveryVault(join(root, "vault"), { key }, "key"),
      adapters: [adapter],
      authorize: async () => true,
      requireRecoverable: false,
    });
  const dispatch = (operationId: string, args: Json) =>
    runtime().execute({
      workspace: "probe",
      operationId,
      runId: "run",
      agentId: "agent",
      adapterId: adapter.id,
      arguments: args,
    });
  const records = async (operationId: string): Promise<OperationEvent[]> => {
    const found: OperationEvent[] = [];
    await localOperationJournal(join(root, "journal"), signer).transaction(
      "probe",
      async (tx) => {
        for (const event of tx.events)
          if (event.operationId === operationId) found.push(event);
      },
    );
    return found;
  };
  return { runtime, dispatch, records };
};

test("the signed record carries what the adapter observed, not what the caller declared", async (t) => {
  const adapter = observing(true);
  const { dispatch, records } = await probe(t, adapter);
  assert.equal(
    (await dispatch("op-1", { id: "op-1", consulted: "other" })).status,
    "succeeded",
  );
  // The caller named no resource at all; the adapter observed one, and only
  // that reaches the journal.
  const events = (await records("op-1")).filter((event) => event.stage !== "received");
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.deepEqual(event.readSet, ["observed:other"]);
    assert.deepEqual(event.writeSet, ["observed:op-1"]);
    // The observed revision is null here, recorded canonically rather than
    // dropped, so the record never claims a revision it did not see.
    assert.equal(event.revision, "null");
  }
});

test("an adapter that cannot observe its reads records no read set at all", async (t) => {
  const adapter = observing(false);
  const { dispatch, records } = await probe(t, adapter);
  assert.equal(
    (await dispatch("op-1", { id: "op-1", consulted: "other" })).status,
    "succeeded",
  );
  // `received` is written before the adapter is asked anything, so the sets
  // start at the first record that could have observed them.
  const events = (await records("op-1")).filter((event) => event.stage !== "received");
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal(event.readSet, undefined);
    assert.deepEqual(event.writeSet, ["observed:op-1"]);
  }
});

test("an adapter that reports no revision records none, and still journals", async (t) => {
  const adapter = unversioned();
  const { dispatch, records } = await probe(t, adapter);
  // A signed record that cannot be canonicalised is a defect at the producer,
  // so the dispatch has to complete rather than fail on its own absent field.
  assert.equal(
    (await dispatch("op-1", { id: "op-1" })).status,
    "succeeded",
  );
  const events = (await records("op-1")).filter((event) => event.stage !== "received");
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal(event.revision, undefined);
    assert.equal(event.readSet, undefined);
    assert.deepEqual(event.writeSet, ["observed:op-1"]);
  }
});

test("a run of two writes to one resource is a plan, not a refusal", async (t) => {
  const adapter = observing(true);
  const { runtime, dispatch } = await probe(t, adapter);
  for (const operationId of ["op-1", "op-2"])
    assert.equal(
      (await dispatch(operationId, { id: "op-1", consulted: "op-1" })).status,
      "succeeded",
    );
  const plan = await runtime().planRecoveryJob({
    workspace: "probe",
    jobId: "job",
    selection: { kind: "run", runId: "run" },
  });
  assert.deepEqual(
    plan.steps.map((step) => step.operationId),
    ["op-2", "op-1"],
  );
});
