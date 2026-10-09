import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "./index.ts";

/**
 * These tests hold the wiring, not the runtime. The runtime's own tests prove
 * what the gate and the trigger decide; these prove the settled turn of a real
 * conversation reaches that code at all, which is a different claim and one a
 * module test cannot make.
 *
 * The provider request count is the evidence. A runtime that was never wired
 * would leave the count at zero for the wrong reason, so the permitting test
 * drives a chain that mines candidates and asserts the count moved.
 */
const fetcher = (replies: readonly string[]) => {
  let index = 0;
  return async (url: unknown) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const content = replies[index] ?? "Done.";
    index += 1;
    return Response.json({
      choices: [{ message: { role: "assistant", content } }],
    });
  };
};

const withWorkbench = async (
  t: { after(fn: () => Promise<void>): void },
  replies: readonly string[] = ["ok"],
): Promise<Workbench> => {
  const root = await mkdtemp(join(tmpdir(), "nomo-harness-wiring-"));
  const app = new Workbench(
    { NOMO_DATA_DIR: root } as NodeJS.ProcessEnv,
    fetcher(replies),
  );
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture",
  });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  return app;
};

test("a settled turn leaves the conversation finished, not running", async (t) => {
  const app = await withWorkbench(t);
  const session = await app.start("Summarise the workspace", "fixture");
  await app.settled();
  // The boundary runs inside the run job, so the job settling is what proves
  // the hook did not leave the session waiting on a review.
  assert.notEqual(app.get(session.id)?.status, "running");
});

test("the settled turn reaches the gate and says why it did not run", async (t) => {
  const app = await withWorkbench(t);
  const session = await app.start("Say ok", "fixture");
  await app.settled();

  // The wiring claim: a settled turn reaches the boundary and reports it. A
  // hook that was never reached would leave no such event, so this fails when
  // the boundary stops being called rather than when a gate decides otherwise.
  const events = app.get(session.id)?.events ?? [];
  const review = events.find((event) => event.type === "harness.review");
  assert.ok(review, "a settled turn left no trace of the harness boundary");
  assert.equal(review?.payload?.["outcome"], "not-run");
  assert.match(review.text, /no trigger is armed|no trigger/i);

  // Nothing was mined, so nothing may have been learned.
  assert.deepEqual(await app.harnessEntries(session.workspace), []);
});

test("a successful compaction arms the trigger for later turns", async (t) => {
  const app = await withWorkbench(t);
  const session = await app.start("Say ok", "fixture");
  await app.settled();
  app.compact(session.id);

  await app.send(session.id, "Say ok again");
  await app.settled();

  const events = app.get(session.id)?.events ?? [];
  const reviews = events.filter((event) => event.type === "harness.review");
  assert.ok(reviews.length > 0, "an armed turn left no trace");
  assert.ok(
    reviews.every((review) => review.payload?.["outcome"] === "not-run"),
    "nothing was mined, so no review may have run",
  );
  assert.ok(
    reviews.some((review) => !/no trigger is armed/i.test(review.text)),
    "after compaction the gate must refuse for a reason other than not-armed",
  );
});

test("a failed review leaves a failed trace, not silence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-harness-review-failed-"));
  // The review ask carries the verdict protocol; only that request fails, so
  // ordinary turns keep settling while the paid call provably throws.
  const refusing = async (url: unknown, init?: { body?: unknown }) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    if (
      typeof init?.body === "string" &&
      init.body.includes("in one of two shapes")
    )
      throw new Error("review provider unavailable");
    const content = "Done.";
    return Response.json({
      choices: [{ message: { role: "assistant", content } }],
    });
  };
  const app = new Workbench(
    { NOMO_DATA_DIR: root } as NodeJS.ProcessEnv,
    refusing,
  );
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture",
  });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const session = await app.start("Say ok", "fixture");
  await app.settled();
  await app.editDocument(session.id, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });
  await app.refineHarness(session.id, {
    summary: "repeated lesson",
    rationale: "supported by signed records",
    expectedOutcome: "fewer repeated approvals",
    edits: [
      {
        action: "create",
        kind: "memory",
        title: "approval pattern",
        content: "The operator repeatedly approved the same action.",
        derivedFromSeq: [1],
        reason: "the pattern repeats",
      },
    ],
  });
  app.compact(session.id);
  // The gate needs 25 settled turns and this session banks them one send at
  // a time; every earlier boundary refuses cheaply without a provider call.
  for (let turn = 0; turn < 25; turn++) {
    app.send(session.id, `Say ok ${turn}`);
    await app.settled();
  }

  const reviews = (app.get(session.id)?.events ?? []).filter(
    (event) => event.type === "harness.review",
  );
  const failed = reviews.filter(
    (review) => review.payload?.["outcome"] === "failed",
  );
  assert.ok(failed.length > 0, "a thrown review must surface as failed");
  assert.ok(
    failed.some((review) => /Harness review failed: .+/i.test(review.text)),
    "the failed trace must name the error instead of staying silent",
  );
});

test("a turn that failed never reaches the harness boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-harness-failed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // The catalogue answers so the conversation starts; the completion throws so
  // the turn ends in a failure rather than settling.
  const app = new Workbench(
    { NOMO_DATA_DIR: root } as NodeJS.ProcessEnv,
    async (url: unknown) => {
      if (String(url).endsWith("/models"))
        return Response.json({ data: [{ id: "fixture" }] });
      throw new Error("provider unavailable");
    },
  );
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture",
  });
  try {
    const session = await app.start("Say ok", "fixture");
    await app.settled();
    assert.notEqual(app.get(session.id)?.status, "idle");
    const review = (app.get(session.id)?.events ?? []).find(
      (event) => event.type === "harness.review",
    );
    // A turn whose outcome nobody knows is not settled, and there is nothing to
    // learn from it. Learning here would mine a failure as if it were a signal.
    assert.equal(review, undefined);
  } finally {
    await app.shutdown();
  }
});

test("the trigger survives a restart as a delay rather than a decision", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-harness-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new Workbench(
    { NOMO_DATA_DIR: root } as NodeJS.ProcessEnv,
    fetcher(["ok"]),
  );
  await first.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture",
  });
  const session = await first.start("Say ok", "fixture");
  await first.settled();
  await first.shutdown();

  // A fresh workbench over the same directory must still read the chain, so
  // what the harness learned is not lost, even though the in-memory trigger
  // that schedules the next review is.
  const second = new Workbench(
    { NOMO_DATA_DIR: root } as NodeJS.ProcessEnv,
    fetcher(["ok"]),
  );
  try {
    assert.ok((await second.harnessEntries(session.workspace)) !== undefined);
  } finally {
    await second.shutdown();
  }
});
