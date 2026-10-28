/**
 * The manual review edge, at the Workbench wiring level.
 *
 * The flag itself is held by the trigger tests and the gate's treatment of it
 * by the gate tests. What these prove is the wiring the operator touches: a
 * request during a run is recorded and served at the next boundary, a held
 * refusal keeps it without reaching the model, a served request reaches the
 * reviewer exactly once, and the cooldown survives the manual path.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { isolatedWorkbench } from "./test-fixture.ts";
import type { RefinementProposal } from "./refine-pass.ts";

const models = () => Response.json({ data: [{ id: "fixture" }] });
const answer = (content = "Done") =>
  Response.json({ choices: [{ message: { role: "assistant", content } }] });
const declined = () =>
  answer(JSON.stringify({ approve: false, reason: "one call is not a pattern" }));

const lesson = (): RefinementProposal => ({
  summary: "manual review proposal",
  rationale: "the operator requested this review",
  expectedOutcome: "one signed proposal awaits the decision",
  edits: [
    {
      action: "create",
      kind: "memory",
      title: "manual lesson",
      content: "The operator asked for this review by hand.",
      derivedFromSeq: [1],
      reason: "the request is the evidence",
    },
  ],
});

function answering(completion: (n: number) => Response) {
  let completions = 0;
  const fetcher = async (url: unknown) => {
    if (String(url).endsWith("/models")) return models();
    completions += 1;
    return completion(completions);
  };
  return { fetcher: fetcher as typeof fetch, count: () => completions };
}

/** A settled conversation whose chain has a sequence a proposal may cite. */
async function seeded(t: TestContext, fetcher: typeof fetch) {
  const { app } = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-harness-manual-",
  });
  const session = await app.start("Review the workspace", "fixture");
  await app.settled();
  await app.editDocument(session.id, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });
  return { app, session };
}

/** One approved lesson, so the gate has a candidate to review. */
async function seedLesson(app: Awaited<ReturnType<typeof seeded>>["app"], sessionId: string) {
  const created = await app.refineHarness(sessionId, lesson());
  await app.approveHarnessProposal(sessionId, created.proposalDigest!);
}

test("a review request for an unknown session is refused, not invented", async (t) => {
  const { fetcher } = answering(() => answer());
  const { app } = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-harness-manual-unknown-",
  });

  const result = await app.requestHarnessReview("missing");
  assert.equal(result.kind, "refused");
  assert.match(result.note, /Session not found/);
});

test("a manual request with nothing mined arms instead of spending a call", async (t) => {
  const { fetcher, count } = answering(() => answer());
  const { app, session } = await seeded(t, fetcher);

  const before = count();
  const result = await app.requestHarnessReview(session.id);
  assert.equal(result.kind, "armed");
  assert.equal(result.note, "nothing has been mined since the last review");
  assert.equal(count(), before, "a held gate must not reach the model");
});

test("a served manual request reaches the reviewer exactly once", async (t) => {
  const { fetcher, count } = answering((n) => (n === 1 ? answer() : declined()));
  const { app, session } = await seeded(t, fetcher);
  await seedLesson(app, session.id);

  const before = count();
  const result = await app.requestHarnessReview(session.id);
  assert.equal(result.kind, "declined");
  assert.match(result.note, /one call is not a pattern/);
  assert.equal(count() - before, 1, "the reviewer is asked once and no more");

  const reviews = (app.get(session.id)?.events ?? []).filter(
    (event) => event.type === "harness.review",
  );
  assert.equal(reviews.at(-1)?.payload?.["outcome"], "declined");
});

test("a second manual request inside the cooldown arms instead of paying again", async (t) => {
  const { fetcher, count } = answering((n) => (n === 1 ? answer() : declined()));
  const { app, session } = await seeded(t, fetcher);
  await seedLesson(app, session.id);

  assert.equal((await app.requestHarnessReview(session.id)).kind, "declined");
  const paid = count();
  const second = await app.requestHarnessReview(session.id);
  assert.equal(second.kind, "armed");
  assert.match(second.note, /cooldown/);
  assert.equal(count(), paid, "the cooldown holds the second request at no cost");
});

test("a request during a run is recorded and served at the next boundary", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let completions = 0;
  const fetcher = async (url: unknown) => {
    if (String(url).endsWith("/models")) return models();
    completions += 1;
    if (completions === 1) return answer();
    if (completions === 2) {
      markStarted();
      await held;
      return answer();
    }
    return declined();
  };
  const { app } = await isolatedWorkbench(t, fetcher as typeof fetch, {}, {
    prefix: "nomo-harness-manual-busy-",
    beforeShutdown: () => release(),
  });
  const session = await app.start("Review the workspace", "fixture");
  await app.settled();
  await app.editDocument(session.id, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });
  await seedLesson(app, session.id);

  app.send(session.id, "One more turn");
  await started;
  const result = await app.requestHarnessReview(session.id);
  assert.equal(result.kind, "armed");
  assert.match(result.note, /next settled boundary/);
  const requested = (app.get(session.id)?.events ?? []).filter(
    (event) => event.type === "harness.review.requested",
  );
  assert.equal(requested.length, 1, "the recorded request is visible in the chain");

  release();
  await app.settled();
  assert.equal(completions, 3, "the turn and the served review each asked once");
  const reviews = (app.get(session.id)?.events ?? []).filter(
    (event) => event.type === "harness.review",
  );
  assert.equal(
    reviews.at(-1)?.payload?.["outcome"],
    "declined",
    "the armed request must be served at the next boundary",
  );
});

test("two concurrent manual requests share one review and its outcome", async (t) => {
  const { fetcher, count } = answering((n) => (n === 1 ? answer() : declined()));
  const { app, session } = await seeded(t, fetcher);
  await seedLesson(app, session.id);

  const before = count();
  const [first, second] = await Promise.all([
    app.requestHarnessReview(session.id),
    app.requestHarnessReview(session.id),
  ]);
  assert.equal(count() - before, 1, "one operator intent pays for one review");
  assert.equal(first.kind, "declined");
  assert.equal(second.kind, "declined");
  assert.equal(second.note, first.note, "the joiner reads the same outcome");
});

test("a refusal for a missing provider does not arm a later settled turn", async (t) => {
  const { fetcher, count } = answering((n) => (n <= 2 ? answer() : declined()));
  const { app, session } = await seeded(t, fetcher);
  await seedLesson(app, session.id);

  app.clearProvider();
  const refused = await app.requestHarnessReview(session.id);
  assert.equal(refused.kind, "refused");
  assert.match(refused.note, /Connect the provider/);

  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  app.send(session.id, "One more turn");
  await app.settled();
  assert.equal(count(), 2, "only the two turns asked the model, never a review");
  const reviews = (app.get(session.id)?.events ?? []).filter(
    (event) => event.type === "harness.review",
  );
  assert.ok(
    reviews.every((event) => event.payload?.["outcome"] !== "declined"),
    "a refused request must not spend a review on a later boundary",
  );
});

test("a settled turn during a manual review joins it instead of paying twice", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markReviewStarted!: () => void;
  const reviewStarted = new Promise<void>((resolve) => {
    markReviewStarted = resolve;
  });
  let markTurnDone!: () => void;
  const turnDone = new Promise<void>((resolve) => {
    markTurnDone = resolve;
  });
  let completions = 0;
  const fetcher = async (url: unknown) => {
    if (String(url).endsWith("/models")) return models();
    completions += 1;
    if (completions === 1) return answer();
    if (completions === 2) {
      markReviewStarted();
      await held;
      return declined();
    }
    markTurnDone();
    return answer();
  };
  const { app } = await isolatedWorkbench(t, fetcher as typeof fetch, {}, {
    prefix: "nomo-harness-manual-overlap-",
    beforeShutdown: () => release(),
  });
  const session = await app.start("Review the workspace", "fixture");
  await app.settled();
  await app.editDocument(session.id, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });
  await seedLesson(app, session.id);

  const review = app.requestHarnessReview(session.id);
  await reviewStarted;
  app.send(session.id, "One more turn");
  await turnDone;
  release();
  const result = await review;
  await app.settled();
  assert.equal(result.kind, "declined");
  assert.equal(
    completions,
    3,
    "the first turn, the review and the second turn, with no second review",
  );
});

test("a two-lens manual round bills twice and names the count on both surfaces", async (t) => {
  const reviewProposal: RefinementProposal = {
    summary: "second manual review proposal",
    rationale: "two lenses reviewed the same evidence",
    expectedOutcome: "one signed proposal awaits the decision",
    edits: [
      {
        action: "create",
        kind: "memory",
        title: "manual lesson two",
        content: "The operator asked twice, so two lenses answered.",
        derivedFromSeq: [1],
        reason: "the request is the evidence",
      },
    ],
  };
  const approval = () =>
    Response.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: JSON.stringify({ approve: true, proposal: reviewProposal }),
          },
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
  const { fetcher, count } = answering((n) => (n === 1 ? answer() : approval()));
  const { app, session } = await seeded(t, fetcher);
  await seedLesson(app, session.id);
  app.patchHarnessSettings({ refinementLensCount: 2 });

  const before = count();
  const result = await app.requestHarnessReview(session.id);
  assert.equal(result.kind, "ran");
  assert.equal(
    result.note,
    "Harness review ran and recorded a proposal (2 of 2 lenses approved).",
  );
  assert.equal(count() - before, 2, "two lenses pay for two model calls");

  const events = app.get(session.id)!.events;
  const usage = events.filter(
    (event) => event.kind === "usage" && event.payload?.source === "harness",
  );
  assert.equal(usage.length, 2, "one usage record per reply that reports usage");
  const reviews = events.filter((event) => event.type === "harness.review");
  assert.equal(
    reviews.at(-1)?.text,
    "Harness review ran and recorded a proposal (2 of 2 lenses approved).",
    "the event log and the manual result must name the same count",
  );
});
