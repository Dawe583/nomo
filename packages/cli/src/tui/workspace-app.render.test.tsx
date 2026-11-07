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
import { visibleLength } from "./layout.ts";
import { getSymbols } from "./theme.ts";
import type { SessionEvent } from "../../../workbench/src/index.ts";

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
        assert.match(frame, /CONVERSATION/);
        assert.match(frame, /PROMPT/);
      } else if (tab === "models") {
        assert.match(frame, /Alpha/);
        assert.match(frame, /Provider|Model ID: alpha-id/);
        assert.doesNotMatch(frame, /› Alpha/);
      } else {
        assert.ok(
          frame.includes(
            `${getSymbols(ui.themeConfig.symbolPreset).arrow.right} ${tab}`,
          ),
          `${tab} marks the selected item without relying on color`,
        );
        assert.doesNotMatch(frame, /│ ╭/, `${tab} list rows stay unboxed`);
        assert.match(frame, /Status: active/);
        assert.match(frame, /DETAILS/);
      }
    } finally {
      root.unmount();
      await setup.dispose();
    }
  });
}
test("every active navigation tab has a visible monochrome marker", async () => {
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
  for (const tab of tabs) {
    const setup = await createTestRenderer({ width: 120, height: 40 });
    const ui = fakeUi(tab);
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
      assert.ok(
        setup
          .captureCharFrame()
          .includes(
            `${getSymbols(ui.themeConfig.symbolPreset).arrow.right} ${tab.toUpperCase()}`,
          ),
        `${tab} active navigation is visible without color`,
      );
    } finally {
      root.unmount();
      await setup.dispose();
    }
  }
});
test("non-model empty views use real empty titles and applicable detail context", async () => {
  const emptyViews = [
    ["overview", "No recent activity"],
    ["sessions", "No conversations yet"],
    ["documents", "No workspace documents"],
    ["ledger", "No activity to review"],
    ["approvals", "No pending approvals"],
    ["policy", "No connected policies"],
    ["tools", "No tools available"],
    ["usage", "No usage recorded"],
    ["help", "Help is ready"],
  ] as const;
  for (const [tab, emptyTitle] of emptyViews) {
    const setup = await createTestRenderer({ width: 120, height: 32 });
    const ui = fakeUi(tab);
    ui.items = () => [];
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
      assert.ok(frame.includes(emptyTitle), `${tab} uses its real empty title`);
      if (tab !== "usage") {
        assert.ok(
          frame.includes("DETAILS"),
          `${tab} identifies the detail section in monochrome`,
        );
        assert.match(frame, /Select a record to inspect its details/);
      }
    } finally {
      root.unmount();
      await setup.dispose();
    }
  }
});

test("chat empty state keeps its real prompt available", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const ui = fakeUi("chat");
  ui.session = () => ({
    id: "empty-conversation",
    workspace: "fixture",
    title: "Empty conversation",
    model: "alpha-id",
    status: "idle",
    events: [],
    continuationCount: 0,
    runTokenCount: 0,
  });
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
    assert.match(frame, /CONVERSATION · Empty conversation/);
    assert.match(frame, /No messages yet/);
    assert.match(frame, /PROMPT/);
  } finally {
    root.unmount();
    await setup.dispose();
  }
});

test("chat with no selected session shows its new-conversation prompt in monochrome", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const ui = fakeUi("chat");
  ui.session = () => undefined;
  const root = createRoot(setup.renderer);
  try {
    flushSync(() =>
      root.render(
        createElement(WorkspaceApp, {
          ui,
          input: "",
          editing: true,
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
    assert.match(frame, /CONVERSATION · New conversation/);
    assert.match(frame, /No messages yet\. Write a prompt to start a conversation\./);
    assert.ok(
      frame.includes(
        `PROMPT  ${getSymbols(ui.themeConfig.symbolPreset).arrow.right}  Message NOMO…`,
      ),
    );
  } finally {
    root.unmount();
    await setup.dispose();
  }
});
test("chat tool-result rows use one clear role label", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const ui = fakeUi("chat");
  ui.session = () => ({
    id: "tool-run",
    workspace: "fixture",
    title: "Tool run",
    model: "alpha-id",
    status: "idle",
    events: [
      {
        seq: 3,
        at: "2026-01-01T00:00:03.000Z",
        kind: "tool",
        type: "tool.result",
        text: "Found 2 records",
      },
    ],
    continuationCount: 0,
    runTokenCount: 0,
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
    assert.match(frame, /TOOL RESULT/);
    assert.doesNotMatch(frame, /TOOL\s+TOOL RESULT/);
    assert.match(frame, /Found 2 records/);
  } finally {
    root.unmount();
    await setup.dispose();
  }
});
test("chat identifies mixed transcript roles and busy or idle status in both color modes", async () => {
  const ui = fakeUi("chat");
  ui.session = () => ({
    id: "mixed-transcript",
    workspace: "fixture",
    title: "Mixed transcript",
    model: "alpha-id",
    status: "idle",
    events: [
      {
        seq: 1,
        at: "2026-01-01T00:00:01.000Z",
        kind: "user",
        type: "message",
        text: "User message",
      },
      {
        seq: 2,
        at: "2026-01-01T00:00:02.000Z",
        kind: "assistant",
        type: "message",
        text: "Assistant response",
      },
      {
        seq: 3,
        at: "2026-01-01T00:00:03.000Z",
        kind: "tool",
        type: "tool.call",
        text: "Search records",
      },
      {
        seq: 4,
        at: "2026-01-01T00:00:04.000Z",
        kind: "tool",
        type: "tool.result",
        text: "Found 2 records",
      },
    ],
    continuationCount: 0,
    runTokenCount: 0,
  });
  for (const color of [false, true]) {
    for (const busy of [false, true]) {
      const setup = await createTestRenderer({ width: 80, height: 60 });
      const root = createRoot(setup.renderer);
      try {
        flushSync(() =>
          root.render(
            createElement(WorkspaceApp, {
              ui,
              input: "",
              editing: false,
              busy,
              color,
              onKey: () => {},
              onPaste: () => {},
              onTab: () => {},
              onSelect: () => {},
            }),
          ),
        );
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        assert.match(frame, /YOU/);
        assert.match(frame, /User message/);
        assert.match(frame, /NOMO/);
        assert.match(frame, /Assistant response/);
        assert.match(frame, /TOOL/);
        assert.match(frame, /Search records/);
        assert.match(frame, /TOOL RESULT/);
        assert.match(frame, /Found 2 records/);
        assert.doesNotMatch(frame, /TOOL\s+TOOL RESULT/);
        assert.match(
          frame,
          busy
            ? /NOMO is working\. Esc stops the active run\./
            : /alpha-id · Enter sends · Alt\+Enter adds a line/,
        );
      } finally {
        root.unmount();
        await setup.dispose();
      }
    }
  }
});




test("chat keeps an in-progress stream visible and replaces it with completed text", async () => {
  const setup = await createTestRenderer({ width: 120, height: 32 });
  const ui = fakeUi("chat");
  const deltaEvents: readonly SessionEvent[] = [
    Object.freeze({
      seq: 1,
      at: "2026-01-01T00:00:00.000Z",
      kind: "assistant",
      type: "message.delta",
      text: "Hel",
    }),
    Object.freeze({
      seq: 2,
      at: "2026-01-01T00:00:00.250Z",
      kind: "assistant",
      type: "message.delta",
      text: "lo",
    }),
  ];
  const completedEvent: SessionEvent = Object.freeze({
    seq: 3,
    at: "2026-01-01T00:00:01.000Z",
    kind: "assistant",
    type: "message.completed",
    text: "Hello world",
  });
  let events: readonly SessionEvent[] = deltaEvents;
  ui.session = () => ({
    id: "streaming-chat",
    workspace: "fixture",
    title: "Streaming transcript",
    model: "alpha-id",
    status: "running",
    events,
    continuationCount: 0,
    runTokenCount: 0,
  });
  const root = createRoot(setup.renderer);
  const render = () =>
    createElement(WorkspaceApp, {
      ui,
      input: "",
      editing: false,
      busy: true,
      color: false,
      onKey: () => {},
      onPaste: () => {},
      onTab: () => {},
      onSelect: () => {},
    });
  try {
    flushSync(() => root.render(render()));
    await setup.renderOnce();
    const streamingFrame = setup.captureCharFrame();
    assert.match(streamingFrame, /NOMO \[stream\]/);
    assert.match(streamingFrame, /Hello/);
    assert.equal(streamingFrame.match(/Hello/g)?.length, 1);

    events = [...deltaEvents, completedEvent];
    flushSync(() => root.render(render()));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /Hello world/);
    assert.equal(frame.match(/Hello/g)?.length, 1);
    assert.doesNotMatch(frame, /NOMO \[stream\]/);
    assert.deepEqual(
      deltaEvents.map((event) => event.text),
      ["Hel", "lo"],
    );
  } finally {
    root.unmount();
    await setup.dispose();
  }
});

test("chat shows a failed session error event in monochrome", async () => {
  const setup = await createTestRenderer({ width: 120, height: 32 });
  const ui = fakeUi("chat");
  const failure: SessionEvent = {
    seq: 1,
    at: "2026-01-01T00:00:00.000Z",
    kind: "error",
    type: "run.error",
    text: "Provider request failed",
  };
  ui.session = () => ({
    id: "failed-chat",
    workspace: "fixture",
    title: "Failed conversation",
    model: "alpha-id",
    status: "failed",
    events: [failure],
    continuationCount: 0,
    runTokenCount: 0,
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
    assert.equal(frame.match(/ERROR/g)?.length, 1);
    assert.match(frame, /Provider request failed/);
  } finally {
    root.unmount();
    await setup.dispose();
  }
});

test("chat view pages through older transcript rows and returns to live follow", async () => {
  const setup = await createTestRenderer({ width: 120, height: 32 });
  const ui = fakeUi("chat");
  ui.session = () => ({
    id: "long-chat",
    workspace: "fixture",
    status: "idle",
    continuationCount: 0,
    runTokenCount: 0,
    title: "Long chat",
    model: "alpha-id",
    events: Array.from({ length: 24 }, (_, index) => ({
      seq: index + 1,
      kind: index % 2 ? "assistant" : "user",
      type: "message",
      at: "2026-01-01T00:00:00.000Z",
      text: `transcript-row-${index + 1}`,
    })),
  });
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
    assert.match(setup.captureCharFrame(), /transcript-row-24/);
    assert.deepEqual(ui.viewport, { offset: 18, height: 6, total: 24 });
    ui.scroll = Math.max(0, ui.viewport.offset - (ui.viewport.height - 2));
    render();
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /transcript-row-15/);
    assert.doesNotMatch(setup.captureCharFrame(), /transcript-row-24/);
    ui.scroll = -1;
    render();
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /transcript-row-24/);
  } finally {
    root.unmount();
    await setup.dispose();
  }
});

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

test("OpenTUI model picker keeps the connected provider visible for an empty search in monochrome", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const ui = fakeUi("chat");
  ui.modelPicker = {
    open: true,
    query: "no-match",
    selected: 0,
    models: ui.provider?.models ?? [],
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
    assert.match(frame, /SELECT MODEL · connected-provider/);
    assert.match(frame, /Search: no-match/);
    assert.match(frame, /No models match this search\./);
    assert.match(frame, /↑↓ move · Enter choose · Esc cancel/);
    assert.doesNotMatch(frame, /Alpha|Beta|foreign-provider/);
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
    themeConfig: { symbolPreset: "unicode", colorTheme: "default" },
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
    assert.ok(
      frame.includes(
        `${getSymbols(ui.themeConfig.symbolPreset).arrow.right} Beta Pro`,
      ),
    );
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
    const updatedLines = setup.captureCharFrame().split("\n");
    const recordRow = updatedLines.findIndex((line) =>
      line.includes(
        `${getSymbols(ui.themeConfig.symbolPreset).arrow.right} overview record`,
      ),
    );
    assert.notEqual(recordRow, -1);
    await setup.mockMouse.click(
      updatedLines[recordRow]!.indexOf(
        `${getSymbols(ui.themeConfig.symbolPreset).arrow.right} overview record`,
      ),
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

test("all workspace views stay bounded in the full viewport and color matrix", async () => {
  const viewports = [
    [40, 12],
    [80, 24],
    [120, 40],
    [200, 48],
  ] as const;
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
  for (const [width, height] of viewports) {
    for (const color of [false, true]) {
      for (const tab of tabs) {
        const setup = await createTestRenderer({ width, height });
        const root = createRoot(setup.renderer);
        try {
          flushSync(() =>
            root.render(
              createElement(WorkspaceApp, {
                ui: fakeUi(tab),
                input: "",
                editing: tab === "chat",
                busy: false,
                color,
                onKey: () => {},
                onPaste: () => {},
                onTab: () => {},
                onSelect: () => {},
              }),
            ),
          );
          await setup.renderOnce();
          const frame = setup.captureCharFrame();
          const lines = frame.split("\n");
          if (lines.at(-1) === "") lines.pop();
          assert.ok(
            lines.length <= height,
            `${tab} ${width}x${height} row bound`,
          );
          assert.ok(
            lines.every((line) => visibleLength(line) <= width),
            `${tab} ${width}x${height} terminal-cell column bound`,
          );
          assert.match(
            lines.join("\n"),
            new RegExp(
              tab === "overview" ? "OVERVIEW|overview" : tab.toUpperCase(),
            ),
          );
        } finally {
          root.unmount();
          await setup.dispose();
        }
      }
    }
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
      line.includes("DETAILS"),
    );
    assert.equal(wideList, wideInspector);
    setup.resize(119, 24);
    await setup.renderOnce();
    const narrowLines = setup.captureCharFrame().split("\n");
    const narrowList = narrowLines.findIndex((line) =>
      line.includes("SESSIONS · 1"),
    );
    const narrowInspector = narrowLines.findIndex((line) =>
      line.includes("DETAILS"),
    );
    assert.notEqual(narrowList, narrowInspector);
  } finally {
    root.unmount();
    await setup.dispose();
  }
});

test("ASCII preset uses its arrow for navigation, list selection, and chat prompt", async () => {
  const setup = await createTestRenderer({
    width: 120,
    height: 32,
    useMouse: true,
  });
  const ui = fakeUi("overview");
  ui.themeConfig = { ...ui.themeConfig, symbolPreset: "ascii" };
  const tabs: WorkspaceTab[] = [];
  const selected: number[] = [];
  const root = createRoot(setup.renderer);
  const render = () =>
    flushSync(() =>
      root.render(
        createElement(WorkspaceApp, {
          ui,
          input: "",
          editing: true,
          busy: false,
          color: false,
          onKey: () => {},
          onPaste: () => {},
          onTab: (tab) => {
            tabs.push(tab);
            ui.tab = tab;
          },
          onSelect: (index) => {
            selected.push(index);
            ui.selected = index;
          },
        }),
      ),
    );
  try {
    const arrow = getSymbols(ui.themeConfig.symbolPreset).arrow.right;
    assert.equal(arrow, ">");
    render();
    await setup.renderOnce();
    let frame = setup.captureCharFrame();
    assert.ok(frame.includes(`${arrow} OVERVIEW`));
    assert.ok(frame.includes(`${arrow} overview record`));

    let lines = frame.split("\n");
    const recordRow = lines.findIndex((line) =>
      line.includes(`${arrow} overview record`),
    );
    assert.notEqual(recordRow, -1);
    await setup.mockMouse.click(
      lines[recordRow]!.indexOf(`${arrow} overview record`),
      recordRow,
    );
    await setup.renderOnce();
    assert.deepEqual(selected, [0]);

    lines = setup.captureCharFrame().split("\n");
    const navRow = lines.findIndex(
      (line) => line.includes("OVERVIEW") && line.includes("CHAT"),
    );
    assert.notEqual(navRow, -1);
    await setup.mockMouse.click(lines[navRow]!.indexOf("CHAT"), navRow);
    await setup.renderOnce();
    assert.deepEqual(tabs, ["chat"]);
    render();
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert.ok(frame.includes(`${arrow} CHAT`));
    assert.ok(frame.includes(`PROMPT  ${arrow}  Message NOMO`));
  } finally {
    root.unmount();
    await setup.dispose();
  }
});

test("ASCII preset uses its arrow for model-picker and usage selection", async () => {
  const arrow = getSymbols("ascii").arrow.right;
  assert.equal(arrow, ">");

  const pickerSetup = await createTestRenderer({ width: 120, height: 32 });
  const pickerUi = fakeUi("chat");
  pickerUi.themeConfig = { ...pickerUi.themeConfig, symbolPreset: "ascii" };
  pickerUi.modelPicker = {
    open: true,
    query: "",
    selected: 1,
    models: [
      { id: "alpha-id", name: "Alpha" },
      { id: "beta-id", name: "Beta" },
    ],
  };
  const pickerRoot = createRoot(pickerSetup.renderer);
  try {
    flushSync(() =>
      pickerRoot.render(
        createElement(WorkspaceApp, {
          ui: pickerUi,
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
    await pickerSetup.renderOnce();
    assert.ok(
      pickerSetup.captureCharFrame().includes(`${arrow} Beta · beta-id`),
    );
  } finally {
    pickerRoot.unmount();
    await pickerSetup.dispose();
  }

  const usageSetup = await createTestRenderer({ width: 120, height: 32 });
  const usageUi = fakeUi("usage");
  usageUi.themeConfig = { ...usageUi.themeConfig, symbolPreset: "ascii" };
  const usageRoot = createRoot(usageSetup.renderer);
  try {
    flushSync(() =>
      usageRoot.render(
        createElement(WorkspaceApp, {
          ui: usageUi,
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
    await usageSetup.renderOnce();
    assert.ok(
      usageSetup
        .captureCharFrame()
        .includes(`${arrow} 2026-01-01T00:00:00.000Z`),
    );
  } finally {
    usageRoot.unmount();
    await usageSetup.dispose();
  }
});
