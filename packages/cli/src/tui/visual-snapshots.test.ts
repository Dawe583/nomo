/**
 * Deterministic visual regression snapshots for the whole TUI frame.
 *
 * Every scenario is rendered by the real `renderWorkspace` at the terminal
 * sizes operators actually use, with colour and motion off, a pinned clock, a
 * pinned working directory and fixtures that carry their own timestamps. The
 * committed file stores only a SHA-256 of the ANSI-stripped frame plus its row
 * count and widest visible row, so a snapshot can never smuggle terminal
 * escape codes or a full frame into the repository.
 *
 * Determinism comes from four pinned inputs:
 *
 * 1. `now` is passed through `visuals.now`, so the only clock the frame reads
 *    is the fixture's.
 * 2. `cwd` is passed through `visuals.cwd` and primed through the git cache,
 *    so the footer never depends on this checkout's branch or dirty state.
 * 3. Every session, ledger entry and approval hold is a fixture whose `at`
 *    timestamps are literals, so transcript, run receipt and usage charts do
 *    not read the wall clock.
 * 4. `WorkspaceTui` is built without `initialize()`, which is what keeps
 *    background health and proxy probes out of the frames.
 *
 * Intentional UI changes are accepted with `NOMO_UPDATE_SNAPSHOTS=1`, which
 * rewrites the committed file after the same shape guardrails run. A missing
 * fixture fails closed instead of silently writing a new baseline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Workbench } from "../../../workbench/src/index.ts";
import type { SessionEvent, SessionView } from "../../../workbench/src/index.ts";
import type { JsonlEntry } from "../../../ledger/src/store.ts";
import { WorkspaceTui, renderWorkspace } from "./workspace.ts";
import { stripAnsi, visibleLength } from "./layout.ts";
import type { Check } from "./health.ts";
import { primeGitStatus, resetGitStatusCache } from "./git-status.ts";

const SNAPSHOT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "test",
  "visual-snapshots.json",
);
const SNAPSHOT_VERSION = 1;
/** Root exists on every platform and is never a checkout, so no branch prints. */
const SNAPSHOT_CWD = "/";
/** The only instant any frame may read as "now". */
const SNAPSHOT_NOW = Date.parse("2026-01-02T03:04:10.000Z");
const PARENT_SESSION_ID = "sess-visual";
const CHILD_SESSION_ID = "sess-child";
const PARENT_RUN_ID = "run-1";
const CHILD_RUN_ID = "run-child";

let visibleViews: readonly SessionView[] = [];
let visibleConnectors: readonly Record<string, unknown>[] = [];
let visibleChecks: readonly Check[] | null = null;
let visibleDocuments: ReturnType<Workbench["documentsList"]> = [];

const TERMINAL_SIZES = [
  [40, 12],
  [80, 24],
  [120, 40],
  [160, 45],
  [200, 48],
] as const;

const SCENARIOS = [
  "chat-idle",
  "chat-busy",
  "sessions",
  "tools",
  "usage",
  "usage-empty",
  "ledger",
  "approvals",
  "settings",
  "runs-empty",
  "runs-one",
  "mcp-empty",
  "mcp-one",
  "status-empty",
  "status-one",
  "documents-empty",
  "documents-one",
] as const;

type Scenario = (typeof SCENARIOS)[number];

type FrameSnapshot = {
  readonly sha256: string;
  readonly rows: number;
  readonly maxVisibleLength: number;
};

type SnapshotFile = {
  readonly version: number;
  readonly frames: Record<string, FrameSnapshot>;
};

const FRAME_FIELDS = ["sha256", "rows", "maxVisibleLength"] as const;

/** A fixture timestamp. Seconds are the only variable, so `at` is a literal. */
const at = (second: number): string =>
  `2026-01-02T03:04:${String(second).padStart(2, "0")}.000Z`;

const event = (
  sessionId: string,
  seq: number,
  kind: SessionEvent["kind"],
  type: string,
  text: string,
  payload: Record<string, unknown>,
  runId: string,
): SessionEvent => ({
  seq,
  at: at(seq),
  kind,
  type,
  text,
  payload,
  runId,
  sessionId,
});

/**
 * One turn that exercises every Chat surface the panel can show: a user
 * prompt, reasoning deltas, a tool request and its result, a structured
 * checklist, a usage record and a settled run.
 */
const PARENT_EVENTS: readonly SessionEvent[] = [
  event(
    PARENT_SESSION_ID,
    1,
    "user",
    "message.completed",
    "Plan the release and record it.",
    {},
    PARENT_RUN_ID,
  ),
  event(
    PARENT_SESSION_ID,
    2,
    "tool",
    "run.status",
    "running",
    { status: "running" },
    PARENT_RUN_ID,
  ),
  event(
    PARENT_SESSION_ID,
    3,
    "assistant",
    "reasoning.delta",
    "Weigh the options. ",
    { text: "Weigh the options. " },
    PARENT_RUN_ID,
  ),
  event(
    PARENT_SESSION_ID,
    4,
    "assistant",
    "reasoning.delta",
    "Then answer.",
    { text: "Then answer." },
    PARENT_RUN_ID,
  ),
  event(
    PARENT_SESSION_ID,
    5,
    "tool",
    "tool.started",
    "Requested void_workspace_write.",
    {
      tool: "void_workspace_write",
      callId: "w1",
      arguments: { path: "plan.md", content: "first" },
    },
    PARENT_RUN_ID,
  ),
  event(
    PARENT_SESSION_ID,
    6,
    "tool",
    "tool.result",
    "void_workspace_write: result received",
    {
      tool: "void_workspace_write",
      callId: "w1",
      result: {
        isError: false,
        content: [{ type: "text", text: '{"completed":true}' }],
      },
    },
    PARENT_RUN_ID,
  ),
  event(
    PARENT_SESSION_ID,
    7,
    "tool",
    "todo.updated",
    "todo updated",
    {
      items: [
        { text: "Write the plan", status: "completed" },
        { text: "Verify the ledger", status: "in_progress" },
        { text: "Ship the release", status: "pending" },
      ],
    },
    PARENT_RUN_ID,
  ),
  event(
    PARENT_SESSION_ID,
    8,
    "usage",
    "usage.reported",
    "usage",
    { total_tokens: 120, source: "provider" },
    PARENT_RUN_ID,
  ),
  event(
    PARENT_SESSION_ID,
    9,
    "assistant",
    "message.completed",
    "The plan is written and verified.",
    { toolCallsPresent: false },
    PARENT_RUN_ID,
  ),
  event(
    PARENT_SESSION_ID,
    10,
    "tool",
    "run.status",
    "idle",
    { status: "idle" },
    PARENT_RUN_ID,
  ),
];

const CHILD_EVENTS: readonly SessionEvent[] = [
  event(
    CHILD_SESSION_ID,
    1,
    "tool",
    "tool.started",
    "Requested read_file.",
    { tool: "read_file", callId: "c1", arguments: { path: "docs/plan.md" } },
    CHILD_RUN_ID,
  ),
  event(
    CHILD_SESSION_ID,
    2,
    "tool",
    "tool.result",
    "read_file: result received",
    {
      tool: "read_file",
      callId: "c1",
      result: { isError: false, content: [{ type: "text", text: "ok" }] },
    },
    CHILD_RUN_ID,
  ),
  event(
    CHILD_SESSION_ID,
    3,
    "usage",
    "usage.reported",
    "usage",
    {
      prompt_tokens: 300,
      completion_tokens: 180,
      total_tokens: 480,
      cost: 0.0025,
      source: "provider",
    },
    CHILD_RUN_ID,
  ),
];

const PARENT_VIEW: SessionView = {
  id: PARENT_SESSION_ID,
  workspace: `ws-${PARENT_SESSION_ID}`,
  model: "fixture-model",
  title: "Visual snapshot",
  createdAt: at(1),
  updatedAt: at(10),
  status: "idle",
  events: PARENT_EVENTS,
  runId: PARENT_RUN_ID,
  continuationCount: 0,
  runTokenCount: 120,
  contextMessages: 4,
  project: "nomo",
  agent: "builder",
  provider: "fixture",
};

const CHILD_VIEW: SessionView = {
  id: CHILD_SESSION_ID,
  parentId: PARENT_SESSION_ID,
  workspace: `ws-${CHILD_SESSION_ID}`,
  model: "fixture-child",
  title: "Delegated task",
  createdAt: at(1),
  updatedAt: at(3),
  status: "idle",
  events: CHILD_EVENTS,
  runId: CHILD_RUN_ID,
  continuationCount: 0,
  runTokenCount: 480,
  contextMessages: 1,
  provider: "fixture",
};


const BUILTIN_CONNECTOR = {
  id: "workspace",
  name: "NOMO documents",
  builtin: true,
  tools: ["void_workspace_read"],
  toolDetails: [],
  undo: true,
  consentState: "confirmed",
};

const EXTERNAL_CONNECTOR = {
  id: "conn-visual",
  name: "fixture connector with a deliberately long name",
  url: "https://connector.fixture.invalid/mcp",
  tools: ["fixture_send"],
  toolDetails: [],
  undo: false,
  consentState: "confirmed",
  lastProbeOutcome: "success",
};

const DEFAULT_CONNECTORS: readonly Record<string, unknown>[] = [
  BUILTIN_CONNECTOR,
  EXTERNAL_CONNECTOR,
];


const STATUS_CHECKS: readonly Check[] = [
  {
    name: "provider",
    area: "runtime",
    state: "unmeasured",
    detail: "Provider state has not been read yet; provider health is unmeasured.",
    remedy: "Run /connect, or r to retry.",
  },
  {
    name: "ledger head",
    area: "records",
    state: "ok",
    detail: "1 chain(s); latest head seq 2, hash sha256:a2.",
  },
];


const DOCUMENT_FIXTURE = {
  path: "release-plan.md",
  revision: "rev-document",
  bytes: 17,
  updatedAt: at(5),
  sessionId: PARENT_SESSION_ID,
  workspace: `ws-${PARENT_SESSION_ID}`,
};

const DEFAULT_DOCUMENTS: ReturnType<Workbench["documentsList"]> = [
  DOCUMENT_FIXTURE,
];

/**
 * Two held calls with no deadline. A deadline would be printed as a countdown
 * that moves every second, which is the one clock the approvals panel reads
 * outside the fixture, so the fixture omits it and the panel says so.
 */
const DEFAULT_VIEWS: readonly SessionView[] = [PARENT_VIEW, CHILD_VIEW];

const FIXTURE_HOLDS = [
  {
    holdId: "hold-1",
    status: "pending",
    call: {
      tool: "stripe.refund.create",
      klass: "r2",
      blastRadius: 1,
      reason: "money movement has no guaranteed inverse",
    },
  },
  {
    holdId: "hold-2",
    status: "pending",
    call: {
      tool: "postgres.table.drop",
      klass: "r3",
      blastRadius: 41_883,
      reason: "destructive DDL is irreversible after commit",
    },
  },
];

const FIXTURE_LEDGER: readonly JsonlEntry[] = [
  {
    workspace: `ws-${PARENT_SESSION_ID}`,
    seq: 1,
    body: { tool: "postgres.row.update", decision: "allow", class: "r0" },
    prev_hash: "",
    hash: "sha256:a1",
    key_id: "dev-ed25519:fixture",
    alg: "ed25519",
    signature: "sig",
  },
  {
    workspace: `ws-${PARENT_SESSION_ID}`,
    seq: 2,
    body: { tool: "postgres.table.drop", decision: "deny", class: "r3" },
    prev_hash: "sha256:a1",
    hash: "sha256:a2",
    key_id: "dev-ed25519:fixture",
    alg: "ed25519",
    signature: "sig",
  },
];

const snapshotEnv = (dataDir: string): NodeJS.ProcessEnv => ({
  NOMO_DATA_DIR: dataDir,
  // Colour and motion are off in the frame and in the Settings panel, so the
  // snapshot cannot depend on the terminal that ran it.
  NO_COLOR: "1",
  NOMO_TUI_COLOR: "0",
  NOMO_TUI_MOTION: "0",
});

/**
 * A frame hash plus the two shape facts that make a hash mismatch readable.
 *
 * The frame is hashed after ANSI removal, so a colour change alone cannot move
 * the hash and the committed file never needs escape sequences.
 */
function describeFrame(frame: string): FrameSnapshot {
  const plain = stripAnsi(frame);
  const rows = plain.split("\n");
  return {
    sha256: createHash("sha256").update(plain, "utf8").digest("hex"),
    rows: rows.length,
    maxVisibleLength: rows.reduce(
      (widest, row) => Math.max(widest, visibleLength(row)),
      0,
    ),
  };
}

/**
 * Fail closed on a snapshot file that is missing, unreadable or carrying
 * anything beyond hashes and shape. Frame text and escape sequences are
 * rejected by field name, not by inspecting values.
 */
function parseSnapshotFile(raw: unknown, source: string): SnapshotFile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error(`${source} must be a JSON object.`);
  const file = raw as { version?: unknown; frames?: unknown };
  if (file.version !== SNAPSHOT_VERSION)
    throw new Error(
      `${source} has version ${JSON.stringify(file.version)}, expected ${SNAPSHOT_VERSION}.`,
    );
  if (
    typeof file.frames !== "object" ||
    file.frames === null ||
    Array.isArray(file.frames)
  )
    throw new Error(`${source} has no frames object.`);
  const frames: Record<string, FrameSnapshot> = {};
  for (const [key, value] of Object.entries(file.frames)) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error(`${source} frame ${key} must be an object.`);
    const frame = value as Record<string, unknown>;
    const unexpected = Object.keys(frame).filter(
      (field) => !(FRAME_FIELDS as readonly string[]).includes(field),
    );
    if (unexpected.length)
      throw new Error(
        `${source} frame ${key} carries ${unexpected.join(", ")}; snapshots store hashes only.`,
      );
    const sha256 = frame.sha256;
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256))
      throw new Error(`${source} frame ${key} has no SHA-256 hash.`);
    const rows = frame.rows;
    if (typeof rows !== "number" || !Number.isInteger(rows) || rows <= 0)
      throw new Error(`${source} frame ${key} has no row count.`);
    const maxVisibleLength = frame.maxVisibleLength;
    if (
      typeof maxVisibleLength !== "number" ||
      !Number.isInteger(maxVisibleLength) ||
      maxVisibleLength < 0
    )
      throw new Error(`${source} frame ${key} has no visible width.`);
    frames[key] = { sha256, rows, maxVisibleLength };
  }
  return { version: SNAPSHOT_VERSION, frames };
}

async function loadSnapshotFile(): Promise<SnapshotFile> {
  let raw: string;
  try {
    raw = await readFile(SNAPSHOT_PATH, "utf8");
  } catch (error) {
    throw new Error(
      `Missing visual snapshot fixture at ${SNAPSHOT_PATH}. Run the test with NOMO_UPDATE_SNAPSHOTS=1 to create it. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Unreadable visual snapshot fixture at ${SNAPSHOT_PATH}. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseSnapshotFile(parsed, SNAPSHOT_PATH);
}

/**
 * Reset every field a scenario can leave behind.
 *
 * The scenarios share one `WorkspaceTui`, and the order they run in must not
 * change a frame, so each one starts from the same panel state.
 */
function resetPanel(ui: WorkspaceTui): void {
  ui.choose("chat");
  ui.detail = undefined;
  ui.confirmation = undefined;
  ui.palette = undefined;
  ui.settingsOpen = false;
  ui.settingsEdit = undefined;
  // `showingKeybindings` and `showingCheatSheet` are getters over these flags
  // and the detail text, so clearing the detail below is what closes them.
  ui.keybindingDetail = false;
  ui.cheatSheet = false;
  ui.diffView = undefined;
  ui.filter = "";
  ui.selected = 0;
  ui.scroll = 0;
  ui.petSplashUntil = 0;
  ui.sessionId = PARENT_SESSION_ID;
  visibleViews = DEFAULT_VIEWS;
  visibleConnectors = DEFAULT_CONNECTORS;
  visibleChecks = null;
  visibleDocuments = DEFAULT_DOCUMENTS;
}

function applyScenario(ui: WorkspaceTui, scenario: Scenario): void {
  resetPanel(ui);
  switch (scenario) {
    case "chat-idle":
      // The idle frame is the screen an operator sees before a conversation
      // exists, so it carries no session at all.
      ui.sessionId = undefined;
      return;
    case "chat-busy":
      return;
    case "sessions":
      // The browser's first frame: the working set open, the delegated child
      // and its parent in their own sections, and the inspector beside the
      // list only at the sizes that can afford it.
      ui.choose("sessions");
      return;
    case "tools":
      ui.choose("tools");
      return;
    case "usage":
      ui.choose("usage");
      return;
    case "usage-empty":
      visibleViews = [];
      ui.choose("usage");
      return;
    case "ledger":
      ui.choose("ledger");
      return;
    case "approvals":
      ui.choose("approvals");
      return;
    case "settings":
      // Settings render into the detail pane. One layout pass publishes the
      // detail, which is what the next frame reads to replace the Chat body.
      ui.refreshSettingsPanel();
      ui.lines();
      return;
    case "runs-empty":
      visibleViews = [];
      ui.choose("runs");
      return;
    case "runs-one":
      visibleViews = [PARENT_VIEW];
      ui.choose("runs");
      return;
    case "mcp-empty":
      visibleConnectors = [];
      ui.choose("mcp");
      return;
    case "mcp-one":
      visibleConnectors = [EXTERNAL_CONNECTOR];
      ui.choose("mcp");
      return;
    case "status-empty":
      visibleChecks = [];
      ui.choose("status");
      return;
    case "status-one":
      visibleChecks = STATUS_CHECKS;
      ui.choose("status");
      return;
    case "documents-empty":
      visibleDocuments = [];
      ui.choose("documents");
      return;
    case "documents-one":
      visibleDocuments = DEFAULT_DOCUMENTS;
      ui.choose("documents");
      return;
  }
}

function captureFrame(
  ui: WorkspaceTui,
  columns: number,
  rows: number,
): string {
  return stripAnsi(
    renderWorkspace(ui, columns, rows, "", false, false, {
      color: false,
      motion: false,
      cwd: SNAPSHOT_CWD,
      now: SNAPSHOT_NOW,
    }),
  );
}

/** The shape every captured frame must keep, in update mode as well. */
function assertFrameShape(
  key: string,
  frame: string,
  columns: number,
  rows: number,
  snapshot: FrameSnapshot,
): void {
  assert.doesNotMatch(
    frame,
    /\x1b/u,
    `${key} must be captured with ANSI stripped.`,
  );
  assert.doesNotMatch(
    frame,
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u,
    `${key} must not carry terminal control characters.`,
  );
  assert.equal(
    snapshot.rows,
    rows,
    `${key} must fill the terminal height with one row per line.`,
  );
  assert.equal(
    frame.split("\n").length,
    rows,
    `${key} rendered ${frame.split("\n").length} rows for a ${rows} row terminal.`,
  );
  assert.ok(
    snapshot.maxVisibleLength <= columns,
    `${key} rendered ${snapshot.maxVisibleLength} visible cells for ${columns} columns.`,
  );
}

test("visual snapshots match the committed frame hashes", async (t) => {
  const update = process.env.NOMO_UPDATE_SNAPSHOTS === "1";
  const stored = update ? undefined : await loadSnapshotFile();

  resetGitStatusCache();
  // The footer appends the branch git reports. Priming the cache with the
  // fixture directory's answer keeps that segment a pure function of the
  // fixture instead of this checkout's branch and dirty state.
  await primeGitStatus(SNAPSHOT_CWD);

  const root = await mkdtemp(join(tmpdir(), "nomo-visual-snapshots-"));
  const env = snapshotEnv(root);
  const app = new Workbench(env);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  const views: readonly SessionView[] = [PARENT_VIEW, CHILD_VIEW];
  visibleViews = DEFAULT_VIEWS;
  visibleConnectors = DEFAULT_CONNECTORS;
  visibleChecks = null;
  visibleDocuments = DEFAULT_DOCUMENTS;
  // The builtin tool registry is the real list; only the session lookup is
  // pinned, because no live session exists for these fixtures.
  const builtinTools = app.availableTools(undefined);
  t.mock.method(app, "get", (id: string) =>
    views.find((view) => view.id === id),
  );
  t.mock.method(app, "list", () => [...views]);
  t.mock.method(app, "allViews", () => [...visibleViews]);
  t.mock.method(app, "availableTools", () => builtinTools);
  t.mock.method(
    app,
    "approvals",
    () => FIXTURE_HOLDS as unknown as ReturnType<Workbench["approvals"]>,
  );
  t.mock.method(app, "pending", () => []);
  t.mock.method(
    app,
    "connectionState",
    () => ({ connectors: [...visibleConnectors] }) as ReturnType<Workbench["connectionState"]>,
  );
  t.mock.method(app, "documentsList", () => [...visibleDocuments]);
  t.mock.method(
    app,
    "workspace",
    () =>
      ({
        version: 1,
        files: { "release-plan.md": "x" },
        operations: [
          {
            id: "op-document",
            kind: "write",
            path: "release-plan.md",
            before: null,
            after: "x",
            at: at(5),
            digest: "sha256:document",
          },
        ],
      }) as ReturnType<Workbench["workspace"]>,
  );

  const ui = new WorkspaceTui(app, env);
  ui.proofs.set(`ws-${PARENT_SESSION_ID}`, [...FIXTURE_LEDGER]);
  const realHealthChecks = ui.healthChecks.bind(ui);
  t.mock.method(ui, "healthChecks", () =>
    visibleChecks === null ? realHealthChecks() : [...visibleChecks],
  );

  const captured: Record<string, FrameSnapshot> = {};
  const mismatches: string[] = [];

  for (const scenario of SCENARIOS) {
    applyScenario(ui, scenario);
    for (const [columns, rows] of TERMINAL_SIZES) {
      const key = `${scenario}@${columns}x${rows}`;
      const frame = captureFrame(ui, columns, rows);
      const snapshot = describeFrame(frame);
      assertFrameShape(key, frame, columns, rows, snapshot);
      captured[key] = snapshot;

      if (stored === undefined) continue;
      const expected = stored.frames[key];
      if (expected === undefined) {
        mismatches.push(`${key}: missing from the committed snapshot`);
        continue;
      }
      if (snapshot.sha256 !== expected.sha256) {
        mismatches.push(
          `${key}: frame changed (committed ${expected.sha256.slice(0, 12)}, rendered ${snapshot.sha256.slice(0, 12)})`,
        );
        continue;
      }
      if (snapshot.rows !== expected.rows)
        mismatches.push(
          `${key}: ${snapshot.rows} rows, committed ${expected.rows}`,
        );
      if (snapshot.maxVisibleLength !== expected.maxVisibleLength)
        mismatches.push(
          `${key}: ${snapshot.maxVisibleLength} visible cells, committed ${expected.maxVisibleLength}`,
        );
    }
  }

  if (stored !== undefined) {
    for (const key of Object.keys(stored.frames))
      if (!Object.hasOwn(captured, key))
        mismatches.push(`${key}: committed frame has no scenario any more`);
    assert.deepEqual(
      mismatches,
      [],
      `Visual snapshots do not match. Review the rendered change, then re-run with NOMO_UPDATE_SNAPSHOTS=1 to accept it.`,
    );
    return;
  }

  await mkdir(dirname(SNAPSHOT_PATH), { recursive: true });
  await writeFile(
    SNAPSHOT_PATH,
    `${JSON.stringify({ version: SNAPSHOT_VERSION, frames: captured }, null, 2)}\n`,
    "utf8",
  );
  t.diagnostic(
    `Wrote ${Object.keys(captured).length} frame hashes to ${SNAPSHOT_PATH}`,
  );
});

test("the committed snapshot stores hashes and shape only", async (t) => {
  // In update mode the previous test has just written the file, so this reads
  // the new baseline and proves it never gained frame text.
  const stored = await loadSnapshotFile();
  assert.equal(stored.version, SNAPSHOT_VERSION);
  const keys = Object.keys(stored.frames);
  assert.equal(
    keys.length,
    SCENARIOS.length * TERMINAL_SIZES.length,
    `expected one frame per scenario and size, found ${keys.length}`,
  );
  for (const scenario of SCENARIOS)
    for (const [columns, rows] of TERMINAL_SIZES)
      assert.ok(
        Object.hasOwn(stored.frames, `${scenario}@${columns}x${rows}`),
        `${scenario}@${columns}x${rows} is not in the snapshot`,
      );
  t.diagnostic(`Snapshot holds ${keys.length} frame hashes.`);
});
