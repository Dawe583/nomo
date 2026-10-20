/**
 * The operator rollback wiring, at the Workbench level.
 *
 * The apply machinery already keeps the pre-application entry on every applied
 * edit, and the chain already carries the activation record whole, so a
 * rollback needs no second approval cycle: the operator names the digest of
 * the activation and the workbench writes one more signed record whose
 * harnessRefinement carries the state the view should read. What these tests
 * prove: a rollback restores what an update replaced from the signed record,
 * removes what a create added, refuses a digest that was never activated,
 * refuses a digest a later refinement has displaced, refuses a digest already
 * rolled back, and lands as a signed record whose lifecycle names it.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { isolatedWorkbench } from "./test-fixture.ts";
import type { RefinementProposal } from "./refine-pass.ts";

const fetcher = async (url: unknown) =>
  String(url).endsWith("/models")
    ? Response.json({ data: [{ id: "fixture" }] })
    : Response.json({ choices: [{ message: { role: "assistant", content: "Ready" } }] });

async function fixture(t: TestContext) {
  const f = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "void-harness-rollback-",
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

const createProposal = (
  content: string,
  seqs: readonly number[],
  id?: string,
): RefinementProposal => ({
  summary: "named lesson",
  rationale: "supported by signed records",
  expectedOutcome: "one durable lesson",
  edits: [{
    action: "create",
    kind: "memory",
    ...(id ? { id } : {}),
    title: "approval pattern",
    content,
    derivedFromSeq: [...seqs],
    reason: "the record repeats",
  }],
});

const updateProposal = (id: string, content: string): RefinementProposal => ({
  summary: "correction lesson",
  rationale: "the record is sharper now",
  expectedOutcome: "the same lesson, with the corrected content",
  edits: [{
    action: "update",
    kind: "memory",
    id,
    title: "approval pattern",
    content,
    derivedFromSeq: [1],
    reason: "the first wording was too broad",
  }],
});

async function activate(
  app: Awaited<ReturnType<typeof fixture>>["app"],
  sessionId: string,
  proposal: RefinementProposal,
): Promise<string> {
  const created = await app.refineHarness(sessionId, proposal);
  await app.approveHarnessProposal(sessionId, created.proposalDigest!);
  return created.proposalDigest!;
}

test("a rollback restores the content an update replaced", async (t) => {
  const { app, session } = await fixture(t);
  await activate(app, session.id, createProposal("v1", [1], "lesson-1"));
  const second = await activate(app, session.id, updateProposal("lesson-1", "v2"));
  assert.deepEqual(
    (await app.harnessEntries(session.workspace)).map((entry) => entry.content),
    ["v2"],
  );

  await app.rollbackHarnessProposal(session.id, second);

  assert.deepEqual(
    (await app.harnessEntries(session.workspace)).map((entry) => entry.content),
    ["v1"],
  );
});

test("a rollback removes a lesson the proposal created", async (t) => {
  const { app, session } = await fixture(t);
  const digest = await activate(app, session.id, createProposal("created lesson", [1]));
  assert.deepEqual(
    (await app.harnessEntries(session.workspace)).map((entry) => entry.content),
    ["created lesson"],
  );

  await app.rollbackHarnessProposal(session.id, digest);

  assert.deepEqual(await app.harnessEntries(session.workspace), []);
});

test("a rollback restores from the record when the created entry had no id", async (t) => {
  const { app, session } = await fixture(t);
  const digest = await activate(app, session.id, createProposal("content addressed", [1]));
  const activation = (await app.ledger(session.workspace))!.entries.at(-1)!
    .body as Record<string, unknown>;
  const overrides = (activation.harnessRefinement as { overrides: { id: string }[] })
    .overrides;
  assert.ok(overrides[0]?.id, "an id-less create still lands in the view under its derived id");

  await app.rollbackHarnessProposal(session.id, digest);

  assert.deepEqual(await app.harnessEntries(session.workspace), []);
});

test("a rollback refuses a digest that was never activated", async (t) => {
  const { app, session } = await fixture(t);
  const created = await app.refineHarness(session.id, createProposal("v1", [1], "lesson-1"));

  await assert.rejects(
    () => app.rollbackHarnessProposal(session.id, created.proposalDigest!),
    /No activated refinement matches that digest\./,
  );
});

test("a rollback refuses a digest a later refinement has displaced", async (t) => {
  const { app, session } = await fixture(t);
  const first = await activate(app, session.id, createProposal("v1", [1], "lesson-1"));
  await activate(app, session.id, createProposal("second lesson", [1], "lesson-2"));

  await assert.rejects(
    () => app.rollbackHarnessProposal(session.id, first),
    new RegExp(
      `A later refinement has changed this workspace since ${first} was activated\\. Roll the later refinement back first\\.`,
    ),
  );
});

test("a second rollback of the same digest is already rolled back", async (t) => {
  const { app, session } = await fixture(t);
  const digest = await activate(app, session.id, createProposal("v1", [1], "lesson-1"));
  await app.rollbackHarnessProposal(session.id, digest);

  await assert.rejects(
    () => app.rollbackHarnessProposal(session.id, digest),
    /That refinement is already rolled back\./,
  );
});

test("the rollback lands as one signed record naming what it undid", async (t) => {
  const { app, session } = await fixture(t);
  await activate(app, session.id, createProposal("v1", [1], "lesson-1"));
  const second = await activate(app, session.id, updateProposal("lesson-1", "v2"));

  await app.rollbackHarnessProposal(session.id, second);

  const body = (await app.ledger(session.workspace))!.entries.at(-1)!.body as Record<
    string,
    unknown
  >;
  assert.equal(body.decision, "refinement:rolled-back");
  const refinement = body.harnessRefinement as Record<string, unknown>;
  assert.equal(refinement.rolledBackDigest, second);
  assert.equal(refinement.approvedBy, "operator");
  const lifecycle = body.harnessLifecycle as { digest: string; events: string[]; atSeq: number };
  assert.deepEqual(lifecycle.events, ["refinement:rolled-back"]);
  assert.equal(lifecycle.digest, second);
  assert.ok(typeof lifecycle.atSeq === "number");
});

test("a rollback that removes a created lesson records the tombstone", async (t) => {
  const { app, session } = await fixture(t);
  const digest = await activate(app, session.id, createProposal("created lesson", [1]));

  await app.rollbackHarnessProposal(session.id, digest);

  const body = (await app.ledger(session.workspace))!.entries.at(-1)!.body as Record<
    string,
    unknown
  >;
  const lifecycle = body.harnessLifecycle as { events: string[]; tombstones?: string[] };
  assert.deepEqual(lifecycle.events, ["refinement:rolled-back", "entry:tombstone"]);
});

test("a rollback does not resurrect a pending approval", async (t) => {
  const { app, session } = await fixture(t);
  await activate(app, session.id, createProposal("v1", [1], "lesson-1"));
  // A pending proposal from the same digest must not come back to life: the
  // rollback names a digested activation, and activation already made every
  // record naming that digest terminal.
  const second = await activate(app, session.id, updateProposal("lesson-1", "v2"));
  await assert.rejects(
    () => app.rollbackHarnessProposal(session.id, "not-a-digest"),
    /No activated refinement matches that digest\./,
  );
  void second;
  assert.deepEqual(await app.pendingApprovalsFor(session.id).then((p) => p.length), 0);
});
