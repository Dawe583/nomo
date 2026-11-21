/**
 * Operator schedules, from a terminal.
 *
 * A schedule is a prompt with a cadence and a run ceiling that the workbench
 * starts without a person watching. The interactive surface could not create
 * one and a script had no way in at all, so unattended work could only be
 * started by whoever wrote the workbench test.
 *
 * This command is an operator door, not a scheduler. It records, reads, pauses,
 * resumes and removes one record, and it asks for one due evaluation. The
 * bounds, the cadence arithmetic and the meaning of a settled firing belong to
 * `packages/workbench/src/schedules.ts`, and the firing itself belongs to
 * `Workbench.runDueSchedules`, which runs it through the same governed path a
 * person's run uses. Starting a run here would be a second answer to what the
 * operator allowed, and a second bound here would be a second answer to what
 * the workbench permits.
 *
 * Every refusal below happens before the workbench is opened, because opening
 * it writes a storage key and creates a workspace on a machine that has none.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../workbench/src/index.ts";
import type { ScheduleCadence } from "../../workbench/src/schedules.ts";
import { dataDir } from "../../ledger/src/paths.ts";

export type ScheduleIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};

/** A schedule as the workbench reports it. Only the fields this command prints
 * are named; a workbench that carries more prints the same lines. The prompt is
 * deliberately not one of them: it is prose the operator already typed, and a
 * listing that echoed it would put it in every scrollback and log a listing
 * passes through. */
export type ScheduleView = {
  readonly id: string;
  readonly name: string;
  readonly cadence: ScheduleCadence;
  /** `active`, `paused`, `completed`, `budget_limited` or `paused_unknown`
   * today. Kept open because the workbench owns the vocabulary. */
  readonly status: string;
  /** The operator's own switch, which is why it is printed beside the status
   * instead of folded into it: a record can be `active` and disabled at once. */
  readonly enabled: boolean;
  readonly maxRuns: number;
  readonly runCount: number;
  readonly tokensUsed?: number;
  readonly tokenBudget?: number;
  readonly nextRunAt: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly agent?: string;
  readonly createdAt?: string;
  readonly lastRunAt?: string;
  readonly lastSessionId?: string;
  readonly lastOutcome?: string;
};

/**
 * The record as the operator states it: the exact body
 * `parseScheduleInput` accepts, with no `id`, `status`, `runCount`,
 * `tokensUsed`, `createdAt` or `nextRunAt`. Those are the workbench's to mint,
 * and a body that could name its own next slot could start work nobody
 * approved. `enabled` is the one switch that is the operator's, so `--paused`
 * states it as `false`.
 */
export type ScheduleCreateInput = {
  readonly name: string;
  readonly prompt: string;
  readonly cadence: ScheduleCadence;
  readonly maxRuns: number;
  readonly enabled: boolean;
  readonly sessionId?: string;
  readonly model?: string;
  readonly agent?: string;
  readonly tokenBudget?: number;
};

/** One settled firing, as the workbench reports it. */
export type ScheduleFiring = {
  readonly scheduleId: string;
  readonly outcome: string;
  readonly sessionId?: string;
};

type MaybePromise<T> = T | Promise<T>;

/**
 * The part of the workbench this command uses. Narrow on purpose: the command
 * records, reads and asks for one due evaluation, and it never runs a session,
 * so a method that would start one is not on this surface at all.
 *
 * `listSchedules` is the reader named here. The design record spells it
 * `schedules()`, so both are read: the command and the workbench can land in
 * either order without this file naming a method the class lacks today.
 */
export type ScheduleSurface = {
  listSchedules?(): MaybePromise<readonly ScheduleView[]>;
  schedules?(): MaybePromise<readonly ScheduleView[]>;
  createSchedule?(input: ScheduleCreateInput): MaybePromise<ScheduleView>;
  pauseSchedule?(id: string): MaybePromise<ScheduleView>;
  resumeSchedule?(id: string): MaybePromise<ScheduleView>;
  deleteSchedule?(id: string): MaybePromise<boolean | void>;
  runDueSchedules?(nowMs?: number): MaybePromise<readonly ScheduleFiring[]>;
};

export type ScheduleDeps = {
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  /** Injected so a test does not open the operator's real workspace. */
  readonly workbench?: () => Promise<ScheduleSurface>;
  /** Injected so a test can pin the tick and two evaluations name the same
   * moment, exactly as the rules module takes its clock from the caller. */
  readonly now?: () => number;
};

/** Where the workbench keeps its state, resolved the way the workbench
 * resolves it. */
function workspaceDir(env: Readonly<NodeJS.ProcessEnv>): string {
  return (
    env.NOMO_DATA_DIR ??
    join(env.NOMO_LEDGER_DIR ?? dataDir(homedir()), "workbench")
  );
}

const USAGE = [
  "usage:",
  "  nomo schedule list",
  "  nomo schedule add --name <name> (--every <seconds> | --at <iso>) --max-runs <n> [--token-budget <n>] [--session <id>] [--model <id>] [--agent <id>] [--paused] <prompt>",
  "  nomo schedule pause <id>",
  "  nomo schedule resume <id>",
  "  nomo schedule remove <id>",
  "  nomo schedule run-due",
  "",
  "A schedule is an operator record. The workbench decides its bounds and runs",
  "a firing through the normal governed path; this command only records, reads",
  "and asks for one due evaluation. `nomo schedule run-due` is what a cron entry",
  "or a systemd timer calls: NOMO owns no clock.",
].join("\n");

const ACTIONS = [
  "list",
  "add",
  "pause",
  "resume",
  "remove",
  "run-due",
] as const;

/** Options that carry a value. Kept in one list so a value that starts with
 * `--` is read as a missing value rather than as the value of the flag before
 * it. */
const VALUE_FLAGS = [
  "--name",
  "--every",
  "--at",
  "--max-runs",
  "--token-budget",
  "--session",
  "--model",
  "--agent",
] as const;

type Flags = {
  readonly name: string;
  readonly every: string;
  readonly at: string;
  readonly maxRuns: string;
  readonly tokenBudget: string;
  readonly session: string;
  readonly model: string;
  readonly agent: string;
  readonly paused: boolean;
  readonly words: readonly string[];
  readonly unknown: readonly string[];
  readonly missing: readonly string[];
};

/**
 * Flags and the positional words in one pass.
 *
 * A value that starts with `--` is a missing value, not a value: `--name
 * --every 60` names no schedule, and reading `--every` as a name would create a
 * record nobody described.
 */
function parseFlags(args: readonly string[]): Flags {
  let name = "";
  let every = "";
  let at = "";
  let maxRuns = "";
  let tokenBudget = "";
  let session = "";
  let model = "";
  let agent = "";
  let paused = false;
  const words: string[] = [];
  const unknown: string[] = [];
  const missing: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--paused") {
      paused = true;
      continue;
    }
    if ((VALUE_FLAGS as readonly string[]).includes(arg)) {
      const value = args[index + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        missing.push(arg);
        continue;
      }
      index += 1;
      if (arg === "--name") name = value;
      else if (arg === "--every") every = value;
      else if (arg === "--at") at = value;
      else if (arg === "--max-runs") maxRuns = value;
      else if (arg === "--token-budget") tokenBudget = value;
      else if (arg === "--session") session = value;
      else if (arg === "--model") model = value;
      else agent = value;
      continue;
    }
    if (arg.startsWith("-")) {
      unknown.push(arg);
      continue;
    }
    // An unquoted prompt is the same prompt: the words after the flags are the
    // text the operator meant, and joining them keeps `nomo schedule add ...
    // sweep the inbox` working.
    words.push(arg);
  }
  return {
    name,
    every,
    at,
    maxRuns,
    tokenBudget,
    session,
    model,
    agent,
    paused,
    words,
    unknown,
    missing,
  };
}

/** The validated command, decided before the store is opened. */
type Prepared =
  | { readonly action: "list" }
  | { readonly action: "run-due" }
  | { readonly action: "add"; readonly input: ScheduleCreateInput }
  | { readonly action: "pause"; readonly id: string }
  | { readonly action: "resume"; readonly id: string }
  | { readonly action: "remove"; readonly id: string };

function refuse(io: ScheduleIo, message: string): number {
  io.stderr(message);
  io.stderr(USAGE);
  return 1;
}

/** The first option that only `add` understands, if the operator typed one. */
function startOnlyOption(flags: Flags): string | undefined {
  if (flags.name) return "--name";
  if (flags.every) return "--every";
  if (flags.at) return "--at";
  if (flags.maxRuns) return "--max-runs";
  if (flags.tokenBudget) return "--token-budget";
  if (flags.session) return "--session";
  if (flags.model) return "--model";
  if (flags.agent) return "--agent";
  if (flags.paused) return "--paused";
  return undefined;
}

/** A whole number above zero, or `undefined`. The shape only: the minimum
 * interval, the run ceiling and the budget ceiling are the workbench's. */
function wholeNumber(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function integerRefusal(flag: string, value: string, what: string): string {
  return `The ${flag} value must be a whole number of ${what} above zero and within the safe integer range, not ${JSON.stringify(value)}.`;
}

/**
 * The `add` record, or the sentence that refuses it.
 *
 * The order is the order an operator would fix the faults in: the record's
 * name, then its cadence, then its ceiling, then the budget, then the prompt.
 * A `--at` value is checked only for being a timestamp; whether the instant is
 * in the future is the rules module's decision, because "now" is its clock.
 */
function addInput(flags: Flags): ScheduleCreateInput | string {
  if (!flags.name) return "A schedule needs a name: --name <name>.";
  if (flags.every && flags.at)
    return "A schedule takes --every or --at, not both.";
  if (!flags.every && !flags.at)
    return "A schedule needs a cadence: --every <seconds> or --at <iso>.";
  let everySeconds: number | undefined;
  if (flags.every) {
    const parsed = wholeNumber(flags.every);
    if (parsed === undefined)
      return integerRefusal("--every", flags.every, "seconds");
    everySeconds = parsed;
  }
  if (flags.at && !Number.isFinite(Date.parse(flags.at)))
    return `The --at value must be an ISO 8601 instant, not ${JSON.stringify(flags.at)}.`;
  if (!flags.maxRuns) return "A schedule needs a run ceiling: --max-runs <n>.";
  const maxRuns = wholeNumber(flags.maxRuns);
  if (maxRuns === undefined)
    return integerRefusal("--max-runs", flags.maxRuns, "runs");
  let tokenBudget: number | undefined;
  if (flags.tokenBudget) {
    const parsed = wholeNumber(flags.tokenBudget);
    if (parsed === undefined)
      return integerRefusal("--token-budget", flags.tokenBudget, "tokens");
    tokenBudget = parsed;
  }
  const prompt = flags.words.join(" ");
  if (!prompt)
    return "A schedule needs a prompt: nomo schedule add --name <name> --every <seconds> --max-runs <n> <prompt>.";
  return {
    name: flags.name,
    prompt,
    cadence:
      everySeconds === undefined
        ? { kind: "once", at: flags.at }
        : { kind: "interval", everySeconds },
    maxRuns,
    enabled: !flags.paused,
    ...(flags.session ? { sessionId: flags.session } : {}),
    ...(flags.model ? { model: flags.model } : {}),
    ...(flags.agent ? { agent: flags.agent } : {}),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
  };
}

function prepare(command: string, flags: Flags, io: ScheduleIo): Prepared | number {
  if (command === "add") {
    const input = addInput(flags);
    return typeof input === "string"
      ? refuse(io, input)
      : { action: "add", input };
  }
  // Refused rather than ignored: an operator who typed --every on pause would
  // otherwise believe a cadence was changed when nothing was.
  const startOnly = startOnlyOption(flags);
  if (startOnly) return refuse(io, `The ${command} action takes no ${startOnly}.`);
  if (command === "list" || command === "run-due") {
    if (flags.words.length)
      return refuse(io, `The ${command} action takes no prompt.`);
    return command === "list" ? { action: "list" } : { action: "run-due" };
  }
  const [id, ...extra] = flags.words;
  if (id === undefined)
    return refuse(
      io,
      `The ${command} action needs a schedule id: nomo schedule ${command} <id>.`,
    );
  if (extra.length) return refuse(io, `The ${command} action takes one schedule id.`);
  if (command === "pause") return { action: "pause", id };
  if (command === "resume") return { action: "resume", id };
  return { action: "remove", id };
}

function describeCadence(cadence: ScheduleCadence): string {
  return cadence.kind === "once"
    ? `once at ${cadence.at}`
    : `every ${cadence.everySeconds} seconds`;
}

/** One field per line, so a schedule can be read and diffed in a terminal. */
function describeSchedule(schedule: ScheduleView): string[] {
  const lines = [
    `id: ${schedule.id}`,
    `name: ${schedule.name}`,
    `cadence: ${describeCadence(schedule.cadence)}`,
    `status: ${schedule.status}`,
    `enabled: ${schedule.enabled ? "yes" : "no"}`,
    `runs: ${schedule.runCount} of ${schedule.maxRuns}`,
  ];
  lines.push(
    schedule.tokenBudget === undefined
      ? `tokens: ${schedule.tokensUsed ?? 0}`
      : `tokens: ${schedule.tokensUsed ?? 0} of ${schedule.tokenBudget}`,
  );
  if (schedule.sessionId) lines.push(`session: ${schedule.sessionId}`);
  if (schedule.model) lines.push(`model: ${schedule.model}`);
  if (schedule.agent) lines.push(`agent: ${schedule.agent}`);
  if (schedule.createdAt) lines.push(`created: ${schedule.createdAt}`);
  lines.push(`next: ${schedule.nextRunAt}`);
  if (schedule.lastRunAt) lines.push(`last run: ${schedule.lastRunAt}`);
  if (schedule.lastOutcome) lines.push(`last outcome: ${schedule.lastOutcome}`);
  if (schedule.lastSessionId) lines.push(`last session: ${schedule.lastSessionId}`);
  return lines;
}

/** One line per record, so a listing is a table a script can cut. */
function summaryLine(schedule: ScheduleView): string {
  const budget =
    schedule.tokenBudget === undefined
      ? ""
      : ` tokens ${schedule.tokensUsed ?? 0}/${schedule.tokenBudget}`;
  return `${schedule.id} ${schedule.status}${schedule.enabled ? "" : " disabled"} ${describeCadence(schedule.cadence)} next ${schedule.nextRunAt} runs ${schedule.runCount}/${schedule.maxRuns}${budget} ${schedule.name}`;
}

function describeList(schedules: readonly ScheduleView[]): string[] {
  if (!schedules.length) return ["No schedules."];
  const lines = [
    `${schedules.length} ${schedules.length === 1 ? "schedule" : "schedules"}.`,
  ];
  for (const schedule of schedules) lines.push(summaryLine(schedule));
  return lines;
}

function describeFiring(firing: ScheduleFiring): string {
  const session = firing.sessionId ? ` session ${firing.sessionId}` : "";
  return `${firing.scheduleId} ${firing.outcome}${session}`;
}

function noSupport(io: ScheduleIo): number {
  io.stderr("This workbench has no schedule support.");
  return 1;
}

export async function runScheduleCommand(
  args: readonly string[],
  io: ScheduleIo,
  deps: ScheduleDeps = {},
): Promise<number> {
  const typed = args[0] ?? "";
  if (!typed || typed === "--help" || typed === "-h") {
    io.stdout(USAGE);
    return typed ? 0 : 1;
  }
  // `rm` is the spelling the design record uses and `remove` is the one the
  // help text promises; both are the same operator act.
  const command = typed === "rm" ? "remove" : typed;
  if (!(ACTIONS as readonly string[]).includes(command)) {
    io.stderr(`Unknown schedule action ${typed}.`);
    io.stderr(USAGE);
    return 1;
  }
  const flags = parseFlags(args.slice(1));
  if (flags.unknown.length) {
    io.stderr(`Unknown option ${flags.unknown[0]}.`);
    io.stderr(USAGE);
    return 1;
  }
  if (flags.missing.length) {
    io.stderr(`The ${flags.missing[0]} option needs a value.`);
    io.stderr(USAGE);
    return 1;
  }
  const prepared = prepare(command, flags, io);
  if (typeof prepared === "number") return prepared;
  const env = deps.env ?? process.env;
  if (!deps.workbench) {
    // The workbench writes its storage key when it is constructed, so a
    // command that only reads would create a workspace on a machine that has
    // none. The refusal names the path and the command that creates it.
    const directory = workspaceDir(env);
    if (!existsSync(directory)) {
      io.stderr(`No workspace at ${directory}. Run nomo init first.`);
      return 1;
    }
  }
  // The schedule methods arrive with the workbench wiring. The command is
  // written against the narrow surface above, so the CLI and that wiring can
  // land in either order without this file naming a method the class lacks
  // today.
  const surface: ScheduleSurface = deps.workbench
    ? await deps.workbench()
    : (new Workbench(env) as unknown as ScheduleSurface);
  try {
    // A closed switch, so an action added to `Prepared` and left unhandled is a
    // typecheck error rather than a silent fall through into another action.
    switch (prepared.action) {
      case "list": {
        const read = surface.listSchedules ?? surface.schedules;
        if (!read) return noSupport(io);
        for (const line of describeList(await read.call(surface))) io.stdout(line);
        return 0;
      }
      case "add": {
        if (!surface.createSchedule) return noSupport(io);
        const created = await surface.createSchedule(prepared.input);
        for (const line of describeSchedule(created)) io.stdout(line);
        io.stdout(
          `Created schedule ${created.id}. The workbench runs it; this command never does.`,
        );
        return 0;
      }
      case "pause": {
        if (!surface.pauseSchedule) return noSupport(io);
        const paused = await surface.pauseSchedule(prepared.id);
        for (const line of describeSchedule(paused)) io.stdout(line);
        io.stdout(`Paused schedule ${paused.id}.`);
        return 0;
      }
      case "resume": {
        if (!surface.resumeSchedule) return noSupport(io);
        const resumed = await surface.resumeSchedule(prepared.id);
        for (const line of describeSchedule(resumed)) io.stdout(line);
        io.stdout(`Resumed schedule ${resumed.id}.`);
        return 0;
      }
      case "remove": {
        if (!surface.deleteSchedule) return noSupport(io);
        const removed = await surface.deleteSchedule(prepared.id);
        // A reader that answers `false` is reporting a record it does not
        // hold, which is a different answer from "removed" and a script has to
        // be able to see it.
        if (removed === false) {
          io.stderr(`No schedule ${prepared.id}.`);
          return 1;
        }
        io.stdout(`Removed schedule ${prepared.id}.`);
        return 0;
      }
      case "run-due": {
        if (!surface.runDueSchedules) return noSupport(io);
        const nowMs = deps.now ? deps.now() : Date.now();
        const firings = await surface.runDueSchedules(nowMs);
        if (!firings.length) {
          io.stdout("No schedule is due.");
          return 0;
        }
        for (const firing of firings) io.stdout(describeFiring(firing));
        io.stdout(
          `Fired ${firings.length} ${firings.length === 1 ? "schedule" : "schedules"}.`,
        );
        return 0;
      }
    }
  } catch (error) {
    // The workbench's own sentence, kept whole: a refusal reworded here is a
    // refusal the operator cannot match against the surface that produced it.
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
