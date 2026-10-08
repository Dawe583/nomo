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
    reason: "the pattern repeats",
  }],
});

test("a refinement is committed as one verified chain record and can be read back", async (t) => {
  const { app, session } = await fixture(t);
  const result = await app.refineHarness(session.id, proposal());
  assert.equal(result.applied.length, 1);
  assert.equal(result.awaitingApproval.length, 0);
  const ledger = await app.ledger(session.workspace);
  assert.ok(ledger);
  assert.equal(ledger.result.ok, true);
  assert.equal(ledger.entries.length, 2);
  const record = ledger.entries.at(-1)!.body as Record<string, unknown>;
  assert.equal(record.tool, "harness.refinement");
  assert.equal(record.decision, "refinement:applied");
  assert.deepEqual((await app.harnessEntries(session.workspace)).map((entry) => entry.title), ["approval pattern"]);
});

test("prompt edits remain pending and never claim approval from caller text", async (t) => {
  const { app, session } = await fixture(t);
  const before = await app.ledger(session.workspace);
  const held = await app.refineHarness(session.id, proposal("prompt"));
  assert.equal(held.awaitingApproval.length, 1);
  const after = await app.ledger(session.workspace);
  assert.equal(after!.entries.length, before!.entries.length);
  assert.equal(after!.result.ok, true);
});

test("skill and subagent edits stay proposal-only until their schema is supported", async (t) => {
  const { app, session } = await fixture(t);
  await assert.rejects(app.refineHarness(session.id, proposal("skill")), /proposal-only/);
  assert.equal((await app.ledger(session.workspace))?.entries.length, 1);
});

test("refinement entries are reconstructed from the signed chain after restart", async (t) => {
  const { app, session, directory, closeOriginal } = await fixture(t);
  await app.refineHarness(session.id, proposal());
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
  await app.refineHarness(session.id, {
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
  assert.equal((await app.harnessEntries(session.workspace)).some((entry) => entry.id === lesson.id), false);

  await app.refineHarness(session.id, {
    ...proposal(),
    edits: proposal().edits.map((edit) => ({ ...edit, title: "later refinement" })),
  });
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
  await app.refineHarness(session.id, proposal());
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
