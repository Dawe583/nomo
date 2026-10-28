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
    prefix: "nomo-harness-retrieval-",
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
  const initialMessages = miningBodies[0]!.messages as Array<{
    role: string;
    content?: unknown;
  }>;
  const followupMessages = bodies[0]!.messages as Array<{
    role: string;
    content?: unknown;
  }>;
  assert.deepEqual(
    followupMessages.slice(0, initialMessages.length),
    initialMessages,
    "learning leaves the previous request prefix byte-for-byte unchanged",
  );
  assert.equal(followupMessages.at(-1)?.role, "system");
  assert.match(
    String(followupMessages.at(-1)?.content ?? ""),
    /^NOMO learned-entry digest,/,
    "the learned context is appended after existing conversation messages",
  );
  assert.ok(
    followup.includes("learned-entry digest"),
    "a later turn in the same workspace must carry the digest",
  );
  assert.ok(
    followup.includes(LESSON),
    "the digest must carry the approved lesson text",
  );
  assert.equal(
    JSON.stringify(app.get(session.id)!.events).includes("learned-entry digest"),
    false,
    "the transient suffix is removed before the conversation is stored",
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

test("the harness reviewer's own tokens are recorded, not just the turn's", async (t) => {
  // The review is a second model call per qualifying round. The turn path
  // records reply.usage; this one used to discard it, so an operator watching
  // usage saw only what the conversation cost.
  let calls = 0;
  const billed = async (url: unknown) => {
    if (String(url).endsWith("/models")) return models();
    calls += 1;
    return Response.json({
      choices: [
        { message: { role: "assistant", content: JSON.stringify({ verdict: "decline" }) } },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
  };
  const { app } = await isolatedWorkbench(t, billed as typeof fetch, {}, {
    prefix: "nomo-harness-usage-",
  });
  const session = await app.start("Review the migration", "fixture");
  await app.settled();
  await app.editDocument(session.id, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });
  await app.refineHarness(session.id, lessonProposal());
  const pending = await app.pendingApprovalsFor(session.id);
  await app.approveHarnessProposal(session.id, pending[0]!.digest);

  // Compaction is what arms the trigger. Without it the gate refuses every
  // boundary with "not-armed" and no review ever runs.
  app.compact(session.id);

  // The gate is a fixed 25 settled turns and is not operator-tunable, so the
  // test walks to it rather than pretending the threshold moved.
  for (let turn = 0; turn <= 25; turn += 1) {
    app.send(session.id, `turn ${turn}`);
    await app.settled();
  }

  assert.ok(calls > 1, "the reviewer must have been called at least once");
  const usage = app
    .get(session.id)!
    .events.filter((event) => event.kind === "usage");
  const fromHarness = usage.filter(
    (event) => event.payload?.source === "harness",
  );
  assert.equal(
    fromHarness.length,
    1,
    `expected one harness-sourced usage record, got ${JSON.stringify(usage.map((event) => event.payload?.source))}`,
  );
  assert.equal(fromHarness[0]!.payload?.total_tokens, 18);
});

test("an operator can switch refinement off, and the gate obeys", async (t) => {
  // The gate decided when to spend a model call, and no setting reached it:
  // index.ts passed DEFAULT_REFINE_GATES directly, so "refinement is disabled
  // by settings" was a refusal no production path could ever produce.
  let calls = 0;
  const billed = async (url: unknown) => {
    if (String(url).endsWith("/models")) return models();
    calls += 1;
    return Response.json({
      choices: [
        { message: { role: "assistant", content: JSON.stringify({ verdict: "decline" }) } },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
  };
  const { app } = await isolatedWorkbench(t, billed as typeof fetch, {}, {
    prefix: "nomo-harness-off-",
  });
  const session = await app.start("Review the migration", "fixture");
  await app.settled();
  await app.editDocument(session.id, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });
  await app.refineHarness(session.id, lessonProposal());
  const pending = await app.pendingApprovalsFor(session.id);
  await app.approveHarnessProposal(session.id, pending[0]!.digest);

  assert.equal(app.patchHarnessSettings({ refinementEnabled: 0 }).refinementEnabled, 0);
  app.compact(session.id);
  for (let turn = 0; turn <= 25; turn += 1) {
    app.send(session.id, `turn ${turn}`);
    await app.settled();
  }

  const fromHarness = app
    .get(session.id)!
    .events.filter(
      (event) => event.kind === "usage" && event.payload?.source === "harness",
    );
  assert.deepEqual(fromHarness, [], "a disabled harness must not call the model");
});
