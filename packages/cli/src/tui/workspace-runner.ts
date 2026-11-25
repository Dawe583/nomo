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
  modelPickerMatches,
  modelPickerSelectionWindowStart,
  modelPickerWindowStart,
  wrap,
  searchHistoryPrompts,
  message,
  nextToolActivityMode,
  PET_SPLASH_MS,
  TUI_COMMANDS,
  type WorkspaceTab,
  type ToolActivityMode,
  type TuiLocalSettings,
} from "./workspace.ts";
import {
  advanceSelection as advancePaletteSelection,
  backspaceInPalette,
  filterPalette,
  paletteFromCommands,
  typeInPalette,
} from "./palette.ts";
import { moveHunk, setSide, toggleHunk } from "./diff-panel.ts";
import {
  createWorkspaceTerminal,
  type WorkspaceMouseEvent,
} from "./workspace-terminal.ts";
import {
  kittyProviderIconCleanup,
  kittyProviderIconTransfer,
  kittyTabIconsCleanup,
  kittyTabIconsTransfer,
} from "./brand.ts";
import { detectCapabilities } from "./caps.ts";
import { copyTextToClipboard } from "./clipboard.ts";
import {
  highlightMouseSelection,
  mouseSelectionLimit,
  railOwnsPoint,
  selectedMouseText,
  type MousePoint,
} from "./mouse-selection.ts";
import { sanitizeText, stripAnsi } from "./layout.ts";
import { motionFrameAt, MOTION_TICK_MS } from "./motion.ts";
import { dismissToast } from "./toast.ts";
import { dataDir as productDataDir } from "../../../ledger/src/paths.ts";
import { envValue } from "../../../ledger/src/env-compat.ts";
import { normalizeOwnedEnv } from "../env-keys.ts";
import {
  DEFAULT_WORKSPACE_KEYBINDINGS,
  parseWorkspaceKeybindings,
  type WorkspaceKeybindings,
} from "./workspace-keybindings.ts";

function modelPickerPageSize(ui: WorkspaceTui, direction: -1 | 1): number {
  const picker = ui.modelPicker;
  if (!picker) return 1;
  const width = Math.max(1, (ui.viewport.width ?? 80) - 4);
  const height = Math.max(1, ui.viewport.height);
  const lines = ui.lines(width, height);
  const matches = modelPickerMatches(picker.models, picker.query);
  if (!matches.length) return 1;
  // The stacked picker has three summary rows; the wide two-pane picker has
  // only two before its model list. Page sizing must follow the active layout
  // or PageUp/PageDown counts a provider row as part of the model catalog.
  const modelStart = width < 88 ? 3 : 2;
  const modelEnd = modelStart + matches.length;
  const reservedRows =
    wrap(lines.slice(0, modelStart), width).length +
    wrap(lines.slice(modelEnd), width).length;
  const visibleRows = Math.max(1, height - reservedRows);
  let index = direction < 0 ? picker.selected - 1 : picker.selected;
  let usedRows = 0;
  let count = 0;
  while (index >= 0 && index < matches.length) {
    const row = lines[modelStart + index] ?? "";
    const rowHeight = Math.max(1, wrap([row], width).length);
    if (count > 0 && usedRows + rowHeight > visibleRows) break;
    if (count === 0 && rowHeight > visibleRows) return 1;
    usedRows += rowHeight;
    count += 1;
    index += direction;
  }
  return Math.max(1, count);
}

function modelPickerVisibleRows(ui: WorkspaceTui): number {
  const columns = Math.max(1, (ui.viewport.width ?? 80) - 4);
  return Math.max(1, ui.viewport.height - (columns >= 88 ? 2 : 5));
}

function oneShotDimension(name: "COLUMNS" | "LINES", fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, 1000)
    : fallback;
}

function setModelPickerQuery(
  ui: WorkspaceTui,
  picker: NonNullable<WorkspaceTui["modelPicker"]>,
  query: string,
  cursor: number,
): void {
  ui.modelPicker = {
    ...picker,
    query,
    cursor: Math.max(0, Math.min([...query].length, cursor)),
    selected: 0,
    modelWindowStart: undefined,
  };
}
function handleModelPickerKey(
  ui: WorkspaceTui,
  value: string | undefined,
  key: Readonly<{ name?: string; ctrl?: boolean; meta?: boolean }>,
): false | true | string | { readonly loadProviderId: string } {
  const picker = ui.modelPicker;
  if (!picker?.open) return false;
  const matches = modelPickerMatches(picker.models, picker.query);
  if (
    key.name === "escape" &&
    picker.query &&
    picker.focusedPane === "models"
  ) {
    setModelPickerQuery(ui, picker, "", 0);
    return true;
  }
  if (key.name === "escape" || (key.ctrl && key.name === "c")) {
    ui.closeModelPicker();
    ui.notice = "Model selection cancelled.";
    return true;
  }
  if (
    picker.focusedPane === "models" &&
    picker.query !== "" &&
    key.ctrl &&
    (key.name === "left" || key.name === "right")
  ) {
    const length = [...picker.query].length;
    const cursor = Math.max(
      0,
      Math.min(length, picker.cursor + (key.name === "right" ? 1 : -1)),
    );
    ui.modelPicker = { ...picker, cursor };
    return true;
  }
  if (key.name === "left" || key.name === "right") {
    if (key.name === "left") {
      ui.modelPicker = { ...picker, focusedPane: "providers" };
      return true;
    }
    const provider = picker.providers[picker.providerIndex];
    if (!provider) return true;
    ui.modelPicker = { ...picker, focusedPane: "models" };
    return { loadProviderId: provider.id };
  }
  if (key.name === "return" || key.name === "enter") {
    if (picker.focusedPane === "providers") {
      const provider = picker.providers[picker.providerIndex];
      if (!provider) return true;
      ui.modelPicker = { ...picker, focusedPane: "models" };
      return { loadProviderId: provider.id };
    }
    return matches[picker.selected]?.id ?? true;
  }
  if (key.name === "up" || key.name === "down") {
    const delta = key.name === "down" ? 1 : -1;
    if (picker.focusedPane === "providers") {
      const providers = picker.providers;
      if (!providers.length) return true;
      const index =
        (picker.providerIndex + delta + providers.length) % providers.length;
      ui.selectModelPickerProvider(index);
      return true;
    }
    const selected = matches.length
      ? (picker.selected + delta + matches.length) % matches.length
      : Math.max(
          0,
          Math.min(Math.max(0, matches.length - 1), picker.selected + delta),
        );
    ui.modelPicker = {
      ...picker,
      selected,
      modelWindowStart: modelPickerSelectionWindowStart(
        picker.selected,
        selected,
        matches.length,
        modelPickerVisibleRows(ui),
        picker.modelWindowStart,
      ),
    };
    return true;
  }
  if (["home", "end", "pageup", "pagedown"].includes(key.name ?? "")) {
    if (picker.focusedPane === "providers") {
      const providers = picker.providers;
      if (providers.length) {
        const step = Math.max(1, Math.floor(ui.viewport.height / 2));
        const index =
          key.name === "home"
            ? 0
            : key.name === "end"
              ? providers.length - 1
              : Math.max(
                  0,
                  Math.min(
                    providers.length - 1,
                    picker.providerIndex +
                      (key.name === "pagedown" ? step : -step),
                  ),
                );
        ui.selectModelPickerProvider(index);
      }
      return true;
    }
    const last = Math.max(0, matches.length - 1);
    const direction = key.name === "pagedown" ? 1 : -1;
    const page = modelPickerPageSize(ui, direction);
    const selected =
      key.name === "home"
        ? 0
        : key.name === "end"
          ? last
          : Math.max(0, Math.min(last, picker.selected + direction * page));
    ui.modelPicker = {
      ...picker,
      selected,
      modelWindowStart: modelPickerSelectionWindowStart(
        picker.selected,
        selected,
        matches.length,
        modelPickerVisibleRows(ui),
        picker.modelWindowStart,
      ),
    };
    return true;
  }
  if (picker.focusedPane === "providers") return true;
  if (key.name === "home" || (key.ctrl && key.name === "a")) {
    ui.modelPicker = { ...picker, cursor: 0 };
    return true;
  }
  if (key.name === "end" || (key.ctrl && key.name === "e")) {
    ui.modelPicker = { ...picker, cursor: [...picker.query].length };
    return true;
  }
  if (key.ctrl && key.name === "u") {
    setModelPickerQuery(ui, picker, "", 0);
    return true;
  }
  if (key.name === "backspace") {
    const points = [...picker.query];
    if (picker.cursor > 0) {
      points.splice(picker.cursor - 1, 1);
      setModelPickerQuery(ui, picker, points.join(""), picker.cursor - 1);
    }
    return true;
  }
  if (key.name === "delete") {
    const points = [...picker.query];
    if (picker.cursor < points.length) {
      points.splice(picker.cursor, 1);
      setModelPickerQuery(ui, picker, points.join(""), picker.cursor);
    }
    return true;
  }
  if (value && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f-\x9f]/.test(value)) {
    const points = [...picker.query];
    const inserted = [...value];
    points.splice(picker.cursor, 0, ...inserted);
    const query = points.join("");
    setModelPickerQuery(ui, picker, query, picker.cursor + inserted.length);
  }
  return true;
}

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

export function normalizePastedPrompt(text: string): string {
  return stripAnsi(text)
    .replace(/\u009b[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u009d[^\u0007\u009c]*(?:\u0007|\u009c|$)/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function signalQuitAction(
  now: number,
  lastCtrlC: number,
): "confirm" | "stop" {
  return isDoubleEscape(now, lastCtrlC) ? "stop" : "confirm";
}

export function escapeOwnedByOverlay(
  state: Readonly<{
    confirmation: boolean;
    palette: boolean;
    keybindings: boolean;
    cheatSheet: boolean;
    filter: string;
    panel?: boolean;
    detail?: boolean;
    suggestions?: boolean;
  }>,
): boolean {
  return (
    state.confirmation ||
    state.palette ||
    state.keybindings ||
    state.cheatSheet ||
    state.panel === true ||
    state.detail === true ||
    state.suggestions === true ||
    state.filter.length > 0
  );
}

export function shouldCancelActiveRun(
  key: Pick<Key, "ctrl" | "name">,
  hasEscapeOwner: boolean,
  pasting: boolean,
): boolean {
  return (
    !pasting &&
    ((key.ctrl && key.name === "c") ||
      (!hasEscapeOwner && key.name === "escape"))
  );
}

export function takeReadyQueuedPrompt(
  ui: Pick<WorkspaceTui, "queuedPrompt" | "takeQueued">,
  state: Readonly<{
    workbenchRunning: boolean;
    hasConfirmation: boolean;
    runnerBusy?: boolean;
  }>,
): string | null {
  if (state.workbenchRunning || state.hasConfirmation || state.runnerBusy)
    return null;
  return ui.takeQueued();
}

export async function dispatchQueuedPrompt(
  ui: Pick<WorkspaceTui, "command" | "queuePrompt">,
  prompt: string,
  refresh: () => Promise<unknown>,
  onDispatchError: (error: unknown) => void,
): Promise<boolean> {
  try {
    await ui.command(prompt);
  } catch (error) {
    ui.queuePrompt(prompt);
    onDispatchError(error);
    return false;
  }
  await refresh();
  return true;
}

export type WorkspaceShortcut =
  | "redraw"
  | "suspend"
  | "toggle-tools"
  | "toggle-tool-visibility"
  | "search-history"
  | "stash"
  | "external-editor"
  | "show-agents"
  | "toggle-plan"
  | "copy-prompt"
  | "show-todos"
  | "retry"
  | "quit";

function isSuspendKey(key: Key): boolean {
  return key.ctrl === true && !key.shift && !key.meta && key.name === "z";
}

export function workspaceShortcut(
  key: Key,
  editing: boolean,
  input: string,
  bindings: WorkspaceKeybindings = DEFAULT_WORKSPACE_KEYBINDINGS,
  tab?: WorkspaceTab,
): WorkspaceShortcut | undefined {
  const chatEditing = editing && (tab === undefined || tab === "chat");
  if (isSuspendKey(key)) return "suspend";
  if (key.ctrl && key.shift && !key.meta && key.name?.toLowerCase() === "o")
    return "toggle-tool-visibility";
  if (!key.ctrl && !key.shift && !key.meta && key.name === "f5") return "retry";
  if (!key.ctrl && !key.shift && key.meta && key.name === "r") return "retry";
  if (!key.ctrl && !key.shift && key.meta && key.name === "a")
    return "show-agents";
  if (
    chatEditing &&
    !key.ctrl &&
    key.shift &&
    key.meta &&
    key.name?.toLowerCase() === "p"
  )
    return "toggle-plan";
  if (
    chatEditing &&
    !key.ctrl &&
    key.shift &&
    key.meta &&
    key.name?.toLowerCase() === "c"
  )
    return "copy-prompt";
  if (!key.ctrl || key.shift || key.meta) return undefined;
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
/** The terminal keypress stream has no key-up event, so ignore rapid
 * autorepeat pairs and accept only a deliberate second Left press. */
export class DoubleLeftSessionShortcut {
  private lastPressAt: number | undefined;

  press(
    key: Pick<Key, "name" | "ctrl" | "meta" | "shift">,
    eligible: boolean,
    now = Date.now(),
  ): boolean {
    if (!eligible || key.name !== "left" || key.ctrl || key.meta || key.shift) {
      this.lastPressAt = undefined;
      return false;
    }
    const previous = this.lastPressAt;
    this.lastPressAt = now;
    if (previous === undefined) return false;
    const elapsed = now - previous;
    if (elapsed < 100) {
      this.lastPressAt = undefined;
      return false;
    }
    if (elapsed <= 450) {
      this.lastPressAt = undefined;
      return true;
    }
    return false;
  }
}

export function isToolActivityCycleKey(
  key: Pick<Key, "name" | "ctrl" | "meta" | "shift">,
  running: boolean,
): boolean {
  return (
    running &&
    !!key.ctrl &&
    !key.shift &&
    !key.meta &&
    key.name?.toLowerCase() === "o"
  );
}

/**
 * Alt+N (or the older Alt+K) toggles the pet.
 *
 * It is a display toggle, so the key is recognised before the composer sees
 * it: toggling never sends a prompt and never inserts text. A plain `n` stays
 * ordinary input, which is why the modifier is required.
 */
export function isPetToggleKey(
  key: Pick<Key, "name" | "ctrl" | "meta" | "shift">,
): boolean {
  const name = key.name?.toLowerCase();
  return (
    key.meta === true &&
    !key.ctrl &&
    !key.shift &&
    (name === "n" || name === "k")
  );
}

/**
 * Alt+Shift+N opens the NIB signal card.
 *
 * The card is an overlay, not a prompt: the key is recognised before the
 * composer, so opening it never sends a prompt or edits the draft. It needs
 * the shifted modifier so the unshifted toggle keeps its one meaning.
 */
export function isPetCardKey(
  key: Pick<Key, "name" | "ctrl" | "meta" | "shift">,
): boolean {
  return (
    key.meta === true &&
    key.shift === true &&
    !key.ctrl &&
    key.name?.toLowerCase() === "n"
  );
}

/**
 * Ctrl+B dismisses the newest notice in the toast stack.
 *
 * A sticky toast (ttl 0) has no deadline, so a mouse click was its only exit
 * and a keyboard-only operator could not clear one at all. Ctrl+B is the
 * chord the workspace key table leaves unbound, and the action is display
 * only: it drops the top toast and never moves a selection, runs a command or
 * touches the approval banner, which is a separate surface carrying an open
 * decision.
 */
export function isDismissNoticeKey(
  key: Pick<Key, "name" | "ctrl" | "meta" | "shift">,
): boolean {
  return (
    key.ctrl === true &&
    !key.shift &&
    !key.meta &&
    key.name?.toLowerCase() === "b"
  );
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
  pendingCommand?: string;
  private pendingCharacterJump?: "forward" | "backward";
  // Recent kills and the latest yank are process-local editor state.
  private killRing: string[] = [];
  private lastKillKind?: "backward" | "forward";
  private lastYank?: { start: number; length: number; ringIndex: number };
  // Undo keeps one previous state for Ctrl+_.
  private undoState?: { value: string; cursor: number };
  private redoState?: { value: string; cursor: number };
  set(value: string) {
    // Drafts can outlive the terminal session that created them. Normalize
    // them at the same boundary as live input so an older raw ANSI escape
    // sequence cannot be rendered as visible `?[...m` text on the next launch.
    this.value = normalizePastedPrompt(value);
    this.cursor = [...this.value].length;
    this.pendingCharacterJump = undefined;
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
  paste(value: string) {
    this.editing = true;
    this.insert(value);
  }
  replaceRange(start: number, length: number, value: string) {
    const normalized = normalizePastedPrompt(value);
    this.remember();
    const points = [...this.value];
    points.splice(start, length, ...normalized);
    points.length = Math.min(points.length, 32000);
    this.value = points.join("");
    this.cursor = Math.min(start + [...normalized].length, points.length);
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
    this.lastYank = {
      start,
      length: this.cursor - start,
      ringIndex: index,
    };
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
      length: inserted.length,
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
    if (key.meta && (key.name === "d" || key.name === "delete")) {
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
      (key.ctrl && (key.name === "w" || key.name === "backspace")) ||
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
      const newline = points.indexOf("\n", this.cursor);
      const lineEnd = newline < 0 ? points.length : newline;
      let count = lineEnd - this.cursor;
      // At the end of a line, Ctrl+K joins the next line by removing the
      // newline; it never runs past the line break on the first press.
      if (count === 0 && newline >= 0) count = 1;
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
            .replace(/\r\n?/g, "\n")
            .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""),
        );
      return;
    }
    if (this.pendingCharacterJump) {
      const direction = this.pendingCharacterJump;
      this.pendingCharacterJump = undefined;
      if (key.ctrl && key.name === "]") return;
      if (!key.ctrl && !key.meta && !key.shift && value) {
        const target = [...value];
        const points = [...this.value];
        const matches = (index: number) =>
          target.every((point, offset) => points[index + offset] === point);
        let index = -1;
        if (target.length) {
          if (direction === "forward") {
            for (
              let candidate = this.cursor + 1;
              candidate <= points.length - target.length;
              candidate++
            ) {
              if (matches(candidate)) {
                index = candidate;
                break;
              }
            }
          } else {
            for (
              let candidate = Math.min(
                this.cursor - 1,
                points.length - target.length,
              );
              candidate >= 0;
              candidate--
            ) {
              if (matches(candidate)) {
                index = candidate;
                break;
              }
            }
          }
        }
        if (index >= 0) this.cursor = index;
        this.lastKillKind = undefined;
        this.lastYank = undefined;
        return;
      }
      // A non-printable key cancels the pending jump, then retains its normal
      // composer behavior below, matching OMP's editor state machine.
    }
    if (key.ctrl && key.name === "]") {
      this.pendingCharacterJump = key.meta ? "backward" : "forward";
      this.lastKillKind = undefined;
      this.lastYank = undefined;
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
    // Ctrl+P opens the command palette while editing. The outer dispatcher
    // uses Ctrl+P/Ctrl+N for list navigation when the composer is unfocused.
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
      points.splice(0, this.cursor);
      this.value = points.join("");
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

/**
 * Whether the startup splash has already been offered in this process.
 *
 * Once per process, not once per conversation: a splash on every re-entry
 * would delay the frame the operator already knows. Module scope is the
 * process scope here because the TUI runs one workspace at a time.
 */
let petSplashShown = false;



/** Whether the visible Chat surface owns keyboard input.
 *
 * Focus is derived from the surface, not remembered from the path that opened
 * or closed it, so Escape, Tab, mouse and command-result closes converge on
 * the same answer.
 */
export function workspaceChatComposerOwnsFocus(ui: WorkspaceTui): boolean {
  return (
    ui.tab === "chat" &&
    !ui.detail &&
    !ui.confirmation &&
    !ui.settingsOpen &&
    !ui.palette &&
    !ui.modelPicker?.open &&
    !ui.diffView &&
    !ui.showingKeybindings &&
    !ui.showingCheatSheet
  );
}

/** Cycle the model picker panes in their keyboard tab order. */
export function cycleModelPickerPane(ui: WorkspaceTui): void {
  const picker = ui.modelPicker;
  if (!picker?.open) return;
  ui.modelPicker = {
    ...picker,
    focusedPane: picker.focusedPane === "providers" ? "models" : "providers",
  };
}

/** The hit target under one-based terminal mouse coordinates. */
export function workspaceHitAt(
  ui: WorkspaceTui,
  x: number,
  y: number,
): {
  readonly tabTarget?: (typeof ui.tabHitTargets)[number];
  readonly rowTarget?: (typeof ui.rowHitTargets)[number];
} {
  return {
    tabTarget: ui.tabHitTargets.find(
      (item) => item.row === y && x >= item.start && x <= item.end,
    ),
    rowTarget: ui.rowHitTargets.find(
      (item) => item.row === y && x >= item.start && x <= item.end,
    ),
  };
}

/** Apply one mouse wheel step to the active workspace surface.
 *
 * The runner draws after this returns; keeping the state transition here is
 * what lets the parity test exercise exactly the same wheel behavior without
 * opening a terminal.
 */
export function applyWorkspaceWheel(
  ui: WorkspaceTui,
  delta: -1 | 1,
  x = 1,
): true {
  if (ui.modelPicker?.open) {
    const picker = ui.modelPicker;
    const columns = Math.max(1, (ui.viewport.width ?? 80) - 4);
    const wide = columns >= 88;
    const sidebarWidth = wide
      ? Math.min(28, Math.max(20, Math.floor(columns * 0.27)))
      : 0;
    const pane = wide
      ? x <= sidebarWidth + 4
        ? "providers"
        : "models"
      : picker.focusedPane;
    const visibleRows = Math.max(1, ui.viewport.height - (wide ? 2 : 5));
    const rows =
      pane === "providers"
        ? picker.providers
        : modelPickerMatches(picker.models, picker.query);
    const selected =
      pane === "providers" ? picker.providerIndex : picker.selected;
    const field =
      pane === "providers" ? "providerWindowStart" : "modelWindowStart";
    const currentStart = modelPickerWindowStart(
      selected,
      rows.length,
      visibleRows,
      picker[field],
    );
    const nextStart = modelPickerWindowStart(
      selected,
      rows.length,
      visibleRows,
      currentStart + delta,
    );
    ui.modelPicker = {
      ...picker,
      [field]: nextStart,
    };
    return true;
  }
  if (ui.settingsOpen) {
    const settingsCount = ui.visibleSettingsControls().length;
    ui.selectSetting(
      Math.max(
        0,
        Math.min(settingsCount - 1, ui.settingsSelected + delta * 3),
      ),
    );
  } else if (ui.detail) ui.scroll = Math.max(0, ui.scroll + delta * 3);
  else if (ui.tab === "chat") {
    const maxOffset = Math.max(0, ui.viewport.total - ui.viewport.height);
    const current = ui.scroll < 0 ? maxOffset : ui.viewport.offset;
    const next = Math.max(0, Math.min(maxOffset, current + delta * 3));
    ui.scroll = next >= maxOffset ? -1 : next;
  } else if (ui.groupTree) ui.moveTreeCursor(delta);
  else {
    const last = Math.max(0, ui.items().length - 1);
    ui.selected = Math.max(0, Math.min(last, ui.selected + delta));
  }
  return true;
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
        "nomo tui [--once] [--project PATH] [--skill ID ...] [--view chat|sessions|documents|ledger|approvals|policy|tools|models|usage|help] [--session ID] [--data-dir PATH] [--import-provider SOURCE-ID]",
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(directory ? { NOMO_DATA_DIR: directory } : {}),
  };
  // Normalized here rather than only in the binary so a test that drives the
  // TUI entry point directly sees the same settings an operator configured
  // under the old names.
  Object.assign(env, normalizeOwnedEnv(env));
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
    toolActivityMode?: ToolActivityMode;
    hideToolActivity?: boolean;
    mode?: string;
    settings?: Partial<TuiLocalSettings>;
    drafts: Record<string, string>;
  }>();
  const app = new Workbench(env),
    ui = new WorkspaceTui(app, env);
  ui.applySavedSettings(saved?.settings);
  const parsedKeybindings = parseWorkspaceKeybindings(ui.keybindingsOverride);
  let keybindings = parsedKeybindings.bindings;
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
  ui.toolActivityMode =
    saved?.toolActivityMode === "compact" ||
    saved?.toolActivityMode === "details" ||
    saved?.toolActivityMode === "expanded"
      ? saved.toolActivityMode
      : "details";
  ui.hideToolActivity = saved?.hideToolActivity ?? false;
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
  if (tab === "models") await ui.openModelPicker();
  else ui.choose(tab);
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
        process.stdout.columns ?? oneShotDimension("COLUMNS", 100),
        process.stdout.rows ?? oneShotDimension("LINES", 32),
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
  let lastMouseClick: { target: string; at: number } | undefined;
  let dismissedCommandSuggestions: string | undefined;
  const doubleLeftSessions = new DoubleLeftSessionShortcut();
  const chord = new ChordTracker();
  let startedAt = Date.now();
  let terminalCapabilities = detectCapabilities(env, process.stdout);
  const color = env.NOMO_TUI_COLOR === "0" ? false : terminalCapabilities.ansi;
  const motion = env.NOMO_TUI_MOTION !== "0" && env.TERM !== "dumb";
  const terminal = createWorkspaceTerminal(process.stdin, process.stdout);
  let busy = false,
    suspended = false,
    stopped = false,
    refreshing = false,
    initializingTerminal = true;
  let timer: NodeJS.Timeout | undefined,
    motionTimer: NodeJS.Timeout | undefined,
    draftTimer: NodeJS.Timeout | undefined,
    cellPixelTimer: NodeJS.Timeout | undefined,
    splashTimer: NodeJS.Timeout | undefined;
  let mouseSelection: { anchor: MousePoint; focus: MousePoint } | undefined;
  let selectionDragging = false;
  let renderedFrame = "";
  const setInputEditing = (editing: boolean, reset = false) => {
    input.editing = editing;
    if (reset) {
      input.cursor = [...input.value].length;
      suggestion = 0;
    }
  };
  // Keep input focus in sync with the same visible Chat surface the renderer
  // treats as the base view. Returning from a panel must restore typing.
  const chatComposerOwnsFocus = () => workspaceChatComposerOwnsFocus(ui);
  const saveDraft = () => {
    if (!input.value.startsWith("/"))
      drafts[ui.sessionId ?? "new"] = input.value;
    store.save({
      sessionId: ui.sessionId,
      projectId: ui.projectId,
      agentId: ui.agentId,
      lastRecoveryJob: ui.lastRecoveryJob,
      model: ui.model,
      toolActivityMode: ui.toolActivityMode,
      hideToolActivity: ui.hideToolActivity,
      mode: ui.mode,
      settings: ui.localSettings(),
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
    if (stopped || suspended || initializingTerminal) return;
    // Derive input ownership from the visible surface on every redraw. A panel
    // can close through several paths (Escape, Tab, mouse or command result);
    // keeping this invariant here prevents stale focus from freezing Chat.
    input.editing = chatComposerOwnsFocus();
    const now = Date.now();
    renderedFrame = renderWorkspace(
      ui,
      terminal.columns,
      terminal.rows,
      input.value,
      input.editing,
      busy,
      {
        color: ui.colorOverride ?? color,
        capabilities: terminalCapabilities,
        motion: ui.motionOverride ?? motion,
        now,
        frame:
          motion && ui.motionOverride !== false
            ? motionFrameAt(now - startedAt)
            : 0,
        command: input.value,
        cursor: input.cursor,
        suggestion,
        suggestionsDismissed: dismissedCommandSuggestions === input.value,
      },
    );
    terminal.render(
      mouseSelection
        ? highlightMouseSelection(
            renderedFrame,
            mouseSelection.anchor,
            mouseSelection.focus,
            terminal.columns,
            // A rail frame highlights the transcript pane only, so the status
            // rail is never painted as selected text.
            mouseSelectionLimit(terminal.columns, ui.viewport),
          )
        : renderedFrame,
    );
  };
  const applyCellPixelHeight = (
    cellPixels: { height: number; width: number } | undefined,
  ) => {
    if (
      !cellPixels ||
      stopped ||
      suspended ||
      terminalCapabilities.cellHeightPixels === cellPixels.height
    )
      return;
    terminalCapabilities = {
      ...terminalCapabilities,
      cellHeightPixels: cellPixels.height,
    };
    draw();
  };
  const scheduleCellPixelMeasurement = () => {
    if (cellPixelTimer !== undefined) clearTimeout(cellPixelTimer);
    cellPixelTimer = setTimeout(() => {
      cellPixelTimer = undefined;
      if (stopped || suspended) return;
      void terminal
        .measureCellPixels()
        .then(applyCellPixelHeight, () => undefined);
    }, 120);
  };
  let activeTask: Promise<void> = Promise.resolve();
  const task = (fn: () => Promise<unknown>, allowBusy = false) => {
    if (busy && !allowBusy) {
      ui.notice = "An action is already running. Try again when it finishes.";
      draw();
      return activeTask;
    }
    busy = true;
    activeTask = (async () => {
      try {
        await fn();
        await ui.refresh();
        const queued = takeReadyQueuedPrompt(ui, {
          workbenchRunning: app.running(),
          hasConfirmation: !!ui.confirmation,
        });
        if (queued) {
          await dispatchQueuedPrompt(
            ui,
            queued,
            () => ui.refresh(),
            (error) => {
              ui.notice = message(error);
            },
          );
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
    terminal.suspend();
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
        terminal.resume();
        scheduleCellPixelMeasurement();
      }
    }
  };
  return new Promise<number>((resolveDone) => {
    let suspendKeepalive: NodeJS.Timeout | undefined;
    let resumeOnContinue: (() => void) | undefined;
    const restoreTerminal = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearInterval(motionTimer);
      clearTimeout(draftTimer);
      clearTimeout(cellPixelTimer);
      clearTimeout(splashTimer);
      if (suspendKeepalive) clearInterval(suspendKeepalive);
      suspendKeepalive = undefined;
      if (resumeOnContinue) process.off("SIGCONT", resumeOnContinue);
      resumeOnContinue = undefined;
      process.off("SIGINT", stopOnSigint);
      process.off("SIGTERM", stopOnSigterm);
      process.off("SIGHUP", stopOnSighup);
      process.off("exit", restoreTerminal);
      process.off("uncaughtExceptionMonitor", restoreTerminal);
      if (ui.localTabIcons) {
        try {
          terminal.writeGraphics(
            `${kittyTabIconsCleanup(ui.localTabIcons)}${kittyProviderIconCleanup(ui.localTabIcons)}`,
          );
        } catch {
          // Terminal restoration must still run if the graphics cleanup fails.
        }
      }
      terminal.destroy();
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
    const suspendToBackground = () => {
      if (process.platform === "win32") {
        ui.notice = "Ctrl+Z suspend is not supported on Windows.";
        draw();
        return;
      }
      try {
        saveDraft();
      } catch (error) {
        ui.notice = message(error);
        draw();
        return;
      }
      suspended = true;
      const suspendedAt = Date.now();
      suspendKeepalive = setInterval(() => {}, 2 ** 30);
      resumeOnContinue = () => {
        if (suspendKeepalive) clearInterval(suspendKeepalive);
        suspendKeepalive = undefined;
        resumeOnContinue = undefined;
        startedAt += Date.now() - suspendedAt;
        suspended = false;
        try {
          terminal.resume();
          scheduleCellPixelMeasurement();
          draw();
        } catch {
          stop();
        }
      };
      try {
        terminal.suspend();
        process.once("SIGCONT", resumeOnContinue);
        // Stop the foreground job as a group so shells and pipelines resume
        // coherently. SIGSTOP cannot be swallowed by child-installed handlers.
        process.kill(0, "SIGSTOP");
      } catch (error) {
        if (suspendKeepalive) clearInterval(suspendKeepalive);
        suspendKeepalive = undefined;
        if (resumeOnContinue)
          process.removeListener("SIGCONT", resumeOnContinue);
        resumeOnContinue = undefined;
        suspended = false;
        try {
          terminal.resume();
          scheduleCellPixelMeasurement();
        } catch {
          stop();
          return;
        }
        ui.notice = `Could not suspend: ${message(error)}`;
        draw();
      }
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
      input.editing = chatComposerOwnsFocus();
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
      input.editing = chatComposerOwnsFocus();
    };
    const onKey = async (value: string | undefined, key: Key) => {
      if (stopped || suspended) return;
      lastMouseClick = undefined;
      // The splash is dismissed by any key. The key keeps its normal meaning,
      // so the dismissal is one redraw rather than a swallowed keystroke.
      if (ui.dismissPetSplash()) draw();
      // The card is the topmost chat overlay, so Escape closes it before it
      // reaches the tab or confirmation handling below.
      if (ui.petCard && key.name === "escape" && !input.pasting) {
        ui.petCard = false;
        ui.notice = "NIB card closed.";
        draw();
        return;
      }
      if (isSuspendKey(key)) {
        suspendToBackground();
        return;
      }
      // A sticky notice has no timer, so the chord is its keyboard exit. It is
      // read here, above every overlay, because the queue is painted on the
      // panel surfaces too and dismissing a notice never changes what an
      // overlay is doing.
      if (isDismissNoticeKey(key) && !input.pasting) {
        const newest = ui.toasts.toasts[0];
        if (newest) {
          ui.toasts = dismissToast(ui.toasts, newest.id);
          draw();
          return;
        }
      }
      if (key.name !== "escape") dismissedCommandSuggestions = undefined;
      if (!input.pasting && key.meta && key.name === "l") {
        terminal.invalidateDisplay();
        draw();
        return;
      }
      if (ui.modelPicker?.open && key.name === "tab") {
        cycleModelPickerPane(ui);
        draw();
        return;
      }
      const pickerResult = handleModelPickerKey(ui, value, key);
      if (pickerResult !== false) {
        if (typeof pickerResult === "string")
          await task(async () => {
            await ui.selectModel(pickerResult);
            input.editing = chatComposerOwnsFocus();
          });
        else if (typeof pickerResult === "object") {
          void task(() =>
            ui.loadModelPickerProvider(pickerResult.loadProviderId),
          );
          input.editing = false;
          draw();
        } else {
          if (!ui.modelPicker?.open) input.editing = chatComposerOwnsFocus();
          draw();
        }
        return;
      }
      // An open palette consumes every key except the ones it binds itself.
      // Letting the key fall through would move tabs or run a shortcut behind
      // a filter surface, which is how a search box starts deleting work.
      if (ui.palette) {
        if (key.name === "escape") {
          ui.palette = undefined;
          input.editing = chatComposerOwnsFocus();
          ui.notice = "Palette closed.";
          draw();
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          const matches = filterPalette(
            paletteFromCommands(TUI_COMMANDS),
            ui.palette.query,
            ui.palette.recent,
          );
          const picked = matches[ui.palette.selected];
          ui.palette = undefined;
          if (!picked) {
            input.editing = chatComposerOwnsFocus();
            ui.notice = "No command matches that.";
            draw();
            return;
          }
          const priorSession = ui.sessionId;
          const priorDraft = input.value;
          const priorCursor = input.cursor;
          await task(async () => {
            saveDraft();
            const result = await ui.command(picked.id);
            if (result === "quit") {
              stop();
              return;
            }
            if (priorSession !== ui.sessionId) {
              input.set(drafts[ui.sessionId ?? "new"] ?? "");
            } else {
              input.set(priorDraft);
              input.cursor = Math.min(priorCursor, [...priorDraft].length);
            }
            input.editing = chatComposerOwnsFocus();
            if (result === "edit") await editor();
            saveDraft();
          });
          return;
        }
        if (key.name === "up" || key.name === "down") {
          ui.palette = advancePaletteSelection(
            ui.palette,
            filterPalette(
              paletteFromCommands(TUI_COMMANDS),
              ui.palette.query,
              ui.palette.recent,
            ),
            key.name === "down" ? 1 : -1,
          );
          draw();
          return;
        }
        if (["home", "end", "pageup", "pagedown"].includes(key.name ?? "")) {
          const matches = filterPalette(
            paletteFromCommands(TUI_COMMANDS),
            ui.palette.query,
            ui.palette.recent,
          );
          if (key.name === "home") ui.palette = { ...ui.palette, selected: 0 };
          else if (key.name === "end")
            ui.palette = {
              ...ui.palette,
              selected: Math.max(0, matches.length - 1),
            };
          else
            ui.palette = advancePaletteSelection(
              ui.palette,
              matches,
              (key.name === "pagedown" ? 1 : -1) *
                Math.max(1, ui.palette.visible - 1),
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
      if (
        doubleLeftSessions.press(
          key,
          input.editing &&
            input.value === "" &&
            !input.pasting &&
            chatComposerOwnsFocus(),
        )
      ) {
        ui.choose("sessions");
        input.editing = chatComposerOwnsFocus();
        draw();
        return;
      }
      if (
        isToolActivityCycleKey(key, app.running()) &&
        chatComposerOwnsFocus() &&
        !input.pasting
      ) {
        ui.toolActivityMode = nextToolActivityMode(ui.toolActivityMode);
        ui.notice = `Agent activity: ${ui.toolActivityMode}.`;
        try {
          saveDraft();
        } catch (error) {
          ui.notice = message(error);
        }
        draw();
        return;
      }
      // The diff panel owns a small set of keys while it is on screen. They
      // are bound here rather than in the normal shortcut path because j, k
      // and space are already filter keys on the list tabs, and the panel is
      // the only surface where staging a hunk is the obvious meaning.
      if (ui.diffView) {
        if (key.name === "escape") {
          ui.diffView = undefined;
          ui.detail = undefined;
          ui.scroll = 0;
          input.editing = chatComposerOwnsFocus();
          draw();
          return;
        }
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
          ui.keybindingQuery = [...ui.keybindingQuery].slice(0, -1).join("");
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
          ui.cheatQuery = [...ui.cheatQuery].slice(0, -1).join("");
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
          input.editing = chatComposerOwnsFocus();
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
      const commandSuggestionsVisible =
        input.editing &&
        !input.pasting &&
        !ui.confirmation &&
        dismissedCommandSuggestions !== input.value &&
        commandSuggestions(input.value).length > 0;
      if (key.name === "escape" && commandSuggestionsVisible) {
        dismissedCommandSuggestions = input.value;
        suggestion = 0;
        lastEsc = 0;
        draw();
        return;
      }
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
      if (
        shouldCancelActiveRun(
          key,
          escapeOwnedByOverlay({
            confirmation: !!ui.confirmation,
            palette: !!ui.palette,
            keybindings: ui.showingKeybindings,
            cheatSheet: ui.showingCheatSheet,
            filter: ui.filter,
            panel: ui.tab !== "chat" || !!ui.diffView,
            detail: !!ui.detail,
            suggestions: commandSuggestionsVisible,
          }),
          input.pasting,
        ) &&
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
      const shortcut =
        ui.confirmation || (ui.settingsOpen && !(key.ctrl && key.name === "d"))
          ? undefined
          : workspaceShortcut(
              key,
              input.editing,
              input.value,
              keybindings,
              ui.tab,
            );
      if (ui.settingsOpen && shortcut !== "quit") {
        const wasOpen = ui.settingsOpen;
        const wasToolActivityHidden = ui.hideToolActivity;
        const settingsBefore = JSON.stringify(ui.localSettings());
        if (ui.handleSettingsKey(value, key)) {
          const parsed = parseWorkspaceKeybindings(ui.keybindingsOverride);
          keybindings = parsed.bindings;
          if (
            wasToolActivityHidden !== ui.hideToolActivity ||
            settingsBefore !== JSON.stringify(ui.localSettings())
          ) {
            try {
              saveDraft();
            } catch (error) {
              ui.notice = message(error);
            }
          }
          if (wasOpen && !ui.settingsOpen)
            input.editing = chatComposerOwnsFocus();
          draw();
          return;
        }
      }
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
      if (shortcut === "show-agents") {
        void task(async () => {
          await navigate(() => ui.command("/agents"));
          input.editing = false;
        });
        return;
      }
      if (shortcut === "toggle-plan") {
        ui.togglePlanMode();
        try {
          saveDraft();
        } catch (error) {
          ui.notice = message(error);
        }
        draw();
        return;
      }
      if (shortcut === "copy-prompt") {
        if (!input.value) {
          ui.notice = "There is no prompt to copy.";
          draw();
          return;
        }
        if (busy) {
          ui.notice = "Wait for the current action before copying the prompt.";
          draw();
          return;
        }
        busy = true;
        void copyTextToClipboard(input.value)
          .then(() => {
            ui.notice = "Prompt copied to clipboard.";
          })
          .catch((error) => {
            ui.notice = message(error);
          })
          .finally(() => {
            busy = false;
            draw();
          });
        draw();
        return;
      }
      if (shortcut === "retry") {
        if (!ui.canRetryLastTurn()) {
          ui.notice = "Nothing to retry.";
          draw();
        } else if (busy || app.running()) {
          ui.notice = "Wait for the active run to settle before retrying.";
          draw();
        } else {
          try {
            saveDraft();
          } catch (error) {
            ui.notice = message(error);
            draw();
            return;
          }
          void task(() => ui.command("/retry"));
        }
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
          terminal.invalidateDisplay();
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
        ui.toolActivityMode = nextToolActivityMode(ui.toolActivityMode);
        ui.notice = `Agent activity: ${ui.toolActivityMode}.`;
        try {
          saveDraft();
        } catch (error) {
          ui.notice = message(error);
        }
        draw();
        return;
      }
      if (shortcut === "toggle-tool-visibility") {
        ui.hideToolActivity = !ui.hideToolActivity;
        ui.notice = ui.hideToolActivity
          ? "Tool activity hidden. Ctrl+Shift+O shows it again."
          : "Tool activity visible.";
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
          void task(() => ui.confirm(), true);
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
      // The sticky banner's a/d actions open the existing review before any
      // decision. Respect focused views, filters and Chat input; the full hold
      // id is resolved from the same ordering the renderer shows.
      if (
        !input.pasting &&
        !input.editing &&
        ui.tab !== "chat" &&
        !ui.filter &&
        !ui.detail &&
        !ui.diffView &&
        !ui.confirmation &&
        !ui.palette &&
        !ui.modelPicker &&
        !ui.showingKeybindings &&
        !ui.showingCheatSheet &&
        (value === "a" || value === "d")
      ) {
        const pending = ui.workbench.pending()[0];
        const proxy = ui.proxy.holds[0];
        const id =
          pending?.holdId ?? (proxy ? `proxy:${proxy.holdId}` : undefined);
        if (id) {
          try {
            ui.prepareApproval(value === "a" ? "approved" : "denied", id);
          } catch (error) {
            ui.notice = message(error);
          }
          draw();
          return;
        }
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
      // Alt+N toggles the pet and Alt+Shift+N opens its signal card. Both are
      // handled here, before the composer, so neither ever sends a prompt or
      // inserts text into the draft.
      if (!input.pasting && isPetCardKey(key)) {
        ui.petCard = !ui.petCard;
        ui.notice = ui.petCard
          ? "NIB card open. Alt+Shift+N closes it."
          : "NIB card closed.";
        draw();
        return;
      }
      if (!input.pasting && isPetToggleKey(key)) {
        ui.petEnabled = !ui.petEnabled;
        ui.petPlacement = ui.petEnabled ? "auto" : "off";
        // The toggle is a display choice like /pet, so it is remembered for
        // this workspace too. A write that cannot land is not worth a notice:
        // the live choice stays either way.
        ui.savePetPreference();
        ui.notice = ui.petEnabled
          ? "Pet is on. /pet off hides it."
          : "Pet is off. /pet on shows it.";
        draw();
        return;
      }
      const modelPickerAllowed =
        !ui.confirmation &&
        !ui.detail &&
        !ui.diffView &&
        !ui.palette &&
        !ui.showingKeybindings &&
        !ui.showingCheatSheet;
      // Alt+M changes the future default; Alt+P changes only the current
      // conversation, restricted to the provider that created that session.
      if (
        !input.pasting &&
        key.meta &&
        (key.name === "m" || key.name === "p") &&
        modelPickerAllowed
      ) {
        const selection = key.name === "p" ? "session" : "default";
        await task(async () => ui.openModelPicker(selection));
        input.editing = chatComposerOwnsFocus();
        draw();
        return;
      }
      // Panels are opened from Chat with slash commands. Tab never cycles
      // screens: in a panel it returns to Chat, and in Chat it belongs to the
      // composer and its completion behavior.
      if (
        !input.pasting &&
        key.name === "tab" &&
        !key.shift &&
        ui.tab !== "chat" &&
        !ui.confirmation
      ) {
        try {
          saveDraft();
        } catch (error) {
          ui.notice = message(error);
        }
        ui.choose("chat");
        input.editing = chatComposerOwnsFocus();
        draw();
        return;
      }
      if (
        !input.pasting &&
        input.editing &&
        ui.tab === "chat" &&
        key.name === "tab" &&
        !key.shift
      ) {
        const token = mentionToken(input.value, input.cursor);
        const hasMentionCandidates =
          token !== undefined &&
          mentionCandidates(token, ui.documentPaths()).length > 0;
        const hasCommandCandidates = commandSuggestions(input.value).length > 0;
        if (!hasMentionCandidates && !hasCommandCandidates) {
          // Tab stays a completion key. Without a candidate it leaves the
          // Chat draft untouched instead of sending the user to another view.
          draw();
          return;
        }
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
      if (
        !input.pasting &&
        input.editing &&
        ui.tab === "chat" &&
        key.ctrl &&
        (key.name === "q" || key.name === "enter" || key.name === "return")
      ) {
        if (ui.workbench.running()) {
          if (ui.queueFollowUpPrompt(input.value)) {
            drafts[ui.sessionId ?? "new"] = "";
            input.set("");
            try {
              saveDraft();
            } catch (error) {
              ui.notice = message(error);
            }
          }
          draw();
          return;
        }
        if (key.name === "q" && input.value.trim()) {
          await task(submit);
          return;
        }
      }
      if (
        !input.pasting &&
        ui.queuedPrompt &&
        (key.meta || key.shift) &&
        key.name === "up"
      ) {
        const queued = ui.dequeueQueuedPrompt();
        if (queued) {
          const current = input.value;
          input.set(
            [queued, current].filter((text) => text.trim()).join("\n\n"),
          );
          ui.choose("chat");
          input.editing = true;
          try {
            saveDraft();
          } catch (error) {
            ui.notice = message(error);
          }
        }
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
          !(key.ctrl && key.name === "p") &&
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
        // The failed run's rail names Escape, so Escape is what dismisses it.
        // The key keeps its normal meaning (leaving the composer) and the
        // dismissal only removes the rail's call to action.
        if (action === "escape") ui.dismissRunError();
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
      if (
        !input.pasting &&
        !input.editing &&
        ui.tab !== "chat" &&
        (key.name === "home" || key.name === "end")
      ) {
        const end = key.name === "end";
        if (ui.detail && !ui.documentPreview)
          ui.scroll = end
            ? Math.max(0, ui.viewport.total - ui.viewport.height)
            : 0;
        else if (ui.tab === "help")
          ui.scroll = end
            ? Math.max(0, ui.viewport.total - ui.viewport.height)
            : 0;
        else if (ui.groupTree) ui.moveTreeCursorToBoundary(end);
        else ui.selected = end ? Math.max(0, ui.items().length - 1) : 0;
        draw();
        return;
      }
      if (!input.pasting && ui.tab === "sessions") {
        if (value === "g" && !key.ctrl && !key.meta) {
          ui.toggleSessionGroup();
          draw();
          return;
        }
        if (value === "[" && !key.ctrl && !key.meta) {
          ui.cycleSessionGroup(-1);
          draw();
          return;
        }
        if (value === "]" && !key.ctrl && !key.meta) {
          ui.cycleSessionGroup(1);
          draw();
          return;
        }
      }
      // Type to filter in list tabs. Bound keys keep their action; every
      // other printable character narrows the list instead of needing /filter.
      const filterChar = !input.pasting
        ? filterKeyForTab(value, key, ui.tab)
        : undefined;
      if (filterChar !== undefined) {
        ui.filter += filterChar;
        ui.selected = 0;
        ui.hoveredRow = undefined;
        ui.detail = undefined;
        ui.documentPreview = false;
        ui.notice = `Filter: ${ui.filter} (Esc clears, Backspace deletes)`;
        draw();
        return;
      }
      if (!input.pasting && key.name === "backspace" && ui.filter) {
        ui.filter = [...ui.filter].slice(0, -1).join("");
        ui.selected = 0;
        ui.hoveredRow = undefined;
        ui.detail = undefined;
        ui.documentPreview = false;
        ui.notice = ui.filter
          ? `Filter: ${ui.filter} (Esc clears, Backspace deletes)`
          : "Filter cleared.";
        draw();
        return;
      }
      if (key.name === "tab") {
        if (ui.tab === "chat") input.editing = true;
      } else if (
        !input.pasting &&
        (key.name === "right" || key.name === "left")
      ) {
        // OMP's tree selector uses Left/Right as page navigation too.
        if (ui.groupTree) {
          ui.moveTreeCursorByPage(
            key.name === "right" ? 1 : -1,
            Math.max(1, ui.viewport.height),
          );
          draw();
        }
      } else if (key.name === "escape") {
        // A focused detail closes before its underlying list filter, matching
        // selector cancellation precedence while preserving the filtered rows.
        if (ui.detail) {
          ui.detail = undefined;
          ui.documentPreview = false;
          ui.scroll = 0;
          input.editing = chatComposerOwnsFocus();
          lastEsc = 0;
          draw();
          return;
        }
        // An active filter clears after a focused detail, before checkpoints.
        if (ui.filter) {
          ui.filter = "";
          ui.selected = 0;
          lastEsc = 0;
          ui.notice = "Filter cleared.";
          draw();
          return;
        }
        if (ui.tab !== "chat") {
          ui.choose("chat");
          input.editing = chatComposerOwnsFocus();
          lastEsc = 0;
          ui.notice = "Returned to Chat.";
          draw();
          return;
        }
        // An unfocused composer still owns the dismissal the rail names,
        // unless a search/detail/palette surface already owns Escape.
        if (
          !escapeOwnedByOverlay({
            confirmation: !!ui.confirmation,
            palette: !!ui.palette,
            keybindings: ui.showingKeybindings,
            cheatSheet: ui.showingCheatSheet,
            filter: ui.filter,
            panel: ui.tab !== "chat" || !!ui.diffView,
            detail: !!ui.detail,
            suggestions: false,
          }) &&
          ui.dismissRunError()
        ) {
          lastEsc = 0;
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
      } else if (
        (key.name === "return" && (ui.tab === "chat" || !ui.diffView)) ||
        (key.name === "enter" && ui.tab !== "chat" && !ui.diffView)
      ) {
        if (ui.groupTree && ui.tab !== "chat") {
          if (ui.activateTreeCursor() === "row")
            void task(() => navigate(() => ui.openSelected()));
          else draw();
        } else void task(() => navigate(() => ui.openSelected()));
      } else if (key.name === "pageup" || key.name === "pagedown") {
        const direction = key.name === "pageup" ? -1 : 1;
        if (ui.groupTree && (!ui.detail || ui.documentPreview)) {
          ui.moveTreeCursorByPage(direction, Math.max(1, ui.viewport.height));
        } else if (
          ui.tab === "chat" ||
          ui.tab === "help" ||
          ui.detail ||
          ui.diffView
        ) {
          ui.scrollPage(direction);
        } else {
          const pageSize = Math.max(1, ui.viewport.height);
          const last = Math.max(0, ui.items().length - 1);
          ui.selected = Math.max(
            0,
            Math.min(last, ui.selected + direction * pageSize),
          );
        }
      } else if (value === "{" || value === "}") {
        const target = nextPromptRow(
          ui.promptRows,
          ui.viewport.offset,
          value === "}" ? 1 : -1,
        );
        if (target < 0) ui.notice = "No further prompt in this direction.";
        else ui.scroll = target;
      } else if (key.name === "up" || (key.ctrl && key.name === "p")) {
        if (ui.tab === "documents" && ui.groupTree && ui.documentPreview)
          ui.moveTreeCursor(-1);
        else if (ui.detail) ui.scroll = Math.max(0, ui.scroll - 1);
        else if (ui.tab === "help")
          ui.scroll = Math.max(
            0,
            Math.min(
              Math.max(0, ui.viewport.total - ui.viewport.height),
              ui.scroll - 1,
            ),
          );
        else if (ui.tab !== "chat" && !ui.moveTreeCursor(-1) && !ui.groupTree)
          ui.selected = ui.items().length
            ? (ui.selected - 1 + ui.items().length) % ui.items().length
            : 0;
      } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
        if (ui.tab === "documents" && ui.groupTree && ui.documentPreview)
          ui.moveTreeCursor(1);
        else if (ui.detail) ui.scroll++;
        else if (ui.tab === "help")
          ui.scroll = Math.max(
            0,
            Math.min(
              Math.max(0, ui.viewport.total - ui.viewport.height),
              ui.scroll + 1,
            ),
          );
        else if (ui.tab !== "chat" && !ui.moveTreeCursor(1) && !ui.groupTree)
          ui.selected = ui.items().length
            ? (ui.selected + 1) % ui.items().length
            : 0;
      }
      draw();
    };
    const onMouse = (event: WorkspaceMouseEvent) => {
      const point = {
        x: Math.max(0, event.x - 1),
        y: Math.max(0, event.y - 1),
      };
      if (event.motion) {
        if (selectionDragging && mouseSelection) {
          mouseSelection = { ...mouseSelection, focus: point };
          draw();
          return;
        }
        const rowTarget = ui.rowHitTargets.find(
          (item) =>
            item.row === event.y &&
            event.x >= item.start &&
            event.x <= item.end,
        );
        // Only the list kinds carry a hover cursor; a chip or a toast has no
        // selected row to highlight, so hovering it changes nothing.
        const hoveredRow =
          rowTarget &&
          (rowTarget.kind === "item" ||
            rowTarget.kind === "tree" ||
            rowTarget.kind === "provider" ||
            rowTarget.kind === "model" ||
            rowTarget.kind === "setting")
            ? { kind: rowTarget.kind, index: rowTarget.index }
            : undefined;
        if (
          ui.hoveredRow?.kind !== hoveredRow?.kind ||
          ui.hoveredRow?.index !== hoveredRow?.index
        ) {
          ui.hoveredRow = hoveredRow;
          draw();
        }
        return;
      }
      const button = event.button & ~32;
      if (!event.pressed) {
        if (selectionDragging && mouseSelection) {
          const moved =
            mouseSelection.anchor.x !== point.x ||
            mouseSelection.anchor.y !== point.y;
          mouseSelection = moved
            ? { ...mouseSelection, focus: point }
            : undefined;
          selectionDragging = false;
          const selectedText =
            moved && mouseSelection
              ? selectedMouseText(
                  renderedFrame,
                  mouseSelection.anchor,
                  mouseSelection.focus,
                  terminal.columns,
                  // Copying stops at the transcript edge: a drag that ends on
                  // the rail must not paste status text into the prompt.
                  mouseSelectionLimit(terminal.columns, ui.viewport),
                )
              : "";
          draw();
          if (selectedText.length > 0) {
            void copyTextToClipboard(selectedText)
              .then(() => {
                ui.notice = "Selection copied to clipboard.";
              })
              .catch((error) => {
                ui.notice = message(error);
              })
              .finally(draw);
          }
        }
        return;
      }
      if (button === 64 || button === 65) {
        lastMouseClick = undefined;
        // SGR wheel reports use button 64/65 for up/down.
        applyWorkspaceWheel(ui, button === 64 ? -1 : 1, event.x);
        draw();
        return;
      }
      if ((button & 3) === 0 && (button & 4) !== 0) {
        lastMouseClick = undefined;
        // The rail is status, not conversation text: a Shift click there must
        // not open a selection the transcript never owned.
        if (railOwnsPoint(ui.viewport, point)) return;
        mouseSelection = { anchor: point, focus: point };
        selectionDragging = true;
        draw();
        return;
      }
      if (button !== 0) {
        lastMouseClick = undefined;
        return;
      }
      const { tabTarget, rowTarget } = workspaceHitAt(ui, event.x, event.y);
      const actionableRow =
        rowTarget &&
        !(
          ui.tab === "chat" &&
          !(ui.settingsOpen && rowTarget.kind === "setting") &&
          rowTarget.kind !== "provider" &&
          rowTarget.kind !== "model" &&
          rowTarget.kind !== "chip" &&
          rowTarget.kind !== "toast"
        );
      // Ordinary drags select passive text; interactive rows keep click
      // behavior, while Shift explicitly selects through those hit targets.
      // A rail cell is neither: it is status painted beside the transcript, so
      // the click neither selects nor moves input focus.
      if (!tabTarget && !actionableRow) {
        lastMouseClick = undefined;
        if (railOwnsPoint(ui.viewport, point)) return;
        mouseSelection = { anchor: point, focus: point };
        selectionDragging = true;
        draw();
        return;
      }
      mouseSelection = undefined;
      if (tabTarget) {
        const targetKey = `tab:${tabTarget.tab}:${tabTarget.row}`;
        const now = Date.now();
        const doubleClick =
          lastMouseClick?.target === targetKey &&
          now >= lastMouseClick.at &&
          now - lastMouseClick.at <= 450;
        lastMouseClick = doubleClick
          ? undefined
          : { target: targetKey, at: now };
        if (ui.tab === "chat" && tabTarget.tab === "sessions" && !doubleClick) {
          return;
        }
        try {
          saveDraft();
        } catch (error) {
          ui.notice = message(error);
        }
        ui.choose(tabTarget.tab);
        input.editing = chatComposerOwnsFocus();
        draw();
        return;
      }
      if (
        !rowTarget ||
        (ui.tab === "chat" &&
          !(ui.settingsOpen && rowTarget.kind === "setting") &&
          rowTarget.kind !== "provider" &&
          rowTarget.kind !== "model" &&
          rowTarget.kind !== "chip" &&
          rowTarget.kind !== "toast")
      ) {
        lastMouseClick = undefined;
        return;
      }
      const picker = ui.modelPicker;
      const targetIdentity =
        rowTarget.kind === "model" && picker
          ? [
              picker.providerId,
              modelPickerMatches(picker.models, picker.query)[rowTarget.index]
                ?.id,
            ]
          : rowTarget.kind === "provider" && picker
            ? picker.providers[rowTarget.index]?.id
            : rowTarget.index;
      const targetKey = JSON.stringify([
        ui.tab,
        rowTarget.kind,
        targetIdentity,
      ]);
      const now = Date.now();
      const doubleClick =
        lastMouseClick?.target === targetKey &&
        now >= lastMouseClick.at &&
        now - lastMouseClick.at <= 450;
      lastMouseClick = doubleClick ? undefined : { target: targetKey, at: now };
      if (rowTarget.kind === "tree") {
        ui.hoveredRow = { kind: rowTarget.kind, index: rowTarget.index };
        ui.selectTreeCursor(rowTarget.index);
        if (doubleClick && ui.activateTreeCursor() === "row")
          void task(() => navigate(() => ui.openSelected()));
      } else if (rowTarget.kind === "model") {
        ui.hoveredRow = { kind: rowTarget.kind, index: rowTarget.index };
        const picker = ui.modelPicker;
        const matches = picker
          ? modelPickerMatches(picker.models, picker.query)
          : undefined;
        const model = matches?.[rowTarget.index];
        if (!picker || !model) return;
        ui.modelPicker = {
          ...picker,
          selected: rowTarget.index,
          modelWindowStart: modelPickerWindowStart(
            picker.selected,
            matches.length,
            modelPickerVisibleRows(ui),
            picker.modelWindowStart,
          ),
        };
        if (doubleClick)
          void task(async () => {
            await ui.selectModel(model.id);
            input.editing = chatComposerOwnsFocus();
          });
      } else if (rowTarget.kind === "setting") {
        const editing = !!ui.settingsEdit;
        const settingsBefore = JSON.stringify(ui.localSettings());
        const toolActivityHiddenBefore = ui.hideToolActivity;
        ui.hoveredRow = { kind: "setting", index: rowTarget.index };
        ui.selectSetting(rowTarget.index);
        // A single click selects; a double-click applies exactly once.
        if (!editing && doubleClick) ui.activateSetting();
        if (
          settingsBefore !== JSON.stringify(ui.localSettings()) ||
          toolActivityHiddenBefore !== ui.hideToolActivity
        ) {
          try {
            saveDraft();
          } catch (error) {
            ui.notice = message(error);
          }
        }
      } else if (rowTarget.kind === "provider") {
        const picker = ui.modelPicker;
        const provider = picker?.providers[rowTarget.index];
        if (!provider || !ui.modelPicker?.open) return;
        ui.selectModelPickerProvider(rowTarget.index);
        if (doubleClick)
          void task(() => ui.loadModelPickerProvider(provider.id));
      } else if (rowTarget.kind === "chip") {
        // A chip click is the pointer form of a command the frame already
        // documents. Nothing here grants authority a keyboard path lacks.
        const action = rowTarget.action;
        if (action === "model") {
          lastMouseClick = undefined;
          // The picker takes the keyboard, so the composer stops owning it
          // exactly as it does when /model runs.
          input.editing = false;
          void task(async () => {
            await ui.openModelPicker(ui.sessionId ? "session" : "default");
          });
          return;
        }
        if (action === "usage") ui.choose("usage");
        else if (action === "documents") ui.choose("documents");
        else if (action === "models-panel") ui.choose("models");
        else if (action === "pet") {
          ui.petEnabled = true;
          ui.petCard = true;
          ui.notice = "NIB card open · Alt+Shift+N closes it.";
        }
      } else if (rowTarget.kind === "toast") {
        // The queue already ages out on its own; a click just clears it now.
        const toast = ui.toasts.toasts[rowTarget.index];
        if (toast) ui.toasts = dismissToast(ui.toasts, toast.id);
      } else {
        ui.hoveredRow = { kind: rowTarget.kind, index: rowTarget.index };
        ui.selected = rowTarget.index;
        void task(() => navigate(() => ui.openSelected()));
      }
      input.editing = false;
      draw();
    };
    process.on("SIGINT", stopOnSigint);
    process.on("SIGTERM", stopOnSigterm);
    process.on("SIGHUP", stopOnSighup);
    process.once("exit", restoreTerminal);
    process.once("uncaughtExceptionMonitor", restoreTerminal);
    terminal.start(
      onKey,
      (text) => {
        if (ui.settingsOpen) {
          ui.insertSettingsText(text);
          draw();
          return;
        }
        if (ui.modelPicker?.open) {
          const picker = ui.modelPicker;
          if (picker.focusedPane !== "models") return;
          const inserted = [
            ...sanitizeText(stripAnsi(text).replace(/[\r\n\t]+/g, " ")),
          ];
          const points = [...picker.query];
          points.splice(picker.cursor, 0, ...inserted);
          const query = points.join("");
          setModelPickerQuery(
            ui,
            picker,
            query,
            picker.cursor + inserted.length,
          );
          draw();
          return;
        }
        input.pasting = true;
        try {
          input.paste(text);
        } finally {
          input.pasting = false;
        }
        try {
          saveDraft();
        } catch (error) {
          ui.notice = message(error);
        }
        draw();
      },
      () => {
        draw();
        scheduleCellPixelMeasurement();
      },
      onMouse,
      { deferDisplay: true },
    );
    const activateTerminal = (
      cellPixels: { height: number; width: number } | undefined,
    ) => {
      if (stopped) return;
      if (cellPixels?.height) {
        terminalCapabilities = {
          ...terminalCapabilities,
          cellHeightPixels: cellPixels.height,
        };
      }
      terminal.activate();
      initializingTerminal = false;
      if (ui.localTabIcons)
        terminal.writeGraphics(
          `${kittyTabIconsTransfer(ui.localTabIcons)}${kittyProviderIconTransfer(ui.localTabIcons)}`,
        );
      // The splash is offered once per process, at the first interactive
      // frame only. It is skipped when the pet is off and when the terminal
      // cannot print the card, and a timer takes it down after 900 ms even if
      // no key arrives. Any key dismisses it through ui.dismissPetSplash.
      if (!petSplashShown) {
        petSplashShown = true;
        if (ui.petEnabled && process.stdout.isTTY) {
          ui.petSplashUntil = Date.now() + PET_SPLASH_MS;
          splashTimer = setTimeout(() => {
            ui.petSplashUntil = 0;
            draw();
          }, PET_SPLASH_MS);
        }
      }
      draw();
    };
    // Measure before the first visible frame so the pixel-based composer
    // height is correct immediately instead of visibly reflowing afterward.
    void terminal
      .measureCellPixels()
      .then(activateTerminal, () => activateTerminal(undefined));
    // The idle pet breathes at 4 fps, so its pose only changes four times a
    // second. Remembering the last idle step keeps the existing 100 ms timer
    // from repainting a static screen ten times a second.
    let lastIdlePetStep = -1;
    motionTimer = setInterval(() => {
      if (!motion || ui.motionOverride === false || stopped || suspended)
        return;
      // Motion frames redraw active runs on any panel; provider and ledger
      // refreshes remain on their separate, slower timer.
      if (busy || app.running()) {
        draw();
        return;
      }
      // Nothing is running, so the only thing motion can change is the pet.
      // A settled or hidden pet renders identically on every frame and costs
      // nothing.
      if (!ui.petAnimating) return;
      const idleStep = Math.floor((Date.now() - startedAt) / 250);
      if (idleStep === lastIdlePetStep) return;
      lastIdlePetStep = idleStep;
      draw();
    }, MOTION_TICK_MS);
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
        .then(async () => {
          const queued = takeReadyQueuedPrompt(ui, {
            workbenchRunning: app.running(),
            hasConfirmation: !!ui.confirmation,
            runnerBusy: busy || ui.hostRunBusy(),
          });
          if (!queued) return;
          busy = true;
          draw();
          try {
            await dispatchQueuedPrompt(
              ui,
              queued,
              () => ui.refresh(),
              (error) => {
                ui.notice = message(error);
              },
            );
          } finally {
            busy = false;
          }
        })
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
