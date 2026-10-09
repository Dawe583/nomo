import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "./index.ts";
import type { RefinementProposal } from "./refine-pass.ts";

const fetcher = async (url: unknown) =>
  String(url).endsWith("/models")
    ? Response.json({ data: [{ id: "fixture" }] })
    : Response.json({ choices: [{ message: { role: "assistant", content: "Ready" } }] });

async function fixture(
  t: { after(fn: () => Promise<void>): void },
  extraEnv: Record<string, string> = {},
  { seedDocument = true }: { seedDocument?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "void-refinement-ledger-"));
  const app = new Workbench({ VOID_DATA_DIR: directory, ...extraEnv }, fetcher);
  let appClosed = false;
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const session = await app.start("Review the workspace", "fixture");
  await app.settled();
  // A read-only workbench cannot take the seed write, and the session start
  // already recorded sequence 1 for a proposal to cite.
  if (seedDocument)
    await app.editDocument(session.id, {
      path: "source.md",
      content: "signed source record",
      expectedRevision: null,
    });
  t.after(async () => {
    if (!appClosed) await app.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    app,
    session,
    directory,
    async closeOriginal() {
      appClosed = true;
      await app.shutdown();
    },
  };
}

const proposal = (kind: "memory" | "prompt" | "skill" = "memory"): RefinementProposal => ({
  summary: "repeated lesson",
  rationale: "supported by signed records",
  expectedOutcome: "fewer repeated approvals",
  edits: [{
    action: "create",
    kind,
    title: "approval pattern",
    content: "The operator repeatedly approved the same action.",
    derivedFromSeq: [1],
    ...(kind === "prompt"
      ? { promptAddendum: "Never retry a denied call with reworded arguments." }
      : {}),
    reason: "the pattern repeats",
  }],
});

test("a memory proposal stays inert until its exact digest is approved", async (t) => {
  const { app, session } = await fixture(t);
  const result = await app.refineHarness(session.id, proposal());

  assert.deepEqual(result.applied, []);
  assert.equal(result.awaitingApproval.length, 1);
  assert.deepEqual(await app.harnessEntries(session.workspace), []);
  const pending = await app.pendingApprovalsFor(session.id);
  assert.equal(pending.length, 1);
  assert.match(pending[0]!.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(pending[0]!.proposal, proposal());

  const applied = await app.approveHarnessProposal(session.id, pending[0]!.digest);
  assert.equal(applied.applied.length, 1);
  assert.deepEqual(
    (await app.harnessEntries(session.workspace)).map((entry) => entry.content),
    ["The operator repeatedly approved the same action."],
  );
  const lifecycle = (await app.ledger(session.workspace))!.entries.at(-1)!
    .body as Record<string, unknown>;
  assert.equal(lifecycle.decision, "proposal:activated");
  assert.deepEqual(
    (lifecycle.harnessLifecycle as { events: string[] }).events,
    ["proposal:approved", "proposal:activated"],
  );
});

test("mutating a returned pending proposal cannot alter the signed chain", async (t) => {
  const { app, session } = await fixture(t);
  await app.refineHarness(session.id, proposal());
  const pending = (await app.pendingApprovalsFor(session.id))[0]!;
  const mutable = pending.proposal as unknown as {
    summary: string;
    edits: Array<{ title: string; derivedFromSeq: number[] }>;
  };

  mutable.summary = "tampered summary";
  mutable.edits[0]!.title = "tampered title";
  mutable.edits[0]!.derivedFromSeq.push(999);

  const ledger = await app.ledger(session.workspace);
  assert.ok(ledger);
  assert.equal(ledger.result.ok, true);
  const record = ledger.entries.at(-1)!.body as {
    harnessProposal: { proposal: RefinementProposal };
  };
  assert.deepEqual(record.harnessProposal.proposal, proposal());
  assert.deepEqual(
    (await app.pendingApprovalsFor(session.id))[0]!.proposal,
    proposal(),
  );
});

test("mutating a returned ledger snapshot cannot alter the signed chain", async (t) => {
  const { app, session } = await fixture(t);
  await app.refineHarness(session.id, proposal());
  const snapshot = await app.ledger(session.workspace);
  assert.ok(snapshot);
  const record = snapshot.entries.at(-1)!.body as {
    harnessProposal: { proposal: RefinementProposal };
  };

  const mutable = record.harnessProposal.proposal as unknown as { summary: string };
  mutable.summary = "tampered ledger snapshot";

  const reread = await app.ledger(session.workspace);
  assert.ok(reread);
  assert.equal(reread.result.ok, true);
  const rereadRecord = reread.entries.at(-1)!.body as {
    harnessProposal: { proposal: RefinementProposal };
  };
  assert.deepEqual(rereadRecord.harnessProposal.proposal, proposal());
});

test("pending proposals survive restart and rejection is signed", async (t) => {
  const { app, session, directory, closeOriginal } = await fixture(t);
  const created = await app.refineHarness(session.id, proposal());
  const digest = created.proposalDigest!;
  await closeOriginal();

  const reopened = new Workbench({ VOID_DATA_DIR: directory }, fetcher);
  try {
    const pending = await reopened.pendingApprovalsFor(session.id);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.digest, digest);
    await reopened.rejectHarnessProposal(session.id, digest);
    assert.deepEqual(await reopened.pendingApprovalsFor(session.id), []);
    assert.deepEqual(await reopened.harnessEntries(session.workspace), []);
    const record = (await reopened.ledger(session.workspace))!.entries.at(-1)!
      .body as Record<string, unknown>;
    assert.equal(record.decision, "proposal:rejected");
    assert.equal((record.harnessProposal as { digest: string }).digest, digest);
  } finally {
    reopened.close();
  }
});

test("a proposal digest cannot approve entries in another workspace", async (t) => {
  const first = await fixture(t);
  const other = await fixture(t);
  const created = await first.app.refineHarness(first.session.id, proposal());

  await assert.rejects(
    other.app.approveHarnessProposal(other.session.id, created.proposalDigest!),
    /No pending refinement matches that digest/,
  );
  assert.deepEqual(await other.app.harnessEntries(other.session.workspace), []);
});

test("approved Harness entries remain scoped to their workspace", async (t) => {
  const { app, session } = await fixture(t);
  const other = await app.start("Review another workspace", "fixture");
  await app.settled();
  assert.notEqual(other.workspace, session.workspace);

  const created = await app.refineHarness(session.id, proposal());
  assert.ok(created.proposalDigest);
  await app.approveHarnessProposal(session.id, created.proposalDigest);

  assert.equal((await app.harnessEntries(session.workspace)).length, 1);
  assert.deepEqual(await app.harnessEntries(other.workspace), []);
});

test("a proposal is signed before it becomes active", async (t) => {
  const { app, session } = await fixture(t);
  const result = await app.refineHarness(session.id, proposal());
  assert.deepEqual(result.applied, []);
  assert.equal(result.awaitingApproval.length, 1);
  const ledger = await app.ledger(session.workspace);
  assert.ok(ledger);
  assert.equal(ledger.result.ok, true);
  assert.equal(ledger.entries.length, 2);
  const record = ledger.entries.at(-1)!.body as Record<string, unknown>;
  assert.equal(record.tool, "harness.proposal");
  assert.equal(record.decision, "proposal:created");
  assert.deepEqual(await app.harnessEntries(session.workspace), []);
});

test("prompt edits remain pending and never claim approval from caller text", async (t) => {
  const { app, session } = await fixture(t);
  const before = await app.ledger(session.workspace);
  const held = await app.refineHarness(session.id, proposal("prompt"));
  assert.equal(held.awaitingApproval.length, 1);
  const after = await app.ledger(session.workspace);
  assert.equal(after!.entries.length, before!.entries.length + 1);
  assert.equal(
    (after!.entries.at(-1)!.body as Record<string, unknown>).decision,
    "proposal:created",
  );
  assert.equal(after!.result.ok, true);
});

test("a prompt addendum applies only after the operator approves its digest", async (t) => {
  const { app, session, directory, closeOriginal } = await fixture(t);
  const before = (await app.ledger(session.workspace))!.entries.length;
  const held = await app.refineHarness(session.id, proposal("prompt"));
  assert.equal(held.awaitingApproval.length, 1);
  const pending = await app.pendingApprovalsFor(session.id);
  assert.equal(pending.length, 1);
  const addendum = "Never retry a denied call with reworded arguments.";
  // The proposal is signed as inert, and nothing is active before approval.
  assert.equal((await app.ledger(session.workspace))!.entries.length, before + 1);
  assert.equal(
    (await app.harnessEntries(session.workspace)).some(
      (entry) => entry.content === addendum,
    ),
    false,
  );

  const applied = await app.applyPromptAddendum(session.id, pending[0]!.digest);
  assert.equal(applied.applied.length, 1);
  const ledger = await app.ledger(session.workspace);
  const record = ledger!.entries.at(-1)!.body as Record<string, unknown>;
  assert.equal(record.decision, "proposal:activated");
  assert.equal(
    (record.harnessRefinement as { digest?: string }).digest,
    pending[0]!.digest,
  );
  assert.equal((await app.pendingApprovalsFor(session.id)).length, 0);

  // The addendum is operator-approved, so it applies to later sessions and is
  // rebuilt from the chain after a restart rather than living in memory.
  await closeOriginal();
  const reopened = new Workbench({ VOID_DATA_DIR: directory }, fetcher);
  try {
    assert.deepEqual(
      (await reopened.harnessEntries(session.workspace)).map((entry) => entry.content),
      [addendum],
    );
  } finally {
    reopened.close();
  }
});

test("an approval is refused once the chain moved under it", async (t) => {
  const { app, session } = await fixture(t);
  const held = await app.refineHarness(session.id, proposal("prompt"));
  assert.equal(held.awaitingApproval.length, 1);
  const digest = (await app.pendingApprovalsFor(session.id))[0]!.digest;
  // A new verified record lands after the operator was shown the proposal, so
  // what they approved was derived from a chain that is no longer the one.
  await app.editDocument(session.id, {
    path: "after-review.md",
    content: "a record written after the review",
    expectedRevision: null,
  });
  await assert.rejects(
    app.applyPromptAddendum(session.id, digest),
    /chain moved after the proposal was reviewed/,
  );
  assert.equal(
    (await app.harnessEntries(session.workspace)).length,
    0,
    "a refused approval still applied the addendum",
  );
});

test("an unknown digest approves nothing", async (t) => {
  const { app, session } = await fixture(t);
  await app.refineHarness(session.id, proposal("prompt"));
  const length = (await app.ledger(session.workspace))!.entries.length;
  await assert.rejects(
    app.applyPromptAddendum(session.id, "0".repeat(64)),
    /No pending refinement matches that digest/,
  );
  assert.equal((await app.ledger(session.workspace))!.entries.length, length);
});

test("skill and subagent edits stay proposal-only until their schema is supported", async (t) => {
  const { app, session } = await fixture(t);
  await assert.rejects(app.refineHarness(session.id, proposal("skill")), /proposal-only/);
  assert.equal((await app.ledger(session.workspace))?.entries.length, 1);
});

test("approved refinement entries are reconstructed from the signed chain after restart", async (t) => {
  const { app, session, directory, closeOriginal } = await fixture(t);
  await app.refineHarness(session.id, proposal());
  const pending = await app.pendingApprovalsFor(session.id);
  await app.approveHarnessProposal(session.id, pending[0]!.digest);
  await closeOriginal();
  const reopened = new Workbench({ VOID_DATA_DIR: directory }, fetcher);
  try {
    assert.deepEqual(
      (await reopened.harnessEntries(session.workspace)).map((entry) => entry.content),
      ["The operator repeatedly approved the same action."],
    );
  } finally {
    reopened.close();
  }
});


test("provenance must cite an existing sequence in this verified workspace", async (t) => {
  const { app, session } = await fixture(t);
  const invalid = {
    ...proposal(),
    edits: proposal().edits.map((edit) => ({ ...edit, derivedFromSeq: [99] })),
  };
  await assert.rejects(
    app.refineHarness(session.id, invalid),
    /unverified workspace sequence 99/,
  );
  assert.equal((await app.ledger(session.workspace))?.entries.length, 1);
});

test("secret-shaped proposal content is refused before it reaches the signed ledger", async (t) => {
  const { app, session } = await fixture(t);
  const unsafe = {
    ...proposal(),
    edits: proposal().edits.map((edit) => ({ ...edit, content: "copied api_key=sk_test_should_not_leak" })),
  };
  await assert.rejects(app.refineHarness(session.id, unsafe), /secret-like content/);
  const ledger = await app.ledger(session.workspace);
  assert.equal(ledger!.entries.length, 1);
  assert.doesNotMatch(JSON.stringify(ledger!.entries), /sk_test_should_not_leak/);
  const configuredSecret = {
    ...proposal(),
    edits: proposal().edits.map((edit) => ({ ...edit, content: "copied provider key fixture" })),
  };
  await assert.rejects(app.refineHarness(session.id, configuredSecret), /secret-like content/);
});



test("the external workspace key is refused if echoed into a proposal", async (t) => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const { app, session } = await fixture(t, { VOID_WORKSPACE_KEY: key });
  await assert.rejects(
    app.refineHarness(session.id, {
      ...proposal(),
      edits: [{ ...proposal().edits[0]!, content: key }],
    }),
    /secret-like content/,
  );
});

test("a read-only workbench refuses a refinement, because it signs a record", async (t) => {
  // The refinement writes to the workspace chain like any other mutation. If
  // only the operator's own edits are gated, `read-only` would still let the
  // model change the harness the operator can see.
  const { app, session } = await fixture(
    t,
    { VOID_PERMISSION_MODE: "read-only" },
    { seedDocument: false },
  );
  await assert.rejects(app.refineHarness(session.id, proposal()), /read-only/);
  // Nothing is signed: without a committed workspace there is no chain to
  // verify, and a refinement that produced one would have written anyway.
  const ledger = await app.ledger(session.workspace);
  assert.equal(ledger, undefined, "a read-only workbench signed a record");
});

test("deleting a mined entry persists as a tombstone across later refinements", async (t) => {
  const { app, session } = await fixture(t);
  const internals = app as unknown as {
    sessions: Map<string, unknown>;
    commitWorkspace: (...args: unknown[]) => Promise<void>;
  };
  const internalSession = internals.sessions.get(session.id);
  assert.ok(internalSession);
  const state = app.workspace(session.id);
  for (let count = 0; count < 5; count++)
    await internals.commitWorkspace(
      internalSession,
      state,
      "void_workspace_write",
      { count },
      "hold:approved",
    );

  const mined = await app.harnessEntries(session.workspace);
  const lesson = mined.find((entry) => entry.kind === "lesson");
  assert.ok(lesson, "expected repeated signed approvals to mine a lesson");
  const removal = await app.refineHarness(session.id, {
    summary: "remove this mined entry",
    rationale: "the operator corrected the record",
    expectedOutcome: "the entry stays removed",
    edits: [{
      action: "delete",
      kind: "memory",
      id: lesson.id,
      derivedFromSeq: [1],
      reason: "the operator rejected this lesson",
    }],
  });
  await app.approveHarnessProposal(session.id, removal.proposalDigest!);
  assert.equal((await app.harnessEntries(session.workspace)).some((entry) => entry.id === lesson.id), false);
  const removed = (await app.ledger(session.workspace))!.entries.at(-1)!.body as
    Record<string, unknown>;
  const removalLifecycle = removed.harnessLifecycle as {
    events: string[];
    tombstones: string[];
  };
  assert.ok(removalLifecycle.events.includes("entry:tombstone"));
  assert.deepEqual(removalLifecycle.tombstones, [lesson.id]);

  const later = await app.refineHarness(session.id, {
    ...proposal(),
    edits: proposal().edits.map((edit) => ({ ...edit, title: "later refinement" })),
  });
  await app.approveHarnessProposal(session.id, later.proposalDigest!);
  assert.equal((await app.harnessEntries(session.workspace)).some((entry) => entry.id === lesson.id), false);
});

test("a mined lesson the proposal did not touch is not frozen as an override", async (t) => {
  const { app, session } = await fixture(t);
  const internals = app as unknown as {
    sessions: Map<string, unknown>;
    commitWorkspace: (...args: unknown[]) => Promise<void>;
  };
  const internalSession = internals.sessions.get(session.id);
  assert.ok(internalSession);
  const state = app.workspace(session.id);
  for (let count = 0; count < 5; count++)
    await internals.commitWorkspace(
      internalSession,
      state,
      "void_workspace_write",
      { count },
      "hold:approved",
    );

  const before = await app.harnessEntries(session.workspace);
  const lesson = before.find((entry) => entry.kind === "lesson");
  assert.ok(lesson, "expected repeated signed approvals to mine a lesson");

  // A proposal about something else entirely. The mined lesson must still be
  // rebuilt from the chain afterwards: storing it as an override would freeze
  // the repeat count the chain keeps producing, and the freeze would survive
  // every later refinement.
  const proposalResult = await app.refineHarness(session.id, proposal());
  await app.approveHarnessProposal(session.id, proposalResult.proposalDigest!);
  const proof = await app.ledger(session.workspace);
  const lastBody = proof?.entries.at(-1)?.body as
    | Record<string, unknown>
    | undefined;
  const record = lastBody?.harnessRefinement as
    | { overrides: Array<{ id: string }> }
    | undefined;
  assert.ok(record, "the refinement record carries no override set");
  assert.equal(
    record.overrides.some((entry) => entry.id === lesson.id),
    false,
    "an untouched mined lesson was stored as an override",
  );
  const after = await app.harnessEntries(session.workspace);
  const rebuilt = after.find((entry) => entry.id === lesson.id);
  assert.ok(rebuilt, "the mined lesson disappeared from the rebuilt set");
  // `createdAt` is stamped from the chain's own last record, so it moves with
  // every commit by design; everything the chain actually proves must not.
  const { createdAt: _minedAt, ...mined } = lesson;
  const { createdAt: _rebuiltAt, ...rebuiltFields } = rebuilt;
  assert.deepEqual(rebuiltFields, mined);
});

test("a proposal carrying a token the pattern list covers is refused", async (t) => {
  // Tokens without a label and without one of the recognised prefixes are the
  // gap the list exists to close: a Slack token, a GitLab token, a Hugging
  // Face token and a JWT are all refused, and so is a private key header.
  const { app, session } = await fixture(t);
  for (const secret of [
    "xoxb-2411-4471-a19d-3f0c2b8e5d61",
    "glpat-abcdef1234567890",
    "hf_1234567890abcdef1234567890abcdef",
    "sk-ant-abcdef1234567890abcdef1234567890",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.0123456789",
    "-----BEGIN RSA PRIVATE KEY-----",
  ]) {
    await assert.rejects(
      app.refineHarness(session.id, {
        ...proposal(),
        edits: proposal().edits.map((edit) => ({ ...edit, content: secret })),
      }),
      /secret-like content/,
      `refused: ${secret}`,
    );
  }
  const ledger = await app.ledger(session.workspace);
  assert.equal(ledger?.entries.length, 1);
});

test("a proposal that quotes ordinary document text is not refused", async (t) => {
  const { app, session } = await fixture(t);
  await app.editDocument(session.id, {
    path: "notes.md",
    content: "The integration token is configured in production.",
    expectedRevision: null,
  });
  // Quoting the document is the point of a refinement. Only a secret-shaped
  // value is refused; a document that holds no credential cannot stop a
  // proposal that quotes it.
  await app.refineHarness(session.id, proposal());
});

test("a failed write does not leave a phantom workspace registered", async (t) => {
  // A workspace that had never committed before this call must not be left
  // registered with an empty state when the write fails: the phantom key
  // would make `ledger()` return a verified-but-empty chain and hide the
  // failure from the next read.
  const { app, session } = await fixture(t, {}, { seedDocument: false });
  // Test-only access to private members, to drive the rollback path of
  // `commitWorkspace` with a controlled failure.
  const internals = app as unknown as {
    sessions: Map<string, unknown>;
    commitWorkspace: (...args: unknown[]) => Promise<void>;
    documents: Record<string, unknown>;
    storage: { save: (value: unknown) => void };
  };
  const internalSession = internals.sessions.get(session.id);
  assert.ok(internalSession);
  const state = app.workspace(session.id);
  const originalSave = internals.storage.save.bind(internals.storage);
  internals.storage.save = () => {
    internals.storage.save = originalSave;
    throw new Error("disk full");
  };
  await assert.rejects(
    internals.commitWorkspace(
      internalSession,
      state,
      "void_workspace_write",
      { count: 0 },
      "hold:approved",
    ),
    /disk full/,
  );
  assert.equal(
    Object.hasOwn(internals.documents, session.workspace),
    false,
    "a failed write left the workspace registered with an empty state",
  );
});

test("updates record signed supersession lifecycle metadata", async (t) => {
  const { app, session } = await fixture(t);
  const created = await app.refineHarness(session.id, proposal());
  await app.approveHarnessProposal(session.id, created.proposalDigest!);
  const original = (await app.harnessEntries(session.workspace))[0]!;

  const updated = await app.refineHarness(session.id, {
    summary: "correct the approval pattern",
    rationale: "the first version was too broad",
    expectedOutcome: "the updated lesson replaces the earlier one",
    edits: [{
      action: "update",
      kind: "memory",
      id: original.id,
      title: "narrow approval pattern",
      content: "The operator approved this exact action.",
      derivedFromSeq: [1],
      reason: "the corrected wording matches the verified record",
    }],
  });
  const result = await app.approveHarnessProposal(session.id, updated.proposalDigest!);
  assert.equal(result.applied[0]!.outcome, "superseded");
  const body = (await app.ledger(session.workspace))!.entries.at(-1)!.body as
    Record<string, unknown>;
  const lifecycle = body.harnessLifecycle as {
    events: string[];
    supersessions: string[];
  };
  assert.ok(lifecycle.events.includes("entry:supersession"));
  assert.deepEqual(lifecycle.supersessions, [original.id]);
});
