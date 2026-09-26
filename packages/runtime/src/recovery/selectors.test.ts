import test from "node:test";
import assert from "node:assert/strict";
import {
  RECOVERY_SELECTOR_KINDS,
  independentBranches,
  resolveRecoverySelection,
  type RecoveryJournalState,
  type RecoveryOperationState,
  type RecoveryJobRequest,
  type RecoverySelection,
} from "./plan.ts";
import {
  orderRecoverySteps,
  provenanceEdges,
  type ProvenanceFact,
} from "./provenance.ts";

const fact = (
  operationId: string,
  sequence: number,
  writes: readonly string[] = [],
  reads?: readonly string[],
): ProvenanceFact => ({
  operationId,
  sequence,
  resources: writes.map((resource) => `file:${resource}`),
  reads: reads?.map((resource) => ({ resource: `file:${resource}`, revision: "r1" })),
});

const operation = (
  operationId: string,
  sequence: number,
  over: {
    readonly at?: string;
    readonly runId?: string;
    readonly fact?: ProvenanceFact;
  } = {},
): RecoveryOperationState => ({
  operationId,
  sequence,
  at: over.at ?? `2026-09-26T10:0${sequence}:00.000Z`,
  runId: over.runId ?? "run",
  fact: over.fact ?? fact(operationId, sequence),
});

const state = (
  operations: readonly RecoveryOperationState[],
  head?: number,
): RecoveryJournalState => ({
  operations,
  boundary: {
    sequence:
      head ??
      operations.reduce((highest, candidate) => Math.max(highest, candidate.sequence), 0),
    digest: "a".repeat(64),
  },
});

const kinds = RECOVERY_SELECTOR_KINDS.join(", ");

test("a dependency selector pulls in the branch that produced what the root read", () => {
  const s = state([
    operation("producer", 1, { fact: fact("producer", 1, ["a.bin"]) }),
    operation("root", 2, { fact: fact("root", 2, ["b.bin"], ["a.bin"]) }),
    operation("elsewhere", 3, { fact: fact("elsewhere", 3, ["c.bin"]) }),
  ]);
  assert.deepEqual(
    resolveRecoverySelection(s, { kind: "dependencies", operationIds: ["root"] }),
    { kind: "resolved", operationIds: ["root", "producer"], missing: [] },
  );
});

test("a dependency selector follows producers transitively", () => {
  const s = state([
    operation("producer", 1, { fact: fact("producer", 1, ["a.bin"]) }),
    operation("middle", 2, { fact: fact("middle", 2, ["b.bin"], ["a.bin"]) }),
    operation("root", 3, { fact: fact("root", 3, ["c.bin"], ["b.bin"]) }),
  ]);
  assert.deepEqual(
    resolveRecoverySelection(s, { kind: "dependencies", operationIds: ["root"] }),
    {
      kind: "resolved",
      operationIds: ["root", "middle", "producer"],
      missing: [],
    },
  );
});

test("a dependency selector refuses a root that recorded no read set", () => {
  // The selector promises the whole branch. A root that proved nothing about
  // what it read cannot have that promise kept for it.
  const s = state([operation("blind", 1, { fact: fact("blind", 1, ["a.bin"]) })]);
  const result = resolveRecoverySelection(s, {
    kind: "dependencies",
    operationIds: ["blind"],
  });
  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") throw new Error("unreachable");
  assert.match(result.reason, /blind/);
  assert.match(result.reason, /read set/);
});

test("a dependency selector refuses a root the journal does not contain", () => {
  const s = state([operation("known", 1)]);
  const result = resolveRecoverySelection(s, {
    kind: "dependencies",
    operationIds: ["absent"],
  });
  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") throw new Error("unreachable");
  assert.match(result.reason, /absent/);
  assert.ok(result.reason.includes(kinds));
});

test("a dependency selector refuses a branch whose order cannot be proven", () => {
  const s = state([
    operation("early", 1, { fact: fact("early", 1, ["a.bin"], ["b.bin"]) }),
    operation("late", 2, { fact: fact("late", 2, ["b.bin"]) }),
  ]);
  const result = resolveRecoverySelection(s, {
    kind: "dependencies",
    operationIds: ["early"],
  });
  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") throw new Error("unreachable");
  assert.match(result.reason, /provably safe/);
  assert.match(result.reason, /early read file:b\.bin from late/);
});

test("a time selector takes the window, inclusive at the upper bound only", () => {
  const s = state([
    operation("a", 1, { at: "2026-09-26T10:00:00.000Z" }),
    operation("b", 2, { at: "2026-09-26T11:00:00.000Z" }),
    operation("c", 3, { at: "2026-09-26T12:00:00.000Z" }),
  ]);
  assert.deepEqual(
    resolveRecoverySelection(s, { kind: "time", before: "2026-09-26T11:00:00.000Z" }),
    { kind: "resolved", operationIds: ["b", "a"], missing: [] },
  );
  assert.deepEqual(
    resolveRecoverySelection(s, {
      kind: "time",
      after: "2026-09-26T10:00:00.000Z",
      before: "2026-09-26T12:00:00.000Z",
    }),
    { kind: "resolved", operationIds: ["c", "b"], missing: [] },
  );
});

test("a time selector refuses an instant it cannot order against the journal", () => {
  const s = state([operation("a", 1)]);
  const result = resolveRecoverySelection(s, { kind: "time", before: "2026-09-26 11:00" });
  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") throw new Error("unreachable");
  assert.match(result.reason, /UTC/);
  assert.ok(result.reason.includes(kinds));
});

test("a time selector refuses rather than skip an operation with no usable instant", () => {
  const s = state([
    operation("a", 1, { at: "2026-09-26T10:00:00.000Z" }),
    operation("b", 2, { at: "yesterday" }),
  ]);
  const result = resolveRecoverySelection(s, { kind: "time", before: "2026-09-27T00:00:00.000Z" });
  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") throw new Error("unreachable");
  assert.match(result.reason, /\bb\b/);
  assert.match(result.reason, /instant/);
});

test("a time selector refuses a window that cannot contain anything", () => {
  const s = state([operation("a", 1)]);
  const result = resolveRecoverySelection(s, {
    kind: "time",
    after: "2026-09-26T12:00:00.000Z",
    before: "2026-09-26T10:00:00.000Z",
  });
  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") throw new Error("unreachable");
  assert.match(result.reason, /earlier/);
});

test("a checkpoint selector takes the journal prefix the checkpoint names", () => {
  const s = state(
    [
      operation("a", 1),
      operation("b", 2),
      operation("c", 3),
      operation("d", 4),
    ],
    9,
  );
  assert.deepEqual(
    resolveRecoverySelection(s, { kind: "checkpoint", sequence: 2 }),
    { kind: "resolved", operationIds: ["b", "a"], missing: [] },
  );
});

test("a checkpoint selector refuses a checkpoint past the journal boundary", () => {
  const s = state([operation("a", 1)], 4);
  const result = resolveRecoverySelection(s, { kind: "checkpoint", sequence: 5 });
  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") throw new Error("unreachable");
  assert.match(result.reason, /boundary at 4/);
  assert.ok(result.reason.includes(kinds));
});

test("a checkpoint selector refuses anything that is not a journal sequence", () => {
  const s = state([operation("a", 1)], 4);
  for (const sequence of [-1, 1.5, "2", null]) {
    const result = resolveRecoverySelection(s, { kind: "checkpoint", sequence });
    assert.equal(result.kind, "refused", `${JSON.stringify(sequence)} must be refused`);
  }
});

test("an unknown selector kind is refused with the valid kinds, never a fallback", () => {
  const s = state([operation("a", 1), operation("b", 2)]);
  for (const selector of [
    { kind: "latest" },
    { kind: "everything" },
    {},
    null,
    "run",
    [{ kind: "run" }],
  ]) {
    const result = resolveRecoverySelection(s, selector);
    assert.equal(result.kind, "refused", `${JSON.stringify(selector)} must be refused`);
    if (result.kind !== "refused") throw new Error("unreachable");
    assert.ok(result.reason.includes(kinds), result.reason);
  }
});

test("a run selector keeps to its own run and orders the undo by journal sequence", () => {
  const s = state([
    operation("a", 1, { runId: "one" }),
    operation("b", 2, { runId: "two" }),
    operation("c", 3, { runId: "one" }),
  ]);
  assert.deepEqual(
    resolveRecoverySelection(s, { kind: "run", runId: "one" }),
    { kind: "resolved", operationIds: ["c", "a"], missing: [] },
  );
});

test("a run that has done nothing resolves to nothing, it does not refuse", () => {
  // The genesis plan: an empty journal, a well formed run selector, no work to
  // undo. That is a zero step plan, the shape `planRecoveryJob` already signs
  // with a zero boundary, and it must not turn into a refusal. The rule forms
  // below differ: the runtime boundary refuses a rule that resolves to
  // nothing, because `validateRecoveryJobPlan` will not record an empty
  // operation list and a plan has no honest way to say "this selector matched
  // nothing". A `run` selection is recorded verbatim, so it is the form that
  // can be a zero step plan.
  const genesis = state([], 0);
  assert.deepEqual(
    resolveRecoverySelection(genesis, { kind: "run", runId: "run" }),
    { kind: "resolved", operationIds: [], missing: [] },
  );
  // The same holds for a run that exists in the journal but owns no operation
  // yet, and for the other selectors that name a point rather than a list.
  const started = state([operation("a", 1, { runId: "one" })], 1);
  assert.deepEqual(
    resolveRecoverySelection(started, { kind: "run", runId: "two" }),
    { kind: "resolved", operationIds: [], missing: [] },
  );
  assert.deepEqual(
    resolveRecoverySelection(started, {
      kind: "time",
      before: "2020-01-01T00:00:00.000Z",
    }),
    { kind: "resolved", operationIds: [], missing: [] },
  );
  assert.deepEqual(
    resolveRecoverySelection(started, { kind: "checkpoint", sequence: 0 }),
    { kind: "resolved", operationIds: [], missing: [] },
  );
});

test("every selector kind is a job request a caller can write without a cast", () => {
  // A compile time claim, and `tsc` runs over this file. A rule selector the
  // runtime resolves is useless to a TypeScript caller who has to assert their
  // way past the request type to ask for one, so the request takes the rule
  // forms while the recorded plan keeps the exact selection.
  const requests: RecoveryJobRequest[] = [
    { workspace: "test", jobId: "run", selection: { kind: "run", runId: "run" } },
    {
      workspace: "test",
      jobId: "operations",
      selection: { kind: "operations", operationIds: ["one", "two"] },
    },
    {
      workspace: "test",
      jobId: "dependencies",
      selection: { kind: "dependencies", operationIds: ["one"] },
    },
    {
      workspace: "test",
      jobId: "time",
      selection: {
        kind: "time",
        after: "2026-09-26T10:00:00.000Z",
        before: "2026-09-26T12:00:00.000Z",
      },
    },
    {
      workspace: "test",
      jobId: "checkpoint",
      selection: { kind: "checkpoint", sequence: 12 },
    },
  ];
  // An exact selection a caller already holds stays request shaped, which is
  // what the workbench, SDK and CLI pass through unchanged.
  const exact: RecoverySelection = { kind: "operations", operationIds: ["one"] };
  const held: RecoveryJobRequest = { workspace: "test", jobId: "exact", selection: exact };
  assert.deepEqual(requests[4]!.selection, { kind: "checkpoint", sequence: 12 });
  assert.equal(held.selection.kind, "operations");
});

test("an operations selector reports a named operation it cannot find", () => {
  const s = state([operation("a", 1), operation("b", 2)]);
  assert.deepEqual(
    resolveRecoverySelection(s, { kind: "operations", operationIds: ["b", "absent"] }),
    { kind: "resolved", operationIds: ["b"], missing: ["absent"] },
  );
});

test("an operations selector refuses an empty, repeated or malformed list", () => {
  const s = state([operation("a", 1)]);
  for (const operationIds of [[], ["a", "a"], ["not an id"], "a", [1]]) {
    const result = resolveRecoverySelection(s, { kind: "operations", operationIds });
    assert.equal(result.kind, "refused", `${JSON.stringify(operationIds)} must be refused`);
  }
});

test("a selector carrying keys its kind does not define is refused", () => {
  const s = state([operation("a", 1)]);
  const result = resolveRecoverySelection(s, {
    kind: "run",
    runId: "run",
    operationIds: [],
  });
  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") throw new Error("unreachable");
  assert.match(result.reason, /run/);
});

test("a journal state that names one operation twice is refused", () => {
  const s = state([operation("a", 1), operation("a", 2)]);
  const result = resolveRecoverySelection(s, { kind: "run", runId: "run" });
  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") throw new Error("unreachable");
  assert.match(result.reason, /\ba\b/);
  assert.match(result.reason, /once/);
});

test("a blocked branch holds only what read what it wrote", () => {
  const s = state([
    operation("blocked", 1, { fact: fact("blocked", 1, ["a.bin"]) }),
    operation("consumer", 2, { fact: fact("consumer", 2, ["b.bin"], ["a.bin"]) }),
    operation("independent", 3, { fact: fact("independent", 3, ["c.bin"], ["d.bin"]) }),
  ]);
  const branches = independentBranches(s, ["blocked"]);
  assert.equal(branches.kind, "resolved");
  if (branches.kind !== "resolved") throw new Error("unreachable");
  // The independent branch continues; only the consumer of the blocked write
  // is held back, and it is held for a reason a reviewer can read.
  assert.deepEqual(branches.independent, ["independent"]);
  assert.deepEqual(branches.unproven, []);
  assert.deepEqual(branches.held, [
    {
      operationId: "consumer",
      blocked: "blocked",
      resource: "file:a.bin",
      reason: "consumer read file:a.bin from blocked, which is blocked or in progress",
    },
  ]);
});

test("a blocked consumer holds the producer that must be restored after it", () => {
  const s = state([
    operation("producer", 1, { fact: fact("producer", 1, ["a.bin"]) }),
    operation("blocked", 2, { fact: fact("blocked", 2, ["b.bin"], ["a.bin"]) }),
    operation("independent", 3, { fact: fact("independent", 3, ["c.bin"], ["d.bin"]) }),
  ]);
  const branches = independentBranches(s, ["blocked"]);
  if (branches.kind !== "resolved") throw new Error("unreachable");
  assert.deepEqual(branches.independent, ["independent"]);
  assert.deepEqual(branches.held, [
    {
      operationId: "producer",
      blocked: "blocked",
      resource: "file:a.bin",
      reason: "blocked read file:a.bin from producer, so producer must be restored after it",
    },
  ]);
});

test("a step that recorded no reads is surfaced, never called independent", () => {
  const s = state([
    operation("blocked", 1, { fact: fact("blocked", 1, ["a.bin"]) }),
    operation("unread", 2, { fact: fact("unread", 2, ["b.bin"]) }),
    operation("independent", 3, { fact: fact("independent", 3, ["c.bin"], ["d.bin"]) }),
  ]);
  const branches = independentBranches(s, ["blocked"]);
  if (branches.kind !== "resolved") throw new Error("unreachable");
  assert.deepEqual(branches.independent, ["independent"]);
  assert.deepEqual(branches.unproven, ["unread"]);
});

test("continuation refuses a blocked operation the journal does not contain", () => {
  const s = state([operation("a", 1)]);
  const branches = independentBranches(s, ["ghost"]);
  assert.equal(branches.kind, "refused");
  if (branches.kind !== "refused") throw new Error("unreachable");
  assert.match(branches.reason, /ghost/);
});

test("continuation holds nothing when the blocked branch touches nothing", () => {
  const s = state([
    operation("blocked", 1, { fact: fact("blocked", 1, ["a.bin"]) }),
    operation("later", 2, { fact: fact("later", 2, ["b.bin"], ["c.bin"]) }),
  ]);
  const branches = independentBranches(s, ["blocked"]);
  if (branches.kind !== "resolved") throw new Error("unreachable");
  assert.deepEqual(branches.independent, ["later"]);
  assert.deepEqual(branches.held, []);
});

// `orderRecoverySteps` used to build this edge list inline and counted a
// repeated read or a repeated write once per occurrence, so one claim was
// counted twice. That counter now reads the shared list above. Both versions
// were run over 20,000 generated fact sets: the safety verdict and the refusal
// reason never moved, and the edge count moved only where a fact listed the
// same resource twice. No other expectation in the tree depends on the old
// count, and `edges` documents itself as one proven edge. Do not re-open this
// without new evidence that the two answers are not the same claim.
test("the edge list counts one edge per consumer, producer and resource", () => {
  const facts = [
    fact("op-1", 1, ["a.bin"]),
    // The same read recorded twice is one claim, not two.
    fact("op-2", 2, ["b.bin"], ["a.bin", "a.bin"]),
  ];
  assert.deepEqual(provenanceEdges(facts), [
    { consumer: "op-2", producer: "op-1", resource: "file:a.bin" },
  ]);
  assert.deepEqual(orderRecoverySteps(facts), {
    safe: true,
    independent: ["op-1"],
    edges: 1,
  });
});
