import { emitKeypressEvents, type Key } from "node:readline";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import { LocalStorage } from "../../../workbench/src/storage.ts";
import {
  WorkspaceTui,
  workspaceTab,
  commandSuggestions,
  filterKeyForTab,
  isDoubleEscape,
  mentionCandidates,
  mentionToken,
  renderWorkspace,
  searchHistoryPrompts,
  message,
  TUI_COMMANDS,
  type WorkspaceTab,
} from "./workspace.ts";
import {
  advanceSelection as advancePaletteSelection,
  backspaceInPalette,
  filterPalette,
  paletteFromCommands,
  typeInPalette,
} from "./palette.ts";
import { moveHunk, setSide, toggleHunk } from "./diff-panel.ts";
import { DiffScreenWriter } from "./watch.ts";
import { sanitizeText } from "./layout.ts";
import { dataDir as productDataDir } from "../../../ledger/src/paths.ts";
import { envValue } from "../../../ledger/src/env-compat.ts";
import { normalizeOwnedEnv } from "../env-keys.ts";

export type WorkspaceShortcut =
  | "redraw"
  | "toggle-tools"
  | "search-history"
  | "stash"
  | "external-editor"
  | "show-todos"
  | "quit";

export function workspaceShortcut(
  key: Key,
  editing: boolean,
  input: string,
): WorkspaceShortcut | undefined {
  if (!key.ctrl) return undefined;
  if (key.name === "l") return "redraw";
  if (key.name === "o") return "toggle-tools";
  if (key.name === "r" && editing) return "search-history";
  if (key.name === "s") return "stash";
  if (key.name === "g") return "external-editor";
  if (key.name === "t") return "show-todos";
  if (key.name === "d" && (!editing || !input)) return "quit";
  return undefined;
}

/** Two key chords with a short window, for readline native bindings the
 * terminal sends as separate presses. Stays in memory only. */
export class ChordTracker {
  private pendingAt = 0;
  chord(key: Key, now = Date.now()): "external-editor" | undefined {
    if (key.ctrl && key.name === "x") {
      this.pendingAt = now;
      return;
    }
    const open = this.pendingAt > 0 && now - this.pendingAt < 1500;
    this.pendingAt = 0;
    if (open && key.ctrl && key.name === "e") return "external-editor";
    return;
  }
}

/** Jump between user prompts in the rendered chat rows. Rows are viewport
 * offsets, so the runner can set the scroll position directly. */
export function nextPromptRow(
  rows: readonly number[],
  offset: number,
  direction: 1 | -1,
): number {
  if (direction === 1) return rows.find((row) => row > offset) ?? -1;
  return [...rows].reverse().find((row) => row < offset) ?? -1;
}

/** Bracketed paste never submits a message or an approval. */
export class WorkspaceInput {
  editing = false;
  value = "";
  cursor = 0;
  pasting = false;
  // Kill ring: Ctrl+K, Ctrl+U, Ctrl+W and Alt+D store deleted text for Ctrl+Y.
  // Undo keeps one previous state for Ctrl+_. Both stay in memory only.
  kill = "";
  /** A slash command requested by a bound key (Ctrl+P); the runner consumes it. */
  pendingCommand?: string;
  private undoState?: { value: string; cursor: number };
  set(value: string) {
    this.value = value;
    this.cursor = [...value].length;
  }
  private remember() {
    this.undoState = { value: this.value, cursor: this.cursor };
  }
  undoEdit(): boolean {
    if (!this.undoState) return false;
    this.value = this.undoState.value;
    this.cursor = Math.min(
      this.undoState.cursor,
      [...this.undoState.value].length,
    );
    this.undoState = undefined;
    return true;
  }
  insert(value: string) {
    this.remember();
    const points = [...this.value];
    points.splice(this.cursor, 0, ...value);
    this.value = points.join("").slice(0, 32000);
    this.cursor = Math.min(
      this.cursor + [...value].length,
      [...this.value].length,
    );
  }
  private static isWordChar(point: string): boolean {
    return /[A-Za-z0-9]/.test(point);
  }
  private editKey(key: Key): boolean {
    const points = [...this.value];
    const up = key.name === "up" || (key.ctrl && key.name === "p");
    const down = key.name === "down" || (key.ctrl && key.name === "n");
    if (up || down) {
      const start = this.cursor
        ? points.lastIndexOf("\n", this.cursor - 1) + 1
        : 0;
      const column = this.cursor - start;
      if (up && start > 0) {
        const previous =
          start > 1 ? points.lastIndexOf("\n", start - 2) + 1 : 0;
        this.cursor = Math.min(start - 1, previous + column);
      } else if (down) {
        const end = points.indexOf("\n", this.cursor);
        if (end >= 0) {
          const nextEnd = points.indexOf("\n", end + 1);
          this.cursor = Math.min(
            nextEnd < 0 ? points.length : nextEnd,
            end + 1 + column,
          );
        }
      }
      return true;
    }
    // Word jumps use letter and digit runs, so punctuation separates words.
    // Ctrl+W is the exception and deletes back to whitespace. Ctrl+Left and
    // Ctrl+Right mirror the Alt word jumps for terminals that send them.
    if ((key.meta && key.name === "b") || (key.ctrl && key.name === "left")) {
      let pos = this.cursor;
      while (pos > 0 && !WorkspaceInput.isWordChar(points[pos - 1]!)) pos--;
      while (pos > 0 && WorkspaceInput.isWordChar(points[pos - 1]!)) pos--;
      this.cursor = pos;
      return true;
    }
    if ((key.meta && key.name === "f") || (key.ctrl && key.name === "right")) {
      let pos = this.cursor;
      while (pos < points.length && !WorkspaceInput.isWordChar(points[pos]!))
        pos++;
      while (pos < points.length && WorkspaceInput.isWordChar(points[pos]!))
        pos++;
      this.cursor = pos;
      return true;
    }
    if (key.meta && key.name === "d") {
      this.remember();
      const start = this.cursor;
      let pos = start;
      while (pos < points.length && !WorkspaceInput.isWordChar(points[pos]!))
        pos++;
      while (pos < points.length && WorkspaceInput.isWordChar(points[pos]!))
        pos++;
      this.kill = points.slice(start, pos).join("");
      points.splice(start, pos - start);
      this.value = points.join("");
      return true;
    }
    if (key.ctrl && key.name === "w") {
      this.remember();
      let start = this.cursor;
      while (start > 0 && /\s/u.test(points[start - 1]!)) start--;
      while (start > 0 && !/\s/u.test(points[start - 1]!)) start--;
      this.kill = points.slice(start, this.cursor).join("");
      points.splice(start, this.cursor - start);
      this.cursor = start;
      this.value = points.join("");
      return true;
    }
    if (key.ctrl && key.name === "k") {
      this.remember();
      const end = points.indexOf("\n", this.cursor);
      const count =
        end < 0 ? points.length - this.cursor : Math.max(1, end - this.cursor);
      this.kill = points.slice(this.cursor, this.cursor + count).join("");
      points.splice(this.cursor, count);
      this.value = points.join("");
      return true;
    }
    return false;
  }
  key(value: string | undefined, key: Key): "submit" | "escape" | undefined {
    if (key.name === "paste-start") {
      this.pasting = true;
      this.editing = true;
      return;
    }
    if (key.name === "paste-end") {
      this.pasting = false;
      return;
    }
    if (!this.editing) return;
    if (this.pasting) {
      if (value)
        this.insert(
          value
            .replace(/\r/g, "\n")
            .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""),
        );
      return;
    }
    if (key.name === "escape") {
      this.editing = false;
      return "escape";
    }
    // Ctrl+J inserts a newline in every terminal, no setup needed.
    if (key.ctrl && key.name === "j") {
      this.insert("\n");
      return;
    }
    if (key.ctrl && key.name === "y") {
      if (this.kill) this.insert(this.kill);
      return;
    }
    if (key.ctrl && (key.name === "_" || key.name === "-")) {
      this.undoEdit();
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      // Shift+Enter, Alt+Enter and Ctrl+Enter insert a newline. A trailing
      // backslash plus Enter is the fallback that works in every terminal.
      if (key.meta || key.shift || key.ctrl) {
        this.insert("\n");
        return;
      }
      const pointsNow = [...this.value];
      if (
        this.cursor === pointsNow.length &&
        pointsNow.length > 0 &&
        pointsNow[pointsNow.length - 1] === "\\"
      ) {
        this.remember();
        pointsNow.pop();
        this.value = pointsNow.join("");
        this.cursor = pointsNow.length;
        this.insert("\n");
        return;
      }
      return "submit";
    }
    // Ctrl+P requests the command palette before the edit keys: the palette
    // must win over the Ctrl+P cursor-up alias.
    if (key.ctrl && key.name === "p") {
      this.pendingCommand = "/command-palette";
      return;
    }
    if (this.editKey(key)) return;
    const points = [...this.value];
    if (key.name === "backspace") {
      if (this.cursor) {
        this.remember();
        points.splice(--this.cursor, 1);
      }
      this.value = points.join("");
    } else if (key.name === "delete") {
      this.remember();
      points.splice(this.cursor, 1);
      this.value = points.join("");
    } else if (key.ctrl && key.name === "d") {
      this.remember();
      points.splice(this.cursor, 1);
      this.value = points.join("");
    } else if (key.name === "left") this.cursor = Math.max(0, this.cursor - 1);
    else if (key.name === "right")
      this.cursor = Math.min(points.length, this.cursor + 1);
    else if (key.name === "home" || (key.ctrl && key.name === "a"))
      this.cursor = 0;
    else if (key.name === "end" || (key.ctrl && key.name === "e"))
      this.cursor = points.length;
    else if (key.ctrl && key.name === "u") {
      this.remember();
      this.kill = points.slice(0, this.cursor).join("");
      this.set("");
    } else if (
      !key.ctrl &&
      !key.meta &&
      value &&
      !/[\x00-\x1f\x7f-\x9f]/.test(value)
    )
      this.insert(value);
    return;
  }
  display() {
    // Block cursor, one cell like a terminal cursor. The render matches it
    // literally, so typed text can never be mistaken for the cursor.
    const points = [...this.value];
    points.splice(this.cursor, 0, "▌");
    return points.join("");
  }
}

export async function runWorkspaceTui(
  argv: readonly string[],
): Promise<number> {
  let directory: string | undefined,
    once = false,
    source: string | undefined,
    sessionId: string | undefined;
  let tab: WorkspaceTab = "chat";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--once") once = true;
    else if (arg === "--help") {
      console.log(
        "nomo tui [--once] [--view runs|overview|chat|sessions|documents|ledger|approvals|policy|tools|models|usage|help] [--session ID] [--data-dir PATH] [--import-provider opencode:zen|opencode:tokenrouter]",
      );
      return 0;
    } else if (
      ["--view", "--session", "--data-dir", "--import-provider"].includes(arg!)
    ) {
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw Error(`${arg} requires a value`);
      if (arg === "--view") {
        const selected = workspaceTab(value);
        if (!selected) throw Error("Unknown TUI view");
        tab = selected;
      }
      if (arg === "--session") sessionId = value;
      if (arg === "--data-dir") directory = resolve(value);
      if (arg === "--import-provider") source = value;
    } else throw Error(`Unknown TUI option: ${arg}`);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(directory ? { NOMO_DATA_DIR: directory } : {}),
  };
  // Normalized here rather than only in the binary so a test that drives the
  // TUI entry point directly sees the same settings an operator configured
  // under the old names.
  Object.assign(env, normalizeOwnedEnv(env));
  const app = new Workbench(env),
    ui = new WorkspaceTui(app, env);
  const dataDir =
    envValue(env, "NOMO_DATA_DIR") ??
    join(
      envValue(env, "NOMO_LEDGER_DIR") ?? join(productDataDir(homedir())),
      "workbench",
    );
  const store = new LocalStorage(join(dataDir, "tui"));
  const saved = store.read<{
    sessionId?: string;
    projectId?: string;
    agentId?: string;
    lastRecoveryJob?: { sessionId: string; jobId: string };
    model?: string;
    compactTools?: boolean;
    mode?: string;
    drafts: Record<string, string>;
  }>();
  const drafts = saved?.drafts ?? {};
  const input = new WorkspaceInput();
  await ui.initialize();
  ui.compactTools = saved?.compactTools ?? true;
  if (
    saved?.mode === "normal" ||
    saved?.mode === "accept" ||
    saved?.mode === "plan"
  )
    ui.mode = saved.mode;
  if (source) await ui.command(`/connect ${source}`);
  const selected = sessionId ?? saved?.sessionId;
  if (selected && app.get(selected)) ui.sessionId = selected;
  if (saved?.model && ui.provider?.models.some((m) => m.id === saved.model))
    ui.model = saved.model;
  ui.choose(tab);
  if (app.listProjects().some((item) => item.id === saved?.projectId))
    ui.projectId = saved?.projectId;
  if (app.agents().agents.some((item) => item.id === saved?.agentId))
    ui.agentId = saved?.agentId;
  if (saved?.lastRecoveryJob && app.get(saved.lastRecoveryJob.sessionId))
    ui.lastRecoveryJob = saved.lastRecoveryJob;
  input.set(drafts[ui.sessionId ?? "new"] ?? "");
  const interactive =
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    process.env.TERM !== "dumb" &&
    !process.env.CI;
  if (once || !interactive) {
    console.log(
      renderWorkspace(
        ui,
        process.stdout.columns ?? 100,
        process.stdout.rows ?? 32,
      ),
    );
    await app.shutdown();
    return ui.proofErrors.size || ui.proxy.errors.length ? 1 : 0;
  }
  input.editing = tab === "chat";
  let suggestion = 0;
  let historyIndex = -1;
  let historyDraft = "";
  let historyQuery = "";
  let historyPos = -1;
  let mentionIndex = 0;
  let lastEsc = 0;
  // Ctrl+S stash slot and Ctrl+L double press stay local, never persisted.
  let stash = "";
  let stashCursor = 0;
  let lastCtrlL = 0;
  let lastCtrlD = 0;
  const chord = new ChordTracker();
  const startedAt = Date.now();
  // NOMO has its own explicit color preference; inherited NO_COLOR must not hide its UI.
  const color = env.NOMO_TUI_COLOR !== "0";
  const motion = env.NOMO_TUI_MOTION !== "0" && env.TERM !== "dumb";
  const screen = new DiffScreenWriter(process.stdout);
  let busy = false,
    suspended = false,
    stopped = false,
    refreshing = false;
  const wasRaw = process.stdin.isRaw;
  let timer: NodeJS.Timeout | undefined, draftTimer: NodeJS.Timeout | undefined;
  const saveDraft = () => {
    if (!input.value.startsWith("/"))
      drafts[ui.sessionId ?? "new"] = input.value;
    store.save({
      sessionId: ui.sessionId,
      projectId: ui.projectId,
      agentId: ui.agentId,
      lastRecoveryJob: ui.lastRecoveryJob,
      model: ui.model,
      compactTools: ui.compactTools,
      mode: ui.mode,
      drafts,
    });
  };
  const scheduleDraft = () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try {
        saveDraft();
      } catch (e) {
        ui.notice = message(e);
      }
    }, 500);
  };
  const draw = () => {
    if (!stopped && !suspended)
      screen.write(
        renderWorkspace(
          ui,
          process.stdout.columns ?? 80,
          process.stdout.rows ?? 24,
          input.display(),
          input.editing,
          busy,
          {
            now: Date.now(),
            color: ui.colorOverride ?? color,
            motion: ui.motionOverride ?? motion,
            frame: Math.floor((Date.now() - startedAt) / 140),
            boot: motion && Date.now() - startedAt < 1800,
            command: input.value,
            suggestion,
            cursor: input.cursor,
          },
        ),
      );
  };
  let activeTask: Promise<void> = Promise.resolve();
  const task = (fn: () => Promise<unknown>) => {
    if (busy) return activeTask;
    busy = true;
    activeTask = (async () => {
      try {
        await fn();
        await ui.refresh();
        const queued = ui.takeQueued();
        if (queued) {
          try {
            await ui.command(queued);
            await ui.refresh();
          } catch (error) {
            ui.notice = message(error);
          }
        }
      } catch (error) {
        ui.notice = message(error);
      } finally {
        busy = false;
        draw();
      }
    })();
    return activeTask;
  };
  const editor = async () => {
    const target = ui.editTarget();
    const config: unknown = env.NOMO_TUI_EDITOR
      ? JSON.parse(env.NOMO_TUI_EDITOR)
      : [env.EDITOR || "nano"];
    if (
      !Array.isArray(config) ||
      !config.length ||
      !config.every((v) => typeof v === "string" && v.length)
    )
      throw Error(
        "NOMO_TUI_EDITOR must be a JSON array of an executable and its arguments.",
      );
    const temp = await mkdtemp(join(tmpdir(), "nomo-editor-")),
      file = join(temp, "document.txt");
    let captured = false;
    await writeFile(file, target.content, { mode: 0o600 });
    suspended = true;
    process.stdin.setRawMode(false);
    process.stdin.pause();
    screen.leave();
    process.stdout.write("\x1b[?2004l");
    try {
      const code = await new Promise<number | null>((done, reject) => {
        const child = spawn(config[0], [...config.slice(1), file], {
          stdio: "inherit",
          shell: false,
        });
        child.once("error", reject);
        child.once("exit", done);
      });
      if (code !== 0)
        throw Error(
          "The editor did not finish. The original document is preserved.",
        );
      const content = await readFile(file, "utf8");
      if (Buffer.byteLength(content) > 256000)
        throw Error("Document exceeds 256 kB.");
      ui.prepareEdit(target, content);
      captured = true;
    } catch (error) {
      throw Error(`${message(error)} Editor draft preserved at ${file}`);
    } finally {
      if (captured) await rm(temp, { recursive: true, force: true });
      suspended = false;
      if (!stopped) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        screen.enter();
        process.stdout.write("\x1b[?2004h");
      }
    }
  };
  return new Promise<number>((resolveDone) => {
    const restoreTerminal = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearTimeout(draftTimer);
      process.stdin.off("keypress", onKey);
      process.stdout.off("resize", draw);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.off("SIGHUP", stop);
      process.off("exit", restoreTerminal);
      process.off("uncaughtExceptionMonitor", restoreTerminal);
      screen.leave();
      process.stdout.write("\x1b[?2004l");
    };
    const stop = () => {
      if (stopped) return;
      // Fatal exits need synchronous terminal cleanup, never asynchronous storage work.
      restoreTerminal();
      let draftError = false;
      try {
        saveDraft();
      } catch {
        draftError = true;
      }
      if (draftError) console.error("Could not save the draft.");
      console.log(
        "NOMO: stopping the run and saving history. A dispatched external tool may still complete.",
      );
      void (async () => {
        app.close();
        await activeTask;
        await app.settled();
      })().then(
        () => resolveDone(draftError ? 1 : 0),
        () => {
          console.error(
            "Save failed. Preserve the data directory and check the ledger.",
          );
          resolveDone(1);
        },
      );
    };
    const submit = async () => {
      const original = input.value,
        oldSession = ui.sessionId ?? "new";
      const result = await ui.command(original);
      if (result === "quit") {
        stop();
        return;
      }
      if (!original.trimStart().startsWith("/")) drafts[oldSession] = "";
      input.set(drafts[ui.sessionId ?? "new"] ?? "");
      input.editing = ui.tab === "chat" && !ui.detail;
      suggestion = 0;
      historyIndex = -1;
      if (result === "edit") await editor();
      saveDraft();
    };
    const navigate = async (fn: () => Promise<unknown>) => {
      const prior = ui.sessionId;
      saveDraft();
      await fn();
      if (prior !== ui.sessionId)
        input.set(drafts[ui.sessionId ?? "new"] ?? "");
    };
    const onKey = async (value: string | undefined, key: Key) => {
      if (stopped || suspended) return;
      // An open palette consumes every key except the ones it binds itself.
      // Letting the key fall through would move tabs or run a shortcut behind
      // a filter surface, which is how a search box starts deleting work.
      if (ui.palette) {
        if (key.name === "escape") {
          ui.palette = undefined;
          ui.notice = "Palette closed.";
          draw();
          return;
        }
        if (key.name === "return") {
          const matches = filterPalette(
            paletteFromCommands(TUI_COMMANDS),
            ui.palette.query,
          );
          const picked = matches[ui.palette.selected];
          ui.palette = undefined;
          if (!picked) {
            ui.notice = "No command matches that.";
            draw();
            return;
          }
          input.set(picked.id);
          await task(() => ui.command(picked.id));
          return;
        }
        if (key.name === "up" || key.name === "down") {
          ui.palette = advancePaletteSelection(
            ui.palette,
            filterPalette(paletteFromCommands(TUI_COMMANDS), ui.palette.query),
            key.name === "down" ? 1 : -1,
          );
          draw();
          return;
        }
        if (key.name === "backspace") {
          ui.palette = backspaceInPalette(ui.palette);
          draw();
          return;
        }
        if (value && !key.ctrl && !key.meta && [...value].length === 1) {
          ui.palette = typeInPalette(ui.palette, value);
          draw();
          return;
        }
        draw();
        return;
      }
      // The diff panel owns a small set of keys while it is on screen. They
      // are bound here rather than in the normal shortcut path because j, k
      // and space are already filter keys on the list tabs, and the panel is
      // the only surface where staging a hunk is the obvious meaning.
      if (ui.diffView) {
        if (key.name === "down" || value === "j") {
          ui.diffView = moveHunk(ui.diffView, 1);
          ui.rediff();
          draw();
          return;
        }
        if (key.name === "up" || value === "k") {
          ui.diffView = moveHunk(ui.diffView, -1);
          ui.rediff();
          draw();
          return;
        }
        if (key.name === "space") {
          ui.diffView = toggleHunk(ui.diffView, ui.diffView.cursor);
          ui.rediff();
          draw();
          return;
        }
        if (value === "s") {
          ui.diffView = setSide(ui.diffView, "split");
          ui.rediff();
          draw();
          return;
        }
        if (value === "u") {
          ui.diffView = setSide(ui.diffView, "unified");
          ui.rediff();
          draw();
          return;
        }
        if (value === "a") {
          const all = ui.diffView.hunks.every((hunk) => hunk.staged);
          ui.diffView = {
            ...ui.diffView,
            hunks: ui.diffView.hunks.map((hunk) => ({ ...hunk, staged: !all })),
          };
          ui.rediff();
          draw();
          return;
        }
      }
      // The keybinding table is searchable in place. A thirty row reference
      // the operator has to scroll is the reason people stop checking and
      // guess instead, and this is the one view where looking something up is
      // the whole task.
      if (ui.showingKeybindings) {
        if (key.name === "backspace") {
          ui.keybindingQuery = ui.keybindingQuery.slice(0, -1);
          ui.refreshKeybindings();
          draw();
          return;
        }
        // Escape with a query clears it, and with an empty query falls
        // through to the normal close, so the key means the obvious thing at
        // both ends without a second binding to remember.
        if (key.name === "escape" && ui.keybindingQuery) {
          ui.keybindingQuery = "";
          ui.refreshKeybindings();
          draw();
          return;
        }
        if (value && !key.ctrl && !key.meta && [...value].length === 1) {
          ui.keybindingQuery += value;
          ui.refreshKeybindings();
          draw();
          return;
        }
      }
      // The cheat sheet is filtered the same way, for the same reason, and it
      // is reachable from anywhere so this block has to work in every mode.
      // Escape with a filter clears it, with an empty filter closes the sheet,
      // so one key covers both ends of the same action.
      if (ui.showingCheatSheet) {
        if (key.name === "backspace") {
          ui.cheatQuery = ui.cheatQuery.slice(0, -1);
          ui.refreshCheatSheet();
          draw();
          return;
        }
        if (key.name === "escape" && ui.cheatQuery) {
          ui.cheatQuery = "";
          ui.refreshCheatSheet();
          draw();
          return;
        }
        if (key.name === "escape") {
          ui.closeCheatSheet();
          draw();
          return;
        }
        if (value && !key.ctrl && !key.meta && [...value].length === 1) {
          ui.cheatQuery += value;
          ui.refreshCheatSheet();
          draw();
          return;
        }
      }
      // Shift+/ opens the sheet. It has to be a binding of its own because
      // plain question mark is a printable character the operator can type,
      // and stealing it would put a stray character from a paste at risk.
      if (
        value === "?" &&
        key.shift &&
        !key.ctrl &&
        !key.meta &&
        !input.editing
      ) {
        // Not while the composer has focus. A question mark mid sentence is
        // ordinary text, and an overlay that swallowed it would corrupt the
        // prompt without the operator doing anything unusual.
        ui.openCheatSheet();
        draw();
        return;
      }
      // Double Escape must be consecutive, not span commands typed in between.
      if (key.name !== "escape") lastEsc = 0;
      if (
        !input.pasting &&
        ((key.ctrl && key.name === "c") || key.name === "escape") &&
        app.running()
      ) {
        try {
          const session = ui.session();
          if (session?.status === "running") {
            app.cancel(session.id);
            // A tool already dispatched may still complete after the cancel.
            // That is the one case where the operator has to keep looking, so
            // it gets a sticky toast rather than a notice the next key
            // overwrites.
            ui.announce(
              "run-stopped",
              "pending",
              "Run stopped. A dispatched tool may still complete.",
            );
          } else {
            if (key.name === "escape") input.editing = false;
            ui.notice =
              "Selected conversation is not running. Open the active conversation to cancel it.";
          }
        } catch (error) {
          ui.announce("cancel-failed", "danger", message(error));
        }
        draw();
        return;
      }
      if (key.ctrl && key.name === "c") {
        if (input.editing && input.value) {
          input.set("");
          suggestion = 0;
          try {
            saveDraft();
          } catch (error) {
            ui.notice = message(error);
          }
          draw();
        } else stop();
        return;
      }
      const shortcut = ui.confirmation
        ? undefined
        : workspaceShortcut(key, input.editing, input.value);
      if (shortcut === "quit") {
        // Empty input exits on the second press within 800 ms, like the
        // reference terminal. Text input clears first instead of quitting.
        if (input.value) {
          input.set("");
          suggestion = 0;
          try {
            saveDraft();
          } catch (error) {
            ui.notice = message(error);
          }
          ui.notice = "Cleared. Draft saved.";
          draw();
          return;
        }
        const nowD = Date.now();
        if (isDoubleEscape(nowD, lastCtrlD)) {
          lastCtrlD = 0;
          stop();
          return;
        }
        lastCtrlD = nowD;
        // Exit guidance must not be masked by the history viewport status.
        ui.scroll = -1;
        ui.notice = "Press Ctrl+D again to exit.";
        draw();
        return;
      }
      if (shortcut === "show-todos") {
        void task(() => ui.command("/todos"));
        return;
      }
      if (shortcut === "redraw") {
        // Second Ctrl+L within 2 s runs /clear, like the reference terminal.
        const nowL = Date.now();
        if (nowL - lastCtrlL < 2000) {
          lastCtrlL = 0;
          void task(async () => {
            await navigate(() => ui.command("/clear"));
            input.editing = true;
          });
        } else {
          lastCtrlL = nowL;
          screen.redraw();
          draw();
        }
        return;
      }
      if (shortcut === "stash") {
        if (input.value) {
          stash = input.value;
          stashCursor = input.cursor;
          input.set("");
          suggestion = 0;
          ui.notice = "Stashed. Ctrl+S restores the prompt.";
        } else if (stash) {
          input.set(stash);
          input.cursor = Math.min(stashCursor, [...input.value].length);
          ui.notice = "Restored the stashed prompt.";
        } else {
          ui.notice = "Nothing stashed. Type first, then Ctrl+S.";
        }
        try {
          saveDraft();
        } catch (error) {
          ui.notice = message(error);
        }
        draw();
        return;
      }
      if (shortcut === "external-editor") {
        void task(async () => {
          await editor();
          saveDraft();
        });
        return;
      }
      if (shortcut === "toggle-tools") {
        ui.compactTools = !ui.compactTools;
        ui.notice = ui.compactTools
          ? "Compact tool output. Ctrl+O shows full results."
          : "Full tool output. Ctrl+O collapses results.";
        try {
          saveDraft();
        } catch (error) {
          ui.notice = message(error);
        }
        draw();
        return;
      }
      if (shortcut === "search-history") {
        if (!input.value) {
          input.set("/find ");
          suggestion = 0;
          historyQuery = "";
          historyPos = -1;
          ui.notice = "Type search text and press Enter.";
          draw();
          return;
        }
        const matches = searchHistoryPrompts(ui.promptHistory(), input.value);
        if (!matches.length) {
          ui.notice = "No matching prompt in this conversation.";
          draw();
          return;
        }
        if (historyQuery !== input.value) {
          historyQuery = input.value;
          historyPos = -1;
        }
        historyPos = (historyPos + 1) % matches.length;
        input.set(matches[historyPos]!);
        ui.notice =
          `History ${historyPos + 1}/${matches.length}. ` +
          "Ctrl+R again for an older match.";
        draw();
        return;
      }
      if (key.name === "paste-start" && ui.confirmation) {
        input.pasting = true;
        return;
      }
      if (input.pasting && ui.confirmation) {
        if (key.name === "paste-end") input.pasting = false;
        return;
      }
      if (ui.confirmation) {
        if (key.name === "escape") {
          ui.confirmation = undefined;
          ui.scroll = 0;
        } else if (value === "y" && !input.pasting)
          void task(() => ui.confirm());
        else if (value === "n" && !input.pasting) ui.reject();
        else if (/^[1-9]$/.test(value ?? "") && !input.pasting) {
          // Per hunk diff scope, client side. The selection rides with
          // the decision; the server applies the full call until scope
          // is enforced by another lane.
          ui.toggleHunk(Number(value) - 1);
        } else if (key.name === "pageup")
          ui.scroll = Math.max(0, ui.scroll - 10);
        else if (key.name === "pagedown") ui.scroll += 10;
        draw();
        return;
      }
      if (!input.pasting && key.name === "tab" && key.shift) {
        ui.cycleMode();
        try {
          saveDraft();
        } catch (error) {
          ui.notice = message(error);
        }
        draw();
        return;
      }
      // Readline native chord: Ctrl+X then Ctrl+E opens the editor. A lone
      // Ctrl+X arms nothing visible; any other key disarms it.
      if (!input.pasting && chord.chord(key) === "external-editor") {
        void task(async () => {
          await editor();
          saveDraft();
        });
        return;
      }
      // Alt+M cycles modes where Shift+Tab never arrives. Meta+P opens the
      // model picker without clearing the prompt. Both mirror the reference.
      if (!input.pasting && key.meta && key.name === "m") {
        ui.cycleMode();
        try {
          saveDraft();
        } catch (error) {
          ui.notice = message(error);
        }
        draw();
        return;
      }
      if (!input.pasting && key.meta && key.name === "p") {
        ui.choose("models");
        input.editing = false;
        ui.notice = "Models. Enter picks the model for new conversations.";
        draw();
        return;
      }
      if (
        !input.pasting &&
        key.ctrl &&
        key.name === "end" &&
        ui.tab === "chat" &&
        !ui.detail
      ) {
        ui.scroll = -1;
        draw();
        return;
      }
      if (input.editing || key.name === "paste-start") {
        // A lone ? on empty input opens help instead of typing, like the
        // reference. Any other text keeps the keystroke as typed input.
        if (!input.pasting && input.value === "" && value === "?") {
          ui.choose("help");
          input.editing = false;
          draw();
          return;
        }
        const token = input.pasting
          ? undefined
          : mentionToken(input.value, input.cursor);
        const mentions =
          token === undefined
            ? []
            : mentionCandidates(token, ui.documentPaths());
        if (mentions.length && key.name === "tab" && !key.shift) {
          const pick = mentions[mentionIndex % mentions.length]!;
          const points = [...input.value];
          const start = input.cursor - [...token!].length;
          points.splice(start, [...token!].length, ...`${pick} `);
          input.value = points.join("").slice(0, 32000);
          input.cursor = Math.min(
            start + [...pick].length + 1,
            [...input.value].length,
          );
          mentionIndex = (mentionIndex + 1) % mentions.length;
          ui.notice =
            mentions.length > 1
              ? `${mentions.length} @ matches. Tab again for the next one.`
              : `Mentioned @${pick}. Content is quoted on send.`;
          draw();
          return;
        }
        mentionIndex = 0;
        const candidates = input.pasting ? [] : commandSuggestions(input.value);
        if (
          candidates.length &&
          ["up", "down", "tab", "return", "enter"].includes(key.name ?? "")
        ) {
          if (key.name === "up" || key.name === "down")
            suggestion =
              (suggestion + (key.name === "up" ? candidates.length - 1 : 1)) %
              candidates.length;
          else {
            input.set(
              candidates[Math.min(suggestion, candidates.length - 1)]![0],
            );
            suggestion = 0;
            if (input.value === "/find") input.set("/find ");
            else if (key.name !== "tab") void task(submit);
          }
          draw();
          return;
        }
        if (
          !input.pasting &&
          (["up", "down"].includes(key.name ?? "") ||
            (key.ctrl && (key.name === "p" || key.name === "n"))) &&
          !input.value.includes("\n")
        ) {
          const history = (ui.session()?.events ?? [])
            .filter((e) => e.kind === "user")
            .map((e) => e.text)
            .reverse();
          if (history.length) {
            if (historyIndex < 0) historyDraft = input.value;
            const older = key.name === "up" || (key.ctrl && key.name === "p");
            historyIndex = older
              ? Math.min(history.length - 1, historyIndex + 1)
              : Math.max(-1, historyIndex - 1);
            input.set(historyIndex < 0 ? historyDraft : history[historyIndex]!);
            draw();
            return;
          }
        }
        if (!input.pasting && ["pageup", "pagedown"].includes(key.name ?? "")) {
          ui.scrollPage(key.name === "pageup" ? -1 : 1);
          draw();
          return;
        }
        const action = input.key(value, key);
        suggestion = 0;
        historyIndex = -1;
        if (input.pendingCommand !== undefined) {
          const command = input.pendingCommand;
          input.pendingCommand = undefined;
          await ui.command(command);
          draw();
          return;
        }
        if (action === "submit") {
          const text = input.value;
          const plain =
            !text.trimStart().startsWith("/") &&
            !text.trimStart().startsWith("!");
          if (plain && app.running() && text.trim()) {
            ui.queuePrompt(text);
            input.set("");
            historyQuery = "";
            historyPos = -1;
            draw();
            return;
          }
          void task(submit);
        } else scheduleDraft();
        draw();
        return;
      }
      if (busy && key.name !== "tab") return;
      // Type to filter in list tabs. Bound keys keep their action; every
      // other printable character narrows the list instead of needing /filter.
      const filterChar = !input.pasting
        ? filterKeyForTab(value, key, ui.tab)
        : undefined;
      if (filterChar !== undefined) {
        ui.filter += filterChar;
        ui.selected = 0;
        ui.detail = undefined;
        ui.notice = `Filter: ${ui.filter} (Esc clears, Backspace deletes)`;
        draw();
        return;
      }
      if (!input.pasting && key.name === "backspace" && ui.filter) {
        ui.filter = ui.filter.slice(0, -1);
        ui.selected = 0;
        ui.notice = ui.filter
          ? `Filter: ${ui.filter} (Esc clears, Backspace deletes)`
          : "Filter cleared.";
        draw();
        return;
      }
      if (key.name === "tab") {
        ui.cycle(key.shift ? -1 : 1);
        input.editing = ui.tab === "chat";
      } else if (
        !input.pasting &&
        (key.name === "right" || key.name === "left")
      ) {
        // Panels follow the reference: Right is next, Left is previous.
        // In editing mode the same arrows move the cursor instead.
        //
        // The documents tab is the one exception: its arrows fold and unfold
        // a folder, because switching panels while reading a tree is a much
        // bigger jump than opening or closing one branch of it.
        if (ui.collapseOrExpand(key.name === "right")) {
          draw();
        } else {
          ui.cycle(key.name === "right" ? 1 : -1);
          input.editing = ui.tab === "chat";
        }
      } else if (value === "q") {
        stop();
        return;
      } else if (value === "i" || value === "/") {
        input.editing = true;
        if (value === "/") {
          try {
            saveDraft();
          } catch (e) {
            ui.notice = message(e);
          }
          input.set("/");
        }
      } else if (value === "n")
        void task(async () => {
          await navigate(() => ui.command("/new"));
          input.editing = true;
        });
      else if (value === "u") void task(() => ui.prepareUndo());
      else if (value === "a" || value === "d")
        void task(async () =>
          ui.prepareApproval(value === "a" ? "approved" : "denied"),
        );
      else if (value === "r") void task(() => ui.refresh(true));
      else if (value === "?") ui.choose("help");
      else if (key.name === "escape") {
        // An active filter clears first, before details or checkpoints.
        if (ui.filter) {
          ui.filter = "";
          ui.selected = 0;
          lastEsc = 0;
          ui.notice = "Filter cleared.";
          draw();
          return;
        }
        const now = Date.now();
        if (isDoubleEscape(now, lastEsc)) {
          lastEsc = 0;
          // Text in the box clears first, empty input opens checkpoints.
          if (input.value) {
            input.set("");
            suggestion = 0;
            try {
              saveDraft();
            } catch (error) {
              ui.notice = message(error);
            }
            ui.notice = "Cleared. The draft stays saved.";
          } else void task(() => ui.command("/rewind"));
        } else {
          lastEsc = now;
          ui.detail = undefined;
          ui.scroll = 0;
        }
      } else if (key.name === "return")
        void task(() => navigate(() => ui.openSelected()));
      else if (key.name === "pageup") ui.scrollPage(-1);
      else if (key.name === "pagedown") ui.scrollPage(1);
      else if (value === "{" || value === "}") {
        const target = nextPromptRow(
          ui.promptRows,
          ui.viewport.offset,
          value === "}" ? 1 : -1,
        );
        if (target < 0) ui.notice = "No further prompt in this direction.";
        else ui.scroll = target;
      } else if (
        key.name === "up" ||
        (key.ctrl && key.name === "p") ||
        value === "k"
      ) {
        if (ui.detail) ui.scroll = Math.max(0, ui.scroll - 1);
        else if (!ui.moveDocumentCursor(-1))
          ui.selected = Math.max(0, ui.selected - 1);
      } else if (
        key.name === "down" ||
        (key.ctrl && key.name === "n") ||
        value === "j"
      ) {
        if (ui.detail) ui.scroll++;
        else if (!ui.moveDocumentCursor(1))
          ui.selected = Math.min(ui.items().length - 1, ui.selected + 1);
      }
      draw();
    };
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKey);
    process.stdout.on("resize", draw);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("SIGHUP", stop);
    process.once("exit", restoreTerminal);
    process.once("uncaughtExceptionMonitor", restoreTerminal);
    screen.enter();
    process.stdout.write("\x1b[?2004h");
    draw();
    timer = setInterval(() => {
      if (refreshing || stopped || suspended) return;
      refreshing = true;
      // Expiring on the same tick as the refresh is what makes a timed toast
      // disappear without a redraw of its own. Nothing is drawn here: draw()
      // runs in the finally below, and a toast that expires without a frame
      // would leave its row behind until the next unrelated event.
      ui.expireToasts();
      // Holds that are closing get announced on the same tick. Waiting for
      // the decision to fail would mean the operator only learns the window
      // closed after pressing the key that would have used it.
      ui.watchHoldsForExpiry();
      void ui
        .refresh()
        .catch((e) => {
          // A failed refresh usually means the connector or the provider went
          // away mid run. That is not transient the way a keystroke notice is,
          // so it gets a danger toast that will not expire on its own.
          ui.announce("refresh-failed", "danger", sanitizeText(message(e)));
        })
        .finally(() => {
          refreshing = false;
          draw();
        });
    }, 250);
  });
}
