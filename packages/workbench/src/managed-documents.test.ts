import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { isolatedWorkbench } from "./test-fixture.ts";
import { digest } from "../../runtime/src/index.ts";
async function fixture(t: TestContext) {
  const fetcher: typeof fetch = async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "test" }] })
      : Response.json({
          choices: [{ message: { role: "assistant", content: "done" } }],
        });
  // `configure: false` because the session below is started after this test's
  // own `configure`, and the fixture's placeholder base URL would be a
  // different provider than the one the assertions describe.
  const f = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-doc-runtime-",
    configure: false,
  });
  await f.app.configure({
    baseUrl: "https://provider.test/v1",
    apiKey: "fixture",
  });
  const session = await f.app.start("Test", "test");
  while (f.app.get(session.id)?.status === "running") await delay(5);
  return {
    root: f.root,
    session,
    get app() {
      return f.app;
    },
    restart: f.restart,
  };
}
test("document edits and sequential Undo use signed runtime after restart without changing legacy history format", async (t) => {
  const f = await fixture(t),
    a = await f.app.editDocument(f.session.id, {
      path: "note.md",
      content: "first",
      expectedRevision: null,
    });
  const b = await f.app.editDocument(f.session.id, {
    path: "note.md",
    content: "second",
    expectedRevision: a.revision,
  });
  const app = f.restart();
  assert.equal(
    (await app.undoPreview(f.session.id, b.revision!)).canApply,
    true,
  );
  await app.undo(f.session.id, b.revision!);
  assert.equal(app.document(f.session.id, "note.md").content, "first");
  await app.undo(f.session.id, a.revision!);
  assert.equal(app.workspace(f.session.id).files["note.md"], undefined);
  await app.undo(f.session.id, a.revision!);
  assert.equal(app.workspace(f.session.id).operations.length, 4);
  assert.equal((await app.ledger(f.session.workspace))?.result.ok, true);
  const events = (
    await readFile(
      join(f.root, "recovery", "journal", f.session.workspace + ".jsonl"),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).body);
  for (const id of [a.revision, b.revision])
    assert.equal(
      events.filter((event) => event.operationId === digest(id)).at(-1).stage,
      "restored",
    );
  assert.equal(
    events.some((event) => JSON.stringify(event).includes("second")),
    false,
  );
});
test("capture persistence failure prevents document mutation and leaves existing signed history intact", async (t) => {
  const f = await fixture(t),
    a = await f.app.editDocument(f.session.id, {
      path: "note.md",
      content: "first",
      expectedRevision: null,
    });
  const db = new DatabaseSync(
    join(f.root, "recovery", "vault", "vault.sqlite"),
  );
  db.exec(
    "CREATE TRIGGER fail_capture BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT,'injected storage failure'); END",
  );
  db.close();
  await assert.rejects(
    f.app.editDocument(f.session.id, {
      path: "note.md",
      content: "lost",
      expectedRevision: a.revision,
    }),
    /operation failed/,
  );
  assert.equal(f.app.document(f.session.id, "note.md").content, "first");
  assert.equal(f.app.workspace(f.session.id).operations.length, 1);
  assert.equal((await f.app.ledger(f.session.workspace))?.result.ok, true);
});
test("newer human edits block managed Undo and independent documents remain untouched", async (t) => {
  const f = await fixture(t),
    a = await f.app.editDocument(f.session.id, {
      path: "note.md",
      content: "a",
      expectedRevision: null,
    });
  const b = await f.app.editDocument(f.session.id, {
    path: "note.md",
    content: "b",
    expectedRevision: a.revision,
  });
  await f.app.editDocument(f.session.id, {
    path: "other.md",
    content: "keep",
    expectedRevision: null,
  });
  assert.equal(
    (await f.app.undoPreview(f.session.id, a.revision!)).canApply,
    false,
  );
  await assert.rejects(f.app.undo(f.session.id, a.revision!), /changed/);
  assert.equal(f.app.document(f.session.id, "note.md").content, "b");
  assert.equal(f.app.document(f.session.id, "other.md").content, "keep");
  await f.app.undo(f.session.id, b.revision!);
  assert.equal(f.app.document(f.session.id, "note.md").content, "a");
  await f.app.undo(f.session.id, a.revision!);
  assert.equal(f.app.workspace(f.session.id).files["note.md"], undefined);
});
test("missing managed journal cannot silently fall back to legacy Undo", async (t) => {
  const f = await fixture(t),
    edit = await f.app.editDocument(f.session.id, {
      path: "note.md",
      content: "retain",
      expectedRevision: null,
    });
  await rm(join(f.root, "recovery", "journal", f.session.workspace + ".jsonl"));
  await assert.rejects(
    f.app.undoPreview(f.session.id, edit.revision!),
    /journal is missing/,
  );
  assert.equal(f.app.document(f.session.id, "note.md").content, "retain");
});
test("previously signed document operations without runtime markers retain legacy Undo after restart", async (t) => {
  const f = await fixture(t),
    { executeWorkspaceTool } = await import("./workspace.ts");
  const args = { path: "old.md", content: "legacy" };
  const change = executeWorkspaceTool(f.app.workspace(f.session.id), {
    id: "legacy-operation",
    name: "void_workspace_write",
    arguments: args,
  });
  // Reuse the unchanged legacy commit boundary to create a pre-runtime record.
  const legacy = f.app as unknown as {
    sessions: Map<string, unknown>;
    commitWorkspace(...args: unknown[]): Promise<void>;
  };
  await legacy.commitWorkspace(
    legacy.sessions.get(f.session.id),
    change.state,
    "void_workspace_write",
    args,
    "execute:completed",
    change.operation,
  );
  const app = f.restart();
  assert.equal(
    (await app.undoPreview(f.session.id, "legacy-operation")).canApply,
    true,
  );
  await app.undo(f.session.id, "legacy-operation");
  assert.equal(app.workspace(f.session.id).files["old.md"], undefined);
  assert.equal((await app.ledger(f.session.workspace))?.result.ok, true);
});
test("each managed document record names the document it read at the revision it read it", async (t) => {
  const f = await fixture(t);
  const first = await f.app.editDocument(f.session.id, {
    path: "note.md",
    content: "first",
    expectedRevision: null,
  });
  await f.app.editDocument(f.session.id, {
    path: "note.md",
    content: "second",
    expectedRevision: first.revision,
  });
  const events = (
    await readFile(
      join(f.root, "recovery", "journal", f.session.workspace + ".jsonl"),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).body);
  const seen = new Map<string, { readSet?: string[]; revision?: string }>();
  for (const event of events)
    if (event.stage === "succeeded")
      seen.set(event.operationId, {
        readSet: event.readSet,
        revision: event.revision,
      });
  assert.equal(seen.size, 2);
  const [older, newer] = [...seen.values()];
  // The read set is the document the call consulted, not the document the
  // caller named, and the revision moved with the first write: that pair is
  // what orders two edits to one document.
  assert.deepEqual(older.readSet, ["document:note.md"]);
  assert.deepEqual(newer.readSet, ["document:note.md"]);
  assert.notEqual(older.revision, newer.revision);
});
