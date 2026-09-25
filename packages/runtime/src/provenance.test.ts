import test from "node:test";
import assert from "node:assert/strict";
import { orderRecoverySteps, provenanceOf, type ProvenanceFact } from "./recovery/provenance.ts";
import type { Observation } from "../../connectors/src/recovery.ts";

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
  // the undo just replaced.
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
