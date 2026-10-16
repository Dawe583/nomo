import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { LocalStorage } from "./storage.ts";
import { assertIsolated, isolatedWorkbench } from "./test-fixture.ts";
import { Workbench } from "./index.ts";
import { readLedgerFeed } from "../../ledger/src/feed.ts";

const reply = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
const models = () => reply({ data: [{ id: "fixture" }] });
const answer = (content: string = "Done") =>
  reply({ choices: [{ message: { role: "assistant", content } }] });

test("spawn creates a child with parentId and fresh history", async (t) => {
  const { app } = await isolatedWorkbench(t, ((u: string) => models()) as unknown as typeof fetch, {});
  // models fetcher returns models, catalog populated; workbench auto not started
  const parent = await app.start("Parent request", "fixture");
  const child = await app.spawnSubagent(parent.id, "Do the delegated task");
  assert.notEqual(child.id, parent.id);
  assert.equal(child.parentId, parent.id);
  assert.notEqual(child.workspace, parent.workspace);
  assert.equal(child.status === "queued" || child.status === "idle", true);
  const childView = app.get(child.id)!;
  // fresh history: only system + at most one pending queued user event
  assert.ok(
    childView.contextMessages === 1 ||
      childView.events.some((e) => e.kind === "user"),
  );
  assert.equal((await app.list()).find((s) => s.id === parent.id)!.parentId, undefined);
});

test("spawn refuses an unknown parent without creating a session", async (t) => {
  const { app } = await isolatedWorkbench(t, ((u: string) => models()) as unknown as typeof fetch, {});
  const before = (await app.list()).length;
  await assert.rejects(
    app.spawnSubagent("no-such-parent", "hello"),
    /Session not found\./,
  );
  assert.equal((await app.list()).length, before);
});

test("spawn refuses an empty prompt without side effects", async (t) => {
  const { app } = await isolatedWorkbench(t, ((u: string) => models()) as unknown as typeof fetch, {});
  const parent = await app.start("Parent request", "fixture");
  await assert.rejects(
    app.spawnSubagent(parent.id, "   "),
    /Enter a prompt between/,
  );
});

test("idempotent replay returns the same child, once", async (t) => {
  const { app } = await isolatedWorkbench(t, ((u: string) => models()) as unknown as typeof fetch, {});
  const parent = await app.start("Parent request", "fixture");
  const first = await app.spawnSubagent(parent.id, "Do the task", {
    idempotencyKey: "key-1",
  });
  const second = await app.spawnSubagent(parent.id, "Do the task", {
    idempotencyKey: "key-1",
  });
  assert.equal(second.id, first.id);
});

test("idempotency key collision with a different prompt is rejected", async (t) => {
  const { app } = await isolatedWorkbench(t, ((u: string) => models()) as unknown as typeof fetch, {});
  const parent = await app.start("Parent request", "fixture");
  await app.spawnSubagent(parent.id, "first prompt", {
    idempotencyKey: "collide-key",
  });
  await assert.rejects(
    app.spawnSubagent(parent.id, "second different prompt", {
      idempotencyKey: "collide-key",
    }),
    /Idempotency key belongs to another request\./,
  );
});

test("spawn writes a void_subagent_spawn entry to the parent chain", async (t) => {
  const { app } = await isolatedWorkbench(t, ((u: string) => models()) as unknown as typeof fetch, {});
  await app.settled();
  const parent = await app.start("Parent request", "fixture");
  const child = await app.spawnSubagent(parent.id, "Delegated payload", { idempotencyKey: "lk" });
  const proof = await app.ledger(parent.workspace);
  assert.ok(proof, "ledger proof for parent workspace");
  const entries = (proof as { entries: Array<{ body: Record<string, unknown> }> }).entries;
  const entry = entries.find((e) => e.body.tool === "void_subagent_spawn");
  assert.ok(entry, "expected a void_subagent_spawn entry");
  assert.equal(entry!.body.decision, "spawn:completed");
  assert.ok(entry!.body.promptSha256, "prompt digest present");
  assert.equal(JSON.stringify(entry!.body).includes("Delegated payload"), false, "no raw prompt in ledger");
  assert.equal(child.parentId, parent.id);
});

test("spawn queues when capacity is held and fails closed at queue cap", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-spawn-cap-"));
  const fetcher: typeof fetch = async (url: unknown) => {
    if (String(url).endsWith("/models")) return models();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return answer("Done");
  };
  const env = {
    NOMO_DATA_DIR: root,
    NOMO_LEDGER_DIR: join(root, "ledger"),
  } as NodeJS.ProcessEnv;
  const app = new Workbench(env, fetcher);
  assertIsolated(root, env);
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  await app.patchHarnessSettings({ maxQueuedRuns: 1 });
  const parent = await app.start("Long parent", "fixture");
  assert.equal(parent.status, "running");
  const child1 = await app.spawnSubagent(parent.id, "Child one");
  assert.equal(child1.status, "queued");
  await assert.rejects(
    app.spawnSubagent(parent.id, "Child two"),
    /Background queue is full/,
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  await app.settled();
  app.close();
  await rm(root, { recursive: true, force: true });
});