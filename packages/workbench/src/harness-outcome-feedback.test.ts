/**
 * The return path of the learning loop, at the Workbench level.
 *
 * An operator's answer has to bind the next question. What these tests prove:
 * a proposal an operator rejected cannot be recorded again unchanged, the same
 * edit resting on a newer record can, a rolled back refinement is settled the
 * same way, the refusal leaves no record behind, and the outcomes never join
 * the entries the agent's prompt is built from.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { isolatedWorkbench } from "./test-fixture.ts";
import type { RefinementProposal } from "./refine-pass.ts";

const fetcher = async (url: unknown) =>
  String(url).endsWith("/models")
    ? Response.json({ data: [{ id: "fixture" }] })
    : Response.json({ choices: [{ message: { role: "assistant", content: "Ready" }, finish_reason: "stop" }] });

async function fixture(t: TestContext) {
  const f = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-harness-outcome-",
  });
  const { app } = f;
  const session = await app.start("Review the workspace", "fixture");
  await app.settled();
  // The seed record gives every proposal a ledger sequence to cite.
  await app.editDocument(session.id, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });
  return { app, session };
}

const lesson = (seqs: readonly number[], reason = "the record repeats"): RefinementProposal => ({
  summary: "named lesson",
  rationale: "supported by signed records",
  expectedOutcome: "one durable lesson",
  edits: [{
    action: "create",
    kind: "memory",
    title: "approval pattern",
    content: "Ask before deleting.",
    derivedFromSeq: [...seqs],
    reason,
  }],
});

async function chain(app: Awaited<ReturnType<typeof fixture>>["app"], workspace: string) {
  return (await app.ledger(workspace))!.entries;
}

test("a rejected proposal cannot be recorded again unchanged", async (t) => {
  const { app, session } = await fixture(t);
  const created = await app.refineHarness(session.id, lesson([1]));
  await app.rejectHarnessProposal(session.id, created.proposalDigest!);
  const before = (await chain(app, session.workspace)).length;

  await assert.rejects(
    app.refineHarness(session.id, lesson([1])),
    /already rejected this refinement at sequence \d+.*nothing recorded after/,
  );
  // Reworded prose around the same edit is the same question.
  await assert.rejects(
    app.refineHarness(session.id, lesson([1], "worded differently this time")),
    /already rejected this refinement/,
  );

  assert.equal((await chain(app, session.workspace)).length, before, "a refused repeat leaves no record");
  assert.deepEqual(await app.pendingApprovalsFor(session.id), []);
});

test("the same edit resting on a newer record reaches the operator again", async (t) => {
  const { app, session } = await fixture(t);
  const created = await app.refineHarness(session.id, lesson([1]));
  await app.rejectHarnessProposal(session.id, created.proposalDigest!);
  await app.editDocument(session.id, {
    path: "later.md",
    content: "a record written after the rejection",
    expectedRevision: null,
  });
  const head = (await chain(app, session.workspace)).at(-1)!.seq;

  const again = await app.refineHarness(session.id, lesson([1, head]));

  assert.match(again.proposalDigest ?? "", /^[a-f0-9]{64}$/);
  assert.equal((await app.pendingApprovalsFor(session.id)).length, 1);
});

test("a rolled back refinement is settled the same way", async (t) => {
  const { app, session } = await fixture(t);
  const created = await app.refineHarness(session.id, lesson([1]));
  await app.approveHarnessProposal(session.id, created.proposalDigest!);
  await app.rollbackHarnessProposal(session.id, created.proposalDigest!);

  await assert.rejects(
    app.refineHarness(session.id, lesson([1])),
    /already rolled back this refinement at sequence \d+/,
  );
});

test("outcomes are read from the chain and stay out of the agent's entries", async (t) => {
  const { app, session } = await fixture(t);
  const refused = await app.refineHarness(session.id, lesson([1]));
  await app.rejectHarnessProposal(session.id, refused.proposalDigest!);
  const kept = await app.refineHarness(session.id, {
    ...lesson([1]),
    summary: "kept lesson",
    edits: [{ ...lesson([1]).edits[0]!, title: "kept pattern", content: "Keep this one." }],
  });
  await app.approveHarnessProposal(session.id, kept.proposalDigest!);

  const outcomes = await app.harnessOutcomes(session.workspace);
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.summary, outcome.status]),
    [["named lesson", "rejected"], ["kept lesson", "activated"]],
  );

  const entries = await app.harnessEntries(session.workspace);
  assert.deepEqual(entries.map((entry) => entry.title), ["kept pattern"]);
  assert.ok(
    entries.every((entry) => !/rejected|rolled back/.test(`${entry.title} ${entry.content}`)),
    "a rejection is not an entry the agent's prompt may carry",
  );
});

test("harnessEffects measures activated refinements descriptively without mutating state or entering harnessEntries", async (t) => {
  const { app, session } = await fixture(t);
  await app.editDocument(session.id, {
    path: "second.md",
    content: "second signed record before activation",
    expectedRevision: null,
  });
  const created = await app.refineHarness(session.id, lesson([1]));
  await app.approveHarnessProposal(session.id, created.proposalDigest!);
  await app.editDocument(session.id, {
    path: "after.md",
    content: "record written after activation",
    expectedRevision: null,
  });

  const beforeReadLength = (await chain(app, session.workspace)).length;
  const effects = await app.harnessEffects(session.workspace, "t0");

  assert.equal(effects.length, 1);
  assert.equal(effects[0]!.digest, created.proposalDigest);
  assert.equal(effects[0]!.summary, "named lesson");
  assert.equal(effects[0]!.status, "activated");
  assert.equal(effects[0]!.effect.before.caseCount, 1);
  assert.equal(effects[0]!.effect.after.caseCount, 1);
  assert.ok(effects[0]!.effect.unmeasuredGuardrails.includes("unknown_tool_rate"));

  // Decision D1: measuring effects writes nothing and triggers no rollback.
  assert.equal((await chain(app, session.workspace)).length, beforeReadLength);
  const outcomes = await app.harnessOutcomes(session.workspace);
  assert.equal(outcomes[0]!.status, "activated");
  const entries = await app.harnessEntries(session.workspace);
  assert.deepEqual(entries.map((entry) => entry.title), ["approval pattern"]);
  assert.ok(
    entries.every((entry) => !/ratchet|unmeasured|guardrail/i.test(`${entry.title} ${entry.content}`)),
    "descriptive scores must never enter harnessEntries or the agent prompt",
  );
});
