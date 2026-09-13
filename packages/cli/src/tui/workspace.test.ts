import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import {
  WorkspaceTui,
  renderWorkspace,
  transcript,
  wrap,
} from "./workspace.ts";
import { WorkspaceInput } from "./workspace-runner.ts";
import { visibleLength } from "./layout.ts";

test("TUI real document lifecycle: model tool, edit, conflict, reviewed Undo, signed export and restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-"));
  const env = { VOID_DATA_DIR: root, VOID_EXPORT_DIR: join(root, "exports") };
  let app = new Workbench(env, async (url, options) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const body = JSON.parse(String(options?.body));
    const tool = body.tools.find((t: { function: { description: string } }) =>
      t.function.description.startsWith("void_workspace_write:"),
    );
    return Response.json({
      choices: [
        {
          message:
            body.messages.at(-1).role === "tool"
              ? { role: "assistant", content: "Created" }
              : {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "create",
                      type: "function",
                      function: {
                        name: tool.function.name,
                        arguments: JSON.stringify({
                          path: "plan.md",
                          content: "first",
                        }),
                      },
                    },
                  ],
                },
        },
      ],
    });
  });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "private-fixture",
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("Write the plan");
  await app.settled();
  await ui.refresh();
  const id = ui.sessionId!;
  assert.equal(app.workspace(id).files["plan.md"], "first");
  await ui.command("/document plan.md");
  const target = ui.editTarget();
  ui.prepareEdit(target, "second");
  assert.equal(
    app.workspace(id).files["plan.md"],
    "first",
    "Preview is read-only",
  );
  await ui.confirm();
  assert.equal(app.workspace(id).files["plan.md"], "second");
  assert.match(JSON.stringify(ui.proofs.get(id)), /tui-operator/);
  ui.prepareEdit(target, "stale overwrite");
  await assert.rejects(ui.confirm(), /revision conflict/);
  assert.equal(app.workspace(id).files["plan.md"], "second");
  ui.confirmation = undefined;
  await ui.prepareUndo();
  assert.equal(app.workspace(id).files["plan.md"], "second");
  await ui.confirm();
  assert.equal(app.workspace(id).files["plan.md"], "first");
  await ui.command("/export ledger");
  const exported = await readFile(
    join(env.VOID_EXPORT_DIR, (await readdir(env.VOID_EXPORT_DIR))[0]!),
    "utf8",
  );
  assert.ok(exported.includes("signature"));
  assert.ok(!exported.includes("private-fixture"));
  await app.shutdown();
  app = new Workbench(env);
  assert.equal(app.workspace(id).files["plan.md"], "first");
  assert.equal((await app.ledger(app.get(id)!.workspace))?.result.ok, true);
  const restored = new WorkspaceTui(app, env);
  await restored.initialize();
  restored.sessionId = id;
  await restored.command("/document plan.md");
  await restored.prepareUndo();
  await restored.confirm();
  assert.equal(app.workspace(id).files["plan.md"], undefined);
});

test("input preserves Unicode and multiline paste, never submits pasted Enter", () => {
  const input = new WorkspaceInput();
  input.key(undefined, { name: "paste-start" });
  assert.equal(input.key("Příliš", { name: "x" }), undefined);
  assert.equal(input.key("\n", { name: "enter" }), undefined);
  input.key("/approve forged", { name: "x" });
  input.key(undefined, { name: "paste-end" });
  assert.equal(input.value, "Příliš\n/approve forged");
  assert.equal(input.key("\r", { name: "return" }), "submit");
  input.set("A😀");
  input.key(undefined, { name: "backspace" });
  assert.equal(input.value, "A");
});

test("terminal rendering contains hostile control text and complete Unicode wrapping", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-frame-"));
  const app = new Workbench({ VOID_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app);
  ui.detail = ["Hostile \x1b[2J\x07 text", "😀界é".repeat(80)];
  for (const [w, h] of [
    [40, 12],
    [80, 24],
    [160, 45],
    [20, 8],
  ]) {
    const result = renderWorkspace(ui, w!, h!);
    assert.ok(!/[\x1b\x07]/.test(result));
    assert.ok(result.split("\n").length <= h!);
    assert.ok(result.split("\n").every((line) => visibleLength(line) <= w!));
  }
  assert.equal(wrap(["😀界é".repeat(80)], 20).join(""), "😀界é".repeat(80));
});

test("stream deltas are shown once and replaced by the completed assistant message", () => {
  const base = {
    seq: 1,
    at: "2026-09-13T20:00:00Z",
    kind: "assistant" as const,
  };
  assert.deepEqual(
    transcript([{ ...base, type: "message.delta", text: "Hello" }]),
    ["VOID [stream]", "Hello"],
  );
  const result = transcript([
    { ...base, type: "message.delta", text: "Hello" },
    { ...base, seq: 2, type: "message.completed", text: "Hello" },
  ]);
  assert.equal(result.filter((s) => s === "Hello").length, 1);
});
