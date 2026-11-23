import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import { renderWorkspace, WorkspaceTui } from "./workspace.ts";
import { stripAnsi } from "./layout.ts";

test("Usage charts only reported totals and selects records without a total as gaps", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-tui-usage-"));
  let turn = 0;
  const usage = [
    { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    { prompt_tokens: 7, completion_tokens: 3 },
  ];
  const fetcher: typeof fetch = async (input) =>
    String(input).endsWith("/models")
      ? Response.json({
          data: [{ id: "fixture-model", name: "Fixture Model" }],
        })
      : Response.json({
          choices: [
            {
              message: { role: "assistant", content: "Done." },
              finish_reason: "stop",
            },
          ],
          usage: usage[turn++]!,
        });
  const app = new Workbench({ NOMO_DATA_DIR: directory }, fetcher);
  t.after(async () => {
    await app.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture-only-key",
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: directory });
  await ui.initialize();
  await ui.command("Record a known usage total.");
  await app.settled();
  await ui.command("Record a usage event with no total.");
  await app.settled();
  await ui.refresh(true);
  ui.choose("usage");
  ui.selected = 1;

  const frame = stripAnsi(
    renderWorkspace(ui, 120, 40, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  assert.equal(ui.items().length, 2);
  assert.equal(ui.items()[0]?.usage?.totalTokens, 20);
  assert.equal(ui.items()[1]?.usage?.totalTokens, null);
  assert.match(frame, /20 tokens/);
  assert.match(ui.items()[1]?.label ?? "", /unknown/i);

  await ui.openSelected();
  assert.match(ui.detail?.join("\n") ?? "", /total.*unknown/i);
  assert.match(ui.detail?.join("\n") ?? "", /cost.*unknown/i);
});
