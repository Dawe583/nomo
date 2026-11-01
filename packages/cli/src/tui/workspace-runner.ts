import type { Key } from "node:readline";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  canonicalProjectRoot,
  projectSandboxConfig,
} from "../../../workbench/src/project-sandbox.ts";
import { readProjectSkills } from "../../../workbench/src/project-skills.ts";
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
import { handleModelPickerKey } from "./workspace-app-model.ts";
import { detectCapabilities } from "./caps.ts";
import type { CliRenderer, KeyEvent as OpenTuiKeyEvent } from "@opentui/core";
import { sanitizeText } from "./layout.ts";
import { dataDir as productDataDir } from "../../../ledger/src/paths.ts";
import { envValue } from "../../../ledger/src/env-compat.ts";
import { normalizeOwnedEnv } from "../env-keys.ts";
import {
  DEFAULT_WORKSPACE_KEYBINDINGS,
  parseWorkspaceKeybindings,
  type WorkspaceKeybindings,
} from "./workspace-keybindings.ts";

export function nextModelId(
  models: readonly { readonly id: string }[],
  current: string | undefined,
  direction: -1 | 1,
): string | undefined {
  const unique = models.filter(
    (model, index) =>
      models.findIndex((candidate) => candidate.id === model.id) === index,
  );
  if (unique.length < 2) return undefined;
  const index = unique.findIndex((model) => model.id === current);
  const start = index < 0 ? (direction > 0 ? -1 : 0) : index;
  return unique[(start + direction + unique.length) % unique.length]?.id;
}

export function signalQuitAction(
  now: number,
  lastCtrlC: number,
): "confirm" | "stop" {
  return isDoubleEscape(now, lastCtrlC) ? "stop" : "confirm";
}

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
  bindings: WorkspaceKeybindings = DEFAULT_WORKSPACE_KEYBINDINGS,
): WorkspaceShortcut | undefined {
  if (!key.ctrl) return undefined;
  const action = (
    Object.keys(bindings) as Array<keyof WorkspaceKeybindings>
  ).find((candidate) => bindings[candidate].name === key.name);
  if (action === "redraw") return "redraw";
  if (action === "toggle-tools") return "toggle-tools";
  if (action === "search-history" && editing) return "search-history";
  if (action === "stash") return "stash";
  if (action === "external-editor") return "external-editor";
  if (action === "show-todos" && !editing) return "show-todos";
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
  // Recent kills and the latest yank are process-local editor state.
  private killRing: string[] = [];
  private lastKillKind?: "backward" | "forward";
  private lastYank?: { start: number; length: number; ringIndex: number };
  // Undo keeps one previous state for Ctrl+_.
  /** A slash command requested by a bound key (Ctrl+P); the runner consumes it. */
  pendingCommand?: string;
  private undoState?: { value: string; cursor: number };
  private redoState?: { value: string; cursor: number };
  set(value: string) {
    this.value = value;
    this.cursor = [...value].length;
    this.lastKillKind = undefined;
    this.lastYank = undefined;
    this.undoState = undefined;
    this.redoState = undefined;
  }
  private remember() {
    this.undoState = { value: this.value, cursor: this.cursor };
    this.redoState = undefined;
  }
  undoEdit(): boolean {
    if (!this.undoState) return false;
    this.redoState = { value: this.value, cursor: this.cursor };
    this.value = this.undoState.value;
    this.cursor = Math.min(
      this.undoState.cursor,
      [...this.undoState.value].length,
    );
    this.undoState = undefined;
    return true;
  }
  redoEdit(): boolean {
    if (!this.redoState) return false;
    this.undoState = { value: this.value, cursor: this.cursor };
    this.value = this.redoState.value;
    this.cursor = Math.min(
      this.redoState.cursor,
      [...this.redoState.value].length,
    );
    this.redoState = undefined;
    return true;
  }
  insert(value: string) {
    this.replaceRange(this.cursor, 0, value);
  }
  replaceRange(start: number, length: number, value: string) {
    this.remember();
    const points = [...this.value];
    points.splice(start, length, ...value);
    points.length = Math.min(points.length, 32000);
    this.value = points.join("");
    this.cursor = Math.min(start + [...value].length, points.length);
    this.lastYank = undefined;
    this.lastKillKind = undefined;
  }
  private static isWordChar(point: string): boolean {
    return /[A-Za-z0-9]/.test(point);
  }
  private static isPunctuationChar(point: string): boolean {
    return /[!-/:-@[-`{-~]/.test(point);
  }
  private killText(text: string, direction: "backward" | "forward") {
    if (!text) return;
    const previous = this.killRing.at(-1);
    if (this.lastKillKind === direction && previous) {
      this.killRing[this.killRing.length - 1] =
        direction === "backward" ? text + previous : previous + text;
    } else {
      this.killRing.push(text);
      if (this.killRing.length > 16) this.killRing.shift();
    }
    this.lastKillKind = direction;
    this.lastYank = undefined;
  }
  private yank() {
    const index = this.killRing.length - 1;
    const text = this.killRing[index];
    if (!text) return;
    const start = this.cursor;
    this.insert(text);
    this.lastYank = { start, length: [...text].length, ringIndex: index };
  }
  private yankPop() {
    const yank = this.lastYank;
    if (
      !yank ||
      this.killRing.length < 2 ||
      this.cursor !== yank.start + yank.length
    )
      return;
    const points = [...this.value];
    points.splice(yank.start, yank.length);
    const index =
      (yank.ringIndex + this.killRing.length - 1) % this.killRing.length;
    const text = this.killRing[index]!;
    const inserted = [...text].slice(0, 32000 - points.length);
    points.splice(yank.start, 0, ...inserted);
    this.remember();
    this.value = points.join("");
    this.cursor = yank.start + inserted.length;
    this.lastYank = {
      start: yank.start,
      length: [...text].length,
      ringIndex: index,
    };
  }
  private editKey(key: Key): boolean {
    const points = [...this.value];
    if (key.ctrl && key.name === "home") {
      this.cursor = 0;
      return true;
    }
    if (key.ctrl && key.name === "end") {
      this.cursor = points.length;
      return true;
    }
    if (key.ctrl && (key.name === "up" || key.name === "down")) {
      const lines = this.value.split("\n");
      const lineStarts: number[] = [];
      let offset = 0;
      for (const line of lines) {
        lineStarts.push(offset);
        offset += [...line].length + 1;
      }
      let lineIndex = Math.max(
        0,
        lineStarts.findIndex(
          (start, i) =>
            this.cursor >= start &&
            this.cursor <= start + [...lines[i]!].length,
        ),
      );
      const paragraphStart = (line: number): number => {
        while (line > 0 && !lines[line - 1]!.trim()) line--;
        while (line > 0 && lines[line - 1]!.trim()) line--;
        return line;
      };
      const paragraphEnd = (line: number): number => {
        while (line < lines.length - 1 && !lines[line + 1]!.trim()) line++;
        while (line < lines.length - 1 && lines[line + 1]!.trim()) line++;
        return line;
      };
      if (key.name === "up") {
        const start = paragraphStart(lineIndex);
        lineIndex =
          lineIndex === start && start > 0 ? paragraphStart(start - 1) : start;
        this.cursor = lineStarts[lineIndex]!;
      } else {
        const end = paragraphEnd(lineIndex);
        lineIndex =
          lineIndex === end && end < lines.length - 1
            ? paragraphEnd(end + 1)
            : end;
        this.cursor = lineStarts[lineIndex]! + [...lines[lineIndex]!].length;
      }
      return true;
    }
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
    if (
      (key.meta && (key.name === "b" || key.name === "left")) ||
      (key.ctrl && key.name === "left")
    ) {
      let pos = this.cursor;
      if (pos === 0 || points[pos - 1] === "\n") {
        this.cursor = pos === 0 ? 0 : pos - 1;
        return true;
      }
      while (pos > 0 && /\s/u.test(points[pos - 1]!)) pos--;
      const previous = points[pos - 1];
      if (previous && WorkspaceInput.isPunctuationChar(previous)) {
        while (pos > 0 && WorkspaceInput.isPunctuationChar(points[pos - 1]!))
          pos--;
      } else {
        while (pos > 0 && WorkspaceInput.isWordChar(points[pos - 1]!)) pos--;
      }
      this.cursor = pos;
      return true;
    }
    if (
      (key.meta && (key.name === "f" || key.name === "right")) ||
      (key.ctrl && key.name === "right")
    ) {
      let pos = this.cursor;
      if (pos >= points.length || points[pos] === "\n") {
        this.cursor = pos >= points.length ? pos : pos + 1;
        return true;
      }
      while (pos < points.length && /\s/u.test(points[pos]!)) pos++;
      const current = points[pos];
      if (current && WorkspaceInput.isPunctuationChar(current)) {
        while (
          pos < points.length &&
          WorkspaceInput.isPunctuationChar(points[pos]!)
        )
          pos++;
      } else {
        while (pos < points.length && WorkspaceInput.isWordChar(points[pos]!))
          pos++;
      }
      this.cursor = pos;
      return true;
    }
    if (key.meta && key.name === "d") {
      const start = this.cursor;
      let pos = start;
      while (pos < points.length && !WorkspaceInput.isWordChar(points[pos]!))
        pos++;
      while (pos < points.length && WorkspaceInput.isWordChar(points[pos]!))
        pos++;
      if (pos > start) {
        this.remember();
        this.killText(points.slice(start, pos).join(""), "forward");
        points.splice(start, pos - start);
        this.value = points.join("");
      }
      return true;
    }
    if (
      (key.ctrl && key.name === "w") ||
      (key.meta && key.name === "backspace")
    ) {
      let start = this.cursor;
      while (start > 0 && /\s/u.test(points[start - 1]!)) start--;
      while (start > 0 && !/\s/u.test(points[start - 1]!)) start--;
      if (start < this.cursor) {
        this.remember();
        this.killText(points.slice(start, this.cursor).join(""), "backward");
        points.splice(start, this.cursor - start);
        this.cursor = start;
        this.value = points.join("");
      }
      return true;
    }
    if (key.ctrl && key.name === "t") {
      const start = this.cursor
        ? points.lastIndexOf("\n", this.cursor - 1) + 1
        : 0;
      const end = points.indexOf("\n", this.cursor);
      const lineEnd = end < 0 ? points.length : end;
      if (lineEnd - start < 2) return true;
      const position = Math.max(
        start + 1,
        this.cursor >= lineEnd ? lineEnd - 1 : this.cursor,
      );
      this.remember();
      [points[position - 1], points[position]] = [
        points[position]!,
        points[position - 1]!,
      ];
      this.value = points.join("");
      this.cursor = position + 1;
      return true;
    }
    if (key.ctrl && key.name === "k") {
      const end = points.indexOf("\n", this.cursor);
      const count =
        end < 0 ? points.length - this.cursor : Math.max(1, end - this.cursor);
      if (count > 0) {
        this.remember();
        this.killText(
          points.slice(this.cursor, this.cursor + count).join(""),
          "forward",
        );
        points.splice(this.cursor, count);
        this.value = points.join("");
      }
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
    const isKill =
      (key.ctrl && ["w", "u", "k"].includes(key.name ?? "")) ||
      (key.meta && key.name === "d");
    if (!isKill) this.lastKillKind = undefined;
    if (!(key.meta && key.name === "y")) this.lastYank = undefined;
    if (key.meta && key.name === "y") {
      this.yankPop();
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
      this.yank();
      return;
    }
    if (key.ctrl && key.shift && key.name === "z") {
      this.redoEdit();
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
    } else if (key.name === "delete" || (key.ctrl && key.name === "d")) {
      if (this.cursor < points.length) {
        this.remember();
        points.splice(this.cursor, 1);
        this.value = points.join("");
      }
    } else if (key.name === "left") this.cursor = Math.max(0, this.cursor - 1);
    else if (key.name === "right")
      this.cursor = Math.min(points.length, this.cursor + 1);
    else if (key.name === "home" || (key.ctrl && key.name === "a"))
      this.cursor = 0;
    else if (key.name === "end" || (key.ctrl && key.name === "e"))
      this.cursor = points.length;
    else if (key.ctrl && key.name === "u") {
      this.remember();
      this.killText(points.slice(0, this.cursor).join(""), "backward");
      this.value = "";
      this.cursor = 0;
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
    sessionId: string | undefined,
    projectPath: string | undefined;
  const skillIds: string[] = [];
  let tab: WorkspaceTab = "chat";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--once") once = true;
    else if (arg === "--help") {
      console.log(
        "nomo tui [--once] [--project PATH] [--skill ID ...] [--view runs|overview|chat|sessions|documents|ledger|approvals|policy|tools|models|usage|help] [--session ID] [--data-dir PATH] [--import-provider opencode:zen|opencode:tokenrouter]",
      );
      return 0;
    } else if (arg === "--project" || arg === "--skill") {
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw Error(`${arg} requires a value`);
      if (arg === "--project") {
        if (projectPath) throw Error("--project may be specified only once");
        projectPath = value;
      } else skillIds.push(value);
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
  const interactive =
    !once &&
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    process.env.TERM !== "dumb" &&
    !process.env.CI;
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  const nodeSupportsOpenTui =
    nodeMajor! > 26 || (nodeMajor === 26 && nodeMinor! >= 4);
  if (interactive && !process.versions.bun && !nodeSupportsOpenTui) {
    try {
      return await new Promise<number>((resolveExit, reject) => {
        const child = spawn("bun", [process.argv[1]!, "tui", ...argv], {
          stdio: "inherit",
          shell: false,
          env: process.env,
        });
        child.once("error", reject);
        child.once("exit", (code) => resolveExit(code ?? 1));
      });
    } catch {
      console.error(
        "Interactive NOMO TUI requires Bun >=1.3.14 or Node >=26.4 with --experimental-ffi. Install Bun or upgrade Node.",
      );
      return 1;
    }
  }
  if (
    interactive &&
    !process.versions.bun &&
    nodeSupportsOpenTui &&
    !process.execArgv.includes("--experimental-ffi")
  ) {
    return await new Promise<number>((resolveExit, reject) => {
      const child = spawn(
        process.execPath,
        [
          ...process.execArgv,
          "--experimental-ffi",
          process.argv[1]!,
          "tui",
          ...argv,
        ],
        {
          stdio: "inherit",
          shell: false,
          env: process.env,
        },
      );
      child.once("error", reject);
      child.once("exit", (code) => resolveExit(code ?? 1));
    });
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(directory ? { NOMO_DATA_DIR: directory } : {}),
  };
  // Normalized here rather than only in the binary so a test that drives the
  // TUI entry point directly sees the same settings an operator configured
  // under the old names.
  Object.assign(env, normalizeOwnedEnv(env));
  const parsedKeybindings = parseWorkspaceKeybindings(env.NOMO_TUI_KEYBINDINGS);
  const keybindings = parsedKeybindings.bindings;
  if (skillIds.length && !projectPath)
    throw Error("--skill requires --project");
  if (projectPath && (once || !interactive)) {
    console.error(
      "Project access requires an interactive TTY confirmation; no project or skill data was sent.",
    );
    return 2;
  }
  const projectRoot = projectPath
    ? await canonicalProjectRoot(resolve(projectPath))
    : undefined;
  const projectSkills = projectRoot
    ? await readProjectSkills(projectRoot, skillIds)
    : [];
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
  if (parsedKeybindings.error) ui.notice = parsedKeybindings.error;
  if (projectRoot) {
    let sandboxConfigured: string;
    try {
      const config = projectSandboxConfig(env);
      sandboxConfigured = `${config.runtime} ${config.imageId}`;
    } catch (error) {
      sandboxConfigured =
        error instanceof Error
          ? `unavailable: ${error.message}`
          : "unavailable";
    }
    ui.prepareProjectAccess(projectRoot, projectSkills, sandboxConfigured);
  }
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
  let lastCtrlC = 0;
  // Ctrl+S stash slot and Ctrl+L double press stay local, never persisted.
  let stash = "";
  let stashCursor = 0;
  let lastCtrlL = 0;
  let lastCtrlD = 0;
  const chord = new ChordTracker();
  const startedAt = Date.now();
  // NOMO has its own explicit color preference; inherited NO_COLOR must not hide its UI.
  const color = env.NOMO_TUI_COLOR !== "0";
  const graphicsProtocol = detectCapabilities(
    env,
    process.stdout,
  ).graphicsProtocol;
  const motion = env.NOMO_TUI_MOTION !== "0" && env.TERM !== "dumb";
  const [
    { createCliRenderer },
    { createRoot, flushSync },
    { createElement },
    { WorkspaceApp },
  ] = await Promise.all([
    import("@opentui/core"),
    import("@opentui/react"),
    import("react"),
    import("./workspace-app.tsx"),
  ]);
  const renderer: CliRenderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    screenMode: "alternate-screen",
    useMouse: true,
    environment: {
      ...(process.env.NO_COLOR ? { NO_COLOR: process.env.NO_COLOR } : {}),
    },
  });
  const root = createRoot(renderer);
  let keyHandler: (event: OpenTuiKeyEvent) => void = () => {};
  let busy = false,
    suspended = false,
    stopped = false,
    refreshing = false;
  let timer: NodeJS.Timeout | undefined, draftTimer: NodeJS.Timeout | undefined;
  const setInputEditing = (editing: boolean, reset = false) => {
    input.editing = editing;
    if (reset) {
      input.cursor = [...input.value].length;
      suggestion = 0;
    }
  };
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
    if (stopped || suspended) return;
    flushSync(() =>
      root.render(
        createElement(WorkspaceApp, {
          ui,
          input: input.display(),
          editing: input.editing,
          busy,
          color: ui.colorOverride ?? color,
          ...(graphicsProtocol === "kitty"
            ? { graphicsProtocol: "kitty" as const }
            : {}),
          onKey: keyHandler,
          onPaste: (text: string) => {
            input.pasting = true;
            input.insert(text);
            input.pasting = false;
            try {
              saveDraft();
            } catch (error) {
              ui.notice = message(error);
            }
            draw();
          },
          onTab: (tab: WorkspaceTab) => {
            void task(async () => {
              saveDraft();
              await ui.choose(tab);
              setInputEditing(tab === "chat");
            });
          },
          onSelect: (index: number) => {
            ui.selected = index;
            draw();
          },
        }),
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
    await renderer.suspend();
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
      if (!stopped) await renderer.resume();
    }
  };
  return new Promise<number>((resolveDone) => {
    const restoreTerminal = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearTimeout(draftTimer);
      process.off("SIGINT", stopOnSigint);
      process.off("SIGTERM", stopOnSigterm);
      process.off("SIGHUP", stopOnSighup);
      process.off("exit", restoreTerminal);
      process.off("uncaughtExceptionMonitor", restoreTerminal);
      root.unmount();
      renderer.destroy();
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
        await renderer.closed;
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
    const stopOnSigint = () => {
      const now = Date.now();
      if (signalQuitAction(now, lastCtrlC) === "stop") {
        lastCtrlC = 0;
        stop();
        return;
      }
      lastCtrlC = now;
      ui.notice = "Press Ctrl+C again to exit.";
      draw();
    };
    const stopOnSigterm = () => stop();
    const stopOnSighup = () => stop();
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
      const pickerResult = handleModelPickerKey(ui, value, key);
      if (pickerResult !== false) {
        if (typeof pickerResult === "string")
          await task(async () => ui.selectModel(pickerResult));
        else draw();
        return;
      }
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
      // ? is bound twice on purpose, and neither binding is here. One sits in
      // the composer path and fires only for a lone ? on an empty prompt,
      // because a question mark mid sentence is ordinary text that has to
      // reach the model. The other sits in the shortcut path below and only
      // runs when the composer does not have focus. A single binding placed
      // here would have to guess which of those two situations it was in, and
      // a guess that swallowed a typed question mark would corrupt a prompt
      // the operator never meant to change.
      //
      // Exit confirmation requires consecutive Ctrl+C presses; any other key
      // cancels the pending quit so a normal edit cannot inherit confirmation.
      const ctrlC = key.ctrl && key.name === "c";
      if (!ctrlC) lastCtrlC = 0;
      // Double Escape must be consecutive, not span commands typed in between.
      if (key.name !== "escape") lastEsc = 0;
      if (
        ctrlC &&
        !input.pasting &&
        !input.value &&
        isDoubleEscape(Date.now(), lastCtrlC)
      ) {
        lastCtrlC = 0;
        stop();
        return;
      }
      if (!input.pasting && (ctrlC || key.name === "escape") && app.running()) {
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
      if (ctrlC) {
        if (input.editing && input.value) {
          input.set("");
          suggestion = 0;
          lastCtrlC = 0;
          try {
            saveDraft();
          } catch (error) {
            ui.notice = message(error);
          }
          draw();
        } else if (isDoubleEscape(Date.now(), lastCtrlC)) {
          lastCtrlC = 0;
          stop();
        } else {
          lastCtrlC = Date.now();
          ui.notice = "Press Ctrl+C again to exit.";
          draw();
        }
        return;
      }
      const shortcut = ui.confirmation
        ? undefined
        : workspaceShortcut(key, input.editing, input.value, keybindings);
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
      // Prime cycles the configured provider's models. The operation changes
      // only the default for future conversations, matching `/model <id>`.
      if (!input.pasting && key.meta && key.name === "m") {
        const models = ui.provider?.models ?? [];
        const selected = nextModelId(models, ui.model, key.shift ? -1 : 1);
        if (selected) {
          void task(() => ui.command(`/model ${selected}`));
        } else {
          ui.notice =
            "No other models are available for the configured provider.";
          draw();
        }
        return;
      }
      if (!input.pasting && key.meta && key.name === "p") {
        ui.openModelPicker();
        input.editing = false;
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
        // A lone ? on empty input opens the cheat sheet, like the
        // reference. Any other text keeps the keystroke as typed input, because
        // a question mark in the middle of a sentence is ordinary text and
        // must reach the model.
        if (!input.pasting && input.value === "" && value === "?") {
          ui.openCheatSheet();
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
          const start = input.cursor - [...token!].length;
          input.replaceRange(start, [...token!].length, `${pick} `);
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
      // ? opens the cheat sheet over whatever is on screen. It used to jump
      // to the help tab, which is a fine destination and the wrong response to
      // the actual press: an operator who opened it because a key did not work
      // loses the panel they were looking at, and has to find their way back.
      // The help tab is still one keystroke away through /help and Tab.
      else if (value === "?") ui.openCheatSheet();
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
    process.on("SIGINT", stopOnSigint);
    process.on("SIGTERM", stopOnSigterm);
    process.on("SIGHUP", stopOnSighup);
    process.once("exit", restoreTerminal);
    process.once("uncaughtExceptionMonitor", restoreTerminal);
    keyHandler = (event: OpenTuiKeyEvent) => {
      if (event.eventType !== "press" && event.eventType !== "repeat") return;
      const value = event.name.length === 1 ? event.name : undefined;
      void onKey(value, event as unknown as Key);
    };
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
