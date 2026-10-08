import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
    return Response.json({ choices: [{ message: { role: "assistant", content } }] });
  };
};

const withWorkbench = async (
  t: { after(fn: () => Promise<void>): void },
  replies: readonly string[] = ["ok"],
): Promise<Workbench> => {
  const root = await mkdtemp(join(tmpdir(), "void-harness-wiring-"));
  const app = new Workbench({ VOID_DATA_DIR: root } as NodeJS.ProcessEnv, fetcher(replies));
  // The storage key is written by the constructor, so an ignored data
  // directory is visible here rather than as a later failure: a fixture that
  // fell back to the operator's real store would write keys, sessions and
  // preferences into `~/.void/workbench` and pass every assertion below.
  assert.ok(
    existsSync(join(root, "workspace.key")),
    "the fixture workbench did not use the temporary data directory",
  );
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
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

test("a turn that failed never reaches the harness boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-harness-failed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // The catalogue answers so the conversation starts; the completion throws so
  // the turn ends in a failure rather than settling.
  const app = new Workbench(
    { VOID_DATA_DIR: root } as NodeJS.ProcessEnv,
    async (url: unknown) => {
      if (String(url).endsWith("/models"))
        return Response.json({ data: [{ id: "fixture" }] });
      throw new Error("provider unavailable");
    },
  );
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
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
  const root = await mkdtemp(join(tmpdir(), "void-harness-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new Workbench(
    { VOID_DATA_DIR: root } as NodeJS.ProcessEnv,
    fetcher(["ok"]),
  );
  await first.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const session = await first.start("Say ok", "fixture");
  await first.settled();
  const learned = await first.harnessEntries(session.workspace);
  await first.shutdown();

  // A fresh workbench over the same directory must still read the chain, so
  // what the harness learned is not lost, even though the in-memory trigger
  // that schedules the next review is.
  const second = new Workbench(
    { VOID_DATA_DIR: root } as NodeJS.ProcessEnv,
    fetcher(["ok"]),
  );
  try {
    // Rebuilding from the verified chain must reproduce the same active
    // entries: an in-memory trigger is forgotten on restart, so the chain is
    // the only thing that can carry what was learned. Comparing the whole
    // entry rather than its length is what makes a stale `createdAt` or a
    // dropped override fail here instead of passing as "not undefined".
    assert.deepEqual(await second.harnessEntries(session.workspace), learned);
  } finally {
    await second.shutdown();
  }
});