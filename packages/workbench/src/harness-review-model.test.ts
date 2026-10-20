/**
 * The auxiliary review model selection.
 *
 * A review is a bounded, structured request, and an operator may want it on a
 * different model than the one they are chatting with: a cheaper one for a
 * cheap question, or a stronger one for a judgement about a workspace. What
 * these prove is that nothing is selected by default, that a selection moves
 * the call and the usage record names the model the call actually went to,
 * that a malformed or unknown selection is refused by name and changes
 * nothing, that a hand-edited snapshot cannot inject a model id the validator
 * refuses, and that a provider which does not know the selected model fails
 * the review with the model named.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { isolatedWorkbench } from "./test-fixture.ts";
import {
  resolveHarnessTextSettings,
  type HarnessTextSettings,
} from "./harness-settings.ts";
import type { RefinementProposal } from "./refine-pass.ts";

const models = () => Response.json({ data: [{ id: "fixture" }] });

const lesson = (): RefinementProposal => ({
  summary: "repeated lesson",
  rationale: "supported by signed records",
  expectedOutcome: "fewer repeated approvals",
  edits: [{
    action: "create",
    kind: "memory",
    title: "approval pattern",
    content: "The operator repeatedly approved the same action.",
    derivedFromSeq: [1],
    reason: "the pattern repeats",
  }],
});

/** A provider that answers a review with a decline and records the model
 * every completion request named. */
function answering(options: { readonly refuseModel?: string } = {}) {
  const seen: string[] = [];
  const fetcher = async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/models")) return models();
    const body = init?.body ? (JSON.parse(String(init.body)) as { model?: string }) : {};
    const model = typeof body.model === "string" ? body.model : "";
    seen.push(model);
    if (options.refuseModel && model === options.refuseModel)
      return new Response("no such model", { status: 404 });
    return Response.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: JSON.stringify({ verdict: "decline" }),
          },
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
  };
  return { fetcher: fetcher as typeof fetch, seen };
}

async function fixture(t: TestContext, fetcher: typeof fetch) {
  const f = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "void-harness-review-model-",
  });
  const { app } = f;
  const session = await app.start("Review the workspace", "fixture");
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

test("with nothing selected the review runs on the conversation's own model", async (t) => {
  const { fetcher, seen } = answering();
  const { app, session } = await fixture(t, fetcher);

  await app.requestHarnessReview(session.id);

  assert.ok(
    seen.includes("fixture"),
    `the review must run on the session's own model, saw ${JSON.stringify(seen)}`,
  );
  assert.deepEqual(app.harnessTextSettings().refinementModel, "");
});

test("a selected model takes the review call and the usage record names it", async (t) => {
  const { fetcher, seen } = answering();
  const { app, session } = await fixture(t, fetcher);

  app.patchHarnessTextSettings({ refinementModel: "reviewer-1" });
  await app.requestHarnessReview(session.id);

  assert.ok(
    seen.includes("reviewer-1"),
    `the review must go to the selected model, saw ${JSON.stringify(seen)}`,
  );
  const usage = app
    .get(session.id)!
    .events.filter(
      (event) => event.kind === "usage" && event.payload?.source === "harness",
    );
  assert.equal(usage.length, 1);
  assert.equal(
    usage[0]!.payload?.model,
    "reviewer-1",
    "the usage record must name the model the call went to, not the one the conversation runs on",
  );
});

test("a malformed model id is refused by name and changes nothing", async (t) => {
  const { fetcher } = answering();
  const { app } = await fixture(t, fetcher);

  assert.throws(
    () => app.patchHarnessTextSettings({ refinementModel: "bad id" }),
    /Invalid refinementModel/,
  );
  assert.throws(
    () => app.patchHarnessTextSettings({ refinementModel: "x".repeat(200) }),
    /at most 128 characters/,
  );
  assert.deepEqual(app.harnessTextSettings().refinementModel, "");
});

test("an unknown selection is refused by name", async (t) => {
  const { fetcher } = answering();
  const { app } = await fixture(t, fetcher);

  assert.throws(
    () => app.patchHarnessTextSettings({ reviewerModel: "reviewer-1" }),
    /Unknown harness selection reviewerModel\. Known: refinementModel\./,
  );
  assert.deepEqual(app.harnessTextSettings().refinementModel, "");
});

test("a hand-edited snapshot cannot inject a model id the validator refuses", () => {
  const resolved = resolveHarnessTextSettings({
    refinementModel: "bad id",
    somethingElse: "reviewer-2",
  });
  assert.deepEqual(resolved.refinementModel, "");
  assert.deepEqual(
    resolveHarnessTextSettings({ refinementModel: "reviewer-2" }),
    { refinementModel: "reviewer-2" } satisfies HarnessTextSettings,
  );
});

test("a provider that does not know the selected model fails the review naming the model", async (t) => {
  const { fetcher } = answering({ refuseModel: "reviewer-1" });
  const { app, session } = await fixture(t, fetcher);

  app.patchHarnessTextSettings({ refinementModel: "reviewer-1" });
  const result = await app.requestHarnessReview(session.id);

  assert.equal(result.kind, "failed");
  assert.match(
    result.kind === "failed" ? result.note : "",
    /The harness review on model reviewer-1 failed/,
  );
  void session;
});
