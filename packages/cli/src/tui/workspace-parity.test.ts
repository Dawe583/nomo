import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Workbench } from "../../../workbench/src/index.ts";
import {
  MODE_ICON,
  TAB_ICONS,
  TAB_ICON_TONE,
  WorkspaceTui,
  chatRows,
  filterKeyForTab,
  approvalLabel,
  approvalBannerLines,
  approvalRiskBadge,
  detectHarnesses,
  commandArgumentHint,
  commandSuggestions,
  extractTodos,
  isDoubleEscape,
  holdSeverity,
  holdSecondsLeft,
  locationLabel,
  mentionCandidates,
  mentionToken,
  promptFrameBottom,
  promptFrameRow,
  promptFrameTop,
  renderWorkspace,
  searchHistoryPrompts,
  TUI_COMMANDS,
  wrap,
} from "./workspace.ts";
import { healthSummary, healthWord, renderHealth } from "./health.ts";
import {
  absentCapabilities,
  discoveryRows,
  DISCOVERY_GROUPS,
  groupTitle,
} from "./discover.ts";
import { activityStrip, activitySummary, buildActivity } from "./activity.ts";
import {
  ChordTracker,
  WorkspaceInput,
  isPetCardKey,
  isPetToggleKey,
  nextPromptRow,
  workspaceShortcut,
} from "./workspace-runner.ts";
import {
  highlightMouseSelection,
  railOwnsPoint,
  selectedMouseText,
} from "./mouse-selection.ts";
import { stripAnsi, visibleLength } from "./layout.ts";
import {
  usageCostLine,
  usageInputOutputLines,
  usageModelLines,
  usageReportedTotals,
  usageSparklineLine,
  usageTotalLine,
} from "./usage-visual.ts";
import {
  chainGlyphs,
  ledgerChainLines,
  ledgerGroupHeading,
} from "./ledger-visual.ts";
import { primeGitStatus, resetGitStatusCache } from "./git-status.ts";
import { moveHunk, setSide, toggleHunk } from "./diff-panel.ts";

const assistantFetcher = (content: string, totalTokens?: number) => async (url: unknown) => {
  if (String(url).endsWith("/models"))
    return Response.json({ data: [{ id: "fixture" }] });
  return Response.json({
    choices: [
      { message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    ...(totalTokens === undefined ? {} : {
      usage: { prompt_tokens: totalTokens - 1, completion_tokens: 1, total_tokens: totalTokens },
    }),
  });
};

async function fixtureApp(
  root: string,
  content = "ok",
  env: Record<string, string> = {},
  totalTokens?: number,
) {
  const full = { NOMO_DATA_DIR: root, ...env };
  const app = new Workbench(full, assistantFetcher(content, totalTokens));
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture-key",
  });
  return { app, env: full };
}

const connectKey = "fixture-connect-key-never-expose";

/** A HOME that local credential discovery reads, separate from the workspace
 * data directory so an import never touches the test's own store. */
async function credentialHome(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), "nomo-tui-connect-home-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

async function saveCredential(home: string, file: string, data: unknown) {
  const path = join(home, file);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(data), { mode: 0o600 });
}

/** OMP stores API keys in its own SQLite table, so the fixture builds the
 * table the importer reads instead of faking the importer's file format. */
async function saveOmpCredentials(home: string, providers: readonly string[]) {
  const directory = join(home, ".omp", "agent");
  await mkdir(directory, { recursive: true });
  const database = new DatabaseSync(join(directory, "agent.db"));
  try {
    database.exec(
      "CREATE TABLE auth_credentials (id TEXT PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, disabled_cause TEXT, data TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    const insert = database.prepare(
      "INSERT INTO auth_credentials (id, provider, credential_type, disabled_cause, data, updated_at) VALUES (?, ?, 'api_key', NULL, ?, ?)",
    );
    let stamp = 1_700_000_000_000;
    for (const provider of providers)
      insert.run(
        `fixture-${provider}`,
        provider,
        JSON.stringify({ key: connectKey }),
        stamp++,
      );
  } finally {
    database.close();
  }
}

/** A workspace whose HOME holds the credentials under test and whose provider
 * endpoint answers with one fixture model. */
async function connectFixture(t: test.TestContext, home: string) {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-connect-"));
  const env = { NOMO_DATA_DIR: root, HOME: home };
  const app = new Workbench(env, async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "fixture-model" }] })
      : Response.json({
          choices: [
            {
              message: { role: "assistant", content: "Fixture reply" },
              finish_reason: "stop",
            },
          ],
        }),
  );
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  return { app, env, ui: new WorkspaceTui(app, env) };
}

/** The message a refused command surfaces, whether it throws or sets a notice. */
async function commandMessage(
  ui: { command(value: string): Promise<unknown>; notice: string },
  command: string,
) {
  try {
    await ui.command(command);
  } catch (error) {
    return `${error instanceof Error ? error.message : String(error)} ${ui.notice}`;
  }
  return ui.notice;
}

test("toasts carry events past the notice, and safety tones never expire", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-toast-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();

  // An ordinary event expires on its own ttl.
  ui.announce("saved", "success", "Saved.");
  assert.equal(ui.toasts.toasts.length, 1);
  assert.equal(ui.toasts.toasts[0]?.message, "Saved.");
  ui.expireToasts(Date.now() + 10 * 60_000);
  assert.equal(ui.toasts.toasts.length, 0, "an ordinary toast expires");

  // The same id updates rather than stacking, so holding a key cannot fill
  // the banner with duplicates of one event.
  ui.announce("saved", "success", "Saved again.");
  ui.announce("saved", "success", "Saved once more.");
  assert.equal(ui.toasts.toasts.length, 1, "one toast per event id");
  assert.equal(ui.toasts.toasts[0]?.message, "Saved once more.");

  // Safety tones must survive any amount of elapsed time. An operator who
  // looks away and comes back has to find the event still there.
  for (const tone of ["danger", "pending"] as const) {
    ui.announce(`${tone}-event`, tone, `Needs attention: ${tone}`);
    ui.expireToasts(Date.now() + 365 * 24 * 3_600_000);
    const kept = ui.toasts.toasts.find(
      (toast) => toast.message === `Needs attention: ${tone}`,
    );
    assert.ok(kept, `a ${tone} toast must never expire`);
    assert.equal(kept.ttl, 0, `${tone} is sticky`);
  }

  // The notice mirrors the toast so a caller reading either sees the same
  // text, rather than the two drifting apart.
  assert.equal(ui.notice, "Needs attention: pending");
});

test("/keybindings is a grouped, searchable table that lays out to the terminal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-keys-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("/keybindings");
  assert.ok(ui.showingKeybindings, "the table is the visible detail");
  const full = ui.detail!.join("\n");
  const countRows = (table: string) => {
    let inGroup = false;
    let count = 0;
    for (const line of table.split("\n")) {
      // The table indents every row by two spaces and leads a group with its
      // glyph. Counting from the trimmed row keeps the indent out of the
      // contract while still requiring the group marker.
      if (/^[>|±◆≡] (SENDING|EDITING|NAVIGATION|REVIEW|SESSION)$/.test(line.trim())) {
        inGroup = true;
        continue;
      }
      if (!line.trim()) {
        inGroup = false;
        continue;
      }
      if (inGroup) count++;
    }
    return count;
  };
  const reportedCounts = (table: string) => {
    const countLine = table
      .split("\n")
      .find((line) => /\d+ of \d+ bindings/.test(line));
    assert.ok(countLine, "the table reports shown and total bindings");
    const match = /^(\d+) of (\d+) bindings$/.exec(countLine.trim());
    assert.ok(match, "the binding count is numeric");
    return { shown: Number(match[1]), total: Number(match[2]) };
  };
  const fullCounts = reportedCounts(full);
  assert.equal(fullCounts.shown, fullCounts.total);
  assert.equal(
    fullCounts.total,
    countRows(full),
    "the full count matches rows in the current binding catalog",
  );
  // The catalog carries 54 bindings; an unfiltered table shows all of them.
  assert.equal(fullCounts.total, 54, "the catalog size is the reported total");
  // Grouped, not one packed sentence per line. A binding that shared a line
  // with two others could not be found by scanning for its key.
  for (const title of ["SENDING", "EDITING", "NAVIGATION", "REVIEW", "SESSION"])
    assert.ok(full.includes(title), `missing group ${title}`);
  assert.ok(
    !full.includes("Enter send |"),
    "no line packs several bindings with pipes",
  );

  // Filtering narrows both sides: the keys and what they do.
  ui.keybindingQuery = "word";
  ui.refreshKeybindings(80);
  const wordTable = ui.detail!.join("\n");
  const wordCounts = reportedCounts(wordTable);
  assert.equal(wordCounts.total, fullCounts.total);
  assert.ok(wordCounts.shown > 0 && wordCounts.shown < wordCounts.total);
  assert.equal(wordCounts.shown, countRows(wordTable));
  assert.match(wordTable, /Jump by word/);
  assert.ok(
    !ui.detail!.join("\n").includes("Send the prompt"),
    "an unrelated binding is filtered out",
  );

  // A query that matches nothing says so rather than showing an empty screen.
  ui.keybindingQuery = "zzzz";
  ui.refreshKeybindings(80);
  const noMatchTable = ui.detail!.join("\n");
  const noMatchCounts = reportedCounts(noMatchTable);
  assert.equal(noMatchCounts.shown, 0);
  assert.equal(noMatchCounts.total, fullCounts.total);
  assert.equal(countRows(noMatchTable), 0);
  assert.match(noMatchTable, /No binding matches/);

  // Columns lay out to the terminal: a wider one does not truncate the
  // action column that a narrow one has to cut short.
  ui.keybindingQuery = "";
  ui.refreshKeybindings(40);
  const narrow = ui.detail!.join("\n");
  ui.refreshKeybindings(120);
  const wide = ui.detail!.join("\n");
  assert.ok(
    wide.includes("Clear the input, or list checkpoints when empty"),
    "a wide terminal states the whole action",
  );
  assert.ok(
    !narrow.includes("Clear the input, or list checkpoints when empty"),
    "a narrow terminal truncates rather than overflowing",
  );
  for (const line of narrow.split("\n"))
    assert.ok(
      visibleLength(line) <= 40,
      `line exceeds the terminal width: ${JSON.stringify(line)}`,
    );

  // Leaving the table stops typing from being swallowed by a filter that is
  // no longer on screen.
  ui.choose("overview");
  assert.equal(ui.showingKeybindings, false);
});

test("the cheat sheet opens over any view and only lists keys that work now", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-cheat-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();

  // It opens without leaving the panel it was opened from, because the whole
  // reason to open it is a key that did not do what was expected here.
  // Chat is the base screen, so that is where it is opened from.
  const tabBefore = ui.tab;
  assert.equal(tabBefore, "chat");
  ui.editingInput = true;
  ui.openCheatSheet();
  assert.ok(ui.showingCheatSheet, "the sheet is the visible detail");
  assert.equal(ui.tab, tabBefore, "the panel behind it is untouched");
  assert.ok(ui.detail!.length > 0, "it renders rows");
  assert.match(ui.detail![0], /Cheat sheet/);

  // Grouped by situation, in the order a person needs them: always first.
  const sheet = ui.detail!.join("\n");
  assert.ok(sheet.includes("ALWAYS"), "the always group leads");
  assert.ok(sheet.includes("Alt+M"), "a known binding is listed");
  assert.match(sheet, /of \d+ bindings/);

  // Filtering matches the key and the action, not only the key.
  ui.cheatQuery = "transpose";
  ui.refreshCheatSheet(80);
  assert.match(ui.detail!.join("\n"), /1 of/);
  assert.ok(
    !ui.detail!.join("\n").includes("undo last change"),
    "an unrelated binding is filtered out",
  );

  // A query matching nothing says so. An empty screen is indistinguishable
  // from a sheet that failed to load.
  ui.cheatQuery = "zzzz";
  ui.refreshCheatSheet(80);
  assert.match(ui.detail!.join("\n"), /No bindings match/);

  // Only keys that apply right now. A sheet listing a key that does nothing is
  // a sheet the operator learns to distrust, so review keys must be absent
  // while no review is open.
  ui.cheatQuery = "";
  ui.refreshCheatSheet(80);
  const idle = ui.detail!.join("\n");
  assert.ok(
    !/\bstaged hunks\b|\btoggle hunks\b/i.test(idle),
    "review keys are not listed outside a review",
  );

  // Opening a review adds them, and closing returns to the previous panel.
  ui.diffView = {
    hunks: [],
    cursor: 0,
    side: "split",
    staged: new Set<string>(),
  } as unknown as NonNullable<typeof ui.diffView>;
  ui.refreshCheatSheet(80);
  assert.match(ui.detail!.join("\n"), /REVIEW/);
  assert.match(ui.detail!.join("\n"), /accept hunk/);
  // Back to no review, and the review group is gone again.
  ui.diffView = undefined;
  ui.refreshCheatSheet(80);
  assert.ok(
    !ui.detail!.join("\n").includes("accept hunk"),
    "the review group closes with the review",
  );

  ui.closeCheatSheet();
  assert.equal(ui.showingCheatSheet, false);
  assert.equal(ui.detail, undefined, "the detail pane is handed back");

  // Changing panel clears the flag, so ordinary typing is not swallowed by a
  // filter for a sheet that is no longer on screen.
  ui.openCheatSheet();
  ui.choose("models");
  assert.equal(ui.showingCheatSheet, false);
  assert.equal(ui.cheatQuery, "");
});

test("/health never calls a check it could not run healthy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-health-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();

  const checks = ui.healthChecks();
  assert.ok(checks.length >= 4, "several subsystems are checked");

  // Every state carries a word, never only a colour or a glyph. A state shown
  // as a shape alone is unreadable to anyone who cannot see it.
  const rendered = ui.healthLines().join("\n");
  for (const word of ["ok", "warn", "fail", "unknown", "skipped"])
    assert.match(healthWord(word as never), /\w/);

  // A provider that was never read is unknown, not ok. This is the single
  // rule that makes the panel worth opening: reporting a subsystem it could
  // not reach as healthy turns an absence of information into an assurance.
  ui.provider = undefined;
  const blind = ui.healthChecks().find((c) => c.name === "provider");
  assert.equal(blind?.state, "unknown", "an unread provider is unknown");
  assert.notEqual(blind?.state, "ok", "never reported as a pass");
  assert.ok(blind?.remedy, "an unknown names what to do about it");

  // A ledger with no verification yet is unknown too, not a pass.
  ui.provider = await app.providerState();
  const unverified = ui.healthChecks().find((c) => c.name === "ledger");
  assert.ok(
    unverified?.state === "unknown" || unverified?.state === "ok",
    "the ledger is either verified or unverified, never assumed",
  );

  // A run needing reconciliation is a warn and says so.
  assert.ok(
    ui.healthChecks().every((c) => c.detail.length > 0),
    "no check has an empty explanation",
  );

  // The summary names the worst thing, not an average that hides it.
  const worst = renderHealth(
    [
      { name: "good", area: "a", state: "ok", detail: "fine" },
      { name: "bad", area: "b", state: "fail", detail: "chain break" },
      { name: "also-good", area: "c", state: "ok", detail: "fine" },
    ],
    60,
  ).join("\n");
  assert.match(worst, /chain break/, "the failure is visible");
  assert.ok(
    worst.indexOf("bad") < worst.indexOf("also-good"),
    "the failing check is ordered first",
  );
  assert.match(
    healthSummary([]),
    /\w/,
    "an empty check set still says something",
  );

  // Every row fits the width it was given, at every width the terminal has.
  for (const width of [24, 40, 60, 100, 140]) {
    for (const line of renderHealth(ui.healthChecks(), width)) {
      assert.ok(
        visibleLength(line) <= width,
        `health row exceeds ${width}: ${JSON.stringify(line)}`,
      );
    }
  }
});

test("/discover groups the command set by the task it serves", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-discover-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("/discover");
  const text = ui.detail!.join("\n");

  // Groups lead in the order a person arrives in, not alphabetically and not
  // in the order the commands happen to be declared.
  const order = DISCOVERY_GROUPS.map((group) =>
    text.indexOf(groupTitle(group)),
  );
  assert.ok(
    order.every((position) => position >= 0),
    "every group is present",
  );
  for (let i = 1; i < order.length; i++)
    assert.ok(order[i]! > order[i - 1]!, `group ${i} is out of order`);
  assert.match(text, /commands in \d+ groups/, "the count is stated");

  // An operator who expected a feature finds out it is absent on purpose
  // rather than assuming it is broken.
  const absent = absentCapabilities();
  assert.ok(absent.length >= 1, "the absent list is never empty");
  assert.match(absent.join("\n"), /background/i);

  // Every row fits, and nothing renders as an empty screen.
  for (const width of [24, 40, 60, 76, 120]) {
    const rows = discoveryRows(
      TUI_COMMANDS.map(([id, summary]) => ({ id, summary, group: "reading" })),
      { width },
    );
    assert.ok(rows.length >= 1, "the panel always renders rows");
    for (const row of rows)
      assert.ok(
        visibleLength(row) <= width,
        `discover row exceeds ${width}: ${JSON.stringify(row)}`,
      );
  }

  // An empty command set says so rather than printing nothing.
  const empty = discoveryRows([], { width: 60 });
  assert.ok(empty.length >= 1, "an empty set still renders");
  assert.match(empty.join("\n"), /No commands/i);
});

test("the chat panel leads with the shape of the conversation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-activity-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start here");
  await app.settled();
  ui.choose("chat");
  const rows = ui.lines();
  const joined = rows.join("\n");

  // The shape comes before the transcript. An operator returning after an hour
  // wants to see where it got to, and scrolling to find that is the work the
  // strip is meant to remove.
  const strip = activityStrip(buildActivity(ui.session()!.events), 76);
  assert.ok(strip.length > 0, "the strip is never empty");
  assert.ok(
    rows[0]!.startsWith("▸"),
    "the activity shape is the first thing in the panel, not an aside",
  );
  assert.match(
    rows[2]!,
    /^\d+ events? over \d+ms, last /,
    "the shape is stated in words right below it",
  );
  const firstWord = rows.findIndex((row) => / YOU$| YOU |NOMO|TOOL/.test(row));
  assert.ok(firstWord > 0, "the words follow the strip");

  // Recency, stated in words, so an operator knows whether to trust it.
  const summary = activitySummary(
    buildActivity(ui.session()!.events),
    Date.now(),
  );
  assert.match(summary, /\w/, "the summary says something");
  assert.match(summary, /event|no activity/i);
  // An empty conversation still renders a panel rather than an empty screen.
  assert.match(activitySummary(buildActivity([]), 0), /\w/);
});

test("the documents tab groups by folder and the arrows fold it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-doctree-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start here");
  await app.settled();
  const id = ui.sessionId!;
  for (const path of [
    "src/app/main.ts",
    "src/lib/util.ts",
    "docs/guide/intro.md",
    "plan.md",
  ])
    await app.editDocument(
      id,
      { path, content: "x", expectedRevision: null },
      "tui-operator",
    );
  ui.choose("documents");
  ui.items();
  assert.ok(ui.groupTree, "the documents tab builds a tree");
  const initial = ui.lines().join("\n");
  // Folders and files are told apart by a trailing slash, not only an icon.
  assert.match(initial, /docs\//);
  assert.match(initial, /src\//);
  assert.match(initial, /plan\.md/);
  // Deeper folders start closed: everything expanded is what made the tree
  // feel like the flat list it replaced.
  assert.match(initial, /folders collapsed/);

  // The arrows fold and unfold rather than switching panels.
  const tree = ui.groupTree!;
  ui.groupTree = { ...tree, state: { ...tree.state, cursor: 0 } };
  assert.equal(ui.collapseOrExpand(true), true, "a folder moved");
  assert.notEqual(ui.lines().join("\n"), initial, "the tree changed");
  assert.equal(ui.collapseOrExpand(false), true, "and it folds back");

  // Outside the documents tab the arrows keep their panel meaning. A tree
  // that followed the operator to another tab would let them collapse
  // something they are not looking at.
  ui.choose("ledger");
  assert.equal(ui.groupTree, undefined, "the tree belongs to one tab");
  assert.equal(ui.collapseOrExpand(true), false, "and does not answer arrows");
});

test("a toast never costs the operator the prompt frame, at any height", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-toastfit-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  // Three toasts at once, one of them sticky: the queue at its busiest.
  ui.announce("saved", "success", "Saved.");
  ui.announce("hold", "pending", "Run awaiting approval");
  ui.announce("warn", "warning", "Proxy unreachable.");

  // The bug this pins: a toast row was charged against the body, which on an
  // eight row terminal pushed the prompt frame's bottom rule off the screen.
  // A toast that costs the operator their input surface has charged more
  // than it delivered.
  for (const width of [20, 40, 60, 80, 100, 140, 180])
    for (const height of [8, 10, 12, 16, 20, 24, 30, 40, 60]) {
      const rows = renderWorkspace(ui, width, height, "x", true, false, {
        frame: 1,
      }).split("\n");
      assert.equal(rows.length, Math.max(8, height), `${width}x${height}`);
      // The framed composer is the input surface: the draft and its block
      // cursor stay on screen even with three toasts competing for rows.
      assert.ok(
        rows.some((row) => row.includes("x▌")),
        `no editable prompt marker at ${width}x${height}`,
      );
      assert.ok(
        rows.some((row) => row.includes("╭─ Draft")),
        `no composer frame at ${width}x${height}`,
      );
      if (height >= 12) {
        assert.ok(
          rows.some((row) => row.trimStart().startsWith("╰")),
          `no composer frame bottom at ${width}x${height}`,
        );
      }
    }
});

test("approvals are ordered by consequence, not by arrival", () => {
  const hold = (
    status: string,
    blastRadius: number | undefined,
    expiresAt = 0,
  ) => ({
    status,
    call: blastRadius === undefined ? {} : { blastRadius },
    expiresAt,
  });
  const ordered = [
    hold("pending", 1),
    hold("pending", 9),
    hold("pending", undefined),
    hold("rejected", 9),
    hold("pending", 3, 123),
    hold("pending", 3),
  ]
    .sort((a, b) => holdSeverity(b) - holdSeverity(a))
    .map((h) => `${h.status}:${h.call.blastRadius ?? "?"}`);

  assert.deepEqual(ordered, [
    // The write that touches everything, first.
    "pending:9",
    // Then the two radius 3 writes, the expiring one ahead of the other.
    "pending:3",
    "pending:3",
    "pending:1",
    // An unmeasured radius is not zero, so it does not outrank a measured
    // one. Sorting it to the top would claim it is the most dangerous.
    "pending:?",
    // A decision the operator already made is not waiting on anyone.
    "rejected:9",
  ]);
});

test("the sessions tab groups by state and words the summary for the tab", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-sesstree-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("first conversation");
  await app.settled();
  ui.choose("sessions");
  ui.items();
  assert.ok(ui.groupTree, "the sessions tab builds its browser");
  const shown = ui.lines().join("\n");
  // A settled conversation reports "idle", which belongs to the working set:
  // a bucket named after what is not happening would hold every finished
  // conversation, and the glyph is what separates idle from running there.
  assert.match(shown, /▾ active \(1\)/);
  assert.match(shown, /○ first conversation/);
  // The summary names what is on screen and what state it is in.
  assert.match(shown, /SESSIONS · 1 conversation · 0 running · 0 attention/);
  assert.ok(!shown.includes("documents"), "the summary speaks about sessions");
  // No tree guides: one row per conversation, indented only by its section.
  assert.doesNotMatch(shown, /\| ●/);
  assert.doesNotMatch(shown, /settled\/|other\//);
});

test("a hold with a deadline says so, and a closed one says it closed", () => {
  const now = 1_000_000;
  // A hold with no deadline is not an eternal one, it is a hold whose
  // deadline the server did not send. A countdown for it would invent a
  // number the terminal was never given.
  assert.equal(holdSecondsLeft({}, now), null);
  assert.equal(holdSecondsLeft({ expiresAt: Number.NaN }, now), null);
  // Rounded, and never negative: "0s left" reads like a value about to change.
  assert.equal(holdSecondsLeft({ expiresAt: now + 45_000 }, now), 45);
  assert.equal(holdSecondsLeft({ expiresAt: now - 10_000 }, now), 0);
  assert.equal(holdSecondsLeft({ expiresAt: now + 400 }, now), 0);
});

test("the approvals tab renders a proxy hold's deadline, and never invents one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-proxy-deadline-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  ui.choose("approvals");

  // A proxy hold arrives from the policy broker rather than from the
  // workbench's own approvals, so it is seeded where a proxy refresh puts it.
  // The undated hold omits `expiresAt` on purpose: that is the shape of a hold
  // whose deadline the server did not send, which the tab must not fill in.
  const proxyHold = (holdId: string, expiresAt?: number) => ({
    holdId,
    decisionToken: `token-${holdId}`,
    status: "pending" as const,
    call: {
      tool: "fixture.write",
      klass: "r3",
      workspace: "fixture",
      blastRadius: 1,
    },
    notify: ["cli" as const],
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
  const seedHolds = (...holds: ReturnType<typeof proxyHold>[]) => {
    ui.proxy.holds = holds as unknown as typeof ui.proxy.holds;
  };

  // One hold with a deadline and one without, in the same queue: the summary
  // must report the soonest deadline that exists, and the undated row must not
  // borrow a countdown from the dated one beside it.
  seedHolds(
    proxyHold("deadline01", Date.now() + 45_000),
    proxyHold("nodeadline02"),
  );
  const lines = ui.lines();
  const text = lines.join("\n");
  // The summary answers "how long have I got", so it names the soonest
  // deadline rather than only counting the queue.
  assert.match(text, /soonest deadline: 45s/);
  // And the countdown rides on the row itself, where the operator is looking
  // when they decide whether to read the detail before answering.
  assert.ok(
    lines.some((line) => line.includes("45s left |")),
    `no row countdown:\n${text}`,
  );
  assert.equal(
    lines.filter((line) => /\d+s left \|/.test(line)).length,
    1,
    `the undated hold borrowed a countdown:\n${text}`,
  );

  // At the smallest frame the tab is expected to work in, one body row is all
  // the terminal affords, and the viewport spends it on the selected row
  // rather than on the summary above it. The deadline still has to survive
  // there, because that row is the one the operator answers from.
  const frame = stripAnsi(renderWorkspace(ui, 40, 12));
  assert.equal(frame.split("\n").length, 12);
  assert.match(frame, /45s left \|/);
  assert.doesNotMatch(frame, /EXPIRED/);

  // With no deadline sent, the tab says so. A countdown here would invent the
  // number the server never provided, and a hold that never closes reads the
  // same way until it silently expires.
  seedHolds(proxyHold("nodeadline01"));
  const undated = ui.lines();
  const undatedText = undated.join("\n");
  assert.ok(
    undated.some((line) => line.includes("no deadline reported")),
    `no undated summary:\n${undatedText}`,
  );
  assert.ok(!undated.some((line) => line.includes("soonest deadline")));
  assert.ok(!undated.some((line) => /\d+s left \|/.test(line)));
  // Same frame, and still no invented deadline in it.
  const undatedFrame = stripAnsi(renderWorkspace(ui, 40, 12));
  assert.equal(undatedFrame.split("\n").length, 12);
  assert.doesNotMatch(undatedFrame, /\d+s left \|/);
  assert.doesNotMatch(undatedFrame, /EXPIRED/);
});

test("the ledger tab groups mixed records in the order they are read", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-ledger-groups-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start here");
  await app.settled();
  await app.editDocument(
    ui.sessionId!,
    { path: "doc.md", content: "a", expectedRevision: null },
    "tui-operator",
  );
  await ui.refresh(true);
  ui.choose("ledger");
  const rows = ui.lines();
  const text = rows.join("\n");

  // The ledger tab holds signed entries, mined rules, harness scores,
  // proposals, hooks and agents in one list. Grouped, a reader looking for a
  // refusal stops in the right block instead of stepping over four kinds.
  const order = [
    "VERIFICATION",
    "SIGNED ENTRIES",
    "LEARNED FROM THE CHAIN",
    "HARNESS SCORE",
    "HARNESS",
    "AGENTS",
    "HOOKS",
  ].filter((title) => text.includes(title));
  assert.ok(
    order.length >= 4,
    `expected several groups, got ${order.join(", ")}`,
  );
  // And in the order an operator reasons in, not the order the records
  // happened to be built in.
  const positions = order.map((title) =>
    rows.findIndex((r) => r.includes(title)),
  );
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
    `groups out of reading order: ${order.join(" -> ")}`,
  );
  // Signed entries come first because they are the only rows that are
  // evidence of anything.
  assert.ok(text.indexOf("SIGNED ENTRIES") < text.indexOf("AGENTS"));
  const entryIndex = ui.items().findIndex((row) => row.kind === "entry");
  assert.ok(entryIndex >= 0);
  ui.selected = entryIndex;
  await ui.openSelected();
  assert.match(ui.detail!.join("\n"), /entry hash/i);
  assert.match(ui.detail!.join("\n"), /previous hash/i);
  assert.doesNotMatch(ui.detail!.join("\n"), /RAW RECORD/);

  // A heading carries no number. The number is how a row is referred to, and
  // one that counts a heading would make every reference after it wrong.
  const numbered = rows.filter((row) => /\d+\.\s/.test(row));
  const headings = rows.filter((row) =>
    ["VERIFICATION", "SIGNED ENTRIES", "AGENTS", "HOOKS"].some((t) =>
      row.startsWith(t),
    ),
  );
  for (const heading of headings)
    assert.ok(!/\d+\.\s/.test(heading), `heading carries a number: ${heading}`);
  assert.ok(numbered.length >= headings.length);
});

test("Enter on a model inspects it; it does not switch the model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-modelinspect-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start here");
  await app.settled();
  const models = ui.provider?.models ?? [];
  if (!models.length) return;
  ui.choose("models");
  ui.selected = 0;
  const before = ui.model;
  await ui.openSelected();
  // Choosing a model changes what every future conversation runs on, so Enter
  // sets the default for new conversations and says so; the active
  // conversation keeps its own snapshot.
  assert.equal(ui.detail, undefined, "Enter opens no inspector panel");
  assert.match(
    ui.notice,
    new RegExp(
      `Model for new conversations: ${models[0]!.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; active conversation keeps its model\\.`,
    ),
  );
  assert.equal(ui.model, models[0]!.id);
  assert.equal(
    (await app.providerState()).defaultModel,
    models[0]!.id,
    "the stored default for future conversations did not move",
  );

  // And the way to actually choose still works, by naming the model.
  const target = models[0]!.id;
  await ui.command(`/model ${target}`);
  assert.equal(ui.model, target);
  assert.notEqual(before, undefined);
});

test("each tab builds only its own rows, and the usage tab leads with a summary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-tabrows-"));
  const { app, env } = await fixtureApp(root, "ok", {}, 73);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start here");
  await app.settled();
  await app.editDocument(
    ui.sessionId!,
    { path: "doc.md", content: "x", expectedRevision: null },
    "tui-operator",
  );

  // A row builder that forgets its tab guard does not fail loudly. It
  // silently replaces every other tab's rows with its own, and the symptom
  // is a tab that is empty for no reason anybody can see.
  for (const tab of [
    "sessions",
    "documents",
    "ledger",
    "tools",
    "approvals",
  ] as const) {
    ui.choose(tab);
    const rows = ui.items();
    if (tab === "sessions" || tab === "documents")
      assert.ok(rows.length > 0, `${tab} built no rows`);
    for (const row of rows)
      assert.ok(
        !/\| tokens /.test(row.label),
        `${tab} shows a usage row: ${row.label}`,
      );
  }

  ui.choose("usage");
  const usage = ui.lines().join("\n");
  assert.match(usage, /^TOKEN ACTIVITY\n73 reported tokens · 1\/1 records/);
  assert.match(usage, /Recent\s+1\s+[▁▂▃▄▅▆▇█]/);
  assert.match(usage, /fixture\s+73\s+[█░]+/);
  await ui.openSelected();
  assert.match(ui.detail!.join("\n"), /total:\s+73/i);
  assert.match(ui.detail!.join("\n"), /unknown, this build does not price/);
});

test("the Chat draft centers its caret in short and tall terminals", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-draft-rail-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  ui.choose("chat");
  for (const [width, height] of [[40, 12], [60, 16], [80, 24], [120, 32], [200, 48]] as const) {
    for (const [draft, cursor, active] of [
      ["", 0, ""],
      ["typed", 5, "typed"],
      ["first\nlast", 5, "first"],
      ["first\nlast", 10, "last"],
    ] as const) {
      const lines = stripAnsi(renderWorkspace(ui, width, height, draft, true, false, { cursor, color: false, motion: false })).split("\n");
      const start = lines.findIndex((line) => line.includes("╭─ Draft"));
      const end = lines.findIndex((line, index) => index > start && line.includes("╰─"));
      assert.ok(start >= 0 && end > start);
      if (height >= 16) assert.ok(end - start >= 4);
      assert.ok(lines[(start + end) / 2]?.includes(`│ ${active}█`), `${width}x${height}: centered caret at offset ${cursor}`);
      assert.equal(lines.length, height);
      assert.ok(lines.every((line) => visibleLength(line) <= width));
      assert.equal(lines.some((line) => line.startsWith("██ ██")), height >= 22 && width >= 64);
    }
  }
});

test("Enter on a session row opens a readable panel, not the transcript", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-session-open-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start here");
  await app.settled();
  ui.choose("sessions");
  const rows = ui.items();
  assert.ok(rows.length > 0, "the sessions tab has rows");
  const conversation = ui.sessionId;
  await ui.openSelected();
  // Enter resumes the conversation in Chat rather than opening a transcript
  // panel: Chat is the only place the transcript is read.
  assert.equal(ui.tab, "chat", "the conversation is restored in Chat");
  assert.equal(ui.detail, undefined, "no transcript panel opens");
  assert.equal(ui.sessionId, conversation);
  assert.ok(
    ui.lines().some((line) => line.includes("start here")),
    "the restored conversation shows its own transcript",
  );
});

test("Enter on a connector row opens the policy, not a JSON dump", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-policy-open-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  ui.choose("policy");
  const rows = ui.items();
  assert.ok(rows.length > 0, "the policy tab has connector rows");
  await ui.openSelected();
  const detail = ui.detail!.join("\n");
  // The two facts the operator came for are the first thing on the panel,
  // not buried inside a dump.
  assert.match(detail, /consent/);
  assert.match(detail, /granted|not granted/);
  assert.match(detail, /tools/);
  assert.ok(!detail.startsWith("{"), "the panel is not a raw JSON dump");
});

test("no rendered row exceeds its width, whatever glyphs it carries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-width-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start here");
  await app.settled();

  // layout.ts counts U+2600 to U+27BF as two cells. A glyph from that range
  // looks like one character on screen and shifts every column after it, so
  // the failure shows up as a dropped hint rather than as an obvious overflow.
  // Every pane, at every tab, at a width narrow enough for a row to be tight.
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
    ui.choose(tab);
    ui.items();
    for (const width of [24, 32, 40, 60, 80, 100, 140]) {
      const rendered = renderWorkspace(ui, width, 40, "hi", false, false, {
        frame: 3,
        color: true,
      });
      for (const row of stripAnsi(rendered).split("\n"))
        assert.ok(
          visibleLength(row) <= width,
          `${tab} at ${width} produced a ${visibleLength(row)} cell row: ${JSON.stringify(row)}`,
        );
    }
  }
});

test("every surface agrees on the real checklist count and prints one receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-work-theater-"));
  const checklist = [
    "Plan:",
    "- [x] read the contract",
    "- [x] write the failing test",
    "- [x] record evidence",
    "- [ ] run the suite",
    "- [ ] hand off",
    "- [ ] review the diff",
    "- [ ] close the run",
  ].join("\n");
  const { app, env } = await fixtureApp(root, checklist, {}, 120);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start here");
  await app.settled();

  const frame = (width: number, height: number) =>
    stripAnsi(
      renderWorkspace(ui, width, height, "", false, false, {
        color: false,
        motion: false,
      }),
    ).split("\n");

  // The chip and the rail heading are two renderings of one measurement, so a
  // frame that shows both must never disagree about it.
  const medium = frame(80, 24);
  assert.equal(medium.length, 24);
  assert.match(medium.join("\n"), /TODO 3\/7/);
  const mediumReceipts = medium.filter((row) => row.includes("RUN "));
  assert.equal(mediumReceipts.length, 1, "80x24 prints the receipt once");
  assert.match(mediumReceipts[0]!, /tok 120/);

  // A frame with the rail prints the receipt as a card there and not as a
  // second header row, so the same numbers are never said twice.
  const wide = frame(120, 40);
  assert.equal(wide.length, 40);
  const wideReceipts = wide.filter((row) => row.includes("RUN "));
  assert.equal(wideReceipts.length, 1, "120x40 prints the receipt once");
  assert.match(wide.join("\n"), /TODO 3\/7 ━+╸─+/);
  assert.match(wide.join("\n"), /tokens 120/);
  // The rail never carries a metric the frame did not measure.
  assert.doesNotMatch(wide.join("\n"), /tests (?:passed|failed)/);

  // A frame too short for either surface keeps its decision keys instead and
  // still reports the real count on the row it already had.
  const compact = frame(40, 12);
  assert.equal(compact.length, 12);
  assert.match(compact.join("\n"), /3\/7/);
  assert.ok(!compact.join("\n").includes("RUN "));
});

test("a typed command hints what argument it wants, and stays silent otherwise", () => {
  // Once the command and a space are typed, the useful thing to say is what
  // it wants next, not what it is called.
  assert.equal(commandArgumentHint("/model "), "exact-ID");
  assert.equal(commandArgumentHint("/mcp probe "), "ID");
  // A subcommand carries its own shape. The longest matching prefix wins, so
  // the hint never says "verb" once the noun is already typed.
  assert.equal(
    commandArgumentHint("/mcp "),
    "inspect, add, probe, confirm, rename or remove",
  );
  // Commands that take nothing say nothing. A guessed placeholder would put a
  // word on screen the command does not accept.
  assert.equal(commandArgumentHint("/todos "), undefined);
  assert.equal(commandArgumentHint("/compact "), undefined);
  assert.equal(commandArgumentHint("/nonsense "), undefined);
  assert.equal(commandArgumentHint("plain text"), undefined);
});

test("Shift+Tab modes cycle with a visible indicator", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-mode-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  assert.equal(ui.mode, "normal");
  ui.cycleMode();
  assert.equal(ui.mode, "accept");
  ui.cycleMode();
  assert.equal(ui.mode, "plan");
  ui.cycleMode();
  assert.equal(ui.mode, "normal");
  ui.cycleMode();
  ui.cycleMode();
  assert.equal(ui.mode, "plan");
  // Chat keeps the composer free of mode labels; the mode is stated where the
  // frame has a rail for it, so open a panel and read the footer.
  assert.doesNotMatch(
    stripAnsi(renderWorkspace(ui, 100, 32)),
    /mode: plan/,
    "the Chat composer never carries a mode label",
  );
  ui.choose("runs");
  const frame = stripAnsi(renderWorkspace(ui, 100, 32));
  assert.match(frame, /mode: plan \(local only, not enforced\)/);
  assert.match(frame, /○ mode: plan/, "the mode pill keeps its icon");
});

test("plan mode prefixes prompts so the model plans first", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-plan-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  ui.mode = "plan";
  await ui.command("build the thing");
  await app.settled();
  const events = app.get(ui.sessionId!)!.events;
  const sent = events.find((event) => event.kind === "user")!;
  assert.match(sent.text, /^Plan only\./);
  assert.match(sent.text, /build the thing/);
});

test("a prompt sent during a run is queued, never dropped", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-queue-"));
  let release: ((value: Response) => void) | undefined;
  const gate = () =>
    new Promise<Response>((done) => {
      release = done;
    });
  const full = { NOMO_DATA_DIR: root };
  const app = new Workbench(full, async (url: unknown) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    return gate();
  });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture-key",
  });
  const ui = new WorkspaceTui(app, full);
  await ui.initialize();
  await ui.command("first prompt");
  assert.equal(app.running(), true);
  await ui.command("second prompt");
  assert.equal(ui.queuedPrompt, "second prompt");
  assert.match(ui.notice, /queued/i);
  release!(
    Response.json({
      choices: [{ message: { role: "assistant", content: "done" } }],
    }),
  );
  await app.settled();
  assert.equal(ui.takeQueued(), "second prompt");
  assert.equal(ui.takeQueued(), null);
});

test("Ctrl+R maps in every editing state for history search", () => {
  assert.equal(
    workspaceShortcut({ name: "r", ctrl: true }, true, ""),
    "search-history",
  );
  assert.equal(
    workspaceShortcut({ name: "r", ctrl: true }, true, "draft"),
    "search-history",
  );
  assert.equal(workspaceShortcut({ name: "r" }, true, ""), undefined);
});

test("prompt history search is case insensitive and keeps recency", () => {
  const prompts = ["Build the plan", "fix the leak", "Build the demo"];
  assert.deepEqual(searchHistoryPrompts(prompts, ""), prompts);
  assert.deepEqual(searchHistoryPrompts(prompts, "build"), [
    "Build the plan",
    "Build the demo",
  ]);
  assert.deepEqual(searchHistoryPrompts(prompts, "LEAK"), ["fix the leak"]);
  assert.deepEqual(searchHistoryPrompts(prompts, "missing"), []);
});

test("double Escape opens checkpoints, single Escape only closes", () => {
  assert.equal(isDoubleEscape(1000, 1000), true);
  assert.equal(isDoubleEscape(1799, 1000), true);
  assert.equal(isDoubleEscape(1801, 1000), false);
  assert.equal(isDoubleEscape(1000, 0), false);
  assert.equal(isDoubleEscape(900, 1000), false);
});

test("gated shell shows output once and refuses key material", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-shell-"));
  const full = { NOMO_DATA_DIR: root, NOMO_TUI_ENV_PROBE: "probe-secret" };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  await ui.command("!echo parity-ok");
  assert.ok(ui.detail?.join("\n").includes("parity-ok"));
  assert.match(ui.notice, /never persisted/);
  await assert.rejects(ui.command("!echo $TOKENHARBOR_API_KEY"), /Refused/);
  await assert.rejects(
    ui.command("!cat ~/.nomo/keys/dev-ed25519.pkcs8"),
    /Refused/,
  );
  await assert.rejects(ui.command("!printenv OPENROUTER_API_KEY"), /Refused/);
  await assert.rejects(
    ui.command("!printenv NOMO_TUI_ENV_PROBE"),
    /Local command failed/,
  );
});

// Failing on purpose is spelled per platform, because the two shells disagree
// on what a non-zero exit with no output looks like. `false` is a POSIX
// builtin and a trailing argument is ignored; cmd.exe has no `false` at all
// and answers "not recognized" on stderr, which is output the operator would
// see and which therefore never reaches the redaction path this test exists to
// exercise. `exit 1 <arg>` is the cmd.exe spelling: cmd ignores the extra
// argument and exits non-zero with both streams empty, which is the same
// observable shape `false` produces under sh. The secret rides in the argv in
// both cases, so the error message built from the failed command still has to
// come back scrubbed.
const failingWithSecret = process.platform === "win32" ? "exit 1" : "false";

test("shell output redacts exact stored secret values", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-redact-"));
  const full = {
    NOMO_DATA_DIR: root,
    TOKENROUTER_API_KEY: "qk7-redact-me",
    NVIDIA_API_KEY: "nv7-x91k3p",
  };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  // echo is a builtin in both sh and cmd.exe, so the successful-output half of
  // the property needs no per-platform spelling and runs identically on each.
  await ui.command("!echo qk7-redact-me nv7-x91k3p");
  const shown = ui.detail?.join("\n") ?? "";
  assert.ok(shown.includes("[redacted]"));
  assert.ok(!shown.includes("qk7-redact-me"));
  assert.ok(!shown.includes("nv7-x91k3p"));
  await assert.rejects(
    ui.command(`!${failingWithSecret} nv7-x91k3p`),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("nv7-x91k3p"));
      return error.message.includes("[redacted]");
    },
  );
});

test("@ tokens complete from managed paths and quote on send", async (t) => {
  assert.equal(mentionToken("see @pla", 8), "pla");
  assert.equal(mentionToken("see @plan.md ", 13), undefined);
  assert.equal(mentionToken("no token here", 13), undefined);
  assert.deepEqual(mentionCandidates("pl", ["plan.md", "other.md"]), [
    "plan.md",
  ]);
  assert.deepEqual(
    mentionCandidates("", [
      "a.md",
      "b.md",
      "c.md",
      "d.md",
      "e.md",
      "f.md",
      "g.md",
      "h.md",
      "i.md",
    ]),
    ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md", "h.md"],
  );
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-mention-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start here");
  await app.settled();
  const id = ui.sessionId!;
  await app.editDocument(
    id,
    { path: "plan.md", content: "quoted content", expectedRevision: null },
    "tui-operator",
  );
  assert.deepEqual(ui.documentPaths(), ["plan.md"]);
  const expanded = ui.expandMentions("read @plan.md please", id);
  assert.deepEqual(expanded.missing, []);
  assert.match(expanded.expanded, /quoted content/);
  const unknown = ui.expandMentions("read @ghost.md please", id);
  assert.deepEqual(unknown.missing, ["ghost.md"]);
  await assert.rejects(ui.command("read @ghost.md"), /Unknown @path/);
});

test("todos come from real agent output, /todos lists them", async (t) => {
  const direct = extractTodos([
    {
      seq: 1,
      kind: "assistant",
      type: "message.completed",
      text: "- [ ] step one\n- [x] done step",
    },
    { seq: 2, kind: "tool", type: "tool.result", text: "- [ ] not a todo" },
    { seq: 3, kind: "assistant", type: "message.delta", text: "- [ ] draft" },
  ]);
  assert.equal(direct.length, 2);
  assert.equal(direct[0]!.text, "step one");
  assert.equal(direct[0]!.done, false);
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-todos-"));
  const { app, env } = await fixtureApp(root, "- [ ] ship it\n- [x] done");
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("do the work");
  await app.settled();
  await ui.command("/todos");
  assert.ok(ui.detail?.join("\n").includes("ship it"));
  const frame = stripAnsi(renderWorkspace(ui, 100, 32));
  assert.match(frame, /ship it/);
});

test("a structured todo event reaches the live TUI rail", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-todo-event-"));
  let called = false;
  const app = new Workbench(
    { NOMO_DATA_DIR: root },
    async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/models"))
        return Response.json({ data: [{ id: "fixture" }] });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const tool = (body.tools ?? []).find(
        (item: { function?: { description?: string } }) =>
          item.function?.description?.startsWith("todo_write:"),
      );
      if (tool && !called) {
        called = true;
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "todo-1",
                    type: "function",
                    function: {
                      name: tool.function.name,
                      arguments: JSON.stringify({
                        items: [
                          { text: "read the contract", status: "completed" },
                          { text: "run the suite", status: "in_progress" },
                          { text: "record evidence", status: "pending" },
                        ],
                      }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      }
      return Response.json({
        choices: [
          { message: { role: "assistant", content: "Done" }, finish_reason: "stop" },
        ],
      });
    },
  );
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture-key" });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.initialize();
  await ui.command("do the work");
  await app.settled();
  const frame = stripAnsi(renderWorkspace(ui, 100, 32));
  assert.match(frame, /TODO 1\/3/);
  assert.match(frame, /\[x\] ✓ read the contract/);
  assert.match(frame, /\[~\] run the suite/);
  assert.match(frame, /\[ \] record evidence/);
  await ui.command("/todos");
  assert.ok(ui.detail?.join("\n").includes("2 open of 3"));
});

test("/context /cost /status report retained numbers, cost stays unknown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-numbers-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("hello");
  await app.settled();
  await ui.command("/context");
  assert.equal(ui.tab, "documents");
  assert.ok(ui.detail?.join("\n").includes("Messages:"));
  await ui.command("/cost");
  assert.equal(ui.tab, "usage");
  assert.ok(ui.detail?.join("\n").includes("Cost: unknown"));
  assert.ok(!ui.detail?.join("\n").includes("CZK"));
  await ui.command("/status");
  assert.equal(ui.tab, "status");
  // /status is a rendered panel rather than a detail list, so the numbers are
  // read from the frame. It reports the runtime it can observe and keeps an
  // unknown cost unknown instead of inventing one.
  const statusPanel = stripAnsi(renderWorkspace(ui, 100, 32));
  assert.ok(
    statusPanel.includes("RUNTIME"),
    "the status panel keeps the runtime section",
  );
  assert.match(
    statusPanel,
    /Provider \S+ \| (?:ready|unavailable)/,
    "the runtime section names the provider state",
  );
  assert.match(
    statusPanel,
    /run \S+ · queue \d+ · context \S+ tokens · cost \?/,
    "the runtime line reports run, queue and context without a guessed cost",
  );
  assert.match(
    statusPanel,
    /mode: normal \(local only, not enforced\)/,
    "the panel footer keeps the local only authority label",
  );
});

test("/compact reports a confirmed no-op without claiming provider summarization", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-compact-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("remember this request");
  await app.settled();
  await ui.command("/compact");
  assert.match(ui.confirmation!.lines.join("\n"), /No provider summarization/);
  await ui.confirm();
  const shown = ui.lines().join("\n");
  assert.match(shown, /Omitted messages: 0/);
  assert.match(shown, /No messages needed compaction/);
  assert.match(ui.notice, /Context unchanged/);
});

test("/agents /config /memory read live data without secrets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-agents-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("agent work");
  await app.settled();
  await ui.command("/agents");
  assert.ok(ui.detail?.join("\n").includes("connector: NOMO documents"));
  await ui.command("/config");
  const config = ui.detail?.join("\n") ?? "";
  assert.ok(config.includes("data-dir"));
  assert.ok(!config.includes("fixture-key"));
  await ui.command("/memory");
  // The memory view is an inspector now, so the count is an aligned field
  // rather than a sentence. What this protects is that it reports live data.
  assert.match(ui.detail?.join("\n") ?? "", /conversations *: *1/);
});

test("provider only commands reject what NOMO cannot do", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-unsupported-"));
  const full = { NOMO_DATA_DIR: root };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  for (const cmd of ["/vim", "/terminal-setup", "/output-style"])
    await assert.rejects(ui.command(cmd), /no NOMO equivalent/);
});

test("/login reuses provider setup, /logout disconnects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-login-"));
  const full = { NOMO_DATA_DIR: root };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  await assert.rejects(ui.command("/login unknown-source"), /./);
  await ui.command("/logout");
  assert.match(ui.notice, /logged out locally/i);
  assert.match(ui.notice, /revoke keys with their providers/i);
  assert.equal(ui.model, "");
});

test("/init creates a starter plan when the run is idle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-init-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start the workspace");
  await app.settled();
  await ui.command("/init");
  assert.match(app.workspace(ui.sessionId!).files["plan.md"] ?? "", /# Plan/);
});

test("review needs an explicit accept or reject key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-review-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start here");
  await app.settled();
  const id = ui.sessionId!;
  await app.editDocument(
    id,
    { path: "doc.md", content: "before", expectedRevision: null },
    "tui-operator",
  );
  ui.sessionId = id;
  ui.documentPath = "doc.md";
  ui.prepareEdit(ui.editTarget(), "after");
  ui.reject();
  assert.equal(ui.confirmation, undefined);
  assert.match(ui.notice, /Rejected/);
  assert.equal(app.workspace(id).files["doc.md"], "before");
});

test("compact prompt frame stays continuous at narrow widths", async (t) => {
  assert.equal(visibleLength(promptFrameTop("Write a prompt", 80)), 80);
  assert.equal(visibleLength(promptFrameBottom(80)), 80);
  assert.equal(visibleLength(promptFrameRow("> hello_", 80)), 80);
  assert.ok(promptFrameTop("Write a prompt", 20).startsWith("┌"));
  assert.ok(promptFrameTop("Write a prompt", 20).endsWith("┐"));
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-frame-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  for (const [width, height] of [
    [20, 8],
    [20, 12],
    [40, 12],
  ]) {
    const rows = stripAnsi(
      renderWorkspace(ui, width, height, "hello_", true, false, { cursor: 6 }),
    ).split("\n");
    assert.equal(rows.length, height);
    assert.ok(rows.every((line) => visibleLength(line) <= width));
    // The composer frame is rounded and closes at the terminal edge.
    const top = rows.find((line) => line.includes("╭─ Draft"));
    assert.ok(top, `${width}x${height} loses the rounded top`);
    assert.ok(top!.startsWith("╭") || top!.includes("╭"), "rounded corner");
    assert.equal(visibleLength(top!), width);
    if (height >= 12) {
      const bottom = rows.find((line) => line.includes("╰"));
      assert.ok(bottom, `${width}x${height} loses the rounded bottom`);
      assert.equal(visibleLength(bottom!), width);
    } else {
      // At eight rows the composer collapses to its top rule plus one draft
      // row so the input surface survives the smaller viewport.
      assert.ok(
        rows.some((line) => line.includes("hello_▌")),
        `${width}x${height} loses the draft row`,
      );
    }
  }
});

test("the composer v2 rail holds five sizes with real chips and no background", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-composer-v2-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");
  ui.model = "fixture-model";
  for (const [width, height] of [
    [40, 12],
    [60, 16],
    [80, 24],
    [120, 40],
    [200, 48],
  ] as const) {
    for (const color of [false, true]) {
      const frame = renderWorkspace(ui, width, height, "", true, false, {
        color,
        motion: false,
        ...(color
          ? {
              capabilities: {
                interactive: true,
                ansi: true,
                colorDepth: 24 as const,
                columns: width,
                rows: height,
                reason: "interactive" as const,
              },
            }
          : {}),
      });
      const rows = frame.split("\n");
      assert.equal(rows.length, height, `${width}x${height} rows`);
      assert.ok(
        rows.every((row) => visibleLength(row) <= width),
        `${width}x${height} overflows`,
      );
      const plain = rows.map((row) => stripAnsi(row));
      const rail = plain.find((row) => row.includes("╭─ Draft"));
      assert.ok(rail, `${width}x${height} loses the rail`);
      assert.equal(visibleLength(rail!), width, `${width}x${height} rail width`);
      // The hint and the real model chip share the rail; the chip never
      // replaces the next action or the activity keys on the last row.
      assert.ok(rail!.includes("Enter send"), `${width}x${height} loses the hint`);
      assert.ok(
        !rail!.includes("◐ fixture-model"),
        `${width}x${height} duplicates the model in the composer rail`,
      );
      assert.ok(
        plain.some((row) =>
          row.includes(width >= 80 ? "◐ fixture-model" : "◐ fixtur"),
        ),
        `${width}x${height} loses the model from the status row`,
      );
      assert.ok(
        plain.at(-1)!.includes("◆ 0"),
        `${width}x${height} loses the activity keys`,
      );
      if (color) {
        assert.ok(
          !frame.includes("48;"),
          `${width}x${height} paints a background`,
        );
        assert.ok(
          frame.includes("38;2;"),
          `${width}x${height} loses the truecolor gradient`,
        );
      } else {
        assert.doesNotMatch(
          frame,
          /\x1b\[[0-9;]*m/,
          `${width}x${height} paints without colour`,
        );
      }
    }
  }
});

test("live status stays within the compact ASCII identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-ascii-status-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");
  const frame = renderWorkspace(ui, 80, 30, "_", true, true, {
    frame: 4,
    motion: false,
  });
  assert.doesNotMatch(frame, /[⏳🔧✍️💭⚠️📜]/u);
  // The workspace has no provider configured, so the phase names what it is
  // actually waiting on rather than guessing at model work.
  assert.match(frame, /◌ Waiting for provider/);
});

test("branch intent reuses its idempotency key after a transient failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-branch-key-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("first prompt");
  await app.settled();
  const parent = ui.sessionId!;
  const seq = app
    .get(parent)!
    .events.find((event) => event.kind === "user")!.seq;
  const original = app.branch.bind(app);
  const keys: string[] = [];
  t.mock.method(
    app,
    "branch",
    async (id: string, body: Parameters<Workbench["branch"]>[1]) => {
      keys.push(body.idempotencyKey);
      if (keys.length === 1) throw Error("transient branch failure");
      return original(id, body);
    },
  );
  await assert.rejects(
    ui.command(`/branch ${seq}`),
    /transient branch failure/,
  );
  await ui.command(`/branch ${seq}`);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.match(keys[0]!, /^[0-9a-f-]{36}$/);
});

test("legacy monochrome snapshot has no color escapes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-icon-tone-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  const mono = renderWorkspace(ui, 100, 32, "", false, false, { color: false });
  assert.doesNotMatch(mono, /\x1b\[[0-9;]*m/);
  assert.match(stripAnsi(mono), /NOMO {2}Chat/);
  assert.doesNotMatch(stripAnsi(mono), /NOMO \/ overview/);
});

test("icons stay one cell wide and never carry safety meaning", () => {
  for (const icon of [...Object.values(TAB_ICONS), ...Object.values(MODE_ICON)])
    assert.equal(visibleLength(icon), 1, icon);
  assert.equal(TAB_ICONS.chat, "●");
  assert.equal(MODE_ICON.plan, "○");
});

test("newline keys match the reference terminal", () => {
  const input = new WorkspaceInput();
  input.editing = true;
  assert.equal(input.key(undefined, { name: "j", ctrl: true }), undefined);
  assert.equal(input.value, "\n");
  input.set("ab");
  assert.equal(input.key(undefined, { name: "enter", shift: true }), undefined);
  assert.equal(input.value, "ab\n");
  input.set("cd");
  assert.equal(input.key(undefined, { name: "enter", meta: true }), undefined);
  assert.equal(input.value, "cd\n");
  input.set("trail\\");
  assert.equal(input.key("\r", { name: "return" }), undefined);
  assert.equal(input.value, "trail\n");
  input.set("send me");
  assert.equal(input.key("\r", { name: "return" }), "submit");
});

test("kill ring and input undo cover the editing keys", () => {
  const input = new WorkspaceInput();
  input.editing = true;
  input.set("hello world");
  input.cursor = 11;
  input.key(undefined, { name: "w", ctrl: true });
  assert.equal(input.value, "hello ");
  input.key(undefined, { name: "y", ctrl: true });
  assert.equal(input.value, "hello world");
  input.set("abcdef");
  input.cursor = 3;
  assert.equal(input.key(undefined, { name: "d", ctrl: true }), undefined);
  assert.equal(input.value, "abcef");
  input.key(undefined, { name: "_", ctrl: true });
  assert.equal(input.value, "abcdef");
  input.set("src/utils/foo.ts");
  input.cursor = 16;
  input.key(undefined, { name: "b", meta: true });
  assert.equal(input.cursor, 14);
  input.key(undefined, { name: "f", meta: true });
  assert.equal(input.cursor, 16);
  input.cursor = 4;
  input.key(undefined, { name: "d", meta: true });
  assert.equal(input.value, "src/utils/foo.ts".replace("utils", ""));
});

test("Ctrl+T transposes in the composer and opens TODOs outside editing", () => {
  const input = new WorkspaceInput();
  input.editing = true;
  input.set("nomo");
  input.cursor = 3;
  assert.equal(
    workspaceShortcut({ name: "t", ctrl: true }, true, "nomo"),
    undefined,
  );
  input.key(undefined, { name: "t", ctrl: true });
  assert.equal(input.value, "noom");
  assert.equal(
    workspaceShortcut({ name: "t", ctrl: true }, false, ""),
    "show-todos",
  );
  assert.equal(workspaceShortcut({ name: "t" }, true, "draft"), undefined);
});

test("Ctrl+X Ctrl+E chord arms, fires and disarms", () => {
  const chord = new ChordTracker();
  assert.equal(chord.chord({ name: "x", ctrl: true }, 1000), undefined);
  assert.equal(chord.chord({ name: "e", ctrl: true }, 1100), "external-editor");
  assert.equal(chord.chord({ name: "e", ctrl: true }, 1200), undefined);
  const stale = new ChordTracker();
  assert.equal(stale.chord({ name: "x", ctrl: true }, 1000), undefined);
  assert.equal(stale.chord({ name: "e", ctrl: true }, 3000), undefined);
  const broken = new ChordTracker();
  assert.equal(broken.chord({ name: "x", ctrl: true }, 1000), undefined);
  assert.equal(broken.chord({ name: "a", ctrl: true }, 1100), undefined);
  assert.equal(broken.chord({ name: "e", ctrl: true }, 1200), undefined);
  assert.equal(
    new ChordTracker().chord({ name: "e", ctrl: true }, 1000),
    undefined,
  );
});

test("prompt jumps move between user rows only", () => {
  const rows = [3, 9, 20];
  assert.equal(nextPromptRow(rows, 0, 1), 3);
  assert.equal(nextPromptRow(rows, 3, 1), 9);
  assert.equal(nextPromptRow(rows, 20, 1), -1);
  assert.equal(nextPromptRow(rows, 20, -1), 9);
  assert.equal(nextPromptRow(rows, 3, -1), -1);
  assert.equal(nextPromptRow([], 0, 1), -1);
});

test("prompt frame follows the permission mode color", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-frame-tone-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  // The prompt frame no longer tints itself by mode; the mode is carried by
  // the panel footer pill, which is the surface that states authority. Give
  // the renderer explicit ANSI capabilities so colour is actually emitted.
  const ansiCaps = {
    columns: 100,
    rows: 32,
    colorDepth: 24 as const,
    ansi: true,
    reason: "interactive" as const,
    interactive: true,
  };
  const pillFor = (mode: "normal" | "accept" | "plan") => {
    ui.mode = mode;
    ui.choose("runs");
    const frame = renderWorkspace(ui, 100, 32, "", false, false, {
      color: true,
      capabilities: ansiCaps,
    });
    const line = frame
      .split("\n")
      .find((row) => row.includes(`mode: ${mode} (local only, not enforced)`));
    assert.ok(line, `the ${mode} pill is not rendered`);
    return line;
  };
  // Every mode pill is painted, and each mode keeps its own glyph.
  for (const mode of ["plan", "accept", "normal"] as const) {
    const line = pillFor(mode);
    assert.match(line, /\x1b\[[0-9;]*38;/, `${mode} pill is not painted`);
    assert.ok(line.includes(`${MODE_ICON[mode]} mode: ${mode}`));
  }
});

test("render collects user prompt rows for jumps", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-prompt-rows-"));
  const { app, env } = await fixtureApp(root, "answer one");
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("first question");
  await app.settled();
  await ui.command("second question");
  await app.settled();
  renderWorkspace(ui, 100, 40, "_", true);
  assert.equal(ui.promptRows.length, 2);
  assert.ok(ui.promptRows[0]! < ui.promptRows[1]!);
});

test("arrow keys cycle panels in navigation, cursor in editing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-arrows-"));
  const full = { NOMO_DATA_DIR: root };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  // Chat is the base screen; there is no overview to cycle through.
  assert.equal(ui.tab, "chat");
  ui.cycle(1);
  assert.equal(ui.tab, "sessions");
  ui.cycle(-1);
  assert.equal(ui.tab, "chat");
  // The retired landing panel still routes to Chat rather than becoming a
  // dead stop in the cycle.
  ui.choose("overview");
  assert.equal(ui.tab, "chat");
  ui.cycle(-1);
  assert.equal(ui.tab, "help");
  const input = new WorkspaceInput();
  input.editing = true;
  input.set("ab");
  input.key(undefined, { name: "left" });
  assert.equal(input.cursor, 1);
  input.key(undefined, { name: "right" });
  assert.equal(input.cursor, 2);
});

test("block cursor, Ctrl arrows and queued badge", async (t) => {
  const input = new WorkspaceInput();
  input.editing = true;
  input.set("src/utils/foo.ts");
  assert.equal(input.display(), "src/utils/foo.ts▌");
  input.cursor = 16;
  input.key(undefined, { name: "left", ctrl: true });
  assert.equal(input.cursor, 14);
  input.key(undefined, { name: "right", ctrl: true });
  assert.equal(input.cursor, 16);
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-queued-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  ui.queuePrompt("later");
  // 140 columns fit the full summary including the local only mode label;
  // narrower frames truncate the tail by the pre-existing fit() behavior.
  const frame = stripAnsi(renderWorkspace(ui, 140, 32));
  assert.match(frame, /≡ 1 queued/);
});

test("typing filters lists, bound keys keep their action", () => {
  // Every printable character filters a supported list, including the letters
  // that used to be single-key actions on these tabs.
  assert.equal(filterKeyForTab("m", { name: undefined }, "models"), "m");
  assert.equal(filterKeyForTab("u", { name: undefined }, "models"), "u");
  assert.equal(filterKeyForTab("q", { name: undefined }, "models"), "q");
  assert.equal(filterKeyForTab("?", { name: undefined }, "models"), "?");
  // Chat and Help have no list to filter, so their keys keep their action.
  assert.equal(filterKeyForTab("m", { name: undefined }, "chat"), undefined);
  assert.equal(filterKeyForTab("m", { name: undefined }, "help"), undefined);
  // A control chord is never a filter character.
  assert.equal(
    filterKeyForTab("m", { name: "m", ctrl: true }, "models"),
    undefined,
  );
  assert.equal(filterKeyForTab("", { name: undefined }, "models"), undefined);
  assert.equal(filterKeyForTab("ab", { name: undefined }, "models"), undefined);
  assert.equal(filterKeyForTab("5", { name: undefined }, "ledger"), "5");
});

test("stash, editor and quit map only the intended control keys", () => {
  assert.equal(
    workspaceShortcut({ name: "s", ctrl: true }, true, "draft"),
    "stash",
  );
  assert.equal(
    workspaceShortcut({ name: "s", ctrl: true }, false, ""),
    "stash",
  );
  assert.equal(
    workspaceShortcut({ name: "g", ctrl: true }, true, "draft"),
    "external-editor",
  );
  assert.equal(workspaceShortcut({ name: "s" }, true, "draft"), undefined);
  assert.equal(workspaceShortcut({ name: "g" }, true, "draft"), undefined);
});

test("approval rows carry class, radius and the matched case", () => {
  assert.equal(
    approvalLabel({
      holdId: "abc123",
      status: "pending",
      call: {
        tool: "stripe.refund.create",
        klass: "r2",
        reason: "Money moves.",
      },
    }),
    "[pending] [R2] stripe.refund.create abc123 radius unknown Money moves.",
  );
  assert.equal(
    approvalLabel({
      holdId: "abc123",
      status: "approved",
      call: { tool: "db.row.delete", klass: "r3", blastRadius: 3 },
    }),
    "[approved] [R3] db.row.delete abc123 radius 3",
  );
  assert.equal(
    approvalLabel({ holdId: "abc123", status: "pending", call: { tool: "x" } }),
    "[pending] x abc123 radius unknown",
  );
});

test("undo review states the drift check before the diff", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-undo-drift-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start here");
  await app.settled();
  const id = ui.sessionId!;
  await app.editDocument(
    id,
    { path: "doc.md", content: "before", expectedRevision: null },
    "tui-operator",
  );
  ui.sessionId = id;
  ui.documentPath = "doc.md";
  await ui.prepareUndo();
  assert.equal(ui.confirmation?.title, "UNDO doc.md?");
  assert.ok(ui.confirmation?.lines.join("\n").includes("Drift check passed"));
});

test("/conformance proves the adapter behind TUI edits inside the TUI", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-conformance-"));
  const full = { NOMO_DATA_DIR: root };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  await ui.command("/conformance");
  assert.match(ui.detail?.[0] ?? "", /conformance managed-documents exit 0/);
  assert.match(ui.detail?.join("\n") ?? "", /write: PASS/);
  assert.match(ui.detail?.join("\n") ?? "", /human-drift/);
  assert.match(ui.notice, /passed/);
  await assert.rejects(ui.command("/conformance unknown"), /managed-documents/);
  assert.ok(
    commandSuggestions("/conf").some(([name]) => name === "/conformance"),
  );
});

test("/plan /stats /exit /keybindings match the reference commands", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-cmds-"));
  const full = { NOMO_DATA_DIR: root };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  await ui.command("/plan");
  assert.equal(ui.mode, "plan");
  assert.match(ui.notice, /Plan mode/);
  assert.equal(await ui.command("/exit"), "quit");
  await ui.command("/stats");
  assert.equal(ui.tab, "usage");
  assert.ok(ui.detail?.join("\n").includes("Cost: unknown"));
  await ui.command("/keybindings");
  assert.ok(ui.detail?.join("\n").includes("Ctrl+J"));
  assert.ok(ui.detail?.join("\n").includes("Shift+Tab"));
  // Alt+M is the only default picker binding; Alt+P is the current
  // conversation's own picker, so it is listed separately.
  assert.ok(ui.detail?.join("\n").includes("Alt+M"));
  assert.ok(!ui.detail?.join("\n").includes("Alt+M / Shift+Alt+M"));
  for (const cmd of ["/plan", "/stats", "/diff", "/keybindings", "/exit"])
    assert.ok(
      commandSuggestions(cmd).some(([name]) => name === cmd),
      `${cmd} should complete`,
    );
});

test("/diff shows outstanding changes and empties after undo", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-diff-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start here");
  await app.settled();
  const id = ui.sessionId!;
  await app.editDocument(
    id,
    { path: "doc.md", content: "before", expectedRevision: null },
    "tui-operator",
  );
  await ui.command("/diff");
  // The header names the position in the outstanding list and the file, so a
  // reviewer reading a hunk always knows which change it belongs to.
  assert.match(ui.detail?.join("\n") ?? "", /DIFF 1 of 1: doc\.md/);
  assert.match(ui.detail?.join("\n") ?? "", /before/);
  ui.sessionId = id;
  ui.documentPath = "doc.md";
  await ui.prepareUndo();
  await ui.confirm();
  await ui.command("/diff");
  assert.match(ui.detail?.join("\n") ?? "", /No outstanding changes/);
});

test("/diff keeps review state across re-renders and resets it per operation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-diffstate-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start here");
  await app.settled();
  const id = ui.sessionId!;
  // Twenty four lines with edits at both ends. The gap has to exceed twice the
  // three lines of context or the two edits merge into a single hunk, and a
  // test that only ever sees one hunk cannot tell staging from a no-op.
  const wide = Array.from({ length: 24 }, (_, i) => `line ${i + 1}`);
  const edited = [...wide];
  edited[0] = "FIRST CHANGED";
  edited[23] = "LAST CHANGED";
  await app.editDocument(
    id,
    { path: "wide.md", content: wide.join("\n"), expectedRevision: null },
    "tui-operator",
  );
  await app.editDocument(
    id,
    {
      path: "wide.md",
      content: edited.join("\n"),
      expectedRevision: (await app.documentsList()).find(
        (d) => d.path === "wide.md",
      )!.revision,
    },
    "tui-operator",
  );
  await ui.command("/diff");
  assert.ok(ui.diffView, "/diff opens a review view");
  // Operation one is the file creation. Operation two is the edit that
  // touches both ends of the file, so that is the one with two hunks.
  await ui.command("/diff-next");
  const view = ui.diffView;
  assert.ok(view, "/diff-next opens the second review view");
  assert.ok(
    view.hunks.length >= 2,
    `two distant edits must be two hunks, got ${view.hunks.length}`,
  );
  assert.ok(
    view.hunks.every((hunk) => hunk.staged),
    "every hunk starts staged",
  );

  // Moving the cursor and staging a hunk must survive a re-render, which is
  // the whole point of keeping state outside the printed lines.
  ui.diffView = moveHunk(view, 1);
  ui.rediff();
  assert.equal(ui.diffView.cursor, 1, "cursor survives the re-render");
  ui.diffView = toggleHunk(ui.diffView, ui.diffView.cursor);
  ui.rediff();
  assert.equal(ui.diffView.hunks[1]?.staged, false, "staged flag survives");
  assert.match(
    ui.detail?.join("\n") ?? "",
    /staged 1\/2/,
    "the panel reports the count",
  );

  // The side toggle is a pure view choice and must not disturb staging.
  ui.diffView = setSide(ui.diffView, "split");
  ui.rediff();
  assert.equal(ui.diffView.side, "split");
  assert.equal(
    ui.diffView.hunks[1]?.staged,
    false,
    "side keeps the staged flag",
  );

  // A different operation is a different document, so the state resets.
  await app.editDocument(
    id,
    { path: "other.md", content: "one", expectedRevision: null },
    "tui-operator",
  );
  await ui.command("/diff-next");
  assert.ok(ui.diffView, "/diff-next opens a review view");
  assert.ok(
    ui.diffView.hunks.every((hunk) => hunk.staged),
    "a new operation starts fully staged",
  );
});

test("/diff-next steps through outstanding operations and wraps", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-diffnext-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start here");
  await app.settled();
  const id = ui.sessionId!;
  // Three separate paths, so every edit is a creation and each one becomes
  // its own outstanding operation for the panel to step through.
  for (const name of ["one", "two", "three"])
    await app.editDocument(
      id,
      { path: `doc-${name}.md`, content: name, expectedRevision: null },
      "tui-operator",
    );
  await ui.command("/diff");
  assert.match(ui.detail?.join("\n") ?? "", /DIFF 1 of 3/);
  await ui.command("/diff-next");
  assert.match(ui.detail?.join("\n") ?? "", /DIFF 2 of 3/);
  await ui.command("/diff-next");
  assert.match(ui.detail?.join("\n") ?? "", /DIFF 3 of 3/);
  // Wrapping back to the first panel is what makes the key safe to hold down.
  await ui.command("/diff-next");
  assert.match(ui.detail?.join("\n") ?? "", /DIFF 1 of 3/);
});

test("/theme switches color theme and symbol preset without touching env", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-theme-"));
  const full = { NOMO_DATA_DIR: root };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  await ui.initialize();
  const initialColor = ui.themeConfig.colorTheme;
  const initialSymbol = ui.themeConfig.symbolPreset;

  await ui.command("/theme paper unicode");
  assert.equal(ui.themeConfig.colorTheme, "paper");
  assert.equal(ui.themeConfig.symbolPreset, "unicode");
  assert.match(ui.notice, /Theme paper \+ unicode saved locally/);

  await ui.command("/theme dark classic");
  assert.equal(ui.themeConfig.colorTheme, "dark");
  assert.equal(ui.themeConfig.symbolPreset, "classic");
  assert.match(ui.notice, /Theme dark \+ classic saved locally/);

  await ui.command("/theme preview solarized-dark classic");
  assert.equal(ui.themeConfig.colorTheme, "solarized-dark");
  assert.equal(ui.themeConfig.symbolPreset, "classic");
  assert.match(ui.notice, /Preview: solarized-dark \+ classic\. Press Enter to keep/);

  await ui.command("/theme reset");
  assert.equal(ui.themeConfig.colorTheme, initialColor);
  assert.equal(ui.themeConfig.symbolPreset, initialSymbol);
  assert.match(ui.notice, /Theme reset to environment defaults/);

  await assert.rejects(
    ui.command("/theme unknown-theme"),
    /Unknown color theme/,
  );
  await assert.rejects(
    ui.command("/theme paper unknown-preset"),
    /Unknown symbol preset/,
  );
});

test("command suggestions include /theme", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-suggest-"));
  const full = { NOMO_DATA_DIR: root };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  await ui.initialize();
  assert.ok(commandSuggestions("/the").some(([name]) => name === "/theme"));
});

test("/attest refuses when nothing has signed, and mints no key to pretend otherwise", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-attest-"));
  const { app, env } = await fixtureApp(root, "answer here");
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start here");
  await app.settled();

  // The old expectation here was a successful attestation with
  // `"entriesCount": 0`, which only worked because `attest` reached for
  // `devKeyProvider`, a function that *creates* a signing key when none
  // exists. Asking a workbench to prove something must never be the way it
  // acquires the power to sign, so the read path now refuses instead. This
  // fixture never signs anything, so refusing is the correct outcome.
  await assert.rejects(ui.command("/attest"), /verification key/i);

  // And the refusal must be a refusal, not a quiet mint: no key directory is
  // created as a side effect of being asked to attest.
  await assert.rejects(
    access(join(root, "keys")),
    "attest must not create the key directory",
  );
  assert.ok(commandSuggestions("/att").some(([name]) => name === "/attest"));
});

test("/providers lists presets with local open model options", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-providers-"));
  const full = { NOMO_DATA_DIR: root };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  await ui.command("/providers");
  const shown = ui.detail?.join("\n") ?? "";
  assert.match(shown, /nvidia/);
  assert.match(shown, /tokenrouter/);
  assert.match(shown, /opencode-zen/);
  assert.match(shown, /pollinations/);
  assert.ok(!shown.includes("tokenharbor"));
  assert.match(shown, /ollama.*local/);
  assert.match(shown, /Hermes/);
  assert.ok(
    commandSuggestions("/prov").some(([name]) => name === "/providers"),
  );
});

test("/connect SOURCE-ID switches to the imported provider and never prints the key", async (t) => {
  const home = await credentialHome(t);
  await saveCredential(home, ".local/share/opencode/auth.json", {
    opencode: { type: "api", key: connectKey },
  });
  const { ui } = await connectFixture(t, home);
  await ui.initialize();
  await ui.command("/connect opencode:zen");
  assert.equal(ui.provider?.providerId, "opencode-zen");
  assert.equal(ui.provider?.baseUrl, "https://opencode.ai/zen/v1");
  assert.equal(ui.provider?.connected, true);
  const shown = JSON.stringify({
    notice: ui.notice,
    detail: ui.detail,
    provider: ui.provider,
    lines: ui.lines(),
  });
  assert.ok(!shown.includes(connectKey), "no surface may print the key");
});

test("/connect with an unknown source lists the IDs that can be used", async (t) => {
  const home = await credentialHome(t);
  const { ui } = await connectFixture(t, home);
  await ui.initialize();
  const message = await commandMessage(ui, "/connect omp:not-a-source");
  assert.match(message, /Unknown source ID/);
  assert.match(message, /opencode:zen/);
  assert.match(message, /omp:nvidia/);
  assert.ok(!message.includes(connectKey));
});

test("a refused /connect is visible in Chat at 40x12 and 80x24", async (t) => {
  const home = await credentialHome(t);
  await saveCredential(home, ".local/share/opencode/auth.json", {
    opencode: { type: "api", key: connectKey },
  });
  const { ui } = await connectFixture(t, home);
  await ui.initialize();
  const refused = await ui.command("/connect omp:not-a-source").then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(refused instanceof Error, "an unknown source is refused");
  // The runner surfaces a refused command through the notice
  // (workspace-runner.ts:1337). Chat used to drop it on every size.
  ui.notice = refused.message;
  const frame = (width: number, height: number) =>
    stripAnsi(
      renderWorkspace(ui, width, height, "", false, false, {
        color: false,
        motion: false,
      }),
    );
  for (const [width, height] of [
    [40, 12],
    [80, 24],
  ] as const) {
    const rendered = frame(width, height);
    assert.match(
      rendered,
      /Unknown source ID/,
      `${width}x${height} Chat must show the refusal:\n${rendered}`,
    );
    // A newline in the notice must never reach a row as a replacement
    // character: the band wraps it instead.
    assert.ok(
      !rendered.includes(".?Use"),
      `the notice must wrap, not leak a newline:\n${rendered}`,
    );
  }
  const wide = frame(80, 24);
  // The ID list is wrapped, so the last IDs are not cut off.
  assert.match(wide, /opencode:zen/);
  assert.match(wide, /omp:nvidia/);
  assert.ok(!wide.includes(connectKey), "no surface may print the key");
  assert.ok(!wide.includes("undefined"), wide);
});

test("/providers shows a source row and keeps PgDn at 40x12", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-providers-narrow-"));
  const full = { NOMO_DATA_DIR: root };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  await ui.command("/providers");
  const rendered = stripAnsi(
    renderWorkspace(ui, 40, 12, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  // The frame title already names the directory, so the body must not spend
  // its first two rows repeating it.
  const title = "PROVIDERS · /connect ID";
  assert.equal(
    rendered.split(title).length - 1,
    1,
    `the title belongs to the frame only:\n${rendered}`,
  );
  assert.match(rendered, /omp:nvidia/, rendered);
  assert.match(rendered, /PgDn/, rendered);
  assert.ok(!rendered.includes("undefined"), rendered);
});

test("the /connect suggestion window keeps the selected row on screen at 40x12", async (t) => {
  const home = await credentialHome(t);
  await saveCredential(home, ".local/share/opencode/auth.json", {
    opencode: { type: "api", key: connectKey },
  });
  await saveOmpCredentials(home, ["nvidia"]);
  const { ui } = await connectFixture(t, home);
  await ui.initialize();
  const candidates = commandSuggestions("/connect ", ui.connectSources);
  assert.ok(
    candidates.length > 5,
    `the fixture needs more than five source IDs, got ${candidates.length}`,
  );
  const selectedId = candidates[5]![0].slice("/connect ".length);
  const rendered = stripAnsi(
    renderWorkspace(ui, 40, 12, "/connect ", true, false, {
      color: false,
      motion: false,
      command: "/connect ",
      suggestion: 5,
    }),
  );
  const row = rendered.split("\n").find((line) => line.includes(selectedId));
  assert.ok(row, `${selectedId} must stay on screen:\n${rendered}`);
  assert.match(row!, /›/, `the selected row keeps its marker:\n${rendered}`);
  // A short hint keeps the availability word instead of cutting it.
  assert.match(row!, /available/, `availability must survive:\n${rendered}`);
});

test("/providers names why OAuth is unavailable and never prints a key", async (t) => {
  const home = await credentialHome(t);
  await saveCredential(home, ".prime/agent/auth.json", {
    anthropic: {
      type: "oauth",
      access: connectKey,
      refresh: "fixture-refresh",
      expires: 4_102_444_800_000,
    },
  });
  const { ui } = await connectFixture(t, home);
  await ui.initialize();
  await ui.command("/providers");
  const row = (ui.detail ?? []).find((line) => line.includes("prime:anthropic"));
  assert.ok(row, `/providers must list prime:anthropic:\n${ui.detail?.join("\n")}`);
  // The discovery record carries the reason; the directory repeats it in
  // short form rather than only saying "not available".
  assert.match(row!, /oauth unavailable: transport-unimplemented/);
  assert.ok(!row!.includes(connectKey));
  // The row is past the first page at 80x24, so scroll to it: the reason has
  // to survive the panel's wrap, not only exist in the data.
  const content = ui.lines(76, 18);
  const wrapped = wrap(content, 80 - 2 - 4);
  const index = wrapped.findIndex((line) => line.includes("prime:anthropic"));
  assert.ok(index >= 0, "the wrapped directory must carry the source row");
  ui.scroll = index;
  const rendered = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  // The row wraps at this width, so read the frame as continuous text: the
  // reason has to be visible in reading order, not only present in the data.
  assert.match(
    rendered.replace(/\s+/g, " "),
    /oauth unavailable: transport-unimplemented/,
    rendered,
  );
  assert.ok(!rendered.includes(connectKey), "no surface may print the key");
  assert.ok(!rendered.includes("undefined"), rendered);
  assert.ok(!/\/Users\/|\/home\/|\/tmp\//.test(rendered), rendered);
});

test("/connect nvidia selects the OMP NVIDIA key instead of an unset environment", async (t) => {
  const home = await credentialHome(t);
  await saveOmpCredentials(home, ["nvidia"]);
  const { ui } = await connectFixture(t, home);
  await ui.initialize();
  await ui.command("/connect nvidia");
  assert.equal(ui.provider?.providerId, "nvidia");
  assert.equal(ui.provider?.baseUrl, "https://integrate.api.nvidia.com/v1");
  assert.equal(ui.provider?.connected, true);
  const shown = JSON.stringify({
    notice: ui.notice,
    detail: ui.detail,
    provider: ui.provider,
  });
  assert.ok(!shown.includes(connectKey));
});

test("/providers names each import source with its availability and no key", async (t) => {
  const home = await credentialHome(t);
  await saveCredential(home, ".local/share/opencode/auth.json", {
    opencode: { type: "api", key: connectKey },
  });
  await saveCredential(home, ".prime/agent/auth.json", {
    anthropic: {
      type: "oauth",
      access: connectKey,
      refresh: "fixture-refresh",
      expires: 4_102_444_800_000,
    },
  });
  await saveOmpCredentials(home, ["nvidia"]);
  const { ui } = await connectFixture(t, home);
  await ui.initialize();
  await ui.command("/providers");
  const shown = (ui.detail ?? []).join("\n");
  const rows = shown.split("\n");
  const row = (id: string) => rows.find((line) => line.includes(id));
  // Availability is per source, not per preset: two stores can map to the same
  // endpoint and only one of them holds a key.
  const zen = row("opencode:zen");
  assert.ok(zen, `/providers must name the source id opencode:zen in:\n${shown}`);
  assert.ok(shown.includes("opencode:zen (available)"), shown);
  assert.ok(!shown.includes("opencode:zen (not available)"), shown);
  const nvidia = row("omp:nvidia");
  assert.ok(nvidia, `/providers must name the source id omp:nvidia in:\n${shown}`);
  assert.ok(shown.includes("omp:nvidia (available)"), shown);
  assert.ok(!shown.includes("omp:nvidia (not available)"), shown);
  const anthropic = row("prime:anthropic");
  assert.ok(anthropic, `/providers must name the source id prime:anthropic in:\n${shown}`);
  assert.ok(
    shown.includes(
      "prime:anthropic (oauth unavailable: transport-unimplemented)",
    ),
    shown,
  );
  assert.ok(!shown.includes(connectKey));
});

test("/harness shows and switches the agent harness", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-harness-"));
  const full = { NOMO_DATA_DIR: root, PATH: "/usr/bin:/bin" };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  await ui.command("/harness");
  assert.match(ui.detail?.join("\n") ?? "", /current default: cloud/);
  assert.match(
    ui.detail?.join("\n") ?? "",
    /prime-agent: not detected on PATH/,
  );
  await ui.command("/harness prime-agent");
  assert.equal(app.getPreferences().defaultAgent, "prime-agent");
  assert.match(ui.notice, /prime-agent/);
  await ui.command("/harness cloud");
  assert.equal(app.getPreferences().defaultAgent, "cloud");
  await assert.rejects(ui.command("/harness skynet"), /\/harness cloud/);
  const found = await detectHarnesses({ PATH: "/usr/bin:/bin" });
  assert.deepEqual(
    found.map((item) => item.id),
    ["prime-agent", "opencode"],
  );
  assert.ok(found.every((item) => item.path === null));
});

test("live thinking dots animate with motion and freeze without it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-dots-"));
  const full = { NOMO_DATA_DIR: root };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  const early = renderWorkspace(ui, 80, 30, "_", true, true, { frame: 0 });
  const late = renderWorkspace(ui, 80, 30, "_", true, true, { frame: 4 });
  assert.match(stripAnsi(early), /◌ Waiting for provider\. /);
  assert.match(stripAnsi(late), /◌ Waiting for provider\.\. /);
  assert.notEqual(stripAnsi(early), stripAnsi(late));
  const still = (frame: number) =>
    renderWorkspace(ui, 80, 30, "_", true, true, { frame, motion: false });
  assert.equal(stripAnsi(still(0)), stripAnsi(still(9)));
  assert.match(stripAnsi(still(0)), /◌ Waiting for provider/);
  // Without motion the dots freeze instead of being dropped, so the phase is
  // still named in words.
  assert.doesNotMatch(stripAnsi(still(0)), /◌ Waiting for provider\./);
});

test("NVIDIA API key is read ONLY from env var, never from chat input", async (t) => {
  // 1. No env key -> providerState stays null, no auto-configuration.
  const root = await mkdtemp(join(tmpdir(), "nomo-nvidia-chat-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.initialize();
  const state = await app.providerState();
  assert.equal(state.providerId, null);
  assert.equal(state.connected, false);
  // 2. A prompt whose text contains "NVIDIA_API_KEY=secret" is just text:
  // it never becomes a credential. Configure a fixture provider first so the
  // prompt can actually be sent, and watch that no request ever carries the
  // literal secret as an authorization header.
  let seenAuth = "";
  let seenBody = "";
  const fetcher: typeof fetch = async (url, options) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "m" }] });
    const headers = (options?.headers ?? {}) as Record<string, string>;
    seenAuth = headers.authorization ?? "";
    seenBody = String(options?.body ?? "");
    return Response.json({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });
  };
  const app2 = new Workbench({ NOMO_DATA_DIR: root }, fetcher);
  await app2.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture-key",
  });
  const ui2 = new WorkspaceTui(app2, { NOMO_DATA_DIR: root });
  await ui2.initialize();
  await ui2.command("please set NVIDIA_API_KEY=secret in the chat");
  await app2.settled();
  // The literal secret never becomes a credential: no auth header carries it.
  assert.ok(!seenAuth.includes("secret"));
  assert.ok(seenAuth.startsWith("Bearer fixture-key"));
  // 3. Explicit env var IS the only path that configures NVIDIA.
  const root3 = await mkdtemp(join(tmpdir(), "nomo-nvidia-env-"));
  const app3 = new Workbench(
    { NOMO_DATA_DIR: root3, NVIDIA_API_KEY: "nvkey" },
    async (url) =>
      String(url).endsWith("/models")
        ? Response.json({ data: [{ id: "m" }] })
        : Response.json({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          }),
  );
  t.after(async () => {
    await app3.shutdown();
    await rm(root3, { recursive: true, force: true });
  });
  const s3 = await app3.providerState();
  assert.equal(s3.providerId, "nvidia");
});

test("no silent provider fallback - workspace with no provider says so explicitly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-no-provider-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.initialize();
  const lines = ui.providerLines().join("\n");
  // The provider is an inspector now, so "there is no provider" is the
  // heading and its state is a field. What this protects is that the
  // workspace names the gap out loud and never falls back silently.
  assert.match(lines, /unknown provider/);
  assert.match(lines, /status *: *setup-required/);
  assert.match(lines, /model *: *not selected/);
  assert.match(lines, /Never type a key into the terminal/);
  // starting a session must not fall back silently
  await assert.rejects(ui.command("hello"), /Select a model/);
});

test("logout preserves readable history, removes profiles and session keys", async (t) => {
  // Build a fresh workspace with a configured provider, send a message, then
  // run /logout and verify: history survives, provider is gone, profiles are
  // cleared, and the env-driven auto-configuration is disabled.
  const root = await mkdtemp(join(tmpdir(), "nomo-logout-"));
  const fetcher: typeof fetch = async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "m" }] })
      : Response.json({
          choices: [{ message: { role: "assistant", content: "hello back" } }],
        });
  const app = new Workbench({ NOMO_DATA_DIR: root }, fetcher);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture-secret",
  });
  const configured = await app.providerState();
  assert.equal(configured.providerId, "custom");
  assert.equal(configured.connected, true);
  assert.equal(configured.profiles.length, 1);
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.initialize();
  await ui.command("first message");
  await app.settled();
  const sessId = ui.sessionId!;
  const historyBefore = (app.get(sessId)?.events ?? []).length;
  assert.ok(historyBefore > 0);
  await ui.command("/logout");
  const afterState = await app.providerState();
  assert.equal(afterState.providerId, null);
  assert.equal(afterState.connected, false);
  assert.equal(afterState.profiles.length, 0);
  // History is preserved.
  const historyAfter = (app.get(sessId)?.events ?? []).length;
  assert.equal(historyAfter, historyBefore);
  // After logout the env-driven auto-configuration is disabled, so a second
  // providerState call does not reconfigure from the host environment.
  const secondState = await app.providerState();
  assert.equal(secondState.providerId, null);
  assert.equal(secondState.connected, false);
});

test("provider presets stay a choice, not a default", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-preset-choice-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const state = await app.providerState();
  assert.equal(state.providerId, null);
  assert.equal(state.defaultModel, null);
  // presets are present but not active
  assert.ok(state.presets.length >= 1);
  // Starting a conversation cannot assume nvidia or any preset
  await assert.rejects(app.start("hello"), /Select a model/);
});

test("new commands complete from a slash prefix", () => {
  for (const cmd of [
    "/compact",
    "/login",
    "/logout",
    "/todos",
    "/agents",
    "/config",
    "/memory",
    "/model",
    "/export",
  ])
    assert.ok(
      commandSuggestions(cmd).some(([name]) => name === cmd),
      `${cmd} should complete`,
    );
  assert.ok(
    commandSuggestions("/comp").some(([name]) => name === "/compact"),
    "/comp should suggest /compact",
  );
});

test("/learned reports what the signed chain taught, and what it may not override", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-learned-"));
  const { app, env } = await fixtureApp(root, "answer here");
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start here");
  await app.settled();

  const internals = ui as unknown as {
    items(): { id: string }[];
    selected: number;
    proofs: Map<string, unknown[]>;
  };
  const id = app.list()[0].id;
  // Seeded into the same map a refresh fills from `ledger()`, so this renders
  // what a real verified chain would teach without forging one in a test.
  internals.proofs.set(id, [
    {
      body: {
        tool: "void_workspace_delete",
        klass: "r1",
        decision: "deny:policy",
      },
    },
    {
      body: {
        tool: "void_workspace_delete",
        klass: "r1",
        decision: "deny:policy",
      },
    },
    {
      body: {
        tool: "void_workspace_delete",
        klass: "r1",
        decision: "deny:policy",
      },
    },
  ]);

  await ui.command("/learned");
  const text = ui.lines().join("\n");
  assert.match(text, /void_workspace_delete \(r1\) -> hold/);
  // The precedence is the whole safety property, so the view has to say it.
  assert.match(text, /evidence, not authority/);
  assert.match(text, /appended after the/);

  // Two refusals sit below the threshold, so they teach nothing.
  internals.proofs.set(id, [
    {
      body: {
        tool: "void_workspace_delete",
        klass: "r1",
        decision: "deny:policy",
      },
    },
    {
      body: {
        tool: "void_workspace_delete",
        klass: "r1",
        decision: "deny:policy",
      },
    },
  ]);
  await ui.command("/learned");
  assert.doesNotMatch(
    ui.lines().join("\n"),
    /void_workspace_delete \(r1\) -> hold/,
  );
});
test("the pet rides in the header and never costs a row at any size", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-pet-frame-"));
  const full = { NOMO_DATA_DIR: root };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  ui.choose("chat");
  ui.model = "fixture-model";

  for (const [width, height] of [
    [40, 12],
    [80, 24],
    [120, 40],
    [160, 45],
    [200, 48],
  ] as const) {
    for (const color of [true, false]) {
      for (const motion of [true, false]) {
        const frame = renderWorkspace(ui, width, height, "", false, false, {
          color,
          motion,
        });
        const rows = frame.split("\n");
        const text = stripAnsi(frame);
        const label = `${width}x${height} ${color ? "color" : "mono"} motion=${motion}`;
        // The pet is header only: the frame keeps its exact height and no row
        // grows past the terminal width.
        assert.ok(
          rows.length <= height,
          `${label} grew to ${rows.length} rows`,
        );
        assert.ok(
          rows.every((row) => visibleLength(row) <= width),
          `${label} has a row wider than the terminal`,
        );
        // From 56x18 up the pet docks on the composer rail and costs no row;
        // below that it is the compact header mark. Either form names the
        // state in words, and neither spends a row of its own.
        const dock = width >= 56 && height >= 18;
        assert.ok(
          text.includes(dock ? "▦ idle" : "▄█▄ idle"),
          `${label} lost the ${dock ? "dock" : "mini"} pet:\n${text}`,
        );
        if (!dock)
          assert.ok(
            !text.includes("NIB idle"),
            `${label} used the perch on a compact terminal`,
          );
        else
          assert.ok(
            !text.includes("NIB idle"),
            `${label} drew the perch beside the dock`,
          );
        // The pet never replaces what the header shares its rows with.
        assert.ok(text.includes("NOMO"), `${label} lost the identity`);
        assert.ok(text.includes("╭─ Draft"), `${label} lost the composer`);
        // A compact chat body shows the usage hint instead of the title row,
        // so the transcript is asserted against whichever one it lays out.
        const grid = width >= 64 && height >= 22;
        assert.ok(
          text.includes(
            grid ? "NEW CONVERSATION" : "/connect shows provider setup",
          ),
          `${label} lost the transcript`,
        );
        // An unfocused composer names the key that focuses it and never fakes
        // an editing caret. The focused frame below is where the caret lives.
        assert.ok(
          text.includes("Tab to write"),
          `${label} lost the unfocused composer hint`,
        );
        assert.doesNotMatch(
          text,
          /│[^│]*[█▌]/,
          `${label} faked an editing cursor while unfocused`,
        );
        assert.ok(
          text.includes("← Sessions"),
          `${label} lost the panel dock`,
        );
        assert.ok(
          !frame.includes("\x1b[│m"),
          `${label} contains a malformed color escape`,
        );
      }
    }
  }
});

test("the review keys stay visible and the pet stays out of the way", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-pet-review-"));
  const full = { NOMO_DATA_DIR: root };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  ui.choose("chat");
  ui.model = "fixture-model";
  ui.confirmation = {
    title: "SAVE plan.md?",
    lines: ["REVIEW PREVIEW: local-fixture-change"],
    apply: async () => {},
  };

  const frame = renderWorkspace(ui, 40, 12, "", false, false, {
    color: false,
    motion: false,
  });
  const text = stripAnsi(frame);
  assert.ok(
    text.includes("╭─ Review  y allow · n deny"),
    "the review keys stay visible on the rail",
  );
  assert.ok(text.includes("Esc cancel"), "the cancel key stays visible");
  // The review overlay owns the whole surface, so the pet is not drawn over
  // the decision keys it would otherwise share a row with.
  assert.ok(!text.includes("▄█▄"), "the pet covered the review");
  assert.equal(frame.split("\n").length, 12);
  assert.ok(frame.split("\n").every((line) => visibleLength(line) <= 40));
});

test("Alt+N toggles the pet and Alt+Shift+N opens its card without sending a prompt", async (t) => {
  // A plain n is text; only the modifier toggles the display.
  assert.equal(isPetToggleKey({ name: "n", meta: true }), true);
  assert.equal(isPetCardKey({ name: "n", meta: true, shift: true }), true);
  assert.equal(isPetCardKey({ name: "n", meta: true }), false);
  assert.equal(isPetToggleKey({ name: "n" }), false);
  assert.equal(isPetToggleKey({ name: "n", ctrl: true }), false);
  assert.equal(isPetToggleKey({ name: "n", meta: true, shift: true }), false);
  // Alt+N is not a workspace shortcut, so it cannot fall through to another
  // action that would send the prompt.
  assert.equal(
    workspaceShortcut({ name: "n", meta: true }, true, "", undefined, "chat"),
    undefined,
  );

  const root = await mkdtemp(join(tmpdir(), "nomo-tui-pet-toggle-"));
  const full = { NOMO_DATA_DIR: root };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  ui.choose("chat");
  assert.equal(ui.petEnabled, true, "the pet starts on");
  assert.equal(app.list().length, 0, "no conversation exists yet");

  await ui.command("/pet dock");
  assert.equal(ui.petPlacement, "dock");
  assert.match(ui.notice, /Pet docks/);
  assert.equal(app.list().length, 0, "/pet dock sent a prompt");
  await ui.command("/pet perch");
  assert.equal(ui.petPlacement, "perch");
  assert.match(ui.notice, /Pet perches/);
  assert.equal(app.list().length, 0, "/pet perch sent a prompt");

  await ui.command("/pet off");
  assert.equal(ui.petEnabled, false);
  assert.match(ui.notice, /Pet is off/);
  // A display toggle never starts a conversation or sends a prompt.
  assert.equal(app.list().length, 0, "/pet off sent a prompt");
  const offFrame = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  assert.ok(!offFrame.includes("NIB"), "/pet off still drew the pet");

  await ui.command("/pet on");
  assert.equal(ui.petEnabled, true);
  assert.match(ui.notice, /Pet is on/);
  assert.equal(app.list().length, 0, "/pet on sent a prompt");

  await ui.command("/pet sideways");
  assert.equal(ui.petEnabled, true, "an unknown argument changes nothing");
  assert.match(ui.notice, /Use \/pet on or \/pet off/);

  // NOMO_TUI_PET=0 disables the pet at startup, and the toggle still works.
  const disabled = new WorkspaceTui(app, { NOMO_DATA_DIR: root, NOMO_TUI_PET: "0" });
  assert.equal(disabled.petEnabled, false);
  const startupFrame = stripAnsi(
    renderWorkspace(disabled, 80, 24, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  assert.ok(!startupFrame.includes("NIB"), "NOMO_TUI_PET=0 still drew the pet");
  await disabled.command("/pet on");
  assert.equal(disabled.petEnabled, true);
});

test("reasoning frames fit five terminal sizes without stealing the composer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-reasoning-sizes-"));
  // A real provider stream: the reasoning channel is recorded by Workbench as
  // reasoning.delta, so the frame test exercises the same events the runner
  // renders rather than a hand-built transcript.
  const reasoning = Array.from(
    { length: 120 },
    (_, index) => `thought-${index + 1}`,
  ).join(" ");
  const fetcher = async (url: unknown) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture-model" }] });
    const frame = (delta: Record<string, unknown>, finish?: string) =>
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta,
            ...(finish === undefined ? {} : { finish_reason: finish }),
          },
        ],
      })}\n\n`;
    return new Response(
      [
        frame({ reasoning_content: reasoning }),
        frame({ content: "Answer." }),
        frame({}, "stop"),
        "data: [DONE]\n\n",
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const app = new Workbench({ NOMO_DATA_DIR: root }, fetcher);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture-key",
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.model = "fixture-model";
  ui.choose("chat");
  await ui.command("Question.");
  await app.settled();
  const events = ui.session()?.events ?? [];
  assert.ok(events.some((event) => event.type === "reasoning.delta"));

  // The collapsed block is bounded by the terminal height: one line at 40x12,
  // three at 80x24, eight at 120x40 and above.
  const budgets: Array<[number, number, number]> = [
    [40, 12, 1],
    [60, 18, 3],
    [80, 24, 3],
    [100, 32, 5],
    [120, 40, 8],
  ];
  for (const [width, height, budget] of budgets) {
    const rows = chatRows(
      events,
      width,
      "details",
      "comfortable",
      false,
      false,
      "unicode",
      height,
    );
    const label = rows.findIndex((row) => row.text === "~ thinking");
    assert.ok(label >= 0, `${width}x${height} lost the thinking label`);
    const hidden = rows.findIndex((row) => /more thinking lines/.test(row.text));
    assert.ok(hidden > label, `${width}x${height} lost the hidden count`);
    assert.equal(
      hidden - label - 1,
      budget,
      `${width}x${height} reasoning budget`,
    );
    assert.ok(
      rows.every((row) => visibleLength(row.text) <= width),
      `${width}x${height} reasoning row overflows`,
    );

    // Mono, static frames: the label and the state word carry the meaning.
    const frame = renderWorkspace(ui, width, height, "", true, false, {
      color: false,
      motion: false,
    });
    const text = stripAnsi(frame);
    assert.equal(
      frame.split("\n").length,
      height,
      `${width}x${height} row count`,
    );
    assert.ok(
      frame.split("\n").every((line) => visibleLength(line) <= width),
      `${width}x${height} visible length`,
    );
    assert.ok(
      text.includes("Enter send"),
      `${width}x${height} lost the composer key`,
    );
    // Reduced motion is a static frame: the same inputs paint the same rows.
    const repeat = renderWorkspace(ui, width, height, "", true, false, {
      color: false,
      motion: false,
    });
    assert.equal(repeat, frame, `${width}x${height} moved without new input`);
  }
});
const gitIn = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/** A committed fixture repository on `branch`, with one tracked file. */
async function fixtureRepository(branch = "feature/location"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-location-repo-"));
  gitIn(root, "init", "-q");
  gitIn(root, "config", "user.email", "nomo@example.invalid");
  gitIn(root, "config", "user.name", "NOMO test");
  gitIn(root, "checkout", "-q", "-b", branch);
  await writeFile(join(root, "tracked.txt"), "one\n");
  gitIn(root, "add", "tracked.txt");
  gitIn(root, "commit", "-qm", "initial");
  return root;
}

test("the location label appends the branch and keeps the directory", () => {
  // A path outside home is printed whole, so the assertion is not about where
  // this test happens to run.
  assert.equal(locationLabel("/srv/project", null, 40), "/srv/project");
  assert.equal(locationLabel("/srv/project", undefined, 40), "/srv/project");
  assert.equal(
    locationLabel("/srv/project", { branch: "main", dirty: false }, 40),
    "/srv/project main",
  );
  assert.equal(
    locationLabel("/srv/project", { branch: "main", dirty: true }, 40),
    "/srv/project main*",
  );
  // The branch keeps every cell it needs while the directory keeps its floor.
  const wide = locationLabel(
    "/srv/project",
    { branch: "a".repeat(40), dirty: false },
    60,
  );
  assert.equal(visibleLength(wide) <= 60, true);
  assert.equal(wide.includes("a".repeat(32)), true, "the branch is capped at 32");
  assert.equal(wide.includes("a".repeat(33)), false);
  // In a narrow row the branch survives and the directory is shortened.
  const narrow = locationLabel(
    "/srv/project",
    { branch: "feature/location", dirty: true },
    20,
  );
  assert.ok(narrow.endsWith("feature/location*"), narrow);
  assert.equal(visibleLength(narrow) <= 20, true);
  assert.equal(locationLabel("/srv/project", null, 0), "");
});

test("the Chat location names the real branch and no invented one", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "nomo-tui-location-"));
  const repo = await fixtureRepository();
  const plain = await mkdtemp(join(tmpdir(), "nomo-tui-location-plain-"));
  const app = new Workbench({ NOMO_DATA_DIR: dataDir });
  t.after(async () => {
    resetGitStatusCache();
    await app.shutdown();
    await rm(dataDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
    await rm(plain, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: dataDir });
  const frameAt = (cwd: string, width: number, height: number): string =>
    stripAnsi(
      renderWorkspace(ui, width, height, "", false, false, {
        color: false,
        motion: false,
        cwd,
      }),
    );

  // Nothing is known before the probe answers, so the branch is omitted.
  resetGitStatusCache();
  assert.equal(
    frameAt(repo, 80, 24).includes("feature/location"),
    false,
    "an unprobed branch must not appear",
  );
  assert.deepEqual(await primeGitStatus(repo), {
    branch: "feature/location",
    dirty: false,
  });

  // 56x18 is the first size that carries the branch, and 80x24 and 120x40
  // keep it. 40x12 carries neither branch nor path.
  for (const [width, height] of [
    [56, 18],
    [80, 24],
    [120, 40],
  ] as const) {
    const text = frameAt(repo, width, height);
    assert.ok(
      text.includes("feature/location"),
      `${width}x${height} lost the branch:\n${text}`,
    );
    assert.equal(
      text.includes("feature/location*"),
      false,
      `${width}x${height} invented a dirty mark on a clean tree`,
    );
    assert.equal(
      text.split("\n").length,
      height,
      `${width}x${height} row count`,
    );
  }
  const compact = frameAt(repo, 40, 12);
  assert.equal(
    compact.includes("feature/location"),
    false,
    `40x12 printed a branch:\n${compact}`,
  );
  assert.equal(
    compact.includes(repo),
    false,
    `40x12 printed the working directory`,
  );

  // A dirty tree is the only thing that adds the mark.
  await writeFile(join(repo, "untracked.txt"), "two\n");
  resetGitStatusCache();
  await primeGitStatus(repo);
  const dirtyText = frameAt(repo, 120, 40);
  assert.ok(dirtyText.includes("feature/location*"), dirtyText);
  // Nothing beyond the branch and the directory leaks into the frame: no git
  // directory, no porcelain path, no second filesystem location.
  assert.equal(dirtyText.includes(".git"), false);
  assert.equal(dirtyText.includes("untracked.txt"), false);
  assert.equal(dirtyText.includes(join(repo, "tracked.txt")), false);

  // Outside a repository the directory stands alone: no branch is invented.
  resetGitStatusCache();
  await primeGitStatus(plain);
  const plainText = frameAt(plain, 120, 40);
  assert.ok(
    plainText.includes(plain.slice(0, 16)),
    `the directory is still reported:\n${plainText}`,
  );
  assert.equal(plainText.includes("feature/location"), false);
  assert.equal(plainText.includes(".git"), false);
});

/**
 * A chat frame whose assistant message carries a checklist. That is the only
 * thing that makes the rail appear, so these frames exercise the real rail
 * layout instead of a hand-built one.
 */
async function railFrame(
  t: test.TestContext,
  columns: number,
  rows: number,
) {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-rail-mouse-"));
  const { app, env } = await fixtureApp(root, "- [ ] ship it\n- [x] done");
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("do the work");
  await app.settled();
  const frame = renderWorkspace(ui, columns, rows, "", false, false, {
    color: false,
    motion: false,
  });
  return { ui, frame, rows: stripAnsi(frame).split("\n") };
}

/** The rail geometry the chat layout derives from the terminal size. */
function chatRailGeometry(columns: number) {
  const margin = columns >= 56 ? 2 : columns >= 40 ? 1 : 0;
  const width = Math.max(1, columns - margin * 2);
  const railWidth = Math.min(34, Math.max(24, Math.floor(width * 0.28)));
  const textWidth = Math.max(1, width - 4 - railWidth);
  return {
    margin,
    width,
    railWidth,
    textWidth,
    railStart: margin + 1 + textWidth,
  };
}

test("a chat rail publishes its transcript width and rail column", async (t) => {
  const { ui, rows } = await railFrame(t, 120, 40);
  const geometry = chatRailGeometry(120);
  assert.equal(ui.viewport.textWidth, geometry.textWidth);
  assert.equal(ui.viewport.railStart, geometry.railStart);
  assert.equal(typeof ui.viewport.railTop, "number");
  assert.ok((ui.viewport.railRows ?? 0) > 0, "the rail band has rows");
  const railTop = ui.viewport.railTop!;
  const railRows = ui.viewport.railRows!;
  assert.ok(railTop > 1, "the rail starts below the task header");
  assert.ok(
    railTop + railRows - 1 <= rows.length,
    "the rail band stays inside the frame",
  );
  const band = rows.slice(railTop - 1, railTop - 1 + railRows);
  assert.ok(
    band.some((row) => row.slice(geometry.railStart - 1).includes("TODO 1/2")),
    `the published column is where the rail paints:\n${band.join("\n")}`,
  );
});

test("a rail click never starts a text selection", async (t) => {
  const { ui } = await railFrame(t, 120, 40);
  const railStart = ui.viewport.railStart!;
  const railTop = ui.viewport.railTop!;
  const railRows = ui.viewport.railRows!;
  // Zero-based screen points: the rail owns its first cell and everything to
  // the right of it, on every painted rail row.
  assert.equal(
    railOwnsPoint(ui.viewport, { x: railStart - 1, y: railTop - 1 }),
    true,
  );
  assert.equal(
    railOwnsPoint(ui.viewport, { x: 119, y: railTop + railRows - 2 }),
    true,
  );
  // The last transcript cell and the rows above the rail stay selectable.
  assert.equal(
    railOwnsPoint(ui.viewport, { x: railStart - 2, y: railTop - 1 }),
    false,
  );
  assert.equal(railOwnsPoint(ui.viewport, { x: 119, y: railTop - 2 }), false);
  assert.equal(
    railOwnsPoint(ui.viewport, { x: 119, y: railTop + railRows - 1 }),
    false,
  );
});

test("a transcript click selects the cell under the pointer", async (t) => {
  const { ui, frame, rows } = await railFrame(t, 120, 40);
  const row = rows.findIndex((line) => line.includes("do the work"));
  assert.ok(row >= 0, `the prompt row is drawn:\n${rows.join("\n")}`);
  const column = rows[row]!.indexOf("do the work");
  const limit = ui.viewport.railStart! - 1;
  assert.equal(
    selectedMouseText(
      frame,
      { x: column, y: row },
      { x: column, y: row },
      120,
      limit,
    ),
    "d",
  );
  assert.equal(
    selectedMouseText(
      frame,
      { x: column, y: row },
      { x: column + "do the work".length - 1, y: row },
      120,
      limit,
    ),
    "do the work",
  );
});

test("a selection stops at the transcript edge instead of entering the rail", async (t) => {
  const { ui, frame } = await railFrame(t, 120, 40);
  const limit = ui.viewport.railStart! - 1;
  const row = ui.viewport.railTop! - 1;
  const loose = selectedMouseText(
    frame,
    { x: 0, y: row },
    { x: 119, y: row },
    120,
  );
  const clamped = selectedMouseText(
    frame,
    { x: 0, y: row },
    { x: 119, y: row },
    120,
    limit,
  );
  assert.ok(loose.includes("TODO 1/2"), "an unclamped read reaches the rail");
  assert.ok(
    !clamped.includes("TODO"),
    "the clamped read never copies the rail",
  );
  assert.equal(
    visibleLength(clamped),
    limit,
    "the clamped read stops at the last transcript cell",
  );
  // A highlight that starts in the rail is clamped to the same edge, so the
  // painted row carries exactly the transcript cells and no rail cell.
  const highlighted = highlightMouseSelection(
    frame,
    { x: 119, y: row },
    { x: 0, y: row },
    120,
    limit,
  );
  assert.equal(stripAnsi(highlighted), stripAnsi(frame));
  const paintedRow = highlighted.split("\n")[row]!;
  assert.equal(
    (paintedRow.match(/\x1b\[7m/g) ?? []).length,
    limit,
    "the highlight paints the transcript pane only",
  );
});

test("a highlight clamps to its width limit and keeps the default", () => {
  const frame = "abcdefghij\nklmnopqrst";
  const loose = highlightMouseSelection(
    frame,
    { x: 0, y: 0 },
    { x: 9, y: 1 },
    10,
  );
  assert.ok(loose.includes("\x1b[7mj\x1b[27m"));
  assert.equal(
    highlightMouseSelection(frame, { x: 0, y: 0 }, { x: 9, y: 1 }, 10, 10),
    loose,
    "the default limit is the column count",
  );
  const clamped = highlightMouseSelection(
    frame,
    { x: 0, y: 0 },
    { x: 9, y: 1 },
    10,
    5,
  );
  const [first, second] = clamped.split("\n");
  assert.ok(first!.includes("\x1b[7me\x1b[27m"));
  assert.ok(!first!.includes("\x1b[7mf\x1b[27m"));
  assert.ok(second!.includes("\x1b[7mo\x1b[27m"));
  assert.ok(!second!.includes("\x1b[7mp\x1b[27m"));
  assert.equal(stripAnsi(clamped), frame);
});

test("40x12 and 80x24 keep every row selectable without a rail", async (t) => {
  for (const [columns, rows] of [
    [40, 12],
    [80, 24],
  ] as const) {
    const { ui, frame } = await railFrame(t, columns, rows);
    assert.equal(
      ui.viewport.railStart,
      undefined,
      `${columns}x${rows} publishes no rail`,
    );
    assert.equal(ui.viewport.railTop, undefined);
    assert.equal(ui.viewport.railRows, undefined);
    assert.equal(
      railOwnsPoint(ui.viewport, { x: columns - 1, y: rows - 1 }),
      false,
      `${columns}x${rows} keeps the last cell selectable`,
    );
    const line = stripAnsi(frame)
      .split("\n")
      .find((row) => row.includes("ship it"));
    assert.ok(line, `${columns}x${rows} draws the checklist row`);
    const rowIndex = stripAnsi(frame).split("\n").indexOf(line);
    const column = line.indexOf("ship it");
    assert.equal(
      selectedMouseText(
        frame,
        { x: column, y: rowIndex },
        { x: column, y: rowIndex },
        columns,
      ),
      "s",
      `${columns}x${rows} selects without a limit`,
    );
  }
});

test("160x45 and 200x48 publish the same rail geometry", async (t) => {
  for (const [columns, rows] of [
    [160, 45],
    [200, 48],
  ] as const) {
    const { ui, rows: frameRows } = await railFrame(t, columns, rows);
    const geometry = chatRailGeometry(columns);
    assert.equal(
      ui.viewport.textWidth,
      geometry.textWidth,
      `${columns}x${rows} text width`,
    );
    assert.equal(
      ui.viewport.railStart,
      geometry.railStart,
      `${columns}x${rows} rail start`,
    );
    const railTop = ui.viewport.railTop!;
    const railRows = ui.viewport.railRows!;
    assert.ok(railRows > 0);
    const band = frameRows.slice(railTop - 1, railTop - 1 + railRows);
    assert.ok(
      band.some((row) => row.slice(geometry.railStart - 1).includes("TODO 1/2")),
      `${columns}x${rows} paints the rail at the published column`,
    );
    assert.equal(
      railOwnsPoint(ui.viewport, { x: geometry.railStart - 2, y: railTop - 1 }),
      false,
      `${columns}x${rows} keeps the transcript edge selectable`,
    );
    assert.equal(
      railOwnsPoint(ui.viewport, { x: geometry.railStart - 1, y: railTop - 1 }),
      true,
      `${columns}x${rows} ignores the rail edge`,
    );
  }
});

/** A workspace whose provider reports a real token split on every turn, so
 * the usage panel renders measurements rather than fixtures of its own. */
async function usagePanelApp(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-usage-panel-"));
  const turns = [
    { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
    { prompt_tokens: 2400, completion_tokens: 600, total_tokens: 3000 },
    { prompt_tokens: 800, completion_tokens: 100, total_tokens: 900 },
  ];
  let turn = 0;
  const fetcher: typeof fetch = async (input) =>
    String(input).endsWith("/models")
      ? Response.json({ data: [{ id: "fixture-model", name: "Fixture Model" }] })
      : Response.json({
          choices: [
            {
              message: { role: "assistant", content: "Done." },
              finish_reason: "stop",
            },
          ],
          usage: turns[turn++ % turns.length]!,
        });
  const env = { NOMO_DATA_DIR: root };
  const app = new Workbench(env, fetcher);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture-only-key",
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  for (const prompt of ["one", "two", "three"]) {
    await ui.command(prompt);
    await app.settled();
  }
  await ui.refresh(true);
  return { app, ui, env };
}

const panelFrame = (
  ui: WorkspaceTui,
  columns: number,
  rows: number,
): string[] =>
  stripAnsi(
    renderWorkspace(ui, columns, rows, "", false, false, {
      color: false,
      motion: false,
    }),
  ).split("\n");

test("usage charts measure reported totals and print n/a for what nobody reported", () => {
  const records = [
    { inputTokens: 12, outputTokens: 8, totalTokens: 20, model: "alpha" },
    { inputTokens: 7, outputTokens: 3, totalTokens: 10, model: "alpha" },
    // No measurement at all: a record whose provider reported nothing.
    { model: "beta" },
  ];

  // Only the two reported totals become samples. The silent record is a gap,
  // not a zero, so the sparkline says it covers two of three records.
  assert.deepEqual(usageReportedTotals(records), [20, 10]);
  const spark = usageSparklineLine(records, 60);
  assert.ok(spark, "a reported series draws a sparkline");
  assert.match(spark!, /^Recent 2\s+[▁▂▃▄▅▆▇█]{2}/);
  assert.equal(
    usageSparklineLine([{ model: "beta" }], 60),
    undefined,
    "an unreported series draws nothing rather than a flat zero line",
  );

  // The split comes from real prompt/completion counts, and a side nobody
  // reported is named n/a instead of being drawn as an empty segment.
  const split = usageInputOutputLines(records, 60).join("\n");
  assert.match(split, /input\/output · 2\/3 records/);
  assert.match(split, /input 19/);
  assert.match(split, /output 11/);
  const inputOnly = usageInputOutputLines([{ inputTokens: 5 }], 60).join("\n");
  assert.match(inputOnly, /output n\/a/);
  assert.doesNotMatch(inputOnly, /output 0/);
  assert.match(
    usageInputOutputLines([{ model: "beta" }], 60).join("\n"),
    /input\/output n\/a/,
  );

  // Cost is never estimated: the activity layer reports none today, so the
  // line says n/a. A cost the provider does report is summed exactly.
  assert.match(usageCostLine(records, 60), /cost n\/a · no record reported a cost/);
  assert.match(
    usageCostLine([{ cost: 0.5 }, { cost: 0.25 }], 60),
    /cost 0\.75 · 2\/2 records/,
  );

  // A reported zero is a measurement and prints as one.
  assert.match(usageTotalLine([{ totalTokens: 0 }], 60), /^0 reported tokens · 1\/1 records$/);
  assert.match(usageTotalLine([{ model: "beta" }], 60), /n\/a/);

  // The model breakdown counts reported totals only, so the silent record's
  // model never appears with an invented figure.
  const models = usageModelLines(records, 60, 5).join("\n");
  assert.match(models, /TOP 1 MODELS BY TOKENS/);
  assert.match(models, /alpha 30/);
  assert.doesNotMatch(models, /beta/);
});

test("the ledger chain draws verified entries and marks a degraded chain", () => {
  assert.equal(chainGlyphs(3), "●─●─●");
  assert.equal(
    chainGlyphs(3, { verified: false }),
    "●─●─×",
    "a failed chain breaks at its last verified entry",
  );
  assert.equal(chainGlyphs(0), "", "no entries draw no chain");
  assert.equal(
    chainGlyphs(20),
    "●─●─●─●─●─●─●─●─…+12",
    "a chain longer than the row keeps its count as text",
  );

  assert.deepEqual(
    ledgerChainLines(
      { label: "managed", entries: 3, verified: true },
      { label: "proxy", entries: 0, verified: false },
      80,
    ),
    ["managed ●─●─● 3 signed · verified", "proxy no entries · no chain"],
  );

  // A failed workspace contributes no entries, so it is counted beside the
  // verified chain instead of turning those entries into a broken one.
  assert.equal(
    ledgerChainLines(
      { label: "managed", entries: 3, verified: true, failedWorkspaces: 1 },
      { label: "proxy", entries: 0, verified: false },
      120,
    )[0],
    "managed ●─●─● 3 signed · verified · 1 workspace DEGRADED",
  );

  // A chain that failed verification carries the marker and the exact reason.
  const degraded = ledgerChainLines(
    { label: "managed", entries: 2, verified: false },
    {
      label: "proxy",
      entries: 1,
      verified: false,
      reason: "hash integrity only; signature not verified (no verification key)",
    },
    120,
  );
  assert.equal(degraded[0], "managed ●─× 2 signed · DEGRADED");
  assert.equal(degraded[1], "proxy × 1 signed · DEGRADED");
  assert.match(degraded[2]!, /^proxy degraded: hash integrity only/);

  // Section headings say what their rows are evidence of, so the signed
  // section and the derived section stay distinct without colour.
  assert.equal(
    ledgerGroupHeading({
      kind: "entry",
      title: "SIGNED ENTRIES",
      icon: "▪",
      count: 3,
    }),
    "▪ SIGNED ENTRIES · 3 · signed evidence",
  );
  assert.equal(
    ledgerGroupHeading({
      kind: "learned",
      title: "LEARNED FROM THE CHAIN",
      icon: "◇",
      count: 1,
    }),
    "◇ LEARNED FROM THE CHAIN · 1 · derived, not evidence",
  );
  assert.equal(
    ledgerGroupHeading({
      kind: "agent",
      title: "AGENTS",
      icon: "◆",
      count: 4,
    }),
    "◆ AGENTS · 4",
  );
});

test("approval rows carry a risk badge from the real class and a real deadline", async (t) => {
  // The badge follows the reversibility class: r0 stays inside the
  // workspace, r1 to r3 can leave it, and an unclassified call is not
  // assumed local.
  assert.equal(approvalRiskBadge({ call: { klass: "r0" } }), "[0] local");
  assert.equal(approvalRiskBadge({ call: { klass: "r1" } }), "[!] external");
  assert.equal(approvalRiskBadge({ call: { klass: "r2" } }), "[!] external");
  assert.equal(approvalRiskBadge({ call: { klass: "r3" } }), "[!] external");
  assert.equal(
    approvalRiskBadge({ call: { klass: "r3", unclassified: true } }),
    "[?] unclassified",
    "an unclassified call never borrows the local badge",
  );
  assert.equal(approvalRiskBadge({}), "[?] unclassified");

  // The banner keeps the decision keys when the frame cannot hold the whole
  // sentence. A banner that drops them has dropped the only actionable part.
  const narrow = approvalBannerLines(
    [
      {
        holdId: "deadline01",
        call: { tool: "aws.s3.object.delete", klass: "r3" },
      },
    ],
    38,
  );
  assert.equal(narrow.length, 1);
  assert.match(narrow[0]!, /\[a\] approve/);
  assert.match(narrow[0]!, /\[d\] deny/);
  assert.ok(visibleLength(narrow[0]!) <= 38, narrow[0]!);

  const { ui } = await usagePanelApp(t);
  const proxyHold = (
    holdId: string,
    klass: string,
    expiresAt: number | undefined,
  ) => ({
    holdId,
    decisionToken: `token-${holdId}`,
    status: "pending" as const,
    call: {
      tool: klass === "r0" ? "workspace.read" : "aws.s3.object.delete",
      klass,
      workspace: "fixture",
      blastRadius: klass === "r0" ? 0 : 12,
    },
    notify: ["cli" as const],
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
  ui.proxy.holds = [
    proxyHold("deadline01", "r3", Date.now() + 45_000),
    proxyHold("local02", "r0", Date.now() + 300_000),
    proxyHold("nodeadline03", "r3", undefined),
  ] as unknown as typeof ui.proxy.holds;
  ui.choose("approvals");

  const frame80 = panelFrame(ui, 80, 24);
  const text80 = frame80.join("\n");
  // Counts come from the holds' real classes, not from their labels.
  assert.match(text80, /3 waiting · 2 external · 1 local/);
  assert.match(text80, /soonest deadline: \d+s · 1 with no deadline/);
  assert.match(text80, /\[0\] local/, "the local hold carries its badge");
  assert.match(text80, /no deadline \| \[!\] external/, "an undated hold says so");
  assert.match(text80, /preview n\/a · the selected hold carries no diff/);
  assert.match(text80, /\[a\] approve {2}\[d\] deny · Enter inspects/);

  // At 40x12 the body holds one row, so the keys have to survive in the
  // banner and the badge has to survive on the row.
  const frame40 = panelFrame(ui, 40, 12);
  const text40 = frame40.join("\n");
  assert.equal(frame40.length, 12);
  assert.match(text40, /\[a\] approve/);
  assert.match(text40, /\[d\] deny/);
  assert.match(text40, /\[!\] external/);
  assert.match(text40, /\d+s left \|/);

  // With no deadline sent, nothing invents one.
  ui.proxy.holds = [
    proxyHold("nodeadline01", "r3", undefined),
  ] as unknown as typeof ui.proxy.holds;
  const undated = panelFrame(ui, 80, 24).join("\n");
  assert.match(undated, /no deadline reported/);
  assert.match(undated, /no deadline \|/);
  assert.doesNotMatch(undated, /\d+s left \|/);
});

test("an empty usage panel reports n/a and never a measured zero", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-usage-empty-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  ui.choose("usage");
  const text = panelFrame(ui, 80, 24).join("\n");
  assert.match(text, /No usage records yet\./);
  assert.match(text, /no usage reported · tokens n\/a · cost n\/a/);
  assert.doesNotMatch(text, /0 reported tokens/);
  assert.doesNotMatch(text, /0 tokens ·/);
});

test("the usage, ledger and approvals panels hold five terminal sizes", async (t) => {
  const { ui } = await usagePanelApp(t);
  // A degraded workspace is a real state this panel must render at every
  // size, and its exact reason is the point of the tab.
  const degraded =
    "Signature / integrity ERROR. Recovery and export cannot be considered verified.";
  ui.proofErrors.set("deadbeef-failed", degraded);
  ui.proxy.holds = [
    {
      holdId: "deadline01",
      decisionToken: "token-deadline01",
      status: "pending",
      call: {
        tool: "aws.s3.object.delete",
        klass: "r3",
        workspace: "fixture",
        blastRadius: 12,
      },
      notify: ["cli"],
      expiresAt: Date.now() + 45_000,
    },
  ] as unknown as typeof ui.proxy.holds;

  const titles = { usage: "Usage", ledger: "Ledger", approvals: "Approvals" };
  for (const tab of ["usage", "ledger", "approvals"] as const) {
    ui.choose(tab);
    for (const [columns, rows] of [
      [40, 12],
      [80, 24],
      [120, 40],
      [160, 45],
      [200, 48],
    ] as const) {
      const frame = panelFrame(ui, columns, rows);
      assert.equal(frame.length, rows, `${tab} ${columns}x${rows} row count`);
      for (const row of frame)
        assert.ok(
          visibleLength(row) <= columns,
          `${tab} ${columns}x${rows} overflowed: ${row}`,
        );
      assert.ok(
        frame[0]!.includes(titles[tab]),
        `${tab} ${columns}x${rows} lost its panel title`,
      );
      // Mono carries the same state: the panel never paints with colour only.
      assert.ok(
        frame.every((row) => !row.includes("\u001b[")),
        `${tab} ${columns}x${rows} painted ANSI in a monochrome frame`,
      );
      if (columns >= 80) {
        const heading =
          tab === "usage"
            ? "TOKEN ACTIVITY"
            : tab === "ledger"
              ? "CHAIN STATUS"
              : "REVIEW QUEUE";
        assert.ok(
          frame.some((row) => row.includes(heading)),
          `${tab} ${columns}x${rows} lost ${heading}`,
        );
      }
    }
  }

  // The degraded ledger names the failure in full, so recovery cannot be
  // treated as verified by a reader who only saw the marker.
  ui.choose("ledger");
  const ledger = panelFrame(ui, 120, 40).join("\n");
  assert.match(ledger, /managed × DEGRADED · no verified entries/);
  assert.match(ledger, /1 workspace DEGRADED/);
  assert.ok(
    ledger.includes(`Managed ledger: ${degraded}`),
    "the exact verification failure is not rendered",
  );
  // Section headings state what their rows are evidence of.
  assert.match(ledger, /VERIFICATION · \d+ · chain check/);
  assert.match(ledger, /LEARNED FROM THE CHAIN · \d+ · derived, not evidence/);
});
