import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "./index.ts";
import type { RefinementProposal } from "./refine-pass.ts";

/**
 * Prompt proposals wait for an operator as signed chain records, and only an
 * explicit approval matching the exact digest may activate them. A proposal
 * nobody approved must never become state, including across a restart, and a
 * decision once recorded must settle the proposal for good: approving twice
 * is a replay, not a second decision.
 */

const fetcher = async (url: unknown) =>
  String(url).endsWith("/models")
    ? Response.json({ data: [{ id: "fixture" }] })
    : Response.json({
        choices: [{ message: { role: "assistant", content: "Ready" } }],
      });

const promptProposal = (
  content = "Summarise inventory before editing.",
): RefinementProposal => ({
  summary: "prompt addendum",
  rationale: "supported by signed records",
  expectedOutcome: "steadier inventory turns",
  edits: [
    {
      action: "create",
      kind: "prompt",
      title: "inventory preamble",
      content,
      derivedFromSeq: [1],
      reason: "the pattern repeats",
    },
  ],
});

const fixture = async (t: { after(fn: () => Promise<void>): void }) => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-harness-approval-"));
  const app = new Workbench({ NOMO_DATA_DIR: directory }, fetcher);
  let appClosed = false;
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture",
  });
  const session = await app.start("Review the inventory", "fixture");
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
};

test("a prompt proposal is pending by default and changes no entries", async (t) => {
  const { app, session } = await fixture(t);
  const result = await app.refineHarness(session.id, promptProposal());
  assert.equal(result.applied.length, 0);
  assert.equal(result.awaitingApproval.length, 1);
  assert.deepEqual(await app.harnessEntries(session.workspace), []);
  const pending = await app.pendingProposals(session.workspace);
  assert.equal(pending.length, 1);
  assert.match(pending[0]!.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(pending[0]!.proposal.edits[0]!.title, "inventory preamble");
});

test("approval activates the exact proposal and settles it", async (t) => {
  const { app, session } = await fixture(t);
  await app.refineHarness(session.id, promptProposal());
  const [pending] = await app.pendingProposals(session.workspace);
  const result = await app.approveHarnessProposal(session.id, pending!.digest);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(
    (await app.harnessEntries(session.workspace)).map((entry) => entry.title),
    ["inventory preamble"],
  );
  assert.deepEqual(await app.pendingProposals(session.workspace), []);
});

test("approving twice is refused as a replay", async (t) => {
  const { app, session } = await fixture(t);
  await app.refineHarness(session.id, promptProposal());
  const [pending] = await app.pendingProposals(session.workspace);
  await app.approveHarnessProposal(session.id, pending!.digest);
  await assert.rejects(
    app.approveHarnessProposal(session.id, pending!.digest),
    /No pending proposal/,
  );
});

test("an unknown digest names itself in the refusal", async (t) => {
  const { app, session } = await fixture(t);
  await assert.rejects(
    app.approveHarnessProposal(session.id, "sha256:0".padEnd(71, "0")),
    /No pending proposal with digest sha256:0/,
  );
  await assert.rejects(
    app.rejectHarnessProposal(session.id, "sha256:0".padEnd(71, "0")),
    /No pending proposal with digest sha256:0/,
  );
});

test("rejection records the decision and activates nothing", async (t) => {
  const { app, session } = await fixture(t);
  await app.refineHarness(session.id, promptProposal());
  const [pending] = await app.pendingProposals(session.workspace);
  await app.rejectHarnessProposal(session.id, pending!.digest, "too vague");
  assert.deepEqual(await app.pendingProposals(session.workspace), []);
  assert.deepEqual(await app.harnessEntries(session.workspace), []);
  const bodies = ((await app.ledger(session.workspace))?.entries ?? []).map(
    (entry) => entry.body as Record<string, unknown>,
  );
  const rejected = bodies.filter(
    (body) => body.decision === "refinement:rejected",
  );
  assert.equal(rejected.length, 1);
  await assert.rejects(
    app.approveHarnessProposal(session.id, pending!.digest),
    /No pending proposal/,
  );
});

test("a pending proposal survives a restart and approves afterwards", async (t) => {
  const { app, session, directory, closeOriginal } = await fixture(t);
  await app.refineHarness(session.id, promptProposal());
  await closeOriginal();
  const reopened = new Workbench({ NOMO_DATA_DIR: directory }, fetcher);
  try {
    const pending = await reopened.pendingProposals(session.workspace);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.proposal.edits[0]!.title, "inventory preamble");
  } finally {
    await reopened.shutdown();
  }
});

test("a secret-bearing prompt proposal is refused before it is recorded", async (t) => {
  const { app, session } = await fixture(t);
  const before = (await app.ledger(session.workspace))?.entries.length;
  await assert.rejects(
    app.refineHarness(
      session.id,
      promptProposal("Use sk-abcdefghijklmnop to connect."),
    ),
    /secret-like content/,
  );
  assert.equal((await app.ledger(session.workspace))?.entries.length, before);
  assert.deepEqual(await app.pendingProposals(session.workspace), []);
});
