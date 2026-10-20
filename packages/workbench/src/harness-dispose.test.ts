/**
 * The dispose drain, at the Workbench wiring level.
 *
 * The gate's reuse of the dispose surface and the trigger's refusal shapes
 * belong to their own files. What these prove is the call the operator
 * actually owns: shutdown reviews a session the settled interval has not
 * reached, that review pays the reviewer exactly once per lens, and a second
 * drain in the same tick is held by the cooldown instead of paying again.
 * `close()` alone must not reach the reviewer, because it closes the
 * transport the review would have to run on.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { isolatedWorkbench } from "./test-fixture.ts";
import type { RefinementProposal } from "./refine-pass.ts";

const models = () => Response.json({ data: [{ id: "fixture" }] });
const answer = (content = "Done") =>
  Response.json({ choices: [{ message: { role: "assistant", content } }] });
const declined = () =>
  answer(JSON.stringify({ approve: false, reason: "close review, nothing to apply" }));

const lesson = (): RefinementProposal => ({
  summary: "dispose drain proposal",
  rationale: "the session is ending and this is the last boundary",
  expectedOutcome: "one signed proposal awaits the decision",
  edits: [
    {
      action: "create",
      kind: "memory",
      title: "dispose lesson",
      content: "Nothing new remained at close, so the drain paid for a review only.",
      derivedFromSeq: [1],
      reason: "the chain held a record a reviewer had not seen",
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

async function seeded(t: TestContext, fetcher: typeof fetch) {
  const { app } = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "void-harness-dispose-",
  });
  const session = await app.start("Review the workspace at close", "fixture");
  await app.settled();
  await app.editDocument(session.id, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });
  const created = await app.refineHarness(session.id, lesson());
  await app.approveHarnessProposal(session.id, created.proposalDigest!);
  return { app, session };
}

test("the dispose drain reviews a session the settled interval has not reached", async (t) => {
  const { fetcher, count } = answering(() => declined());
  const { app } = await seeded(t, fetcher);

  const before = count();
  await app.disposeReviews();
  assert.ok(
    count() > before,
    "the dispose surface must reach the reviewer without waiting for the turn interval",
  );
});

test("a second drain in the same tick is held by the cooldown, not paid again", async (t) => {
  const { fetcher, count } = answering(() => declined());
  const { app } = await seeded(t, fetcher);

  await app.disposeReviews();
  const afterFirst = count();
  await app.disposeReviews();
  assert.equal(
    count(),
    afterFirst,
    "a dispose attempt stamps the cooldown like any boundary attempt, so a drain twice in one tick pays once",
  );
});

test("shutdown drains before it closes the transports", async (t) => {
  const { fetcher, count } = answering(() => declined());
  const { app } = await seeded(t, fetcher);

  const before = count();
  await app.shutdown();
  assert.ok(count() > before, "shutdown must serve the dispose boundary while the provider still works");
});
