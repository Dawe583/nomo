/**
 * Frame budget for the Chat transcript on a large conversation.
 *
 * The TUI renders a window of the transcript, but it still has to produce
 * every row before it can slice the window. That makes the row builder the
 * one place where a large transcript can turn a keystroke into a stall, so
 * this file pins the cost of a real frame at the two sizes operators use:
 * 200x48 (a wide terminal with the rail) and 80x24 (the classic default).
 *
 * The fixture is synthetic on purpose. It carries the surfaces a long
 * conversation actually accumulates - user turns, reasoning deltas, tool
 * cards with multi-line output, a structured checklist, settled runs and
 * usage records - so the measured frame walks the same code paths as a real
 * session instead of a list of short strings.
 *
 * Two properties are asserted:
 *
 * 1. A steady-state frame stays inside a generous p95 ceiling. The ceiling is
 *    far above today's number so it catches a regression rather than a slow
 *    machine, and the measured value is printed so headroom is visible.
 * 2. Doubling the event count doubles the rows and roughly doubles the cold
 *    build, which is what rules out an accidental O(n^2) pass.
 *
 * Nothing here is a benchmark of the terminal: the frame is rendered into a
 * string, never written, and the clock is `performance.now()` around the
 * synchronous call only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import type { SessionEvent, SessionView } from "../../../workbench/src/index.ts";
import { WorkspaceTui, renderWorkspace } from "./workspace.ts";
import { primeGitStatus, resetGitStatusCache } from "./git-status.ts";

const SESSION_ID = "sess-perf";
const RUN_ID = "run-perf";
/** Root exists everywhere and is never a checkout, so the footer is stable. */
const FIXTURE_CWD = "/";
const FIXTURE_NOW = Date.parse("2026-01-02T03:04:10.000Z");

/** The sizes the visual snapshots already treat as operator terminals. */
const TERMINAL_SIZES = [
  [200, 48],
  [80, 24],
] as const;

/** One frame is cheap; 40 of them give a p95 that is not a single outlier. */
const MEASURED_FRAMES = 40;
/** Frames discarded before measuring, so the first-frame cost is separate. */
const WARMUP_FRAMES = 5;

/**
 * Steady-state p95 ceiling for one frame, in milliseconds.
 *
 * This is a regression tripwire, not a target. Measured headroom on the
 * development machine is roughly 4x, so a loaded CI machine does not fail it
 * while a real algorithmic regression still does.
 *
 * If this trips, the per-frame work is the place to look: the frame still
 * walks the whole transcript for the prompt-row index and the settled run
 * receipt even though it paints one window of it.
 */
const FRAME_P95_BUDGET_MS = 50;

/** A single stalled frame is not a regression, but ten of them is. */
const FRAME_MAX_BUDGET_MS = 100;

/**
 * The one-off cost of attaching a large transcript to a fresh view.
 *
 * The first frame in a process also pays JIT warmup on the row builder, so it
 * is several times a settled build of the same transcript. The bound is loose
 * for that reason: it is here to catch an order-of-magnitude regression, not
 * to police first-call compilation.
 */
const COLD_FRAME_BUDGET_MS = 1500;

const isoAt = (seq: number): string =>
  new Date(Date.UTC(2026, 0, 2, 3, 4, 0) + seq * 1_000).toISOString();

/** Six real-looking source lines, so a tool card carries multi-line output. */
const TOOL_OUTPUT = Array.from(
  { length: 6 },
  (_, index) =>
    `packages/cli/src/tui/block-${index}.ts:${120 + index}:  const value = render(${index});`,
).join("\n");

const REASONING_ONE =
  "The row builder walks the settled events once, so the cost stays linear. ";
const REASONING_TWO =
  "No pass rescans the transcript for a later event; the tail is the only extra work. ";

const userText = (turn: number): string =>
  `Turn ${turn}: inspect the parser, then report the failing cases and the ledger entries they touch.`;

const assistantText = (turn: number): string =>
  `## Turn ${turn}\n\nThe parser accepts ${turn} cases. \`renderWorkspace\` stays linear because the row builder only walks the events once.\n\n\`\`\`ts\nconst rows = chatRows(events, width);\nfor (const row of rows) paint(row);\n\`\`\`\n\nNext: verify the ledger chain and record the evidence.`;

const event = (
  seq: number,
  kind: SessionEvent["kind"],
  type: string,
  text: string,
  payload: Record<string, unknown> = {},
): SessionEvent => ({
  seq,
  at: isoAt(seq),
  kind,
  type,
  text,
  payload,
  runId: RUN_ID,
  sessionId: SESSION_ID,
});

/**
 * `turns` turns, each with the surfaces a long conversation accumulates.
 *
 * Nine events per turn and two messages, so 400 turns is 3,600 events and
 * 800 messages: inside the 500 to 2,000 message range this file is about.
 */
function buildEvents(turns: number): SessionEvent[] {
  const events: SessionEvent[] = [];
  let seq = 0;
  const push = (
    kind: SessionEvent["kind"],
    type: string,
    text: string,
    payload: Record<string, unknown> = {},
  ): void => {
    seq += 1;
    events.push(event(seq, kind, type, text, payload));
  };

  for (let turn = 1; turn <= turns; turn += 1) {
    const callId = `call-${turn}`;
    push("user", "message.completed", userText(turn));
    push("assistant", "reasoning.delta", REASONING_ONE, {
      text: REASONING_ONE,
    });
    push("assistant", "reasoning.delta", REASONING_TWO, {
      text: REASONING_TWO,
    });
    push("tool", "tool.started", "Requested void_workspace_read.", {
      tool: "void_workspace_read",
      callId,
      arguments: { path: `packages/cli/src/tui/block-${turn}.ts` },
    });
    push("tool", "tool.result", "void_workspace_read: result received", {
      tool: "void_workspace_read",
      callId,
      result: {
        isError: false,
        content: [{ type: "text", text: TOOL_OUTPUT }],
      },
    });
    if (turn % 3 === 0)
      push("tool", "todo.updated", "todo updated", {
        items: [
          { text: "Read the parser", status: "completed" },
          { text: "Measure the frame", status: "in_progress" },
          { text: "Verify the ledger", status: "pending" },
          { text: "Ship the release", status: "pending" },
        ],
      });
    push("assistant", "message.completed", assistantText(turn), {
      toolCallsPresent: true,
    });
    push("tool", "run.status", "idle", { status: "idle" });
    push("usage", "usage.reported", "usage", {
      total_tokens: turn * 120,
      source: "provider",
    });
  }
  return events;
}

function viewFor(events: readonly SessionEvent[]): SessionView {
  return {
    id: SESSION_ID,
    workspace: `ws-${SESSION_ID}`,
    model: "fixture-model",
    title: "Performance fixture",
    createdAt: isoAt(1),
    updatedAt: isoAt(events.length),
    status: "idle",
    events,
    runId: RUN_ID,
    continuationCount: 0,
    runTokenCount: 48_000,
    contextMessages: events.length,
    project: "nomo",
    agent: "builder",
    provider: "fixture",
  };
}

type PerfFixture = {
  readonly app: Workbench;
  readonly env: NodeJS.ProcessEnv;
  /** A fresh view over the same events, so its caches start empty. */
  readonly makeUi: () => WorkspaceTui;
};

/**
 * A Workbench with only the reads a Chat frame performs pinned to fixtures.
 *
 * `get` returns a copy of the view but keeps the `events` array identity,
 * which is exactly what the real `Workbench.view` does and what the row
 * cache keys on.
 */
async function fixture(
  t: TestContext,
  events: readonly SessionEvent[],
): Promise<PerfFixture> {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-perf-"));
  const env: NodeJS.ProcessEnv = {
    NOMO_DATA_DIR: root,
    NO_COLOR: "1",
    NOMO_TUI_COLOR: "0",
    NOMO_TUI_MOTION: "0",
  };
  const app = new Workbench(env);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  const view = viewFor(events);
  t.mock.method(app, "get", (id: string) =>
    id === SESSION_ID ? { ...view } : undefined,
  );
  t.mock.method(app, "list", () => [{ ...view, events: [] }]);
  t.mock.method(app, "allViews", () => [view]);
  t.mock.method(app, "pending", () => []);
  t.mock.method(app, "runs", () => []);
  t.mock.method(app, "running", () => false);

  const makeUi = (): WorkspaceTui => {
    const ui = new WorkspaceTui(app, env);
    ui.sessionId = SESSION_ID;
    return ui;
  };
  return { app, env, makeUi };
}

const capabilities = (columns: number, rows: number) => ({
  columns,
  rows,
  colorDepth: 24 as const,
  ansi: true,
  reason: "interactive" as const,
  interactive: true,
});

function renderFrame(
  ui: WorkspaceTui,
  columns: number,
  rows: number,
  color: boolean,
): string {
  return renderWorkspace(ui, columns, rows, "", false, false, {
    color,
    motion: false,
    cwd: FIXTURE_CWD,
    now: FIXTURE_NOW,
    capabilities: capabilities(columns, rows),
  });
}

/** Milliseconds around one synchronous frame. */
function timeFrame(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

function percentile(samples: readonly number[], quantile: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(quantile * sorted.length) - 1),
  );
  return sorted[index]!;
}

const fixed = (value: number): string => value.toFixed(2);

test("a large Chat transcript renders inside the frame budget", async (t) => {
  resetGitStatusCache();
  await primeGitStatus(FIXTURE_CWD);

  const events = buildEvents(400);
  const { makeUi } = await fixture(t, events);
  const failures: string[] = [];

  for (const [columns, rows] of TERMINAL_SIZES) {
    const ui = makeUi();
    const render = () => renderFrame(ui, columns, rows, true);

    // The first frame on a fresh view has no cached rows: that is the cost of
    // a large transcript arriving at once, and it is measured separately.
    const cold = timeFrame(render);
    const frame = renderFrame(ui, columns, rows, true);
    assert.equal(
      frame.split("\n").length,
      rows,
      `${columns}x${rows} must fill the terminal height`,
    );
    assert.ok(
      ui.viewport.total > rows,
      `${columns}x${rows} must render a real transcript window`,
    );

    for (let index = 0; index < WARMUP_FRAMES; index += 1) timeFrame(render);
    const samples: number[] = [];
    for (let index = 0; index < MEASURED_FRAMES; index += 1)
      samples.push(timeFrame(render));

    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    const max = Math.max(...samples);
    const rowsShown = ui.viewport.height;
    const rowsTotal = ui.viewport.total;

    t.diagnostic(
      `${columns}x${rows}: cold ${fixed(cold)} ms, p50 ${fixed(p50)} ms, p95 ${fixed(p95)} ms, max ${fixed(max)} ms over ${MEASURED_FRAMES} frames; ${rowsTotal} transcript rows, ${rowsShown} visible (${fixed(rowsTotal / Math.max(1, rowsShown))}x window)`,
    );

    if (cold > COLD_FRAME_BUDGET_MS)
      failures.push(
        `${columns}x${rows}: cold frame ${fixed(cold)} ms exceeds ${COLD_FRAME_BUDGET_MS} ms`,
      );
    if (p95 > FRAME_P95_BUDGET_MS)
      failures.push(
        `${columns}x${rows}: p95 ${fixed(p95)} ms exceeds ${FRAME_P95_BUDGET_MS} ms`,
      );
    if (max > FRAME_MAX_BUDGET_MS)
      failures.push(
        `${columns}x${rows}: max ${fixed(max)} ms exceeds ${FRAME_MAX_BUDGET_MS} ms`,
      );
  }

  assert.deepEqual(failures, []);
});

test("transcript work grows with the event count, not with its square", async (t) => {
  resetGitStatusCache();
  await primeGitStatus(FIXTURE_CWD);

  const small = await fixture(t, buildEvents(200));
  const large = await fixture(t, buildEvents(400));

  /** One cold frame. Callers interleave sizes so load drift cannot decide. */
  const coldFrame = (fixture: PerfFixture): { ms: number; total: number } => {
    const ui = fixture.makeUi();
    const ms = timeFrame(() => renderFrame(ui, 200, 48, true));
    return { ms, total: ui.viewport.total };
  };

  let smallTotal = 0;
  let largeTotal = 0;
  let smallBest = Number.POSITIVE_INFINITY;
  let largeBest = Number.POSITIVE_INFINITY;
  const pairedRatios: number[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const smallFrame = coldFrame(small);
    const largeFrame = coldFrame(large);
    smallTotal = smallFrame.total;
    largeTotal = largeFrame.total;
    smallBest = Math.min(smallBest, smallFrame.ms);
    largeBest = Math.min(largeBest, largeFrame.ms);
    pairedRatios.push(largeFrame.ms / Math.max(0.01, smallFrame.ms));
  }
  const rowRatio = largeTotal / Math.max(1, smallTotal);
  const timeRatio = percentile(pairedRatios, 0.5);

  t.diagnostic(
    `200x48 cold build: 200 turns ${fixed(smallBest)} ms best / ${smallTotal} rows, 400 turns ${fixed(largeBest)} ms best / ${largeTotal} rows (rows ${fixed(rowRatio)}x, paired median time ${fixed(timeRatio)}x)`,
  );

  // Rows are deterministic, so this is the honest scaling signal: twice the
  // events must produce about twice the rows. A quadratic pass would show up
  // here first, and a merged or dropped event would show up as a ratio below.
  assert.ok(
    rowRatio > 1.8 && rowRatio < 2.2,
    `doubling the transcript produced ${fixed(rowRatio)}x the rows`,
  );
  // Timing is noisy, so the bound is loose. Linear work lands near 2x; an
  // O(n^2) row pass over doubled input would land near 4x.
  assert.ok(
    timeRatio < 3,
    `doubling the transcript cost ${fixed(timeRatio)}x the paired cold builds (${fixed(smallBest)} ms best to ${fixed(largeBest)} ms best), which looks superlinear`,
  );
});
