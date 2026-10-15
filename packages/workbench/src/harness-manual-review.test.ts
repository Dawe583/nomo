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
    prefix: "void-harness-manual-",
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
    prefix: "void-harness-manual-unknown-",
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
    prefix: "void-harness-manual-busy-",
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
