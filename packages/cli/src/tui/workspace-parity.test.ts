import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import {
  MODE_ICON,
  TAB_ICONS,
  TAB_ICON_TONE,
  WorkspaceTui,
  filterKeyForTab,
  approvalLabel,
  detectHarnesses,
  commandSuggestions,
  extractTodos,
  isDoubleEscape,
  holdSeverity,
  mentionCandidates,
  mentionToken,
  promptFrameBottom,
  promptFrameRow,
  promptFrameTop,
  renderWorkspace,
  searchHistoryPrompts,
} from "./workspace.ts";
import {
  ChordTracker,
  WorkspaceInput,
  nextPromptRow,
  workspaceShortcut,
} from "./workspace-runner.ts";
import { stripAnsi, visibleLength } from "./layout.ts";
import { moveHunk, setSide, toggleHunk } from "./diff-panel.ts";

const assistantFetcher = (content: string) => async (url: unknown) => {
  if (String(url).endsWith("/models"))
    return Response.json({ data: [{ id: "fixture" }] });
  return Response.json({
    choices: [{ message: { role: "assistant", content } }],
  });
};

async function fixtureApp(
  root: string,
  content = "ok",
  env: Record<string, string> = {},
) {
  const full = { NOMO_DATA_DIR: root, ...env };
  const app = new Workbench(full, assistantFetcher(content));
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture-key",
  });
  return { app, env: full };
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
  assert.match(full, /31 of 31 bindings/);
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
  assert.match(ui.detail!.join("\n"), /2 of 31 bindings/);
  assert.match(ui.detail!.join("\n"), /Jump by word/);
  assert.ok(
    !ui.detail!.join("\n").includes("Send the prompt"),
    "an unrelated binding is filtered out",
  );

  // A query that matches nothing says so rather than showing an empty screen.
  ui.keybindingQuery = "zzzz";
  ui.refreshKeybindings(80);
  assert.match(ui.detail!.join("\n"), /0 of 31 bindings/);
  assert.match(ui.detail!.join("\n"), /No binding matches/);

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
      assert.ok(
        rows.some((row) => row.startsWith("┌")),
        `no prompt frame top at ${width}x${height}`,
      );
      assert.ok(
        rows.some((row) => row.startsWith("└")),
        `no prompt frame bottom at ${width}x${height}`,
      );
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
  assert.ok(ui.groupTree, "the sessions tab builds a tree");
  const shown = ui.lines().join("\n");
  // A settled conversation reports "idle". Filing it under other would put
  // every finished conversation in a bucket named after what is not
  // happening.
  assert.match(shown, /settled\//);
  assert.ok(!shown.includes("other/"), "idle is a settled state, not other");
  // The summary must name what is on screen. Saying "documents hidden"
  // above a list of conversations is wrong in a way the reader has to stop
  // and parse, which is the whole cost the line exists to avoid.
  assert.match(shown, /0 groups collapsed, 0 conversations hidden/);
  assert.ok(!shown.includes("documents"), "the summary speaks about sessions");
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
  const frame = stripAnsi(renderWorkspace(ui, 100, 32));
  assert.match(frame, /mode: plan/);
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
  assert.equal(ui.tab, "overview");
  assert.ok(
    ui.detail?.join("\n").includes("mode: normal (local only, not enforced)"),
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
  assert.ok(ui.detail?.join("\n").includes("Conversations: 1"));
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
  const frame = stripAnsi(renderWorkspace(ui, 100, 32));
  assert.ok(frame.includes("Tab panels"));
});

test("prompt frame stays continuous at every width", async (t) => {
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
    [40, 12],

    [80, 24],
    [100, 32],
    [160, 45],
  ]) {
    const frame = stripAnsi(
      renderWorkspace(ui, width!, height!, "hello_", true, false, {
        cursor: 6,
      }),
    );
    const rows = frame.split("\n");
    assert.equal(rows.length, height);
    assert.ok(rows.every((line) => visibleLength(line) <= width!));
    const top = rows.find((line) => line.startsWith("┌"))!;
    const bottom = rows.find((line) => line.startsWith("└"))!;
    assert.ok(top.endsWith("┐"), top);
    assert.ok(bottom.endsWith("┘"), bottom);
    assert.equal(visibleLength(top), width);
    assert.equal(visibleLength(bottom), width);
    // Composer rows are the rows between the frame top and bottom. Selecting
    // them positionally instead of by prefix keeps the header rows, which also
    // start with the indent, out of the assertion.
    const topIndex = rows.findIndex((line) => line.startsWith("┌"));
    const bottomIndex = rows.findIndex((line) => line.startsWith("└"));
    const promptRows = rows.slice(topIndex + 1, bottomIndex);
    assert.ok(promptRows.length > 0);
    for (const row of promptRows) {
      assert.ok(row.startsWith("  "), row);
      assert.ok(row.endsWith("  "), row);
      assert.equal(visibleLength(row), width);
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
  assert.match(frame, /Finishing operation/);
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

test("logo is one stroke width and every row aligns", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-logo-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  const rows = stripAnsi(renderWorkspace(ui, 100, 32)).split("\n");
  // The mark is 7 rows of half blocks: an ink square outline, an accent
  // square inside it, and a dot in the centre. Every row carries ink, so the
  // mark never reads as a broken or partial rule.
  const mark = rows.slice(0, 7).map((line) => line.slice(0, 13));
  assert.ok(mark.every((line) => /[█▀▄]/.test(line)));
  // Column 0 and column 12 are the outer rule, so they are ink on every row.
  for (const row of mark) {
    assert.ok(row.startsWith("█"), row);
    assert.equal(row[12], "█", row);
  }
  // The centre cell of the middle row is the dot.
  assert.equal(mark[3]![6], "█", mark[3]);
});

test("tab icons carry fixed colors in color mode only", async (t) => {
  for (const tone of Object.values(TAB_ICON_TONE))
    assert.match(tone, /^38;5;\d+$/);
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-icon-tone-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  const color = renderWorkspace(ui, 200, 40, "_", true, false, { color: true });
  assert.ok(color.includes("38;5;203"));
  assert.ok(color.includes("38;5;78"));
  const mono = stripAnsi(renderWorkspace(ui, 100, 32, "_", true));
  assert.ok(!mono.includes("38;5;"));
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

test("Ctrl+T maps to the checklist in every editing state", () => {
  assert.equal(
    workspaceShortcut({ name: "t", ctrl: true }, true, "draft"),
    "show-todos",
  );
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
  ui.mode = "plan";
  assert.ok(
    renderWorkspace(ui, 80, 24, "hi_", true, false, { color: true }).includes(
      "38;5;75",
    ),
  );
  ui.mode = "accept";
  assert.ok(
    renderWorkspace(ui, 80, 24, "hi_", true, false, { color: true }).includes(
      "38;5;78",
    ),
  );
  ui.mode = "normal";
  assert.ok(
    renderWorkspace(ui, 80, 24, "hi_", true, false, { color: true }).includes(
      "38;5;117",
    ),
  );
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
  assert.equal(ui.tab, "overview");
  ui.cycle(1);
  assert.equal(ui.tab, "chat");
  ui.cycle(-1);
  assert.equal(ui.tab, "overview");
  ui.choose("overview");
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
  assert.match(frame, /\+1 queued/);
});

test("typing filters lists, bound keys keep their action", () => {
  assert.equal(filterKeyForTab("m", { name: undefined }, "models"), "m");
  assert.equal(filterKeyForTab("u", { name: undefined }, "models"), undefined);
  assert.equal(filterKeyForTab("q", { name: undefined }, "models"), undefined);
  assert.equal(filterKeyForTab("?", { name: undefined }, "models"), undefined);
  assert.equal(filterKeyForTab("m", { name: undefined }, "chat"), undefined);
  assert.equal(filterKeyForTab("m", { name: undefined }, "help"), undefined);
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
  assert.ok(ui.detail?.join("\n").includes("Shift+Tab or Alt+M"));
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
  assert.match(ui.notice, /Theme set: paper \+ unicode/);

  await ui.command("/theme dark classic");
  assert.equal(ui.themeConfig.colorTheme, "dark");
  assert.equal(ui.themeConfig.symbolPreset, "classic");

  await ui.command("/theme preview solarized-dark classic");
  assert.equal(ui.themeConfig.colorTheme, "solarized-dark");
  assert.equal(ui.themeConfig.symbolPreset, "classic");

  await ui.command("/theme reset");
  assert.equal(ui.themeConfig.colorTheme, initialColor);
  assert.equal(ui.themeConfig.symbolPreset, initialSymbol);

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
  // `devKeyProvider` — a function that *creates* a signing key when none
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
  assert.match(stripAnsi(early), /Finishing operation\. \//);
  assert.match(stripAnsi(late), /Finishing operation\.\. \//);
  assert.notEqual(stripAnsi(early), stripAnsi(late));
  const still = (frame: number) =>
    renderWorkspace(ui, 80, 30, "_", true, true, { frame, motion: false });
  assert.equal(stripAnsi(still(0)), stripAnsi(still(9)));
  assert.match(stripAnsi(still(0)), /Finishing operation \/ Esc stop/);
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
  assert.match(lines, /Provider: unknown|Provider: unknown/);
  assert.match(lines, /setup-required/);
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
