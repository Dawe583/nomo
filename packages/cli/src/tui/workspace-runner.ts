import { emitKeypressEvents, type Key } from "node:readline";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import { LocalStorage } from "../../../workbench/src/storage.ts";
import {
  WorkspaceTui,
  WORKSPACE_TABS,
  renderWorkspace,
  message,
  type WorkspaceTab,
  wrap,
} from "./workspace.ts";
import { DiffScreenWriter } from "./watch.ts";
import { sanitizeText } from "./layout.ts";

/** Bracketed paste never submits a message or an approval. */
export class WorkspaceInput {
  editing = false;
  value = "";
  cursor = 0;
  pasting = false;
  set(value: string) {
    this.value = value;
    this.cursor = [...value].length;
  }
  insert(value: string) {
    const points = [...this.value];
    points.splice(this.cursor, 0, ...value);
    this.value = points.join("").slice(0, 32000);
    this.cursor = Math.min(
      this.cursor + [...value].length,
      [...this.value].length,
    );
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
    if (key.name === "return" || key.name === "enter") {
      if (key.meta || key.shift) {
        this.insert("\n");
        return;
      }
      return "submit";
    }
    const points = [...this.value];
    if (key.name === "backspace") {
      if (this.cursor) points.splice(--this.cursor, 1);
      this.value = points.join("");
    } else if (key.name === "delete") {
      points.splice(this.cursor, 1);
      this.value = points.join("");
    } else if (key.name === "left") this.cursor = Math.max(0, this.cursor - 1);
    else if (key.name === "right")
      this.cursor = Math.min(points.length, this.cursor + 1);
    else if (key.name === "home" || (key.ctrl && key.name === "a"))
      this.cursor = 0;
    else if (key.name === "end" || (key.ctrl && key.name === "e"))
      this.cursor = points.length;
    else if (key.ctrl && key.name === "u") this.set("");
    else if (
      !key.ctrl &&
      !key.meta &&
      value &&
      !/[\x00-\x1f\x7f-\x9f]/.test(value)
    )
      this.insert(value);
    return;
  }
  display() {
    const points = [...this.value];
    points.splice(this.cursor, 0, "_");
    return points.join("").replace(/\n/g, " / ");
  }
}

export async function runWorkspaceTui(
  argv: readonly string[],
): Promise<number> {
  let directory: string | undefined,
    once = false,
    source: string | undefined,
    sessionId: string | undefined;
  let tab: WorkspaceTab = "overview";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--once") once = true;
    else if (arg === "--help") {
      console.log(
        "void tui [--once] [--view overview|chat|sessions|documents|ledger|approvals|policy|tools|models|usage|help] [--session ID] [--data-dir PATH] [--import-provider opencode:tokenrouter]",
      );
      return 0;
    } else if (
      ["--view", "--session", "--data-dir", "--import-provider"].includes(arg!)
    ) {
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw Error(`${arg} requires a value`);
      if (arg === "--view") {
        if (!WORKSPACE_TABS.includes(value as WorkspaceTab))
          throw Error("Unknown TUI view");
        tab = value as WorkspaceTab;
      }
      if (arg === "--session") sessionId = value;
      if (arg === "--data-dir") directory = resolve(value);
      if (arg === "--import-provider") source = value;
    } else throw Error(`Unknown TUI option: ${arg}`);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(directory ? { VOID_DATA_DIR: directory } : {}),
  };
  const app = new Workbench(env),
    ui = new WorkspaceTui(app, env);
  const dataDir =
    env.VOID_DATA_DIR ??
    join(env.VOID_LEDGER_DIR ?? join(homedir(), ".void"), "workbench");
  const store = new LocalStorage(join(dataDir, "tui"));
  const saved = store.read<{
    sessionId?: string;
    model?: string;
    drafts: Record<string, string>;
  }>();
  const drafts = saved?.drafts ?? {};
  const input = new WorkspaceInput();
  await ui.initialize();
  if (source) await ui.command(`/connect ${source}`);
  const selected = sessionId ?? saved?.sessionId;
  if (selected && app.get(selected)) ui.sessionId = selected;
  if (saved?.model && ui.provider?.models.some((m) => m.id === saved.model))
    ui.model = saved.model;
  ui.choose(tab);
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
    return ui.proofErrors.size ? 1 : 0;
  }
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
    store.save({ sessionId: ui.sessionId, model: ui.model, drafts });
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
    const config: unknown = env.VOID_TUI_EDITOR
      ? JSON.parse(env.VOID_TUI_EDITOR)
      : [env.EDITOR || "nano"];
    if (
      !Array.isArray(config) ||
      !config.length ||
      !config.every((v) => typeof v === "string" && v.length)
    )
      throw Error("VOID_TUI_EDITOR musí být JSON pole programu a argumentů.");
    const temp = await mkdtemp(join(tmpdir(), "void-editor-")),
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
          "Editor nedokončil úpravu. Původní dokument zůstal zachován.",
        );
      const content = await readFile(file, "utf8");
      if (Buffer.byteLength(content) > 256000)
        throw Error("Dokument přesahuje 256 kB.");
      ui.prepareEdit(target, content);
      captured = true;
    } catch (error) {
      throw Error(`${message(error)} Koncept editoru zůstal v ${file}`);
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
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearTimeout(draftTimer);
      let draftError = false;
      try {
        saveDraft();
      } catch {
        draftError = true;
      }
      process.stdin.off("keypress", onKey);
      process.stdout.off("resize", draw);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.off("SIGHUP", stop);
      screen.leave();
      process.stdout.write("\x1b[?2004l");
      if (draftError) console.error("Koncept se nepodařilo uložit.");
      console.log(
        "VOID: ukončuji běh a ukládám historii. Již odeslaný externí nástroj může doběhnout.",
      );
      void (async () => {
        app.close();
        await activeTask;
        await app.settled();
      })().then(
        () => resolveDone(draftError ? 1 : 0),
        () => {
          console.error(
            "Uložení selhalo. Zachovej datový adresář a zkontroluj ledger.",
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
      input.editing = false;
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
    const onKey = (value: string | undefined, key: Key) => {
      if (stopped || suspended) return;
      if (key.ctrl && key.name === "c") {
        stop();
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
        else if (key.name === "pageup") ui.scroll = Math.max(0, ui.scroll - 10);
        else if (key.name === "pagedown") ui.scroll += 10;
        draw();
        return;
      }
      if (input.editing || key.name === "paste-start") {
        const action = input.key(value, key);
        if (action === "submit") void task(submit);
        else scheduleDraft();
        draw();
        return;
      }
      if (busy && key.name !== "tab") return;
      if (ui.scroll < 0 && (key.name === "pageup" || key.name === "pagedown"))
        ui.scroll = Math.max(
          0,
          wrap(ui.lines(), (process.stdout.columns ?? 80) - 4).length -
            Math.max(1, (process.stdout.rows ?? 24) - 7),
        );
      if (key.name === "tab") ui.cycle(key.shift ? -1 : 1);
      else if (value === "q") {
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
        void task(() => navigate(() => ui.command("/new")));
      else if (value === "u") void task(() => ui.prepareUndo());
      else if (value === "a" || value === "d")
        void task(async () =>
          ui.prepareApproval(value === "a" ? "approved" : "denied"),
        );
      else if (value === "r") void task(() => ui.refresh(true));
      else if (value === "?") ui.choose("help");
      else if (key.name === "escape") {
        ui.detail = undefined;
        ui.scroll = 0;
      } else if (key.name === "return")
        void task(() => navigate(() => ui.openSelected()));
      else if (key.name === "pageup") ui.scroll = Math.max(0, ui.scroll - 10);
      else if (key.name === "pagedown") ui.scroll += 10;
      else if (key.name === "up" || value === "k") {
        if (ui.detail) ui.scroll = Math.max(0, ui.scroll - 1);
        else ui.selected = Math.max(0, ui.selected - 1);
      } else if (key.name === "down" || value === "j") {
        if (ui.detail) ui.scroll++;
        else ui.selected = Math.min(ui.items().length - 1, ui.selected + 1);
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
    screen.enter();
    process.stdout.write("\x1b[?2004h");
    draw();
    timer = setInterval(() => {
      if (refreshing || stopped || suspended) return;
      refreshing = true;
      void ui
        .refresh()
        .catch((e) => {
          ui.notice = sanitizeText(message(e));
        })
        .finally(() => {
          refreshing = false;
          draw();
        });
    }, 250);
  });
}
