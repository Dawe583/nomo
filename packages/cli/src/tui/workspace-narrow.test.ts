import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import {
  WORKSPACE_TABS,
  WorkspaceTui,
  renderWorkspace,
  type WorkspaceTab,
} from "./workspace.ts";
import { stripAnsi, visibleLength } from "./layout.ts";

const PRIMARY_FACT: Record<WorkspaceTab, RegExp> = {
  chat: /Draft Tab to write/,
  sessions: /SESSIONS · 0 conversations/,
  runs: /RUNS · 0 recorded/,
  documents: /DOCUMENT TREE · 0 files/,
  ledger: /VERIFICATION · 1 · chain check/,
  approvals: /No approvals waiting\./,
  policy: /POLICY, 1 connectors: 1 confirmed/,
  tools: /r0 -- 5 tools/,
  mcp: /connected · NOMO documents/,
  status: /UNMEASURED · identity/,
  models: /MODELS · 0 configured providers/,
  usage: /No usage records yet\./,
  help: /QUICK KEYS/,
};

test("every workspace screen keeps title, primary fact and escape at narrow terminals", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-narrow-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });

  for (const tab of WORKSPACE_TABS) {
    ui.choose(tab);
    ui.filter = "";
    ui.selected = 0;
    ui.scroll = 0;
    for (const [width, height] of [
      [40, 12],
      [52, 16],
    ] as const) {
      const rows = stripAnsi(
        renderWorkspace(ui, width, height, "", false, false, {
          color: false,
          motion: false,
        }),
      ).split("\n");
      const text = rows.join("\n");
      const title = tab === "mcp" ? "Mcp" : tab[0]!.toUpperCase() + tab.slice(1);
      assert.ok(
        rows[0]?.includes(title),
        `${tab} ${width}x${height} lost its screen title`,
      );
      assert.match(
        text,
        PRIMARY_FACT[tab],
        `${tab} ${width}x${height} lost its primary fact`,
      );
      if (tab !== "chat")
        assert.match(
          text,
          /Esc (?:returns to )?Chat/,
          `${tab} ${width}x${height} lost its escape hint`,
        );
      assert.equal(rows.length, height);
      assert.ok(
        rows.every((row) => visibleLength(row) <= width),
        `${tab} ${width}x${height} exceeded its terminal width`,
      );
      assert.ok(
        !text.includes("not enforce."),
        `${tab} ${width}x${height} clips the mode authority note mid-word`,
      );
    }
  }
});
