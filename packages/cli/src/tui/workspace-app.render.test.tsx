import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";

import { ImageRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";

import { handleModelPickerKey } from "./workspace-app-model.ts";
import { WorkspaceApp } from "./workspace-app.tsx";
import type { WorkspaceTui, WorkspaceTab } from "./workspace.ts";

function fakeUi(tab: WorkspaceTab): WorkspaceTui {
  const models = [
    { id: "alpha-id", name: "Alpha" },
    { id: "beta-id", name: "Beta" },
    { id: "beta-pro", name: "Beta Pro" },
  ];
  return {
    tab,
    selected: 0,
    model: "alpha-id",
    modelCatalogStatus: "ready",
    provider: { providerId: "connected-provider", models },
    themeConfig: { colorTheme: "default", symbolPreset: "unicode" },
    projectId: "fixture",
    detail: undefined,
    notice: "Ready",
    modelPicker: undefined,
    items: () => [
      {
        id: `${tab}-record`,
        label: `${tab} record`,
        lines: [`${tab} record detail`, "Status: active"],
        usage: {
          id: "usage-1",
          provider: "connected-provider",
          model: "alpha-id",
          totalTokens: 42,
          inputTokens: 30,
          outputTokens: 12,
          at: "2026-01-01T00:00:00.000Z",
        },
      },
    ],
    session: () => ({
      title: "Test chat",
      model: "alpha-id",
      events: [
        { seq: 1, kind: "user", type: "message", text: "Hello from operator" },
        { seq: 2, kind: "assistant", type: "message", text: "Hello from NOMO" },
      ],
    }),
    workbench: {
      listProjects: () => [
        { id: "fixture", name: "Fixture workspace", root: process.cwd() },
      ],
    },
    providerSummary: () => "Provider connected",
  } as unknown as WorkspaceTui;
}

for (const tab of [
  "overview",
  "chat",
  "sessions",
  "documents",
  "ledger",
  "approvals",
  "policy",
  "tools",
  "models",
  "usage",
  "help",
] as const) {
  test(`OpenTUI composes real ${tab} rows and details`, async () => {
    const setup = await createTestRenderer({ width: 120, height: 32 });
    const ui = fakeUi(tab);
    const root = createRoot(setup.renderer);
    try {
      flushSync(() =>
        root.render(
          createElement(WorkspaceApp, {
            ui,
            input: "",
            editing: true,
            busy: false,
            onKey: () => {},
            onPaste: () => {},
            onTab: () => {},
            onSelect: () => {},
          }),
        ),
      );
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      assert.match(frame, /Fixture workspace/);
      assert.match(frame, new RegExp(tab.toUpperCase()));
      assert.match(frame, /TAB/);
      assert.doesNotMatch(frame, /Press |\\[object Object\\]|raw JSON/);
      if (tab === "chat") {
        assert.match(frame, /Hello from operator/);
        assert.match(frame, /Message NOMO/);
      } else {
        assert.match(frame, new RegExp(`${tab} record|Alpha`));
        assert.match(frame, /Status: active|Model ID: alpha-id/);
      }
    } finally {
      root.unmount();
      await setup.dispose();
    }
  });
}
test("OpenTUI composes a compact narrow-terminal usage screen", async () => {
  const setup = await createTestRenderer({ width: 60, height: 16 });
  const ui = fakeUi("usage");
  const root = createRoot(setup.renderer);
  try {
    flushSync(() =>
      root.render(
        createElement(WorkspaceApp, {
          ui,
          input: "",
          editing: false,
          busy: false,
          onKey: () => {},
          onPaste: () => {},
          onTab: () => {},
          onSelect: () => {},
        }),
      ),
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /Fixture workspace/);
    assert.match(frame, /USAGE/);
    assert.match(frame, /42 tokens/);
    assert.match(frame, /TAB/);
    assert.doesNotMatch(frame, /raw JSON|\\[object Object\\]/);
  } finally {
    root.unmount();
    await setup.dispose();
  }
});
test("OpenTUI does not offer a model menu without a ready provider catalog", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const ui = fakeUi("chat");
  ui.modelCatalogStatus = "unavailable";
  ui.notice = "Connect a provider before choosing a model.";
  ui.modelPicker = {
    open: true,
    query: "",
    selected: 0,
    models: [{ id: "alpha-id", name: "Alpha" }],
  };
  const root = createRoot(setup.renderer);
  try {
    flushSync(() =>
      root.render(
        createElement(WorkspaceApp, {
          ui,
          input: "",
          editing: false,
          busy: false,
          onKey: () => {},
          onPaste: () => {},
          onTab: () => {},
          onSelect: () => {},
        }),
      ),
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.doesNotMatch(frame, /SELECT MODEL|Alpha|alpha-id/);
    assert.match(frame, /Connect a provider/);
  } finally {
    root.unmount();
    await setup.dispose();
  }
});
test("OpenTUI model picker shows only the refreshed connected-provider catalog", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const ui = fakeUi("chat");
  ui.modelPicker = {
    open: true,
    query: "",
    selected: 1,
    models: [
      { id: "alpha-id", name: "Alpha" },
      { id: "beta-id", name: "Beta" },
    ],
  };
  const root = createRoot(setup.renderer);
  try {
    flushSync(() =>
      root.render(
        createElement(WorkspaceApp, {
          ui,
          input: "",
          editing: true,
          busy: false,
          onKey: () => {},
          onPaste: () => {},
          onTab: () => {},
          onSelect: () => {},
        }),
      ),
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /SELECT MODEL/);
    assert.match(frame, /connected-provider/);
    assert.match(frame, /Alpha/);
    assert.match(frame, /alpha-id/);
    assert.match(frame, /Beta/);
    assert.match(frame, /beta-id/);
    assert.doesNotMatch(frame, /foreign-provider/);
  } finally {
    root.unmount();
    await setup.dispose();
  }
});
test("Kitty app renders private icon buffers and the transparent NOMO logo", async () => {
  const setup = await createTestRenderer({ width: 120, height: 32 });
  const ui = fakeUi("overview");
  const tabs = [
    "overview",
    "chat",
    "sessions",
    "documents",
    "ledger",
    "approvals",
    "policy",
    "tools",
    "models",
    "usage",
    "help",
  ] as const;
  const iconBuffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/3b8AAAAASUVORK5CYII=",
    "base64",
  );
  const iconSet = (base: number) =>
    Object.fromEntries(
      tabs.map((tab, index) => [tab, { id: base + index, png: iconBuffer }]),
    );
  Object.assign(ui, {
    themeConfig: { symbolPreset: "icons", colorTheme: "default" },
    localTabIcons: { dark: iconSet(100), light: iconSet(200) },
  });
  const root = createRoot(setup.renderer);
  try {
    flushSync(() =>
      root.render(
        createElement(WorkspaceApp, {
          ui,
          input: "",
          editing: false,
          busy: false,
          graphicsProtocol: "kitty",
          onKey: () => {},
          onPaste: () => {},
          onTab: () => {},
          onSelect: () => {},
        }),
      ),
    );
    await setup.renderOnce();
    const walk = (node: Renderable): Renderable[] => [
      node,
      ...node.getChildren().flatMap((child) => walk(child as Renderable)),
    ];
    const images = walk(setup.renderer.root).filter(
      (node): node is ImageRenderable => node instanceof ImageRenderable,
    );
    assert.equal(
      images.filter((image) => image.source === iconBuffer).length,
      tabs.length,
    );
    assert.ok(images.every((image) => image.effectiveProtocol === "kitty"));
    const logo = images.find((image) => image.source instanceof URL);
    assert.ok(logo?.source instanceof URL);
    assert.ok(logo.source.pathname.endsWith("/nomo-logo.png"));
    const logoPng = readFileSync(logo.source);
    assert.deepEqual(
      [...logoPng.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    assert.equal(logoPng.readUInt32BE(16), 320);
    assert.equal(logoPng.readUInt32BE(20), 315);
    assert.equal(
      logoPng[25],
      6,
      "the standalone NOMO mark keeps alpha transparency",
    );
    const background = setup.renderer.root.getChildren()[0] as unknown as {
      backgroundColor: { buffer: ArrayLike<number> };
    };
    assert.deepEqual(
      Array.from(background.backgroundColor.buffer),
      [0, 0, 0, 0],
    );
  } finally {
    root.unmount();
    await setup.dispose();
  }
});

test("rendered model picker filters, moves, selects and cancels through useKeyboard", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const ui = fakeUi("chat");
  ui.modelPicker = {
    open: true,
    query: "",
    selected: 0,
    models: [
      { id: "beta-id", name: "Beta" },
      { id: "beta-pro", name: "Beta Pro" },
      { id: "alpha-id", name: "Alpha" },
    ],
  };
  const selected: string[] = [];
  const actions: string[] = [];
  const closeModelPicker = () => {
    ui.modelPicker = undefined;
  };
  Object.assign(ui, {
    closeModelPicker,
    selectModel: async (modelId: string) => {
      actions.push(`selected:${modelId}`);
      ui.model = modelId;
      closeModelPicker();
    },
  });
  const root = createRoot(setup.renderer);
  const draw = () =>
    flushSync(() =>
      root.render(
        createElement(WorkspaceApp, {
          ui,
          input: "",
          editing: false,
          busy: false,
          onKey: async (event) => {
            const result = handleModelPickerKey(
              ui,
              event.name?.length === 1 ? event.name : undefined,
              event,
            );
            if (typeof result === "string") {
              selected.push(result);
              await ui.selectModel(result);
            }
            draw();
          },
          onPaste: () => {},
          onTab: () => {},
          onSelect: () => {},
        }),
      ),
    );
  try {
    draw();
    await setup.renderOnce();
    setup.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await setup.renderOnce();
    assert.equal(ui.modelPicker, undefined);
    ui.modelPicker = {
      open: true,
      query: "",
      selected: 0,
      models: [
        { id: "beta-id", name: "Beta" },
        { id: "beta-pro", name: "Beta Pro" },
        { id: "alpha-id", name: "Alpha" },
      ],
    };
    draw();
    await setup.renderOnce();
    await setup.mockInput.typeText("beta");
    await setup.renderOnce();
    let frame = setup.captureCharFrame();
    assert.match(frame, /Beta Pro/);
    assert.doesNotMatch(frame, /Alpha/);
    setup.mockInput.pressArrow("down");
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert.match(frame, /› Beta Pro/);
    setup.resize(60, 16);
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert.match(frame, /SELECT MODEL/);
    setup.mockInput.pressEnter();
    await setup.renderOnce();
    assert.deepEqual(selected, ["beta-pro"]);
    assert.deepEqual(actions, ["selected:beta-pro"]);
    assert.equal(ui.model, "beta-pro");
    assert.equal(ui.modelPicker, undefined);
  } finally {
    root.unmount();
    await setup.dispose();
  }
});

test("rendered keyboard, mouse navigation and paste dispatch to workspace handlers", async () => {
  const setup = await createTestRenderer({
    width: 120,
    height: 32,
    useMouse: true,
  });
  const ui = fakeUi("overview");
  const keys: string[] = [];
  const tabs: WorkspaceTab[] = [];
  const selected: number[] = [];
  const pasted: string[] = [];
  const root = createRoot(setup.renderer);
  try {
    flushSync(() =>
      root.render(
        createElement(WorkspaceApp, {
          ui,
          input: "",
          editing: true,
          busy: false,
          onKey: (event) => keys.push(event.name),
          onPaste: (text) => pasted.push(text),
          onTab: (tab) => tabs.push(tab),
          onSelect: (index) => selected.push(index),
        }),
      ),
    );
    await setup.renderOnce();
    const lines = setup.captureCharFrame().split("\n");
    const navRow = lines.findIndex(
      (line) => line.includes("OVERVIEW") && line.includes("CHAT"),
    );
    assert.notEqual(navRow, -1);
    await setup.mockMouse.click(lines[navRow]!.indexOf("CHAT"), navRow);
    await setup.renderOnce();
    const recordRow = lines.findIndex(
      (line) => line.includes("overview record") && !line.includes("detail"),
    );
    assert.notEqual(recordRow, -1);
    await setup.mockMouse.click(
      lines[recordRow]!.indexOf("overview record"),
      recordRow,
    );
    await setup.renderOnce();
    setup.mockInput.pressTab();
    await setup.mockInput.pasteBracketedText("pasted prompt");
    assert.deepEqual(tabs, ["chat"]);
    assert.deepEqual(selected, [0]);
    assert.ok(keys.includes("tab"));
    assert.deepEqual(pasted, ["pasted prompt"]);
  } finally {
    root.unmount();
    await setup.dispose();
  }
});

test("every workspace view stays inside a 40 by 12 terminal", async () => {
  for (const tab of [
    "overview",
    "chat",
    "sessions",
    "documents",
    "ledger",
    "approvals",
    "policy",
    "tools",
    "models",
    "usage",
    "help",
  ] as const) {
    const setup = await createTestRenderer({ width: 40, height: 12 });
    const root = createRoot(setup.renderer);
    try {
      flushSync(() =>
        root.render(
          createElement(WorkspaceApp, {
            ui: fakeUi(tab),
            input: "",
            editing: false,
            busy: false,
            color: false,
            onKey: () => {},
            onPaste: () => {},
            onTab: () => {},
            onSelect: () => {},
          }),
        ),
      );
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      assert.ok(
        frame.split("\n").length <= 13,
        `${tab} stays within the viewport plus capture terminator`,
      );
      assert.ok(
        frame.split("\n").every((line) => [...line].length <= 40),
        `${tab} stays within 40 columns`,
      );
      assert.match(
        frame,
        new RegExp(
          tab === "overview" ? "OVERVIEW|overview" : tab.toUpperCase(),
        ),
      );
    } finally {
      root.unmount();
      await setup.dispose();
    }
  }
});

test("model picker remains usable at 40 columns and 12 rows", async () => {
  const setup = await createTestRenderer({ width: 40, height: 12 });
  const ui = fakeUi("chat");
  ui.modelPicker = {
    open: true,
    query: "",
    selected: 1,
    models: [
      { id: "alpha-id", name: "Alpha" },
      { id: "beta-id", name: "Beta" },
    ],
  };
  const root = createRoot(setup.renderer);
  try {
    flushSync(() =>
      root.render(
        createElement(WorkspaceApp, {
          ui,
          input: "",
          editing: false,
          busy: false,
          onKey: () => {},
          onPaste: () => {},
          onTab: () => {},
          onSelect: () => {},
        }),
      ),
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /SELECT MODEL/);
    assert.match(frame, /Beta/);
    assert.match(frame, /Enter choose/);
    assert.ok(frame.split("\n").length >= 12);
  } finally {
    root.unmount();
    await setup.dispose();
  }
});

test("monochrome OpenTUI keeps labels, selected state, and model controls readable", async () => {
  const setup = await createTestRenderer({ width: 40, height: 12 });
  const ui = fakeUi("models");
  const root = createRoot(setup.renderer);
  try {
    flushSync(() =>
      root.render(
        createElement(WorkspaceApp, {
          ui,
          input: "",
          editing: false,
          busy: false,
          color: false,
          onKey: () => {},
          onPaste: () => {},
          onTab: () => {},
          onSelect: () => {},
        }),
      ),
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /MODELS/);
    assert.match(frame, /M/);
    assert.match(frame, /Alpha/);
    assert.match(frame, /Provider|Model ID/);
    assert.match(frame, /TAB/);
  } finally {
    root.unmount();
    await setup.dispose();
  }
});

test("rendered list and inspector switch from side-by-side to stacked at 120 columns", async () => {
  const setup = await createTestRenderer({ width: 120, height: 24 });
  const ui = fakeUi("sessions");
  const root = createRoot(setup.renderer);
  const render = () =>
    flushSync(() =>
      root.render(
        createElement(WorkspaceApp, {
          ui,
          input: "",
          editing: false,
          busy: false,
          onKey: () => {},
          onPaste: () => {},
          onTab: () => {},
          onSelect: () => {},
        }),
      ),
    );
  try {
    render();
    await setup.renderOnce();
    const wideLines = setup.captureCharFrame().split("\n");
    const wideList = wideLines.findIndex((line) =>
      line.includes("SESSIONS · 1"),
    );
    const wideInspector = wideLines.findIndex((line) =>
      line.includes("Selected record"),
    );
    assert.equal(wideList, wideInspector);
    setup.resize(119, 24);
    await setup.renderOnce();
    const narrowLines = setup.captureCharFrame().split("\n");
    const narrowList = narrowLines.findIndex((line) =>
      line.includes("SESSIONS · 1"),
    );
    const narrowInspector = narrowLines.findIndex((line) =>
      line.includes("Selected record"),
    );
    assert.notEqual(narrowList, narrowInspector);
  } finally {
    root.unmount();
    await setup.dispose();
  }
});
