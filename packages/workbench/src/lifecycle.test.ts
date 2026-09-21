import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
test("background sessions queue behind the active run and drain after settlement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-background-"));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const app = new Workbench({ VOID_DATA_DIR: root }, async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "fixture" }] });
    calls++;
    await blocked;
    return Response.json({ choices: [{ message: { role: "assistant", content: "Done" } }] });
  });
  t.after(async () => {
    release();
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const first = await app.start("First", "fixture");
  const queued = await app.start("Queued", "fixture", undefined, undefined, undefined, true);
  assert.equal(queued.status, "queued");
  release();
  for (let poll = 0; poll < 200 && app.get(queued.id)?.status === "queued"; poll++) await delay(10);
  await app.settled();
  assert.equal(app.get(queued.id)?.status, "idle");
  assert.equal(calls, 2);
  assert.equal(app.get(first.id)?.status, "idle");
});
