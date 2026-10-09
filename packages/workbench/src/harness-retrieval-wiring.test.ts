import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { retrievalContext } from "./index.ts";
import { isolatedWorkbench } from "./test-fixture.ts";
import { HARNESS_SETTINGS } from "./harness-settings.ts";
import type { RefinementProposal } from "./refine-pass.ts";

/**
 * The retrieval wiring is only a claim until a prompt actually carries the
 * digest the settings describe. These tests are behavioural: they fail if the
 * bound reverts to "everything reaches the prompt", if zero stops meaning
 * "out of the prompt entirely", or if the block survives the run that carried
 * it.
 */

const LESSON =
  "The operator keeps reopening the same postgres migration after hold.";

const models = () =>
  Response.json({ data: [{ id: "fixture" }] });
const answer = () =>
  Response.json({
    choices: [{ message: { role: "assistant", content: "Done" } }],
  });

const lessonProposal = (): RefinementProposal => ({
  summary: "repeated migration hold",
  rationale: "supported by signed records",
  expectedOutcome: "fewer repeated approvals of the same migration",
  edits: [
    {
      action: "create",
      kind: "memory",
      title: "migration reopen pattern",
      content: LESSON,
      derivedFromSeq: [1],
      reason: "the pattern repeats across turns",
    },
  ],
});

async function fixture(t: TestContext) {
  const bodies: Array<Record<string, unknown>> = [];
  const capturing = async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/models")) return models();
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return answer();
  };
  const { app } = await isolatedWorkbench(t, capturing as typeof fetch, {}, {
    prefix: "void-harness-retrieval-",
  });
  const session = await app.start("Review the migration", "fixture");
  await app.settled();
  // An edit document leaves one chain record the proposal may cite, so the
  // provenance check has a real sequence to verify rather than a bare [1].
  await app.editDocument(session.id, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });
  return { app, session, bodies };
}

function systemTexts(body: Record<string, unknown>): string {
  const messages = (body.messages ?? []) as Array<{
    role: string;
    content?: unknown;
  }>;
  return messages
    .filter((message) => message.role === "system")
    .map((message) => String(message.content ?? ""))
    .join("\n");
}

test("a follow-up turn carries the retrieved lesson, the mining turn does not", async (t) => {
  const { app, session, bodies } = await fixture(t);

  const miningBodies = [...bodies];
  assert.ok(miningBodies.length > 0);
  for (const body of miningBodies)
    assert.ok(
      !systemTexts(body).includes("learned-entry digest"),
      "the turn that produced nothing yet must not carry a digest",
    );

  const created = await app.refineHarness(session.id, lessonProposal());
  assert.equal(created.awaitingApproval.length, 1);
  const pending = await app.pendingApprovalsFor(session.id);
  assert.equal(pending.length, 1);
  await app.approveHarnessProposal(session.id, pending[0]!.digest);

  bodies.length = 0;
  app.send(session.id, "Why does the same postgres migration keep stalling?");
  await app.settled();

  const followup = bodies.map(systemTexts).join("\n");
  assert.ok(
    followup.includes("learned-entry digest"),
    "a later turn in the same workspace must carry the digest",
  );
  assert.ok(
    followup.includes(LESSON),
    "the digest must carry the approved lesson text",
  );
});

test("an entry limit of zero keeps the harness out of the prompt entirely", async (t) => {
  const { app, session, bodies } = await fixture(t);
  await app.refineHarness(session.id, lessonProposal());
  const pending = await app.pendingApprovalsFor(session.id);
  await app.approveHarnessProposal(session.id, pending[0]!.digest);

  app.patchHarnessSettings({ contextEntryLimit: 0 });
  assert.equal(app.harnessSettings().contextEntryLimit, 0);

  bodies.length = 0;
  app.send(session.id, "Why does the same postgres migration keep stalling?");
  await app.settled();

  const followup = bodies.map(systemTexts).join("\n");
  assert.ok(
    !followup.includes("learned-entry digest"),
    "a zero limit must not be an off-by-one: nothing reaches the prompt",
  );
});

test("the retrieval block is removed from the stored conversation", async (t) => {
  const { app, session } = await fixture(t);
  await app.refineHarness(session.id, lessonProposal());
  const pending = await app.pendingApprovalsFor(session.id);
  await app.approveHarnessProposal(session.id, pending[0]!.digest);
  app.send(session.id, "Why does the same postgres migration keep stalling?");
  await app.settled();

  const stored = JSON.stringify(app.get(session.id)!.events);
  assert.ok(
    !stored.includes("learned-entry digest"),
    "a digest that survives the run would leak one turn's context into every later one",
  );
});

test("the harness entries themselves are never clipped by contextCharsPerEntry", async (t) => {
  const { app, session } = await fixture(t);
  await app.refineHarness(session.id, lessonProposal());
  const pending = await app.pendingApprovalsFor(session.id);
  await app.approveHarnessProposal(session.id, pending[0]!.digest);

  app.patchHarnessSettings({ contextCharsPerEntry: 40 });
  const ranked = retrievalContext(
    await app.harnessEntries(session.workspace),
    "postgres migration",
    app.harnessSettings(),
  );
  assert.ok(ranked.includes("learned-entry digest"));
  assert.ok(
    !ranked.includes(LESSON),
    "the prompt view must be clipped to 40 characters",
  );

  const entries = await app.harnessEntries(session.workspace);
  assert.ok(
    entries.some((entry) => entry.content === LESSON),
    "the stored entry is never shortened",
  );
});
