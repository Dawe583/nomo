import type { Key } from "node:readline";
import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const MOUSE_START = "\x1b[<";
const CELL_PIXEL_REPLY_START = "\x1b[6;";
const MOUSE_MOTION_ON = "\x1b[?1003h";
const MOUSE_MOTION_OFF = "\x1b[?1003l";
const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";

export type WorkspaceMouseEvent = Readonly<{
  button: number;
  x: number;
  y: number;
  pressed: boolean;
  motion: boolean;
}>;

export function createWorkspaceTerminal(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
) {
  const keyInput = new PassThrough();
  const decoder = new StringDecoder("utf8");
  const initialRaw = input.isRaw ?? false;
  let buffer = "";
  let paste = "";
  let specialTimer: ReturnType<typeof setTimeout> | undefined;
  let inPaste = false;
  let started = false;
  let suspended = false;
  let displayDeferred = false;
  let stopped = false;
  let outputBlocked = false;
  let pendingFrame: string | undefined;
  let previousFrame: string | undefined;
  let previousFrameLines: string[] | undefined;
  let previousColumns: number | undefined;
  let previousRows: number | undefined;
  let onKey: ((value: string | undefined, key: Key) => void) | undefined;
  let onPaste: ((value: string) => void) | undefined;
  let onMouse: ((event: WorkspaceMouseEvent) => void) | undefined;
  let onDrain: (() => void) | undefined;
  let pendingCellPixelQuery:
    | {
        resolve: (value: { height: number; width: number } | undefined) => void;
        promise: Promise<{ height: number; width: number } | undefined>;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  const finishCellPixelQuery = (
    value: { height: number; width: number } | undefined,
  ) => {
    const pending = pendingCellPixelQuery;
    if (!pending) return;
    pendingCellPixelQuery = undefined;
    clearTimeout(pending.timer);
    pending.resolve(value);
  };

  const writeModes = (enabled: boolean) => {
    const mouse =
      input.isTTY && output.isTTY
        ? enabled
          ? `\x1b[?1000h${MOUSE_MOTION_ON}\x1b[?1006h`
          : `\x1b[?1006l${MOUSE_MOTION_OFF}\x1b[?1000l`
        : "";
    output.write(
      enabled
        ? `${ALT_SCREEN_ON}${BRACKETED_PASTE_ON}${mouse}\x1b[H\x1b[2J\x1b[?25l`
        : `${BRACKETED_PASTE_OFF}${mouse}${ALT_SCREEN_OFF}\x1b[?25h`,
    );
    previousFrame = undefined;
    previousFrameLines = undefined;
    previousColumns = undefined;
    previousRows = undefined;
  };
  const trailingPrefixLength = (value: string, marker: string) => {
    for (
      let length = Math.min(value.length, marker.length - 1);
      length > 0;
      length--
    )
      if (value.endsWith(marker.slice(0, length))) return length;
    return 0;
  };
  const deferPartialSequence = (delayMs = 40) => {
    if (specialTimer !== undefined) clearTimeout(specialTimer);
    specialTimer = setTimeout(() => {
      specialTimer = undefined;
      const pending = buffer;
      buffer = "";
      if (pending) keyInput.write(pending);
    }, delayMs);
  };
  const feed = (text: string) => {
    if (!text) return;
    if (specialTimer !== undefined) {
      clearTimeout(specialTimer);
      specialTimer = undefined;
    }
    buffer += text;
    while (buffer) {
      if (inPaste) {
        const end = buffer.indexOf(PASTE_END);
        if (end >= 0) {
          paste += buffer.slice(0, end);
          onPaste?.(paste);
          paste = "";
          buffer = buffer.slice(end + PASTE_END.length);
          inPaste = false;
          continue;
        }
        const safe = buffer.length - trailingPrefixLength(buffer, PASTE_END);
        paste += buffer.slice(0, safe);
        buffer = buffer.slice(safe);
        return;
      }
      const pasteStart = buffer.indexOf(PASTE_START);
      const mouseStart = buffer.indexOf(MOUSE_START);
      const cellPixelStart = buffer.indexOf(CELL_PIXEL_REPLY_START);
      const specialStart =
        pasteStart < 0
          ? mouseStart < 0
            ? cellPixelStart
            : cellPixelStart < 0
              ? mouseStart
              : Math.min(mouseStart, cellPixelStart)
          : mouseStart < 0
            ? cellPixelStart < 0
              ? pasteStart
              : Math.min(pasteStart, cellPixelStart)
            : cellPixelStart < 0
              ? Math.min(pasteStart, mouseStart)
              : Math.min(pasteStart, mouseStart, cellPixelStart);
      if (specialStart < 0) {
        const trailing = Math.max(
          trailingPrefixLength(buffer, PASTE_START),
          trailingPrefixLength(buffer, MOUSE_START),
          trailingPrefixLength(buffer, CELL_PIXEL_REPLY_START),
        );
        const safe = buffer.length - trailing;
        if (safe) keyInput.write(buffer.slice(0, safe));
        buffer = buffer.slice(safe);
        if (buffer) deferPartialSequence(pendingCellPixelQuery ? 100 : 40);
        return;
      }
      if (specialStart > 0) {
        keyInput.write(buffer.slice(0, specialStart));
        buffer = buffer.slice(specialStart);
        continue;
      }
      if (pasteStart === 0) {
        buffer = buffer.slice(PASTE_START.length);
        inPaste = true;
        continue;
      }
      if (cellPixelStart === 0) {
        const reply = /^\x1b\[6;(\d+);(\d+)t/.exec(buffer);
        if (reply) {
          const height = Number(reply[1]);
          const width = Number(reply[2]);
          finishCellPixelQuery(
            Number.isSafeInteger(height) &&
              Number.isSafeInteger(width) &&
              height > 0 &&
              width > 0
              ? { height, width }
              : undefined,
          );
          buffer = buffer.slice(reply[0].length);
          continue;
        }
        if (/^\x1b\[6;\d*(?:;\d*)?$/.test(buffer)) {
          deferPartialSequence(100);
          return;
        }
      }
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([mM])/.exec(buffer);
      if (mouse) {
        const button = Number(mouse[1]);
        onMouse?.({
          button,
          x: Number(mouse[2]),
          y: Number(mouse[3]),
          pressed: mouse[4] === "M",
          motion: (button & 32) !== 0,
        });
        buffer = buffer.slice(mouse[0].length);
        continue;
      }
      if (/^\x1b\[<\d*(?:;\d*){0,2}$/.test(buffer)) {
        deferPartialSequence();
        return;
      }
      keyInput.write(buffer[0]!);
      buffer = buffer.slice(1);
    }
  };
  const onData = (chunk: Buffer | string) => feed(decoder.write(chunk));
  let onResize: (() => void) | undefined;
  const handleResize = () => onResize?.();
  const flushPendingFrame = () => {
    if (stopped || suspended || outputBlocked || pendingFrame === undefined)
      return;
    const latest = pendingFrame;
    pendingFrame = undefined;
    renderFrame(latest);
  };
  const handleDrain = () => {
    outputBlocked = false;
    onDrain = undefined;
    flushPendingFrame();
  };
  function renderFrame(frame: string) {
    if (stopped || suspended) return;
    const columns = output.columns ?? 80;
    const rows = output.rows ?? 24;
    if (
      previousFrameLines &&
      (previousColumns !== columns || previousRows !== rows)
    ) {
      // Treat a size change as a full cache miss. Erasing the whole screen
      // first creates a visible blank frame before the redraw. The next frame
      // rewrites every visible row; rows exposed by a later expansion are
      // rewritten on that resize too.
      previousFrame = undefined;
      previousFrameLines = undefined;
    }
    if (frame === previousFrame) return;
    const nextLines = frame.split("\n");
    const previousLines = previousFrameLines ?? [];
    const updates: string[] = [];
    const rowCount = Math.max(previousLines.length, nextLines.length);
    for (let row = 0; row < rowCount; row++) {
      const nextLine = nextLines[row] ?? "";
      if (nextLine === previousLines[row]) continue;
      updates.push(`\x1b[${row + 1};1H${nextLine}\x1b[K`);
    }
    previousFrameLines = nextLines;
    previousFrame = frame;
    previousColumns = columns;
    previousRows = rows;
    if (updates.length && !output.write(updates.join(""))) {
      outputBlocked = true;
      onDrain = handleDrain;
      output.once("drain", handleDrain);
    }
  }
  emitKeypressEvents(keyInput);
  keyInput.on("keypress", (value: string, key: Key) =>
    onKey?.(value || undefined, key),
  );
  output.on("resize", handleResize);

  const acquire = () => {
    if (stopped || !started || !suspended) return;
    input.setRawMode?.(true);
    input.resume();
    writeModes(true);
    displayDeferred = false;
    suspended = false;
    flushPendingFrame();
  };
  const release = () => {
    if (!started || suspended) return;
    input.pause();
    input.setRawMode?.(initialRaw);
    writeModes(false);
    suspended = true;
  };

  return {
    start(
      keyHandler: (value: string | undefined, key: Key) => void,
      pasteHandler: (value: string) => void,
      resizeHandler?: () => void,
      mouseHandler?: (event: WorkspaceMouseEvent) => void,
      options?: { readonly deferDisplay?: boolean },
    ) {
      if (started || stopped) return;
      started = true;
      onKey = keyHandler;
      onPaste = pasteHandler;
      onMouse = mouseHandler;
      onResize = resizeHandler;
      input.on("data", onData);
      input.setRawMode?.(true);
      input.resume();
      displayDeferred = options?.deferDisplay === true;
      suspended = displayDeferred;
      if (!displayDeferred) writeModes(true);
    },
    activate() {
      if (stopped || !started || !displayDeferred) return;
      writeModes(true);
      displayDeferred = false;
      suspended = false;
      flushPendingFrame();
    },
    render(frame: string) {
      if (stopped || suspended) return;
      if (outputBlocked) {
        pendingFrame = frame;
        return;
      }
      renderFrame(frame);
    },
    writeGraphics(sequence: string) {
      if (!started || stopped || suspended || !output.isTTY || !sequence)
        return false;
      return output.write(sequence);
    },
    measureCellPixels(timeoutMs = 160) {
      if (
        !started ||
        stopped ||
        (suspended && !displayDeferred) ||
        !input.isTTY ||
        !output.isTTY
      )
        return Promise.resolve(undefined);
      if (pendingCellPixelQuery) return pendingCellPixelQuery.promise;
      let resolveQuery!: (
        value: { height: number; width: number } | undefined,
      ) => void;
      const promise = new Promise<
        { height: number; width: number } | undefined
      >((resolve) => {
        resolveQuery = resolve;
      });
      const timer = setTimeout(
        () => finishCellPixelQuery(undefined),
        timeoutMs,
      );
      pendingCellPixelQuery = { promise, resolve: resolveQuery, timer };
      output.write("\x1b[16t");
      return promise;
    },
    invalidateDisplay() {
      previousFrame = undefined;
      previousFrameLines = undefined;
      previousColumns = undefined;
      previousRows = undefined;
    },
    suspend: release,
    resume: acquire,
    destroy() {
      if (stopped) return;
      if (specialTimer !== undefined) clearTimeout(specialTimer);
      finishCellPixelQuery(undefined);
      if (!suspended) writeModes(false);
      input.pause();
      input.setRawMode?.(initialRaw);
      suspended = true;
      input.off("data", onData);
      output.off("resize", handleResize);
      if (onDrain) output.off("drain", onDrain);
      onDrain = undefined;
      pendingFrame = undefined;
      outputBlocked = false;
      keyInput.removeAllListeners();
      keyInput.end();
      stopped = true;
      onKey = undefined;
      onPaste = undefined;
      onMouse = undefined;
      onResize = undefined;
    },
    get columns() {
      return output.columns ?? 80;
    },
    get rows() {
      return output.rows ?? 24;
    },
  };
}
