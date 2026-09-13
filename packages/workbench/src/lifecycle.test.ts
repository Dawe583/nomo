import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "./index.ts";

test("Stop does not release capacity until the original provider settles; shutdown drains it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-stop-"));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const app = new Workbench({ VOID_DATA_DIR: root }, async (url) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    calls++;
    await blocked; // Transport may ignore cancellation until it finishes.
    return Response.json({
      choices: [{ message: { role: "assistant", content: "Late answer" } }],
    });
  });
  t.after(async () => {
    release();
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture",
  });
  const session = await app.start("First", "fixture");
  app.cancel(session.id);
  assert.throws(() => app.send(session.id, "Second"), /not ready/);
  await assert.rejects(app.start("Other", "fixture"), /active session/);
  await assert.rejects(
    app.editDocument(session.id, {
      path: "x.md",
      content: "x",
      expectedRevision: null,
    }),
    /stop/,
  );
  release();
  await app.settled();
  assert.equal(calls, 1);
  assert.equal(app.get(session.id)?.status, "cancelled");
  assert.equal(
    app.get(session.id)?.events.some((e) => e.text === "Late answer"),
    false,
  );
  app.send(session.id, "Now continue");
  await app.settled();
  assert.equal(calls, 2);
  assert.equal(app.get(session.id)?.status, "idle");
});
