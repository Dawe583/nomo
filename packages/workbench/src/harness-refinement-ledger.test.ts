import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "./index.ts";
import type { RefinementProposal } from "./refine-pass.ts";
import { initialTriggerState, type TriggerState } from "./refine-trigger.ts";

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

test("a review queued behind a branch cannot write to the abandoned branch", async (t) => {
  const { app, session } = await fixture(t);
  const before = await app.ledger(session.workspace);
  assert.ok(before);
  const triggerStates = (
    app as unknown as {
      harnessTriggers: Map<string, { branchVersion: number }>;
    }
  ).harnessTriggers;
  assert.equal(triggerStates.get(session.id)?.branchVersion, 0);
  const expectedBranchVersion = triggerStates.get(session.id)!.branchVersion;
  triggerStates.delete(session.id);

  const branch = app.branch(session.id, {
    seq: session.events.at(-1)!.seq,
    idempotencyKey: "stale-harness-review",
  });
  const staleReview = app.refineHarness(session.id, proposal(), {
    expectedBranchVersion,
  });

  await branch;
  await assert.rejects(staleReview, /branch moved/i);
  assert.equal((await app.ledger(session.workspace))!.entries.length, before.entries.length);
});

test("a rejected branch request does not advance the harness version", async (t) => {
  const { app, session } = await fixture(t);
  const triggerStates = (
    app as unknown as {
      harnessTriggers: Map<string, { branchVersion: number }>;
    }
  ).harnessTriggers;
  assert.equal(triggerStates.get(session.id)?.branchVersion, 0);
  const expectedBranchVersion = triggerStates.get(session.id)!.branchVersion;

  await assert.rejects(
    app.branch(session.id, {
      seq: session.events.at(-1)!.seq,
      idempotencyKey: "not a valid key!",
    }),
    /idempotency key/i,
  );
  await assert.rejects(
    app.branch(session.id, { seq: 99_999, idempotencyKey: "no-such-message" }),
    /existing message/i,
  );

  assert.equal(triggerStates.get(session.id)?.branchVersion, expectedBranchVersion);
  const landed = await app.refineHarness(session.id, proposal("prompt"), {
    expectedBranchVersion,
  });
  assert.equal(landed.awaitingApproval.length, 1);
});

test("a branch save keeps its idempotency record and invalidates stale reviews", async (t) => {
  const { app, session, directory, closeOriginal } = await fixture(t);
  const internals = app as unknown as {
    harnessTriggers: Map<string, { branchVersion: number }>;
    persist: () => void;
  };
  const initialBranchVersion = internals.harnessTriggers.get(session.id)!.branchVersion;
  assert.equal(initialBranchVersion, 0);
  const persist = internals.persist.bind(app);
  let calls = 0;
  let failAfterCommit = true;
  internals.persist = () => {
    calls += 1;
    persist();
    if (failAfterCommit) {
      failAfterCommit = false;
      throw new Error("branch persistence reported failure");
    }
  };
  const request = {
    seq: session.events.at(-1)!.seq,
    idempotencyKey: "branch-persist-failure",
  };

  await assert.rejects(
    app.branch(session.id, request),
    /branch persistence reported failure/,
  );
  assert.equal(calls, 1);
  assert.equal(
    internals.harnessTriggers.get(session.id)?.branchVersion,
    initialBranchVersion + 1,
  );
  await assert.rejects(
    app.refineHarness(session.id, proposal(), {
      expectedBranchVersion: initialBranchVersion,
    }),
    /branch moved/i,
  );

  const sameProcessRetry = await app.branch(session.id, request);
  assert.equal(calls, 2);
  await closeOriginal();
  const reopened = new Workbench({ NOMO_DATA_DIR: directory }, fetcher);
  try {
    const afterRestart = await reopened.branch(session.id, request);
    assert.equal(afterRestart.id, sameProcessRetry.id);
  } finally {
    await reopened.shutdown();
  }
});

test("a retry commits an in-memory branch after an initial save failure", async (t) => {
  const { app, session, directory, closeOriginal } = await fixture(t);
  const internals = app as unknown as {
    sessions: Map<string, unknown>;
    persist: () => void;
  };
  const persist = internals.persist.bind(app);
  let calls = 0;
  let failBeforeCommit = true;
  internals.persist = () => {
    calls += 1;
    if (failBeforeCommit) {
      failBeforeCommit = false;
      throw new Error("branch save failed before commit");
    }
    persist();
  };
  const request = {
    seq: session.events.at(-1)!.seq,
    idempotencyKey: "branch-retry-after-save-failure",
  };

  await assert.rejects(
    app.branch(session.id, request),
    /branch save failed before commit/,
  );
  const sessionCountAfterFailure = internals.sessions.size;
  const retry = await app.branch(session.id, request);

  assert.equal(calls, 2);
  assert.equal(internals.sessions.size, sessionCountAfterFailure);
  await closeOriginal();
  const reopened = new Workbench({ NOMO_DATA_DIR: directory }, fetcher);
  try {
    const afterRestart = await reopened.branch(session.id, request);
    assert.equal(afterRestart.id, retry.id);
  } finally {
    await reopened.shutdown();
  }
});

test("a snapshot retry completes missing files after a committed copy reports unknown", async (t) => {
  const { app, session, directory, closeOriginal } = await fixture(t);
  const secondDocument = await app.editDocument(session.id, {
    path: "second.md",
    content: "second signed record",
    expectedRevision: null,
  });
  const internals = app as unknown as {
    sessions: Map<string, { view: { id: string; parentId?: string } }>;
    mutateDocument: (
      session: unknown,
      id: string,
      name: string,
      args: Record<string, unknown>,
      approval?: { by?: string; reason?: string },
    ) => Promise<unknown>;
  };
  const originalMutateDocument = internals.mutateDocument.bind(app);
  let mutations = 0;
  internals.mutateDocument = async (session, id, name, args, approval) => {
    const result = await originalMutateDocument(
      session,
      id,
      name,
      args,
      approval,
    );
    mutations += 1;
    if (mutations === 1) throw new Error("snapshot outcome was unknown");
    return result;
  };
  const request = {
    seq: session.events.at(-1)!.seq,
    snapshotDocuments: true,
    idempotencyKey: "snapshot-retry-after-unknown",
  };

  await assert.rejects(
    app.branch(session.id, request),
    /snapshot outcome was unknown/,
  );
  assert.equal(mutations, 1);
  const child = [...internals.sessions.values()].find(
    (candidate) => candidate.view.parentId === session.id,
  );
  assert.ok(child);
  const sessionCountAfterFailure = internals.sessions.size;
  internals.mutateDocument = originalMutateDocument;
  const copiedSource = app.document(child.view.id, "source.md");
  assert.ok(copiedSource);
  await app.editDocument(child.view.id, {
    path: "source.md",
    content: "changed in the incomplete child",
    expectedRevision: copiedSource.revision!,
  });
  const changedParent = await app.editDocument(session.id, {
    path: "second.md",
    content: "changed after the branch attempt",
    expectedRevision: secondDocument.revision!,
  });
  await assert.rejects(
    app.branch(session.id, request),
    /parent workspace changed while the branch snapshot was incomplete/i,
  );
  await app.editDocument(session.id, {
    path: "second.md",
    content: "second signed record",
    expectedRevision: changedParent.revision!,
  });
  const retry = await app.branch(session.id, request);

  assert.equal(retry.id, child.view.id);
  assert.equal(internals.sessions.size, sessionCountAfterFailure);
  await closeOriginal();
  const reopened = new Workbench({ NOMO_DATA_DIR: directory }, fetcher);
  try {
    const afterRestart = await reopened.branch(session.id, request);
    assert.equal(afterRestart.id, child.view.id);
    assert.ok(afterRestart.events.length > 0);
    assert.equal(
      reopened.workspace(afterRestart.id).files["source.md"],
      "signed source record",
    );
    assert.equal(
      reopened.workspace(afterRestart.id).files["second.md"],
      "second signed record",
    );
  } finally {
    await reopened.shutdown();
  }
});

test("a retained review cannot write after the branch wins the Workbench lock", async (t) => {
  const { app, session } = await fixture(t);
  const seeded = await app.refineHarness(session.id, proposal());
  assert.equal(seeded.applied.length, 1);
  const before = await app.ledger(session.workspace);
  assert.ok(before);
  const internals = app as unknown as {
    harnessTriggers: Map<string, TriggerState>;
    sessions: Map<string, unknown>;
    refineHarness: Workbench["refineHarness"];
    serviceHarnessTurn: (
      session: unknown,
      surface: "checkpoint",
    ) => Promise<void>;
  };
  const internalSession = internals.sessions.get(session.id);
  assert.ok(internalSession);
  internals.harnessTriggers.set(session.id, {
    ...initialTriggerState(),
    pending: true,
    settledTurnsSinceReview: 24,
    pendingReview: JSON.stringify(proposal()),
  });
  const originalRefineHarness = app.refineHarness.bind(app);
  let writerCalls = 0;
  internals.refineHarness = async (...args) => {
    writerCalls += 1;
    // Force the real branch between the retained-review check and the writer.
    await app.branch(session.id, {
      seq: session.events.at(-1)!.seq,
      idempotencyKey: "branch-before-retained-write",
    });
    return originalRefineHarness(...args);
  };

  await internals.serviceHarnessTurn(internalSession, "checkpoint");
  internals.refineHarness = originalRefineHarness;

  const after = await app.ledger(session.workspace);
  assert.equal(after!.entries.length, before.entries.length);
  assert.equal(writerCalls, 1);
  assert.equal(internals.harnessTriggers.get(session.id)?.branchVersion, 1);
  assert.equal(internals.harnessTriggers.get(session.id)?.pendingReview, null);
});

test("an idempotent branch replay does not advance the harness version", async (t) => {
  const { app, session } = await fixture(t);
  const triggerStates = (
    app as unknown as {
      harnessTriggers: Map<string, { branchVersion: number }>;
    }
  ).harnessTriggers;
  const before = triggerStates.get(session.id)!.branchVersion;
  const request = {
    seq: session.events.at(-1)!.seq,
    idempotencyKey: "harness-branch-replay",
  };

  const first = await app.branch(session.id, request);
  const afterFirst = triggerStates.get(session.id)!.branchVersion;
  assert.equal(afterFirst, before + 1);
  const retry = await app.branch(session.id, request);

  assert.equal(retry.id, first.id);
  assert.equal(triggerStates.get(session.id)!.branchVersion, afterFirst);
});
