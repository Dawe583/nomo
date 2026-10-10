import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import { assertIsolated } from "../../../workbench/src/test-fixture.ts";
import { approvalReview, renderWorkspace, WorkspaceTui } from "./workspace.ts";
import { previewState } from "./fixtures.ts";
import { renderWatchFrame } from "./watch.ts";
import { stripAnsi, visibleLength } from "./layout.ts";

// The workspace draws no glyph to stand in for a name, a status or a state.
// This covers box drawing, block elements, geometric shapes and the braille
// spinner, because all four were decoration rather than information: the tab
// strip names every destination in words, the composer is a labelled block, and
// a running turn is stated in text. The markers that do carry meaning are
// untouched: [0] to [3] for a reversibility class, [+]/[!]/[x] for a decision.
const DECORATIVE_GLYPH = /[\u2500-\u25FF\u2800-\u28FF]/u;

test("the workspace renders no decorative glyph", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-glyph-"));
  const app = new Workbench({ VOID_DATA_DIR: root });
  assertIsolated(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app);
  const rendered = renderWorkspace(ui, 100, 40, "", false, false, { color: true });
  assert.equal(stripAnsi(rendered).match(DECORATIVE_GLYPH), null);
});

test("workspace status names stopped and unknown runtime states explicitly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-state-"));
  const app = new Workbench({ VOID_DATA_DIR: root });
  assertIsolated(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { VOID_DATA_DIR: root });
  ui.sessionId = "fixture";
  t.mock.method(app, "runs", () => [
    {
      id: "run-1", runId: "run-1", sessionId: "fixture", model: "fixture", provider: "fixture",
      status: "cancelled", state: "stopped", progress: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      durationMs: null, steps: 0, legacy: false, reconcileRequired: false,
    },
  ]);
  const stopped = ui.statusLines().join("\n");
  assert.match(stopped, /State: stopped/);
  assert.doesNotMatch(stopped, /State: completed/);

  t.mock.method(app, "runs", () => [
    {
      id: "run-2", runId: "run-2", sessionId: "fixture", model: "fixture", provider: "fixture",
      status: "unknown", state: "unknown", progress: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      durationMs: null, steps: 0, legacy: false, reconcileRequired: true,
    },
  ]);
  const unknown = ui.statusLines().join("\n");
  assert.match(unknown, /State: unknown/);
  assert.match(unknown, /reconciliation required/);
});

test("workspace model labels are sanitized before summary rendering", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-model-"));
  const app = new Workbench({ VOID_DATA_DIR: root });
  assertIsolated(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { VOID_DATA_DIR: root });
  ui.model = "evil\x1b[2J\x1b]0;pwned";
  for (const color of [false, true]) {
    const frame = renderWorkspace(ui, 80, 24, "", false, false, { color });
    const plain = stripAnsi(frame);
    assert.doesNotMatch(plain, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u);
    assert.ok(frame.split("\n").every((line) => visibleLength(line) <= 80));
  }
});

test("approval review exposes evidence but never production arguments", () => {
  const hostileCall = {
    tool: "stripe.refund.create", klass: "r2", blastRadius: 1,
    args: { apiKey: "SENTINEL_SECRET" },
  } as unknown as Parameters<typeof approvalReview>[0]["call"];
  const review = approvalReview({ holdId: "proxy:fixture", call: hostileCall });
  const visible = review.lines.join("\n");
  assert.match(visible, /stripe\.refund\.create/);
  assert.doesNotMatch(visible, /SENTINEL_SECRET|apiKey|args/);
});

test("dashboard exposes call status and context severity without colour", () => {
  const statuses = ["observed", "sealed", "pending", "cancelled", "failed"] as const;
  const caps = { interactive: false, ansi: false, colorDepth: 0 as const, columns: 120, rows: 48, reason: "not-tty" as const };
  for (const status of statuses) {
    const frame = stripAnsi(renderWatchFrame({ ...previewState, calls: [{ ...previewState.calls[0]!, status }] }, caps));
    assert.match(frame, new RegExp(`status:${status}`));
  }
  const warning = stripAnsi(renderWatchFrame({ ...previewState, context: { total: 100, used: 75, billing: 0 } }, caps));
  assert.match(warning, /75% warning/);
  const critical = stripAnsi(renderWatchFrame({ ...previewState, context: { total: 100, used: 95, billing: 0 } }, caps));
  assert.match(critical, /95% critical/);
});
