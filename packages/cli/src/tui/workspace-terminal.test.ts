import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Workbench } from "../../../workbench/src/index.ts";
import {
  WORKSPACE_TABS,
  WorkspaceTui,
  renderWorkspace,
} from "./workspace.ts";
import { createWorkspaceTerminal, type WorkspaceMouseEvent } from "./workspace-terminal.ts";
import { applyWorkspaceWheel, workspaceHitAt } from "./workspace-runner.ts";

const exec = promisify(execFile);
const binary = fileURLToPath(new URL("../../bin/nomo.mjs", import.meta.url));
const checkoutLauncher = fileURLToPath(
  new URL("../../../../nomo", import.meta.url),
);

test("root help succeeds without opening workspace data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-terminal-help-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await exec(process.execPath, [binary, "--help"], {
    env: { PATH: process.env.PATH, HOME: root, NOMO_DATA_DIR: root },
  });
  assert.deepEqual(await readdir(root), []);
  assert.match(result.stdout, /usage: nomo/);
  assert.match(result.stdout, /recovery/);
  assert.equal(result.stderr, "");
});

test("version prints without opening workspace data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-terminal-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await exec(process.execPath, [binary, "--version"], {
    env: { PATH: process.env.PATH, HOME: root, NOMO_DATA_DIR: root },
  });
  assert.deepEqual(await readdir(root), []);
  assert.match(result.stdout, /^nomo \d+\.\d+\.\d+\n$/);
  assert.equal(result.stderr, "");
});

test("bare nomo and TUI flags open the real workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-terminal-default-tui-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bare = await exec(process.execPath, [binary], {
    env: { PATH: process.env.PATH, HOME: root, NOMO_DATA_DIR: root },
  });
  assert.match(bare.stdout, /NOMO {2}Chat/);
  assert.match(bare.stdout, /NEW CONVERSATION/);
  assert.doesNotMatch(bare.stdout, /usage: nomo/);
  const result = await exec(
    process.execPath,
    [binary, "--once", "--view", "runs"],
    {
      env: { PATH: process.env.PATH, HOME: root, NOMO_DATA_DIR: root },
    },
  );
  // The runs panel leads with the panel title and how many runs it recorded.
  assert.match(result.stdout, /▶ RUNS · 0 recorded/);
  assert.doesNotMatch(result.stdout, /usage: nomo/);
  assert.equal(result.stderr, "");
});

test("checkout launcher exposes the same bare nomo command on POSIX", async (t) => {
  if (process.platform === "win32") {
    t.skip("the POSIX launcher is not used on Windows");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "nomo-checkout-launcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // The launcher reports the package version, so read it from the manifest
  // instead of pinning a release number the checkout no longer carries.
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  const result = await exec(checkoutLauncher, ["--version"], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root },
  });
  assert.equal(result.stdout, `nomo ${manifest.version}\n`);
  assert.equal(result.stderr, "");
  const tui = await exec(
    checkoutLauncher,
    ["--once", "--view", "runs"],
    {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root, NOMO_DATA_DIR: root },
    },
  );
  assert.match(tui.stdout, /▶ RUNS · 0 recorded/);
  assert.doesNotMatch(tui.stdout, /usage: nomo/);
});

test("one-shot TUI exits unsuccessfully for a corrupt proxy ledger", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-terminal-proof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "ledger"));
  await writeFile(join(root, "ledger", "broken.jsonl"), "not JSON\n");
  await assert.rejects(
    exec(process.execPath, [binary, "tui", "--once", "--view", "ledger"], {
      env: { PATH: process.env.PATH, HOME: root, NOMO_DATA_DIR: root },
    }),
    (error: unknown) => {
      const result = error as { code: number; stdout: string };
      assert.equal(result.code, 1);
      assert.match(result.stdout, /Invalid proxy ledger: broken.jsonl/);
      assert.doesNotMatch(result.stdout, /\x1b/);
      return true;
    },
  );
});

test("shared runs view is available in plain one-shot output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-terminal-runs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await exec(
    process.execPath,
    [binary, "tui", "--once", "--view", "runs"],
    {
      env: { PATH: process.env.PATH, HOME: root, NOMO_DATA_DIR: root },
    },
  );
  // The runs panel leads with its own title and the honest record count, then
  // states that the provider still needs setup. Plain output stays plain.
  assert.match(result.stdout, /▶ RUNS · 0 recorded/);
  assert.match(result.stdout, /No runs in this conversation\./);
  assert.match(result.stdout, /Provider unknown \| setup-required/);
  assert.doesNotMatch(result.stdout, /\x1b/);
});


test("SGR mouse decoding carries wheel, click, release and motion events", async () => {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (enabled: boolean) => {
    input.isRaw = enabled;
    return input;
  };
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  const events: WorkspaceMouseEvent[] = [];
  const terminal = createWorkspaceTerminal(input, output);
  terminal.start(
    () => {},
    () => {},
    undefined,
    (event) => events.push(event),
  );
  input.write("\x1b[<64;10;5M\x1b[<65;10;5M\x1b[<0;12;6M\x1b[<32;13;6M\x1b[<0;13;6m");
  await new Promise((resolve) => setImmediate(resolve));
  terminal.destroy();
  assert.deepEqual(events, [
    { button: 64, x: 10, y: 5, pressed: true, motion: false },
    { button: 65, x: 10, y: 5, pressed: true, motion: false },
    { button: 0, x: 12, y: 6, pressed: true, motion: false },
    { button: 32, x: 13, y: 6, pressed: true, motion: true },
    { button: 0, x: 13, y: 6, pressed: false, motion: false },
  ]);
});

test("hit targets exist on every panel and rebuild inside the resized frame", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-mouse-hit-resize-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  for (const tab of WORKSPACE_TABS) {
    ui.choose(tab);
    ui.detail = undefined;
    ui.settingsOpen = false;
    ui.modelPicker = undefined;
    for (const [width, height] of [
      [80, 24],
      [40, 12],
    ] as const) {
      renderWorkspace(ui, width, height, "", false, false, {
        color: false,
        motion: false,
      });
      const expectedTab = tab === "chat" ? "sessions" : "chat";
      const tabTarget = ui.tabHitTargets.find((target) => target.tab === expectedTab);
      assert.ok(tabTarget, `${tab} ${width}x${height} lost its click tab target`);
      for (const target of [...ui.tabHitTargets, ...ui.rowHitTargets]) {
        assert.ok(target.row >= 1 && target.row <= height, `${tab} target row outside ${height}`);
        assert.ok(target.start >= 1 && target.start <= target.end && target.end <= width, `${tab} target columns outside ${width}`);
        const hit = workspaceHitAt(ui, target.start, target.row);
        if (ui.tabHitTargets.includes(target as never))
          assert.equal(hit.tabTarget, target);
        else assert.equal(hit.rowTarget, target);
      }
    }
  }
});

test("the shared wheel handler reaches every panel without leaving bounds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-mouse-wheel-panels-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  for (const tab of WORKSPACE_TABS) {
    ui.choose(tab);
    ui.detail = undefined;
    ui.settingsOpen = false;
    ui.modelPicker = undefined;
    ui.groupTree = undefined;
    ui.selected = 0;
    ui.scroll = 0;
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
    });
    assert.equal(applyWorkspaceWheel(ui, 1), true, `${tab} ignored wheel down`);
    const itemCount = ui.items().length;
    assert.ok(ui.selected >= 0 && ui.selected <= Math.max(0, itemCount - 1));
    assert.ok(ui.scroll >= -1);
    assert.equal(applyWorkspaceWheel(ui, -1), true, `${tab} ignored wheel up`);
    assert.ok(ui.selected >= 0 && ui.selected <= Math.max(0, itemCount - 1));
    assert.ok(ui.scroll >= -1);
  }
});

test("hit resolution covers every row kind the mouse runner can activate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-mouse-row-kinds-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.rowHitTargets = [
    { row: 2, start: 2, end: 20, kind: "item", index: 0 },
    { row: 3, start: 2, end: 20, kind: "tree", index: 0 },
    { row: 4, start: 2, end: 20, kind: "provider", index: 0 },
    { row: 5, start: 2, end: 20, kind: "model", index: 0 },
    { row: 6, start: 2, end: 20, kind: "setting", index: 0 },
    { row: 7, start: 2, end: 20, kind: "chip", index: 0, action: "usage" },
    { row: 8, start: 2, end: 20, kind: "toast", index: 0 },
  ];
  for (const target of ui.rowHitTargets)
    assert.equal(workspaceHitAt(ui, target.start, target.row).rowTarget, target);
  assert.equal(workspaceHitAt(ui, 21, 2).rowTarget, undefined);
});

test("the shared wheel handler moves list, detail, chat, settings and picker surfaces", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-mouse-wheel-surfaces-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });

  ui.choose("tools");
  const before = ui.selected;
  applyWorkspaceWheel(ui, 1);
  assert.equal(ui.selected, Math.min(1, Math.max(0, ui.items().length - 1)));
  assert.notEqual(ui.items().length, 0);
  assert.ok(ui.selected >= before);

  ui.detail = ["detail"];
  ui.scroll = 0;
  applyWorkspaceWheel(ui, 1);
  assert.equal(ui.scroll, 3);
  applyWorkspaceWheel(ui, -1);
  assert.equal(ui.scroll, 0);

  ui.detail = undefined;
  ui.choose("chat");
  ui.viewport = { ...ui.viewport, offset: 0, height: 5, total: 20 };
  ui.scroll = 0;
  applyWorkspaceWheel(ui, 1);
  assert.equal(ui.scroll, 3);

  ui.refreshSettingsPanel();
  ui.settingsSelected = 0;
  applyWorkspaceWheel(ui, 1);
  assert.equal(ui.settingsSelected, Math.min(3, ui.visibleSettingsControls().length - 1));

  ui.modelPicker = {
    open: true,
    origin: "chat",
    selection: "default",
    providers: [
      { id: "p1", name: "p1", attached: true, catalogStatus: "ready" },
    ],
    query: "",
    cursor: 0,
    selected: 0,
    providerIndex: 0,
    providerId: "p1",
    focusedPane: "models",
    catalogStatus: "ready",
    models: Array.from({ length: 20 }, (_, index) => ({
      id: `m${index}`,
      name: `m${index}`,
    })),
  };
  ui.viewport = { ...ui.viewport, width: 80, height: 5 };
  applyWorkspaceWheel(ui, 1, 10);
  assert.equal(ui.modelPicker.modelWindowStart, 1);
  applyWorkspaceWheel(ui, -1, 10);
  assert.equal(ui.modelPicker.modelWindowStart, 0);
});
