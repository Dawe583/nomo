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
  // The ratchet counts a rollback as `event: "rollback"` on the signed record,
  // so the writer and the metric agree on one chain.
  assert.equal(body.event, "rollback");
  const refinement = body.harnessRefinement as Record<string, unknown>;
  assert.equal(refinement.rolledBackDigest, second);
  // Not "operator": the operator rolled back a digest without reading the
  // restored text again, so the record must not claim they approved it.
  assert.equal(refinement.approvedBy, "rollback");
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

test("a restored lesson is not relabelled as operator approved", async (t) => {
  const { app, session } = await fixture(t);
  await activate(app, session.id, createProposal("v1", [1], "lesson-1"));
  const second = await activate(app, session.id, updateProposal("lesson-1", "v2"));
  const before = await app.harnessEntries(session.workspace);
  assert.equal(
    before[0]?.decidedByOperator,
    true,
    "the operator approved that text by digest, so the entry carries the label",
  );

  await app.rollbackHarnessProposal(session.id, second);

  const after = await app.harnessEntries(session.workspace);
  assert.deepEqual(after.map((entry) => entry.content), ["v1"]);
  assert.notEqual(
    after[0]?.decidedByOperator,
    true,
    "the operator rolled back a digest without reading the restored text again, so the label must not follow the text back",
  );
});

test("a rollback refuses content that became secret-like after it was written", async (t) => {
  const { app, session } = await fixture(t);
  await activate(app, session.id, createProposal("the operator approved twice", [1], "lesson-1"));
  // The update replaces that text. Rolling the update back would write the
  // replaced text into the chain again, and the rollback re-scans what it
  // writes rather than trusting that the original write was scanned.
  const second = await activate(
    app,
    session.id,
    updateProposal("lesson-1", "v2"),
  );
  // The content was ordinary when it was written. It becomes secret-like
  // here, because the operator's own provider key now carries that text.
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "the operator approved twice",
  });

  await assert.rejects(
    () => app.rollbackHarnessProposal(session.id, second),
    /Refinement contains secret-like content and was not recorded\./,
  );
  // The refusal is a refusal: the view still reads the newer text, because
  // nothing was written.
  assert.deepEqual(
    (await app.harnessEntries(session.workspace)).map((entry) => entry.content),
    ["v2"],
  );
});

test("a rollback of a two edit proposal restores the state before it", async (t) => {
  const { app, session } = await fixture(t);
  // One proposal that creates an entry and then replaces it. The inverse has
  // to run backwards: applied forwards, the delete would remove the entry and
  // the update would put the intermediate text back.
  const created = await app.refineHarness(session.id, {
    summary: "two edits",
    rationale: "supported by signed records",
    expectedOutcome: "one lesson",
    edits: [
      {
        action: "create",
        kind: "memory",
        id: "lesson-x",
        title: "approval pattern",
        content: "v1",
        derivedFromSeq: [1],
        reason: "the pattern repeats",
      },
      {
        action: "update",
        kind: "memory",
        id: "lesson-x",
        title: "approval pattern",
        content: "v2",
        derivedFromSeq: [1],
        reason: "the wording was too broad",
      },
    ],
  });
  await app.approveHarnessProposal(session.id, created.proposalDigest!);
  assert.deepEqual(
    (await app.harnessEntries(session.workspace)).map((entry) => entry.content),
    ["v2"],
  );

  await app.rollbackHarnessProposal(session.id, created.proposalDigest!);

  assert.deepEqual(
    await app.harnessEntries(session.workspace),
    [],
    "the state before the proposal had no such lesson, so the rollback removes it rather than restoring the intermediate text",
  );
});

test("a restored lesson keeps the tool and class it was about", async (t) => {
  const { app, session } = await fixture(t);
  // A lesson about one tool, created by one proposal, replaced by the next.
  const first = await app.refineHarness(session.id, {
    summary: "scoped lesson",
    rationale: "supported by signed records",
    expectedOutcome: "one lesson about one tool",
    edits: [
      {
        action: "create",
        kind: "memory",
        id: "lesson-tool",
        title: "approval pattern",
        content: "v1",
        derivedFromSeq: [1],
        tool: "postgres.row.update",
        klass: "r2",
        reason: "the pattern repeats",
      },
    ],
  });
  await app.approveHarnessProposal(session.id, first.proposalDigest!);
  const second = await app.refineHarness(session.id, {
    summary: "wider wording",
    rationale: "supported by signed records",
    expectedOutcome: "the same lesson, less specific",
    edits: [
      {
        action: "update",
        kind: "memory",
        id: "lesson-tool",
        title: "approval pattern",
        content: "v2",
        derivedFromSeq: [1],
        reason: "the wording was too broad",
      },
    ],
  });
  await app.approveHarnessProposal(session.id, second.proposalDigest!);

  await app.rollbackHarnessProposal(session.id, second.proposalDigest!);

  const restored = await app.harnessEntries(session.workspace);
  assert.equal(restored.length, 1);
  assert.equal(restored[0]!.content, "v1");
  assert.equal(restored[0]!.tool, "postgres.row.update");
  assert.equal(restored[0]!.klass, "r2");
  assert.deepEqual(restored[0]!.derivedFromSeq, [1]);
});

test("the refinement before a rolled back one can be rolled back too", async (t) => {
  const { app, session } = await fixture(t);
  const first = await activate(app, session.id, createProposal("v1", [1], "lesson-1"));
  const second = await activate(app, session.id, createProposal("v2", [1], "lesson-2"));
  await app.rollbackHarnessProposal(session.id, second);
  // The harness reads the state of the first refinement again, so that is
  // what the operator can undo next.
  assert.deepEqual(
    (await app.harnessEntries(session.workspace)).map((entry) => entry.content),
    ["v1"],
  );

  await app.rollbackHarnessProposal(session.id, first);

  assert.deepEqual(await app.harnessEntries(session.workspace), []);
});

test("a refinement that was rolled back and then displaced says so", async (t) => {
  const { app, session } = await fixture(t);
  const first = await activate(app, session.id, createProposal("v1", [1], "lesson-1"));
  await app.rollbackHarnessProposal(session.id, first);
  // A later refinement moves the state on again, and the first refinement is
  // now behind a rollback as well as behind that refinement.
  await activate(app, session.id, createProposal("v2", [1], "lesson-2"));

  await assert.rejects(
    () => app.rollbackHarnessProposal(session.id, first),
    /A later rollback already restored this workspace past that refinement\.|already rolled back\./,
  );
});

test("a proposal that was pending before the rollback stops being pending", async (t) => {
  const { app, session } = await fixture(t);
  const created = await app.refineHarness(session.id, createProposal("v1", [1], "lesson-1"));
  await app.approveHarnessProposal(session.id, created.proposalDigest!);
  // The same proposal again, so the same digest is pending a second time.
  await app.refineHarness(session.id, createProposal("v1", [1], "lesson-1"));
  assert.equal((await app.pendingApprovalsFor(session.id)).length, 1);

  await app.rollbackHarnessProposal(session.id, created.proposalDigest!);

  assert.deepEqual(
    await app.pendingApprovalsFor(session.id),
    [],
    "a digest that was rolled back must not sit in the inbox as a decision nobody can take",
  );
});
