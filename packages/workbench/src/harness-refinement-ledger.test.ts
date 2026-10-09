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
    : Response.json({
        choices: [{ message: { role: "assistant", content: "Ready" } }],
      });

async function fixture(
  t: { after(fn: () => Promise<void>): void },
  extraEnv: Record<string, string> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "nomo-refinement-ledger-"));
  const app = new Workbench({ NOMO_DATA_DIR: directory, ...extraEnv }, fetcher);
  let appClosed = false;
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture",
  });
  const session = await app.start("Review the workspace", "fixture");
  await app.settled();
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

const proposal = (
  kind: "memory" | "prompt" | "skill" = "memory",
): RefinementProposal => ({
  summary: "repeated lesson",
  rationale: "supported by signed records",
  expectedOutcome: "fewer repeated approvals",
  edits: [
    {
      action: "create",
      kind,
      title: "approval pattern",
      content: "The operator repeatedly approved the same action.",
      derivedFromSeq: [1],
      reason: "the pattern repeats",
    },
  ],
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
  assert.deepEqual(
    (await app.harnessEntries(session.workspace)).map((entry) => entry.title),
    ["approval pattern"],
  );
});

test("prompt edits remain pending and never claim approval from caller text", async (t) => {
  const { app, session } = await fixture(t);
  const before = await app.ledger(session.workspace);
  const held = await app.refineHarness(session.id, proposal("prompt"));
  assert.equal(held.awaitingApproval.length, 1);
  assert.equal(held.applied.length, 0);
  const after = await app.ledger(session.workspace);
  // The pending proposal is a signed record, not active state: exactly one
  // `refinement:proposed` record is added and no entries activate.
  assert.equal(after!.entries.length, before!.entries.length + 1);
  const record = after!.entries.at(-1)!.body as Record<string, unknown>;
  assert.equal(record.decision, "refinement:proposed");
  assert.equal(after!.result.ok, true);
  assert.deepEqual(await app.harnessEntries(session.workspace), []);
});

test("skill and subagent edits stay proposal-only until their schema is supported", async (t) => {
  const { app, session } = await fixture(t);
  await assert.rejects(
    app.refineHarness(session.id, proposal("skill")),
    /proposal-only/,
  );
  assert.equal((await app.ledger(session.workspace))?.entries.length, 1);
});

test("refinement entries are reconstructed from the signed chain after restart", async (t) => {
  const { app, session, directory, closeOriginal } = await fixture(t);
  await app.refineHarness(session.id, proposal());
  await closeOriginal();
  const reopened = new Workbench({ NOMO_DATA_DIR: directory }, fetcher);
  try {
    assert.deepEqual(
      (await reopened.harnessEntries(session.workspace)).map(
        (entry) => entry.content,
      ),
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
    edits: proposal().edits.map((edit) => ({
      ...edit,
      content: "copied api_key=sk_test_should_not_leak",
    })),
  };
  await assert.rejects(
    app.refineHarness(session.id, unsafe),
    /secret-like content/,
  );
  const ledger = await app.ledger(session.workspace);
  assert.equal(ledger!.entries.length, 1);
  assert.doesNotMatch(
    JSON.stringify(ledger!.entries),
    /sk_test_should_not_leak/,
  );
  const configuredSecret = {
    ...proposal(),
    edits: proposal().edits.map((edit) => ({
      ...edit,
      content: "copied provider key fixture",
    })),
  };
  await assert.rejects(
    app.refineHarness(session.id, configuredSecret),
    /secret-like content/,
  );
});

test("the external workspace key is refused if echoed into a proposal", async (t) => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const { app, session } = await fixture(t, { NOMO_WORKSPACE_KEY: key });
  await assert.rejects(
    app.refineHarness(session.id, {
      ...proposal(),
      edits: [{ ...proposal().edits[0]!, content: key }],
    }),
    /secret-like content/,
  );
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
    edits: [
      {
        action: "delete",
        kind: "memory",
        id: lesson.id,
        derivedFromSeq: [1],
        reason: "the operator rejected this lesson",
      },
    ],
  });
  assert.equal(
    (await app.harnessEntries(session.workspace)).some(
      (entry) => entry.id === lesson.id,
    ),
    false,
  );

  await app.refineHarness(session.id, {
    ...proposal(),
    edits: proposal().edits.map((edit) => ({
      ...edit,
      title: "later refinement",
    })),
  });
  assert.equal(
    (await app.harnessEntries(session.workspace)).some(
      (entry) => entry.id === lesson.id,
    ),
    false,
  );
});
