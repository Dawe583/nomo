import { loadPending, writeDecision } from "../../policy/src/approvals.ts";
import { join } from "node:path";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { readLedgerFeed } from "../../ledger/src/feed.ts";
import {
  NO_VERIFICATION_KEY_NOTE,
  resolveVerificationKey,
  verificationKeyLine,
  verificationStatus,
} from "../../ledger/src/verify-key.ts";
import { retainedKeyProvider } from "../../ledger/src/sign.ts";
import { detectCapabilities } from "./tui/caps.ts";
import { DiffScreenWriter } from "./tui/watch.ts";
import { liveRecords, renderLiveFeed, type LiveView } from "./tui/live.ts";
import { dataDir } from "../../ledger/src/paths.ts";
import { envValue } from "../../ledger/src/env-compat.ts";

/// Resolve the `--ledger` value to a ledger file. Every sibling command reads
/// `<ledger dir>/<workspace>.jsonl`, so handing the directory itself to the
/// feed fails to open it. A path that exists as a file is taken as given, so
/// pointing at one specific ledger still works.
export async function resolveLedgerPath(value: string | undefined, workspace: string): Promise<string> {
  const fallback = join(envValue(process.env, "NOMO_LEDGER_DIR") ?? join(dataDir(homedir()), "ledger"), `${workspace}.jsonl`);
  if (value === undefined) return fallback;
  const isDirectory = await stat(value).then(info => info.isDirectory()).catch(() => false);
  return isDirectory ? join(value, `${workspace}.jsonl`) : value;
}

export async function runWatchCommand(argv: readonly string[]): Promise<number> {
  let workspace = envValue(process.env, "NOMO_WORKSPACE") ?? "default";
  let ledger: string | undefined;
  let once = false;
  let approvalDir = envValue(process.env, "NOMO_APPROVALS_DIR");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--once") once = true;
    else if (arg === "--ledger" || arg === "--workspace" || arg === "--approvals-dir") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--ledger") ledger = value;
      else if (arg === "--approvals-dir") approvalDir = value;
      else workspace = value;
    } else throw new Error(`unknown watch option: ${arg}`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(workspace)) throw new Error("invalid workspace");
  const ledgerFile = await resolveLedgerPath(ledger, workspace);
  approvalDir ??= join(dataDir(homedir()), "approvals", workspace);
  let view: LiveView = { workspace, selected: 0, filter: "", paused: false, detail: false, help: false };
  const caps = () => detectCapabilities(process.env, process.stdout);
  let reading = false;
  let stopped = false;
  let writer: DiffScreenWriter | undefined;
  const draw = () => { if (!stopped) writer?.write(renderLiveFeed(view, caps())); };
  const refresh = async () => {
    if (reading || stopped) return;
    reading = true;
    try {
      // Resolved the same way every other verifier surface resolves it, so an
      // operator's pin is honoured here and the source is reported. This used
      // to call `devKeyProvider()` with no arguments at all: it read the real
      // `~/.nomo/keys`, ignored the trust file, and minted a key when none
      // existed. `retainedKeyProvider` keeps a watch from creating signing
      // capability as a side effect of looking at the ledger.
      const key = await resolveVerificationKey({
        env: process.env,
        allowDegraded: true,
        signingKey: async () => {
          try {
            return await retainedKeyProvider({ env: process.env });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
          }
        },
      });
      const page = await readLedgerFeed(ledgerFile, { publicKey: key?.publicKey });
      if (stopped) return;
      const selectedSeq = liveRecords(view)[view.selected]?.seq;
      // The watch stated nothing at all when no key resolved, which is the one
      // state an operator most needs to be told about. It now always names the
      // answer, using the same line every other surface prints, so a reader
      // comparing `nomo watch` against `nomo verify` is comparing the same
      // claim and not two different ones.
      const note = key === undefined ? NO_VERIFICATION_KEY_NOTE : verificationKeyLine(key);
      view = {
        ...view,
        page,
        error: undefined,
        verificationNote: note,
        verificationStatus: key === undefined ? "NOT VERIFIED (integrity only)" : verificationStatus(key),
      };
      const index = liveRecords(view).findIndex(row => row.seq === selectedSeq);
      view = { ...view, selected: Math.max(0, index) };
    } catch {
      if (!stopped) view = { ...view, page: undefined, error: "Ledger unavailable or verification failed" };
    } finally {
      try {
        const approvals = loadPending(approvalDir).filter(record => record.expiresAt > Date.now() && record.call.workspace === workspace);
        if (!stopped) {
          const selectedId = view.approvals?.[view.approvalSelected ?? 0]?.holdId;
          const index = approvals.findIndex(record => record.holdId === selectedId);
          view = { ...view, approvals, approvalSelected: Math.max(0, index), confirmDecision: index < 0 ? undefined : view.confirmDecision };
        }
      } catch (error) {
        if (!stopped) view = { ...view, approvals: [], confirmDecision: undefined, ...((error as NodeJS.ErrnoException).code === "ENOENT" ? {} : { notice: "Approval state unavailable or invalid" }) };
      }
      reading = false; draw();
    }
  };
  await refresh();
  if (once || !caps().interactive || !caps().ansi || !process.stdin.isTTY) {
    process.stdout.write(`${renderLiveFeed(view, { ...caps(), ansi: false, colorDepth: 0 })}\n`);
    return view.error ? 1 : 0;
  }
  const screen = new DiffScreenWriter(process.stdout);
  writer = screen;
  const wasRaw = process.stdin.isRaw;
  const wasPaused = process.stdin.isPaused();
  return new Promise<number>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      process.stdin.off("data", onData);
      process.stdin.setRawMode(wasRaw);
      if (wasPaused) process.stdin.pause();
      process.off("SIGWINCH", draw);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.off("SIGHUP", stop);
      process.off("exit", stop);
      process.off("uncaughtExceptionMonitor", stop);
      screen.leave();
      resolve(0);
    };
    const onData = (chunk: Buffer) => {
      const key = chunk.toString("utf8");
      if (key === "q" || key === "\u0003") return stop();
      if (key === "h") { view = { ...view, approvalView: !view.approvalView, confirmDecision: undefined }; void refresh(); draw(); return; }
      if (view.approvalView) {
        if (key === "j" || key === "\u001b[B") view = { ...view, approvalSelected: Math.min((view.approvalSelected ?? 0) + 1, Math.max(0, (view.approvals?.length ?? 0) - 1)), confirmDecision: undefined };
        if (key === "k" || key === "\u001b[A") view = { ...view, approvalSelected: Math.max(0, (view.approvalSelected ?? 0) - 1), confirmDecision: undefined };
        if (key === "a" || key === "d") view = { ...view, confirmDecision: key === "a" ? "approved" : "denied" };
        if (key === "\u001b") view = { ...view, confirmDecision: undefined };
        if (key === "y" && view.confirmDecision) {
          const record = view.approvals?.[view.approvalSelected ?? 0];
          try {
            if (!record) throw new Error("No selected hold");
            writeDecision(approvalDir, record.holdId, { kind: view.confirmDecision, by: "tui" });
            view = { ...view, confirmDecision: undefined, notice: "Decision queued. Proxy resolution is not yet confirmed." };
          } catch { view = { ...view, confirmDecision: undefined, notice: "Cannot queue decision. Refresh the hold and retry." }; }
          void refresh();
        }
        draw(); return;
      }
      if (key === "j" || key === "\u001b[B") view = { ...view, selected: Math.min(view.selected + 1, Math.max(0, liveRecords(view).length - 1)) };
      if (key === "k" || key === "\u001b[A") view = { ...view, selected: Math.max(0, view.selected - 1) };
      if (key === "\r") view = { ...view, detail: !view.detail };
      if (key === "\u001b") view = { ...view, detail: false, help: false };
      if (key === "?") view = { ...view, help: !view.help };
      if (key === "p") view = { ...view, paused: !view.paused };
      if (key === "f") {
        const filters = ["", "r0", "r1", "r2", "r3"];
        view = { ...view, filter: filters[(filters.indexOf(view.filter) + 1) % filters.length]!, selected: 0 };
      }
      if (key === "v") void refresh();
      draw();
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.on("SIGWINCH", draw);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("SIGHUP", stop);
    process.once("exit", stop);
    process.once("uncaughtExceptionMonitor", stop);
    screen.enter();
    draw();
    timer = setInterval(() => { if (!view.paused || view.approvalView) void refresh(); }, 1000);
  });
}
