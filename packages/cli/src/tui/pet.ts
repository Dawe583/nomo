import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { envValue } from "../../../ledger/src/env-compat.ts";
import { dataDir } from "../../../ledger/src/paths.ts";
import { box, fit, pad, sanitizeText, visibleLength } from "./layout.ts";
import { SPINNER, type MotionContext } from "./motion.ts";
import { getSymbolSet, type SymbolPreset } from "./theme-config.ts";

// NIB, the animated NOMO pet.
//
// Four rules shape this module, and they are the same rules the rest of the
// frame follows. First, every pose is a pure function of a frame counter, so a
// paused frame is byte identical to the frame it froze on and NOMO_TUI_MOTION=0
// can freeze frame zero without degrading the sprite. Second, the sprite is
// plain text: no colour, no graphics protocol, no dependency. A monochrome
// terminal keeps the exact silhouette, and the state word is printed beside it,
// so motion never carries meaning that text does not already carry. Third, the
// state is read from the run state the status row already reads. Nothing here
// is inferred from elapsed time: a pet that starts "thinking" because a clock
// ticked would be the one animation in the product that lies. Fourth, the
// silhouette itself reports the phase of the run: a seated pet while the run
// has not produced anything, a working pet while it is producing output, and a
// closed card once the outcome is final.
//
// The glyph set is restricted to ASCII, U+2500-25FF (box drawing, block
// elements and geometric shapes) and U+2800-28FF (braille). U+2600-27BF is
// excluded because layout.ts counts those cells as two wide, which would make
// the sprite disagree with the width accounting that pads the header.
//
// The life layer follows the same rules as the silhouette. An ear twitch, a
// tail wag, an idle sleep mark and the work bounce are all pure functions of
// the frame counter and only ever write into a content row, so the pose and
// its outline stay put and reduced motion freezes a clean base frame. Two
// gestures read as posture rather than as a second blink: a waiting pet cocks
// its head to listen, and a finished pet sparkles once and then holds the
// settled frame. Both start from the frame zero pose, so a frozen frame and a
// snapshot taken after the gesture are the same bytes the pet always drew. The
// reaction and bubble read the state plus a real tool or provider name, never
// a clock, so the pet cannot narrate activity the run did not report.

export type PetState =
  | "idle"
  | "waiting"
  | "thinking"
  | "streaming"
  | "tool"
  | "approval"
  | "error"
  | "done"
  | "cancelled";

/** Sprite width in terminal cells. Every frame is exactly this wide. */
export const PET_WIDTH = 9;
/** Sprite height in rows. Every frame is exactly this tall. */
export const PET_HEIGHT = 5;
/** Rows a full perch needs: the sprite plus its caption row. */
export const PET_PERCH_ROWS = PET_HEIGHT + 1;
/** Cells the one-line mini pet needs: the mark, a gap and the longest word. */
export const PET_MINI_WIDTH = 3 + 1 + 7;
/** The dock mark. U+25A6 is one cell wide and reads without colour. */
export const PET_DOCK_MARK = "▦";
/** Cells the dock needs at its narrowest: the mark, a gap and "approve". */
export const PET_DOCK_MIN_WIDTH = 1 + 1 + 7;
/** The narrowest column count that still holds the three-row splash card. */
export const PET_SPLASH_MIN_WIDTH = 30;
/** Rows the splash card occupies. */
export const PET_SPLASH_ROWS = 3;
/** One border breathe step for a pending approval. */
export const PET_APPROVAL_BREATHE_MS = 1200;
/** The narrowest column count that still holds a speech bubble. */
export const PET_BUBBLE_MIN_WIDTH = 20;
/** Rows a speech bubble can occupy: the line, then its wrapped tail. */
export const PET_BUBBLE_ROWS = 2;
/** The longest reaction line, in cells. Longer facts are truncated. */
export const PET_REACTION_MAX_WIDTH = 40;

/** The motion tick the frame counter advances on. */
const TICK_MS = 100;
/** Ticks per approval breathe step: twelve ticks are the 1200 ms cadence. */
const BREATHE_TICKS = PET_APPROVAL_BREATHE_MS / TICK_MS;
/** Ticks a waiting face holds before it swaps. */
const WAITING_HOLD_TICKS = 5;
/** Ticks the tool mark holds before it swaps, and the typing cycle. */
const TOOL_HOLD_TICKS = 2;
const TOOL_CYCLE = TOOL_HOLD_TICKS * 2;
/** Steps in the streaming cycle: the star row and the bounce share it. */
const STREAMING_CYCLE = 7;
/** The bound on the atlas period scan. Every animating state repeats inside it. */
const PET_ATLAS_MAX_STEPS = 240;

/** The state words the caption prints. Text carries the meaning. */
const PET_WORD: Record<PetState, string> = {
  idle: "idle",
  waiting: "waiting",
  thinking: "thinking",
  streaming: "writing",
  tool: "tool",
  approval: "approval",
  error: "error",
  done: "done",
  cancelled: "cancelled",
};

/** The same words, shortened for the one-line mini and dock forms. */
const PET_SHORT: Record<PetState, string> = {
  idle: "idle",
  waiting: "wait",
  thinking: "think",
  streaming: "write",
  tool: "tool",
  approval: "approve",
  error: "error",
  done: "done",
  cancelled: "stop",
};

/**
 * States whose outcome is final and whose frame never changes again. They
 * render one frame and never animate.
 *
 * `done` is deliberately not here. It is final too, but it says so with one
 * short sparkle and then holds the settled frame, which is the only way a
 * completion can be marked without a row and without a colour. `error` and
 * `cancelled` stay still: a refusal that keeps moving reads as an alarm.
 */
const STATIC: ReadonlySet<PetState> = new Set<PetState>(["error", "cancelled"]);

/**
 * The three silhouettes. Each pose is a separate shape on the same 9x5 grid,
 * so a screenshot without any text still shows whether the run has started
 * producing, is producing, or has finished.
 *
 * - sit: rounded, narrow body with two legs meeting at the floor.
 * - work: square, full width body standing on two straight legs.
 * - report: closed card with no legs, resting on a shadow line.
 */
export type PetPoseKind = "sit" | "work" | "report";

/** The pose a state is drawn in. */
export function petPoseKind(state: PetState): PetPoseKind {
  switch (state) {
    case "idle":
    case "waiting":
    case "thinking":
      return "sit";
    case "streaming":
    case "tool":
    case "approval":
      return "work";
    case "done":
    case "error":
    case "cancelled":
      return "report";
  }
}

/**
 * The run signals the pet is allowed to read.
 *
 * Every field already exists in the chat model. `approval` is the pending hold
 * for this session, `status` is the session status the workbench reports,
 * `lastEventType` and `lastEventKind` are the last visible session event, and
 * `toolCallsPresent` is the flag a completed message carries when the model
 * asked for tools. There is no clock here on purpose.
 */
export interface PetSignal {
  /** A pending approval hold belongs to this session. */
  readonly approval?: boolean;
  /** The session status string from the workbench view. */
  readonly status?: string;
  /** `kind` of the last visible session event. */
  readonly lastEventKind?: string;
  /** `type` of the last visible session event. */
  readonly lastEventType?: string;
  /** True when a completed message asked for tool calls. */
  readonly toolCallsPresent?: boolean;
  /** True when the last event reported a run error. */
  readonly error?: boolean;
}

/** A state plus the signal that decided it. The card prints this verbatim. */
interface PetDecision {
  readonly state: PetState;
  /** The observed signal that decided the state. Never a clock reading. */
  readonly evidence: string;
}

/**
 * Map the existing run signals to one pet state and the evidence for it.
 *
 * The priority is fixed by the design audit: approval, tool, streaming,
 * thinking, waiting, terminal, idle. Approval wins because a human decision is
 * the only thing that unblocks the run. Tool and streaming win over thinking
 * because they are observed output, not a prediction. Terminal states come
 * after waiting because a status that still reports an active run is not yet
 * final.
 *
 * "thinking" is only claimed when a turn is in flight and the model has
 * produced nothing yet: the last visible event is the user prompt itself, or
 * there is no visible event at all. It is never claimed from elapsed time, and
 * never when the session is idle.
 */
function petDecision(signal: PetSignal): PetDecision {
  const status = signal.status ?? "idle";
  const type = signal.lastEventType;
  const kind = signal.lastEventKind;
  const running = status === "running";
  if (signal.approval === true)
    return { state: "approval", evidence: "approval pending" };
  if (type === "tool.started")
    return { state: "tool", evidence: "event=tool.started" };
  if (type === "tool.result")
    return { state: "tool", evidence: "event=tool.result" };
  if (type === "message.completed" && signal.toolCallsPresent === true)
    return {
      state: "tool",
      evidence: "event=message.completed asked for tools",
    };
  if (type === "message.delta")
    return { state: "streaming", evidence: "event=message.delta" };
  if (running && type === undefined)
    return { state: "thinking", evidence: "status=running before any output" };
  if (running && type === "run.status")
    return { state: "thinking", evidence: "status=running at run start" };
  if (running && kind === "user")
    return { state: "thinking", evidence: "status=running after the prompt" };
  if (status === "queued")
    return { state: "waiting", evidence: "status=queued" };
  if (status === "paused")
    return { state: "waiting", evidence: "status=paused" };
  // A run that is still active but whose last visible step is already settled
  // has nothing in flight to report, so it waits rather than looking busy.
  if (running)
    return {
      state: "waiting",
      evidence: "status=running with nothing in flight",
    };
  if (signal.error === true)
    return { state: "error", evidence: "the last event reported an error" };
  if (type === "run.error")
    return { state: "error", evidence: "event=run.error" };
  if (status === "failed") return { state: "error", evidence: "status=failed" };
  if (status === "cancelled")
    return { state: "cancelled", evidence: "status=cancelled" };
  // An unconfirmed outcome is never reported as done: the runs panel asks for
  // reconciliation, and a pet that celebrated an unverified result would
  // contradict it.
  if (status === "unknown")
    return { state: "idle", evidence: "status=unknown" };
  if (type === "message.completed")
    return { state: "done", evidence: "event=message.completed" };
  if (type === "tool.result")
    return { state: "done", evidence: "event=tool.result" };
  return { state: "idle", evidence: "no run signal" };
}

/** The state alone, for the header, the dock and the mini form. */
export function petStateFrom(signal: PetSignal): PetState {
  return petDecision(signal).state;
}

interface PetGlyphs {
  readonly tl: string;
  readonly tr: string;
  readonly bl: string;
  readonly br: string;
  readonly h: string;
  readonly v: string;
  readonly tee: string;
  readonly mark: string;
}

/** The sprite outline comes from the active symbol set, so the ASCII preset
 * renders an ASCII pet and every other preset keeps its own corners. */
function petGlyphs(preset: SymbolPreset): PetGlyphs {
  const symbols = getSymbolSet(preset);
  return {
    tl: symbols.frame.tl,
    tr: symbols.frame.tr,
    bl: symbols.frame.bl,
    br: symbols.frame.br,
    h: symbols.frame.h,
    v: symbols.frame.v,
    tee: symbols.frame.teeT,
    mark: `${symbols.brand.halfBottom}${symbols.brand.full}${symbols.brand.halfBottom}`,
  };
}

/**
 * The spinner used for the thinking face.
 *
 * The nerd preset's spinner glyphs are private use code points, outside the
 * whitelist above, so only the ASCII preset uses its own spinner and every
 * other preset reuses the braille spinner motion.ts already ships.
 */
function petSpinner(preset: SymbolPreset): readonly string[] {
  return preset === "ascii" ? getSymbolSet("ascii").spinner : SPINNER;
}

/**
 * The five-row silhouettes.
 *
 * Tokens: 1 to 4 are the four corners, ~ is the horizontal edge, : the
 * vertical edge, 5 a tee that carries a leg, and @ a content slot. Nothing
 * else in a template is a token, so the shapes stay readable in source.
 */
const POSE_ROWS: Record<PetPoseKind, readonly string[]> = {
  sit: [" 1~~~~~2 ", " :@@@@@: ", " :@@@@@: ", " 3~5~5~4 ", "   3~4   "],
  work: ["1~~~~~~~2", ":@@@@@@@:", ":@@@@@@@:", "3~5~~~5~4", "  :   :  "],
  report: [" 1~~~~~2 ", " :@@@@@: ", " :@@@@@: ", " 3~~~~~4 ", "  ~~~~~  "],
};

/** Expand one template row. `horizontal` lets the border breathe. */
function expandRow(
  template: string,
  glyphs: PetGlyphs,
  horizontal: string,
): string {
  let row = "";
  for (const token of template) {
    if (token === "1") row += glyphs.tl;
    else if (token === "2") row += glyphs.tr;
    else if (token === "3") row += glyphs.bl;
    else if (token === "4") row += glyphs.br;
    else if (token === "5") row += glyphs.tee;
    else if (token === "~") row += horizontal;
    else if (token === ":") row += glyphs.v;
    else row += token;
  }
  return row;
}

/** Replace the run of `@` in a row with content of exactly that width. */
function fillSlot(row: string, content: string): string {
  const start = row.indexOf("@");
  if (start < 0) return row;
  let end = start;
  while (row[end] === "@") end += 1;
  const width = end - start;
  return `${row.slice(0, start)}${pad(fit(content, width), width)}${row.slice(end)}`;
}

/** The idle blink: open, open, closed, open. Four steps at the idle cadence. */
const BLINK = [" o o ", " o o ", " - - ", " o o "] as const;
/**
 * Idle blink rhythm over 24 frames: a single blink at 3 and 9, then a double
 * blink at 15 and 16, so the pet does not look like a metronome. The closed
 * frame is the same one the old cycle printed, so the pose is unchanged and
 * only its timing differs.
 */
const IDLE_RHYTHM = 24;
const IDLE_CLOSED = new Set([3, 9, 15, 16]);

/** The four border weights of the approval breathe. */
const BREATHE = ["light", "heavy", "heavy", "light"] as const;

/** The weight a pending approval's border holds at this step. */
function breatheWeight(step: number): "light" | "heavy" {
  const phase = Math.floor(step / BREATHE_TICKS) % BREATHE.length;
  return BREATHE[phase] ?? "light";
}

/** The heavier horizontal rule. ASCII keeps a double line instead. */
function heavyHorizontal(preset: SymbolPreset): string {
  return preset === "ascii" ? "=" : "━";
}

/** A travelling dot, for the writing face. */
function travel(position: number, width: number): string {
  const cells = Array.from({ length: width }, () => ".");
  const index = ((position % width) + width) % width;
  cells[index] = "*";
  return cells.join("");
}

/**
 * The idle sleep window: four steps of a twenty-four step cycle.
 *
 * Idle steps advance at four per second, so the pet dozes for about a second
 * every six. The window is expressed in steps, never in wall clock time, so a
 * frozen frame still shows whichever part of the cycle it froze on.
 */
const IDLE_SLEEP_CYCLE = 24;
const IDLE_SLEEP_FIRST = 16;
const IDLE_SLEEP_LAST = 19;

/** True while an idle pet is in its sleep window. */
function idleSleeping(state: PetState, step: number): boolean {
  if (state !== "idle") return false;
  const phase = ((step % IDLE_SLEEP_CYCLE) + IDLE_SLEEP_CYCLE) % IDLE_SLEEP_CYCLE;
  return phase >= IDLE_SLEEP_FIRST && phase <= IDLE_SLEEP_LAST;
}

/**
 * The listening window: four steps in every twenty of the waiting cycle.
 *
 * A waiting pet already swaps its eyes every five ticks, and on its own that
 * is only a slow blink. The listening window is a second, slower beat: the pet
 * cocks its head - the near ear lifts and the mouth slides one cell off centre
 * - and it holds its tail still, because a pet that is listening to you stops
 * wagging. Twenty steps is two eye beats, so the two rhythms drift against
 * each other instead of locking into one gesture, and twenty is a multiple of
 * the ear and tail periods, so the seated atlas period stays forty.
 */
const LISTEN_CYCLE = 20;
const LISTEN_FIRST = 12;
const LISTEN_LAST = 15;

/** True while a waiting pet is holding the listening posture. */
function listening(state: PetState, step: number): boolean {
  if (state !== "waiting") return false;
  const phase = ((step % LISTEN_CYCLE) + LISTEN_CYCLE) % LISTEN_CYCLE;
  return phase >= LISTEN_FIRST && phase <= LISTEN_LAST;
}

/** Ear twitch: one step in eight, at the left edge of a seated body. */
function earTwitch(step: number): boolean {
  return step % 8 === 3;
}

/** Tail wag: every other step, starting still so frame zero is the base. */
function tailWag(step: number): boolean {
  return Math.floor(step / 2) % 2 === 1;
}

/**
 * The done flourish: three frames of a sparkle that settles back onto the
 * mouth, then the held final pose for the rest of the cycle.
 *
 * Frame zero is the settled pose on purpose. That is the frame reduced motion
 * freezes, the frame a snapshot already contains and the frame the atlas
 * starts on, so the flourish can only ever add life: it never changes the
 * result the run reported. The cycle is forty steps, four seconds at the
 * motion tick, because a finished run has to read as finished. The pet
 * sparkles once and then holds still until the sparkle comes round again,
 * rather than looping a celebration over a result that is already final.
 */
const DONE_CYCLE = 40;
const DONE_FLOURISH: readonly string[] = [" *_* ", "  *  ", "  .  "];

/** The sparkle frame of the done flourish, or null for the held final pose. */
function doneFlourish(step: number): string | null {
  const phase = ((step % DONE_CYCLE) + DONE_CYCLE) % DONE_CYCLE;
  if (phase === 0) return null;
  return DONE_FLOURISH[phase - 1] ?? null;
}

/**
 * Work bounce: the hands lift for the last two steps of the cycle.
 *
 * Streaming keeps a seven step cycle because the star row it shares the pose
 * with repeats every seven steps, so frame seven is frame zero again. Tool
 * uses four, which matches its two step typing cadence. Approval is excluded:
 * its ! hold and border breathe already carry the pending decision.
 */
function workBounce(state: PetState, step: number): boolean {
  if (state !== "streaming" && state !== "tool") return false;
  const cycle = state === "streaming" ? STREAMING_CYCLE : TOOL_CYCLE;
  return step % cycle >= cycle - 2;
}

/** Replace one cell without changing the row width. */
function withCell(row: string, index: number, glyph: string): string {
  const cells = [...row];
  if (index < 0 || index >= cells.length) return row;
  cells[index] = glyph;
  return cells.join("");
}

/** Center a short mark inside the content slot. */
function centered(text: string, width: number): string {
  const fitted = fit(text, width);
  const left = Math.max(0, Math.floor((width - visibleLength(fitted)) / 2));
  return pad(`${" ".repeat(left)}${fitted}`, width);
}

/** The width of the @ run in a pose template. */
function slotWidth(template: string): number {
  const start = template.indexOf("@");
  if (start < 0) return 0;
  let end = start;
  while (template[end] === "@") end += 1;
  return end - start;
}

/**
 * The listening posture, drawn in the body row of a seated pet.
 *
 * The near ear lifts at the left edge and the mouth moves one cell off centre,
 * so the head reads as cocked rather than as blinking: the eyes above it keep
 * their own o/O beat and are not touched. The tail is deliberately absent -
 * an attentive pet stops wagging - which is what separates this held posture
 * from the one-step ear twitch that shares the same ear.
 */
function listeningBody(width: number): string {
  return pad(fit("^  _", width), width);
}

/**
 * The seated body row. The mouth stays where it was; an ear twitches at the
 * left edge and the tail wags at the right edge. Sleep replaces both with a
 * single z, so a sleeping pet never looks busy.
 */
function sitBody(state: PetState, step: number, width: number): string {
  if (idleSleeping(state, step)) return centered("z", width);
  if (listening(state, step)) return listeningBody(width);
  let row = pad(fit(bodyRow(state, step), width), width);
  if (earTwitch(step)) row = withCell(row, 0, "^");
  if (tailWag(step)) row = withCell(row, width - 1, "~");
  return row;
}

/**
 * The working face row. The hands lift on the bounce steps; every other state
 * keeps the face it already had, and approval keeps its ! hold untouched.
 */
function workFace(
  state: PetState,
  step: number,
  preset: SymbolPreset,
  width: number,
): string {
  const base = pad(fit(eyesRow(state, step, preset), width), width);
  if (!workBounce(state, step)) return base;
  return centered("^   ^", width);
}

/** The upper content row: eyes, a spinner or a travelling pair of brackets. */
function eyesRow(
  state: PetState,
  step: number,
  preset: SymbolPreset,
  sleeping = false,
): string {
  switch (state) {
    case "idle":
      // A sleeping pet holds the same closed-eye frame the blink already
      // prints, so the body mark carries the sleep rather than a new face.
      if (sleeping) return " - - ";
      if (IDLE_CLOSED.has(step % IDLE_RHYTHM)) return " - - ";
      return BLINK[0];
    case "waiting":
      // Two steps, held for five ticks each so waiting reads as calm.
      return Math.floor(step / WAITING_HOLD_TICKS) % 2 === 0 ? " o o " : " O O ";
    case "thinking": {
      // Ten braille frames on every preset that can print braille. The ASCII
      // preset keeps its own four frame spinner, which is the only spinner
      // that stays inside ASCII.
      const frames = petSpinner(preset);
      const glyph = frames[step % frames.length] ?? frames[0]!;
      return ` ${glyph} . `;
    }
    case "streaming":
      return " >   < ";
    case "tool":
      return " =   = ";
    case "approval":
      return " !   ! ";
    case "done":
      return " + + ";
    case "error":
      return " x x ";
    case "cancelled":
      return " - - ";
  }
}

/** The lower content row: the mouth, the typing hands or the travelling star. */
function bodyRow(state: PetState, step: number): string {
  switch (state) {
    case "idle":
      return "  .  ";
    case "waiting":
      return "  _  ";
    case "thinking":
      return "  .  ";
    case "streaming":
      // Seven cells, one lit cell, moving right once per tick.
      return travel(step, STREAMING_CYCLE);
    case "tool":
      // Two steps: typing, then the tool mark.
      return Math.floor(step / TOOL_HOLD_TICKS) % 2 === 0 ? "  ===  " : "  ###  ";
    case "approval":
      return "   !   ";
    case "done":
      // The sparkle of the completion flourish, or the settled smile. The
      // held frame is the one the pet drew before the flourish existed.
      return doneFlourish(step) ?? "  _  ";
    case "error":
      return "  !  ";
    case "cancelled":
      return "  -  ";
  }
}

/**
 * The five rows of one pose. Each is exactly PET_WIDTH cells wide.
 *
 * The life layer only ever writes into a content row: the silhouette rows are
 * left to the pose, which is what keeps a seated pet seated and a closed card
 * closed while the ear, tail, sleep mark or bounce animates inside it.
 */
function poseRows(
  state: PetState,
  step: number,
  preset: SymbolPreset,
  pose: PetPoseKind,
): readonly string[] {
  const glyphs = petGlyphs(preset);
  const templates = POSE_ROWS[pose];
  const contentWidth = slotWidth(templates[1]!);
  const border =
    state === "approval" && breatheWeight(step) === "heavy"
      ? heavyHorizontal(preset)
      : glyphs.h;
  return templates.map((template, index) => {
    const row = expandRow(
      template,
      glyphs,
      index === 0 || index === 3 ? border : glyphs.h,
    );
    if (index === 1) {
      const content =
        pose === "work"
          ? workFace(state, step, preset, contentWidth)
          : eyesRow(
              state,
              step,
              preset,
              pose === "sit" && idleSleeping(state, step),
            );
      return fillSlot(row, content);
    }
    if (index === 2) {
      const content =
        pose === "sit"
          ? sitBody(state, step, contentWidth)
          : bodyRow(state, step);
      return fillSlot(row, content);
    }
    return row;
  });
}

/**
 * The step a state animates on.
 *
 * The motion tick is 100 ms, so active states advance once per tick. Idle
 * breathes at 4 fps, which is two steps in every five ticks. Approval keeps
 * one step per tick and derives its slower border breathe from that step, so
 * the dot and the border never share a cadence by accident.
 */
function stepFor(state: PetState, frame: number): number {
  return state === "idle" ? Math.floor((frame * 2) / 5) : frame;
}

export interface PetPose {
  readonly state: PetState;
  /** The silhouette this state is drawn in. */
  readonly pose: PetPoseKind;
  /** The animation step within this state's cadence. Zero when frozen. */
  readonly step: number;
  /** True when this pose changes between frames. */
  readonly moving: boolean;
  /** Exactly PET_HEIGHT rows of PET_WIDTH cells each. */
  readonly rows: readonly string[];
}

/**
 * The sprite for one state at one frame.
 *
 * A frozen or reduced motion context returns step zero for every frame, so the
 * bytes are identical whatever the counter says. `error` and `cancelled` are
 * static even with motion on: a refusal that keeps moving reads as an alarm.
 * `done` moves, but only through its one flourish, and then holds the same
 * frame it started from, so the outcome still reads as finished.
 *
 * `pose` defaults to the state's own pose. The override exists so a caller can
 * preview any state in any silhouette; every combination keeps the same frame
 * purity and 9x5 bounds contract.
 */
export function petPose(
  state: PetState,
  frame: number,
  motion: MotionContext,
  preset: SymbolPreset = "unicode",
  pose: PetPoseKind = petPoseKind(state),
): PetPose {
  const moving = motion.enabled && !motion.reduced && !STATIC.has(state);
  const base = Number.isFinite(frame) ? Math.max(0, Math.floor(frame)) : 0;
  const step = moving ? stepFor(state, base) : 0;
  return {
    state,
    pose,
    step,
    moving,
    rows: poseRows(state, step, preset, pose),
  };
}

function rightAlign(text: string, width: number): string {
  return `${" ".repeat(Math.max(0, width - visibleLength(text)))}${text}`;
}

/**
 * How many frames one full animation cycle of `state` in `pose` produces.
 *
 * The period is measured rather than declared: it is the smallest step count
 * after which the whole sequence repeats, checked against every frame in the
 * window and not just against frame zero. That distinction matters because a
 * state cycle and the seated pose's ear and tail layer share the same counter,
 * so the combined period is the least common multiple of the two rather than
 * either one, and some individual steps repeat by coincidence. Measuring it
 * from the same renderer the text path uses means the atlas cannot drift from
 * the ASCII frames, and a state that never moves reports one frame.
 *
 * `done` reports its flourish cycle rather than one frame: the flourish is
 * part of what the text path draws, so an atlas that held a single frame would
 * be the one place the two disagree. Its cycle is measured like any other, and
 * its first frame is still the settled pose the text path holds afterwards.
 *
 * The scan is bounded, and the bound is a guard on work rather than a second
 * cadence: every animating state in this module repeats well inside it.
 */
export function petAtlasFrameCount(
  state: PetState,
  pose: PetPoseKind = petPoseKind(state),
  preset: SymbolPreset = "unicode",
): number {
  if (STATIC.has(state)) return 1;
  const frames = Array.from({ length: PET_ATLAS_MAX_STEPS }, (_, step) =>
    poseRows(state, step, preset, pose).join("\n"),
  );
  const window = Math.floor(frames.length / 2);
  for (let period = 1; period <= window; period += 1) {
    let repeats = true;
    for (let index = 0; index < frames.length - period; index += 1) {
      if (frames[index] !== frames[index + period]) {
        repeats = false;
        break;
      }
    }
    if (repeats) return period;
  }
  return PET_ATLAS_MAX_STEPS;
}

/**
 * The ordered frames of one animation cycle, for an image sprite sheet.
 *
 * Each frame is the same PET_HEIGHT rows of PET_WIDTH cells the ASCII renderer
 * draws, in cycle order, so an atlas consumer indexes by animation step and
 * gets exactly the sprite the text path shows at that step. The frames are
 * preset specific because the glyphs are and pose specific because the
 * silhouette is.
 *
 * This is groundwork, not a second renderer: the ASCII path still draws from
 * `petPose`, and nothing here reads a clock, a terminal capability or a file.
 */
export function petAtlasFrames(
  state: PetState,
  pose: PetPoseKind,
  preset: SymbolPreset = "unicode",
): readonly (readonly string[])[] {
  const count = petAtlasFrameCount(state, pose, preset);
  return Array.from({ length: count }, (_, step) =>
    poseRows(state, step, preset, pose),
  );
}

/**
 * The caption. The full word is used when the block is wide enough, the short
 * word otherwise, and it is always present: the sprite never carries the state
 * on its own.
 */
export function petCaption(state: PetState, width: number): string {
  const long = `NIB ${PET_WORD[state]}`;
  if (visibleLength(long) <= width) return long;
  const short = `NIB ${PET_SHORT[state]}`;
  if (visibleLength(short) <= width) return short;
  return fit(short, Math.max(1, Math.floor(width)));
}

/**
 * The full perch block: five sprite rows and one caption row, each right
 * aligned to `width` cells.
 *
 * `width` is the number of columns the caller reserved at the right edge of the
 * header, not the terminal width. It is clamped to PET_WIDTH so the sprite is
 * never truncated; a caller with less room than that hides the pet instead.
 */
export function renderPetRows(
  state: PetState,
  width: number,
  motion: MotionContext,
  preset: SymbolPreset = "unicode",
): string[] {
  const block = Math.max(
    PET_WIDTH,
    Number.isFinite(width) ? Math.floor(width) : PET_WIDTH,
  );
  const pose = petPose(state, motion.frame, motion, preset);
  return [
    ...pose.rows.map((row) => rightAlign(row, block)),
    rightAlign(petCaption(state, block), block),
  ];
}

/** The one-line mini form: the brand mark and the short state word. */
export function renderPetMini(
  state: PetState,
  preset: SymbolPreset = "unicode",
): string {
  return `${petGlyphs(preset).mark} ${PET_SHORT[state]}`;
}

/**
 * The one-line dock form: the dock mark and the state word, right aligned.
 *
 * Exactly one row and never more. The word is the same one the caption
 * prints, so the dock, the mini form and the perch can never disagree about
 * what the run is doing. The function returns null rather than clipping when
 * the width cannot hold the mark, a gap and the shortest word for the state.
 *
 * `motion` is accepted so every renderer in the frame takes the same context,
 * and is deliberately not used: a single line sharing a row with real status
 * text must not flicker, and the word already carries the state.
 */
export function renderPetDock(
  state: PetState,
  width: number,
  _motion: MotionContext,
): string | null {
  const columns = Number.isFinite(width) ? Math.floor(width) : 0;
  if (columns < PET_DOCK_MIN_WIDTH) return null;
  const long = `${PET_DOCK_MARK} ${PET_WORD[state]}`;
  const text =
    visibleLength(long) <= columns
      ? long
      : `${PET_DOCK_MARK} ${PET_SHORT[state]}`;
  if (visibleLength(text) > columns) return null;
  return rightAlign(text, columns);
}

/**
 * The run facts a reaction may read, besides the state itself.
 *
 * Both are observed values, not estimates: `tool` is the name a real tool
 * event carried and `provider` is the configured provider name. There is no
 * clock, no heartbeat and no elapsed time here, so a reaction cannot claim
 * activity that the run did not report.
 */
export interface PetContext {
  /** The tool name from a real tool event, for example "read parser". */
  readonly tool?: string;
  /** The provider name from the session configuration. */
  readonly provider?: string;
}

/** The verbs a known tool name maps to. Unknown tools read as "using". */
const TOOL_VERBS: Readonly<Record<string, string>> = {
  read: "reading",
  edit: "editing",
  write: "editing",
  bash: "running",
  shell: "running",
  grep: "searching",
  glob: "searching",
  search: "searching",
  webfetch: "fetching",
  websearch: "searching",
  task: "delegating",
};

/** A context fact, stripped of control characters and collapsed to one line. */
function cleanFact(value: string | undefined): string {
  if (value === undefined) return "";
  return sanitizeText(value).replace(/\s+/g, " ").trim();
}

/** Turn a tool name into a short truthful phrase. */
function toolReaction(tool: string): string {
  const parts = tool.split(" ");
  const head = parts[0] ?? "";
  const rest = parts.slice(1).join(" ");
  const verb = TOOL_VERBS[head.toLowerCase()] ?? "using";
  if (rest === "") return verb === "using" ? `using ${head}...` : `${verb}...`;
  return `${verb} ${rest}...`;
}

/**
 * One short line naming what the run is actually doing.
 *
 * The line is derived from the state and, when the caller has them, the real
 * tool and provider names. It never reports a finished outcome the state has
 * not reached and never reads a clock, so it can sit beside a live transcript
 * without contradicting it.
 */
export function petReaction(
  state: PetState,
  context: PetContext = {},
): string {
  const tool = cleanFact(context.tool);
  const provider = cleanFact(context.provider);
  let text = "idle";
  switch (state) {
    case "idle":
      text = "idle";
      break;
    case "waiting":
      text = "waiting to start";
      break;
    case "thinking":
      text =
        provider === "" ? "waiting for provider" : `waiting for ${provider}`;
      break;
    case "streaming":
      text = "writing...";
      break;
    case "tool":
      text = tool === "" ? "using a tool..." : toolReaction(tool);
      break;
    case "approval":
      text = "needs approval";
      break;
    case "error":
      text = "failed";
      break;
    case "done":
      text = "done";
      break;
    case "cancelled":
      text = "cancelled";
      break;
  }
  return fit(`NIB: ${text}`, PET_REACTION_MAX_WIDTH);
}

/**
 * Split a reaction into at most two lines that each fit `width` cells.
 *
 * Words are kept whole until the first line is full; the remainder is fitted
 * to the same width, so a very long tool name is truncated rather than allowed
 * to widen the bubble or push the composer off the frame.
 */
function wrapBubble(text: string, width: number): readonly string[] {
  if (visibleLength(text) <= width) return [text];
  const words = text.split(" ").filter((word) => word !== "");
  const first: string[] = [];
  let index = 0;
  while (index < words.length) {
    const candidate = [...first, words[index]!].join(" ");
    if (visibleLength(candidate) > width) break;
    first.push(words[index]!);
    index += 1;
  }
  if (first.length === 0) return [fit(text, width)];
  const rest = words.slice(index).join(" ");
  if (rest === "") return [first.join(" ")];
  return [first.join(" "), fit(rest, width)];
}

/**
 * The speech bubble: the reaction wrapped in parentheses, one or two rows.
 *
 * Each row is exactly `width` cells so the caller can reserve it without the
 * bubble ever reflowing the composer. Below PET_BUBBLE_MIN_WIDTH the bubble
 * returns null instead of squeezing the line or borrowing a row from the
 * input.
 */
export function renderPetBubble(
  state: PetState,
  context: PetContext = {},
  width: number,
): string[] | null {
  const columns = Number.isFinite(width) ? Math.floor(width) : 0;
  if (columns < PET_BUBBLE_MIN_WIDTH) return null;
  const inner = columns - 4;
  const lines = wrapBubble(petReaction(state, context), inner);
  return lines.map((line) => rightAlign(`( ${line} )`, columns));
}

/**
 * The keys the splash names. Every one of them exists in the workspace help,
 * so the card cannot promise a binding the product does not have.
 */
const PET_SPLASH_KEYS = "/help  /pet  /exit";

/** The ASCII brand mark, so the splash carries an identity without colour. */
const PET_SPLASH_MARK = `${getSymbolSet("ascii").brand.halfBottom}${getSymbolSet("ascii").brand.full}${getSymbolSet("ascii").brand.halfBottom}`;

/**
 * The startup splash: a static three-row ASCII card naming the pet, its mark
 * and the keys that reach it.
 *
 * The card carries no telemetry: no clock, no counters, no usage figures and
 * no version numbers. It is drawn with the ASCII frame and mark so it renders
 * identically under every symbol preset, and it returns null below the width
 * where the title and the keys still fit on one line each.
 */
export function renderPetSplash(width: number): string[] | null {
  const columns = Number.isFinite(width) ? Math.floor(width) : 0;
  if (columns < PET_SPLASH_MIN_WIDTH) return null;
  return box(
    "NIB is awake",
    [`${PET_SPLASH_MARK}  ${PET_SPLASH_KEYS}`],
    columns,
    getSymbolSet("ascii").frame,
  );
}

/** One `key=value` per signal field that is actually present. */
function signalLine(signal: PetSignal): string {
  const parts: string[] = [];
  if (signal.approval !== undefined)
    parts.push(`approval=${signal.approval ? "yes" : "no"}`);
  if (signal.status !== undefined)
    parts.push(`status=${sanitizeText(signal.status)}`);
  if (signal.lastEventType !== undefined)
    parts.push(`event=${sanitizeText(signal.lastEventType)}`);
  if (signal.lastEventKind !== undefined)
    parts.push(`kind=${sanitizeText(signal.lastEventKind)}`);
  if (signal.toolCallsPresent !== undefined)
    parts.push(`tools=${signal.toolCallsPresent ? "yes" : "no"}`);
  if (signal.error !== undefined)
    parts.push(`error=${signal.error ? "yes" : "no"}`);
  return `signal: ${parts.length === 0 ? "none" : parts.join(" ")}`;
}

/**
 * The accessible text card for the pet.
 *
 * Two lines. The first lists only the signals that were actually supplied, so
 * a missing field reads as missing rather than as a negative observation. The
 * second names the drawn state and the signal that decided it. Neither line
 * carries a clock, a heartbeat, an elapsed time or a made up figure: the card
 * reports what the run said, and nothing else.
 */
export function petCardLines(state: PetState, signal: PetSignal): string[] {
  const decision = petDecision(signal);
  const shown = PET_WORD[state] ?? state;
  const reads =
    decision.state === state
      ? `reads: NIB ${shown} from ${decision.evidence}`
      : `reads: NIB ${shown} shown, signals read ${PET_WORD[decision.state]} from ${decision.evidence}`;
  return [signalLine(signal), reads];
}

export interface PetLayout {
  readonly kind: "hidden" | "mini" | "perch";
  /** Columns reserved at the right edge of the header. Zero when hidden. */
  readonly width: number;
}

const HIDDEN: PetLayout = { kind: "hidden", width: 0 };

/**
 * Where the pet can live without costing a row.
 *
 * A perch needs six header rows, so it only exists where the brand header
 * already draws six. The mini form needs one existing row. Either form is
 * dropped rather than allowed to overwrite the identity it shares a row with,
 * which is what keeps the logo, composer, transcript and the review keys
 * visible on a 40x12 terminal.
 */
export function petLayout(
  width: number,
  height: number,
  headerWidth: number,
  state: PetState,
  enabled = true,
): PetLayout {
  if (!enabled) return HIDDEN;
  const columns = Number.isFinite(width) ? Math.floor(width) : 0;
  const rows = Number.isFinite(height) ? Math.floor(height) : 0;
  const occupied = Number.isFinite(headerWidth)
    ? Math.max(0, Math.floor(headerWidth))
    : 0;
  const room = columns - occupied - 1;
  if (rows >= 22 && columns >= 64) {
    const caption = petCaption(state, Math.max(PET_WIDTH, room));
    const block = Math.min(room, Math.max(PET_WIDTH, visibleLength(caption)));
    if (block >= PET_WIDTH) return { kind: "perch", width: block };
  }
  if (room >= PET_MINI_WIDTH) return { kind: "mini", width: PET_MINI_WIDTH };
  return HIDDEN;
}

/**
 * Put the pet at the right edge of a header row.
 *
 * The header row keeps its left edge and is padded to the remaining columns, so
 * the pet can never truncate the brand, the tab or the key hints beside it.
 */
export function attachPetRow(row: string, pet: string, width: number): string {
  const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const petWidth = visibleLength(pet);
  const leftWidth = Math.max(0, columns - petWidth - 1);
  const left = pad(fit(row, leftWidth), leftWidth);
  return pad(`${left} ${pet}`, columns);
}

// ---------------------------------------------------------------------------
// Optional image mode
//
// ASCII is the pet. It is the only form every test renders, the only form that
// works on macOS Terminal.app, over ssh, and inside a multiplexer without an
// opt-in, and the only form that prints the state word. The image form below is
// a decoration the user has to ask for with NOMO_TUI_IMAGE=1, and it is refused
// unless the terminal advertises the Kitty graphics protocol, nothing is
// multiplexing the output (or the user declared passthrough), colour and motion
// are on, and the pet block has room. Every other answer is ASCII, never a
// half written escape.
//
// The image is a built-in PNG carried as a data URI, so no file, network call
// or dependency is involved. It is transferred once through the same Kitty
// channel the tab icons already use and placed with virtual placement, which
// means the frame still carries ordinary one-cell placeholders: the width
// accounting, the padding and the diffing renderer keep working unchanged.

/** The narrowest terminal that may carry the image form. */
export const PET_IMAGE_MIN_WIDTH = 20;
/** Cells the image occupies horizontally, matching the ASCII sprite. */
export const PET_IMAGE_COLUMNS = PET_WIDTH;
/** Rows the image occupies vertically, matching the ASCII sprite. */
export const PET_IMAGE_ROWS = PET_HEIGHT;
/** The fixed Kitty image id. 0x4e4942 is "NIB" in ASCII, so ids stay clear of
 * the tab icon ids the brand module allocates from the process id. */
export const PET_IMAGE_ID = 0x4e4942;
/**
 * The built-in 16x16 PNG: a coral NIB face with a transparent background, so it
 * never paints a rectangle over the user's own terminal background.
 */
export const PET_IMAGE_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAN0lEQVR42mNgwAP+F8T9B2EGcgHJBsA0EMI4NZNi0SA3AN2v2Pi0NWBwBCK+uB+kXqA4KQ8YAAC1cJyhSrLSswAAAABJRU5ErkJggg==";

/** A truthy environment flag, matching the capability probe's rule. */
function petEnvFlag(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0";
}

/** The terminal families the pet knows how to answer for. */
export type PetTerminalKind =
  | "ghostty"
  | "kitty"
  | "iterm2"
  | "terminal-app"
  | "tmux"
  | "screen"
  | "dumb"
  | "unknown";

/** Why the terminal was classified the way it was. Machine readable, and
 * printed by the tests rather than shown to a user. */
export type PetTerminalReason =
  | "ghostty-kitty"
  | "kitty-native"
  | "iterm2-no-kitty-graphics"
  | "terminal-app-no-graphics"
  | "multiplexer-needs-passthrough"
  | "dumb-terminal"
  | "unknown-terminal";

export interface PetTerminal {
  readonly kind: PetTerminalKind;
  /** The graphics protocol the terminal speaks. Only Kitty is ever used. */
  readonly protocol: "kitty" | "none";
  /** The multiplexer the output passes through, if any. */
  readonly multiplexer: "none" | "tmux" | "screen";
  /** True only when an image escape may be written to this terminal. */
  readonly graphics: boolean;
  readonly reason: PetTerminalReason;
}

/**
 * Classify the terminal from the environment.
 *
 * Ghostty, Kitty and anything advertising the Kitty protocol are the only
 * terminals that may receive an image. macOS Terminal.app has no graphics
 * protocol at all, iTerm2 has its own escape that this module deliberately does
 * not use, and a multiplexer forwards text rather than graphics unless the user
 * says passthrough is configured.
 */
export function detectPetTerminal(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): PetTerminal {
  const term = env.TERM ?? "";
  const program = env.TERM_PROGRAM ?? "";
  const multiplexer: PetTerminal["multiplexer"] = petEnvFlag(env.TMUX)
    ? "tmux"
    : env.STY === "screen" || term.startsWith("screen")
      ? "screen"
      : "none";
  const refused = (
    kind: PetTerminalKind,
    reason: PetTerminalReason,
  ): PetTerminal => ({
    kind,
    protocol: "none",
    multiplexer,
    graphics: false,
    reason,
  });
  if (term === "dumb") return refused("dumb", "dumb-terminal");
  if (multiplexer !== "none" && env.NOMO_TUI_IMAGE_PASSTHROUGH !== "1")
    return refused(multiplexer, "multiplexer-needs-passthrough");
  if (
    program === "ghostty" ||
    term === "xterm-ghostty" ||
    petEnvFlag(env.GHOSTTY_RESOURCES_DIR)
  )
    return {
      kind: "ghostty",
      protocol: "kitty",
      multiplexer,
      graphics: true,
      reason: "ghostty-kitty",
    };
  if (
    petEnvFlag(env.KITTY_WINDOW_ID) ||
    program === "kitty" ||
    term.includes("kitty")
  )
    return {
      kind: "kitty",
      protocol: "kitty",
      multiplexer,
      graphics: true,
      reason: "kitty-native",
    };
  if (
    program === "iTerm.app" ||
    petEnvFlag(env.ITERM_SESSION_ID) ||
    petEnvFlag(env.I_TERM_SESSION)
  )
    return refused("iterm2", "iterm2-no-kitty-graphics");
  if (program === "Apple_Terminal")
    return refused("terminal-app", "terminal-app-no-graphics");
  return refused("unknown", "unknown-terminal");
}

/** Why the image form is or is not allowed. */
export type PetImageReason =
  | "image-on"
  | "image-off"
  | "no-color"
  | "reduced-motion"
  | "unsupported-terminal"
  | "too-narrow";

export interface PetImageSupport {
  readonly available: boolean;
  readonly reason: PetImageReason;
  readonly terminal: PetTerminal;
}

/**
 * Whether the environment alone allows an image.
 *
 * The opt-in is exact: only NOMO_TUI_IMAGE=1 turns graphics on, so an inherited,
 * empty or half written value can never paint an escape. NO_COLOR wins over the
 * opt-in, because a user who asked for no colour did not ask for a picture.
 */
export function petImageSupport(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): PetImageSupport {
  const terminal = detectPetTerminal(env);
  const verdict = (reason: PetImageReason): PetImageSupport => ({
    available: reason === "image-on",
    reason,
    terminal,
  });
  if (env.NOMO_TUI_IMAGE !== "1") return verdict("image-off");
  if (petEnvFlag(env.NO_COLOR) && !petEnvFlag(env.FORCE_COLOR))
    return verdict("no-color");
  if (!terminal.graphics) return verdict("unsupported-terminal");
  return verdict("image-on");
}

/**
 * Kitty's placeholder code point. layout.ts counts it as one cell and the
 * combining marks below as zero, so a placeholder row measures exactly like the
 * ASCII sprite row it replaces.
 */
const PET_IMAGE_CELL = "\u{10eeee}";
/** The combining marks Kitty maps to row and column numbers 0-8. */
const PET_IMAGE_MARKS = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346,
] as const;

/** One placeholder row, carrying the image id in its foreground colour. */
function petImageRow(row: number): string {
  const colour = [
    (PET_IMAGE_ID >> 16) & 0xff,
    (PET_IMAGE_ID >> 8) & 0xff,
    PET_IMAGE_ID & 0xff,
  ].join(";");
  const rowMark = String.fromCodePoint(PET_IMAGE_MARKS[row] ?? PET_IMAGE_MARKS[0]);
  const cells = PET_IMAGE_MARKS.slice(0, PET_IMAGE_COLUMNS)
    .map((mark) => `${PET_IMAGE_CELL}${rowMark}${String.fromCodePoint(mark)}`)
    .join("");
  return `\x1b[38;2;${colour}m${cells}\x1b[39m`;
}

/**
 * The one-shot Kitty transfer for the built-in PNG.
 *
 * The payload is chunked at the protocol's 4096 byte limit and every chunk is
 * quiet (`q=2`), so the terminal never answers with a response this renderer
 * would have to read. `U=1` makes it a virtual placement, drawn only where the
 * placeholder rows put it.
 */
function petImageTransferEscape(terminal: PetTerminal): string {
  const payload = PET_IMAGE_DATA_URI.slice(PET_IMAGE_DATA_URI.indexOf(",") + 1);
  const chunks: string[] = [];
  for (let offset = 0; offset < payload.length; offset += 4096) {
    const chunk = payload.slice(offset, offset + 4096);
    const more = offset + 4096 < payload.length;
    const header =
      offset === 0
        ? `a=T,f=100,i=${PET_IMAGE_ID},U=1,c=${PET_IMAGE_COLUMNS},r=${PET_IMAGE_ROWS},q=2,m=${more ? 1 : 0}`
        : `m=${more ? 1 : 0},q=2`;
    chunks.push(`\x1b_G${header};${chunk}\x1b\\`);
  }
  const transfer = chunks.join("");
  if (terminal.multiplexer === "none") return transfer;
  // The passthrough opt-in is the user's statement that the multiplexer
  // forwards graphics, so wrap the escape the way that multiplexer forwards it
  // instead of guessing.
  return terminal.multiplexer === "tmux"
    ? `\x1bPtmux;${transfer.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`
    : `\x1bP${transfer}\x1b\\`;
}

/** The transfer the caller writes once, or "" when the image form is refused. */
export function petImageTransfer(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  const support = petImageSupport(env);
  return support.available ? petImageTransferEscape(support.terminal) : "";
}

/** The delete escape for the pet image, so a caller can clean up on exit. */
export function petImageCleanup(): string {
  return `\x1b_Ga=d,d=I,i=${PET_IMAGE_ID},q=2\x1b\\`;
}

export interface PetImagePlan extends PetImageSupport {
  /** Placeholder columns the image occupies. */
  readonly columns: number;
  /** Placeholder rows the image occupies. */
  readonly rows: number;
  /** The transfer escape, or "" when the plan is not available. */
  readonly transfer: string;
  /** PET_HEIGHT placeholder rows, or empty when the plan is not available. */
  readonly block: readonly string[];
}

/**
 * The full image verdict for one frame.
 *
 * `width` is the terminal column count, not the pet block: a nine-cell sprite
 * can sit on any terminal the perch already fits, and a narrow terminal that
 * cannot hold the image form falls back to ASCII without the caller having to
 * know the threshold. Reduced motion and a disabled motion context both fall
 * back, because the image is decoration and a user who asked for stillness
 * asked for the plain form.
 */
export function petImagePlan(
  env: Readonly<NodeJS.ProcessEnv>,
  width: number,
  motion: MotionContext,
): PetImagePlan {
  const support = petImageSupport(env);
  const columns = PET_IMAGE_COLUMNS;
  const rows = PET_IMAGE_ROWS;
  const refused = (reason: PetImageReason): PetImagePlan => ({
    ...support,
    available: false,
    reason,
    columns,
    rows,
    transfer: "",
    block: [],
  });
  if (!support.available) return refused(support.reason);
  if (!motion.enabled || motion.reduced) return refused("reduced-motion");
  const cells = Number.isFinite(width) ? Math.floor(width) : 0;
  if (cells < PET_IMAGE_MIN_WIDTH) return refused("too-narrow");
  return {
    ...support,
    columns,
    rows,
    transfer: petImageTransferEscape(support.terminal),
    block: Array.from({ length: rows }, (_, row) => petImageRow(row)),
  };
}

// ---------------------------------------------------------------------------
// Per-workspace display preference
//
// The pet is decoration, so the only thing worth remembering is where the
// operator put it: on or off, and in which spot. That choice is display state
// and nothing else, so it is a two field JSON file beside the TUI state the
// workspace store already keeps. No run state, no session id, no provider
// name, no token and no path is written, and every failure mode (missing file,
// unreadable file, torn write, a directory where the file belongs) falls back
// to the documented default instead of interrupting a session.

/**
 * Where NIB is asked to live.
 *
 * `auto` picks the composer dock where it fits and the header otherwise, so a
 * terminal never spends a row on the pet. `dock` and `perch` are explicit
 * requests that still fall back to the header form when the requested surface
 * is too small; `off` is the same display toggle as NOMO_TUI_PET=0.
 */
export type PetPlacement = "auto" | "dock" | "perch" | "off";

/** The display choice persisted for one workspace. */
export interface PetPreference {
  readonly enabled: boolean;
  readonly placement: PetPlacement;
}

/** The default the product ships: the pet is on, in the automatic spot. */
export const PET_DEFAULT_PREFERENCE: PetPreference = {
  enabled: true,
  placement: "auto",
};

/** The placements a saved file may name. Anything else is not a choice. */
const PET_PLACEMENTS: readonly PetPlacement[] = ["auto", "dock", "perch", "off"];

/**
 * The preference file for `env`, beside the TUI state it belongs to.
 *
 * The base directory follows the same resolution the TUI store uses, so a
 * machine that set NOMO_DATA_DIR or NOMO_LEDGER_DIR keeps one state tree
 * rather than a second one holding a stray pet file.
 */
export function petPreferencePath(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  const home = env.HOME ?? homedir();
  const base =
    envValue(env, "NOMO_DATA_DIR") ??
    join(envValue(env, "NOMO_LEDGER_DIR") ?? dataDir(home), "workbench");
  return join(base, "tui", "state", "pet.json");
}

/**
 * Validate one parsed value.
 *
 * A mistyped field falls back to its default rather than discarding the whole
 * record, and the two fields are normalized together: an off pet always reads
 * `off`, and an on pet is never placed at `off`. A file written by an older or
 * a hand edited build therefore cannot leave the renderer in a state the
 * toggle could not produce.
 */
export function petPreferenceFrom(value: unknown): PetPreference {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return PET_DEFAULT_PREFERENCE;
  const record = value as { enabled?: unknown; placement?: unknown };
  const enabled =
    typeof record.enabled === "boolean"
      ? record.enabled
      : PET_DEFAULT_PREFERENCE.enabled;
  const placement = PET_PLACEMENTS.includes(record.placement as PetPlacement)
    ? (record.placement as PetPlacement)
    : PET_DEFAULT_PREFERENCE.placement;
  if (!enabled) return { enabled: false, placement: "off" };
  return { enabled: true, placement: placement === "off" ? "auto" : placement };
}

/**
 * Read the saved choice, or the default.
 *
 * Every failure is the same answer on purpose: a session that cannot read a
 * decoration file must still start, and the default is the documented one.
 */
export function readPetPreference(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): PetPreference {
  try {
    return petPreferenceFrom(
      JSON.parse(readFileSync(petPreferencePath(env), "utf8")),
    );
  } catch {
    return PET_DEFAULT_PREFERENCE;
  }
}

/**
 * Save the choice for this workspace.
 *
 * The write is atomic (a temporary file renamed over the target) and private
 * (0700 directory, 0600 file), so a crash mid-write leaves the previous choice
 * intact rather than a half written file that would parse as corrupt. Returns
 * false when the choice could not be stored; the caller keeps the live choice
 * either way, because a display preference is never worth failing a session.
 */
export function writePetPreference(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  preference: PetPreference = PET_DEFAULT_PREFERENCE,
): boolean {
  const path = petPreferencePath(env);
  const temporary = `${path}.${process.pid}.tmp`;
  const record = { version: 1, ...petPreferenceFrom(preference) };
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, path);
    return true;
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file never landed, or already went with the rename.
    }
    return false;
  }
}
