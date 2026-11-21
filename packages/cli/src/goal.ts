/**
 * Operator goals, from a terminal.
 *
 * A goal is an objective with a token budget and optional completion gates.
 * The interactive surface could not start one and a script had no way in at
 * all, so the loop could only be driven by whoever wrote the workbench test.
 *
 * This command is an operator door, not a second loop. It hands the workbench
 * the objective and the exact gate strings the operator typed, and the
 * workbench decides: each gate is checked against the runtime hook allowlist,
 * continuation runs there, and a budget ends the goal there. Running a gate
 * here would be a second answer to what the operator allowed.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../workbench/src/index.ts";
import { dataDir } from "../../ledger/src/paths.ts";

export type GoalIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};

/** A goal as the workbench reports it. Only the fields this command prints
 * are named; a workbench that carries more prints the same lines. */
export type GoalView = {
  readonly objective: string;
  readonly tokenBudget: number;
  readonly tokensUsed?: number;
  readonly gates?: readonly string[];
  /** `active`, `completed`, `cancelled`, `stalled` or `budget_limited` today.
   * Kept open because the workbench owns the vocabulary. */
  readonly status: string;
  readonly continuationCount?: number;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly reason?: string;
};

export type GoalInput = {
  readonly objective: string;
  readonly tokenBudget: number;
  readonly gates: readonly string[];
};

type MaybePromise<T> = T | Promise<T>;

/**
 * The part of the workbench this command uses. Narrow on purpose: the command
 * records, reads and cancels a goal, and it never runs one.
 *
 * `get` is the session view, whose `goal` is the read path the interactive
 * surface already uses. `getGoal` is the dedicated reader, preferred when the
 * workbench has one.
 */
export type GoalSurface = {
  get?(id: string):
    | { readonly workspace: string; readonly goal?: GoalView | null }
    | undefined;
  getGoal?(sessionId: string): MaybePromise<GoalView | null | undefined>;
  startGoal?(sessionId: string, input: GoalInput): MaybePromise<GoalView>;
  cancelGoal?(sessionId: string): MaybePromise<GoalView | null | undefined | void>;
};

export type GoalDeps = {
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  /** Injected so a test does not open the operator's real workspace. */
  readonly workbench?: () => Promise<GoalSurface>;
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
  "  nomo goal start --session <id> --token-budget <n> [--gate <exact-command>]... <objective>",
  "  nomo goal status --session <id>",
  "  nomo goal cancel --session <id>",
  "",
  "A gate is one exact command the runtime already allows (NOMO_HOOK_COMMANDS).",
  "The workbench runs it; this command never does.",
].join("\n");

type Flags = {
  readonly session: string;
  readonly tokenBudget: string;
  readonly gates: readonly string[];
  readonly objective: string;
  readonly unknown: readonly string[];
  readonly missing: readonly string[];
};

/**
 * Flags and the objective in one pass.
 *
 * A value that starts with `--` is a missing value, not a value: `--session
 * --token-budget 10` names no session, and reading `--token-budget` as an id
 * would open the store for a session nobody named.
 */
function parseFlags(args: readonly string[]): Flags {
  let session = "";
  let tokenBudget = "";
  const gates: string[] = [];
  const objective: string[] = [];
  const unknown: string[] = [];
  const missing: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--session" || arg === "--token-budget" || arg === "--gate") {
      const value = args[index + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        missing.push(arg);
        continue;
      }
      index += 1;
      if (arg === "--session") session = value;
      else if (arg === "--token-budget") tokenBudget = value;
      else gates.push(value);
      continue;
    }
    if (arg.startsWith("-")) {
      unknown.push(arg);
      continue;
    }
    // An unquoted objective is the same objective: the words after the flags
    // are the text the operator meant, and joining them keeps `nomo goal start
    // --session s --token-budget 10 fix the tests` working.
    objective.push(arg);
  }
  return {
    session,
    tokenBudget,
    gates,
    objective: objective.join(" "),
    unknown,
    missing,
  };
}

/** One field per line, so a goal can be read and diffed in a terminal. */
function describeGoal(goal: GoalView): string[] {
  const lines = [`objective: ${goal.objective}`, `status: ${goal.status}`];
  lines.push(
    goal.tokensUsed === undefined
      ? `budget: ${goal.tokenBudget} tokens`
      : `budget: ${goal.tokenBudget} tokens, ${goal.tokensUsed} used`,
  );
  const gates = goal.gates ?? [];
  lines.push(`gates: ${gates.length}`);
  for (const gate of gates) lines.push(`  ${gate}`);
  if (goal.continuationCount !== undefined)
    lines.push(`continuations: ${goal.continuationCount}`);
  if (goal.startedAt) lines.push(`started: ${goal.startedAt}`);
  if (goal.endedAt) lines.push(`ended: ${goal.endedAt}`);
  if (goal.reason) lines.push(`reason: ${goal.reason}`);
  return lines;
}

/**
 * The goal a session holds, from the dedicated reader when there is one and
 * from the session view otherwise.
 *
 * A reader that answers "nothing" cannot say whether the session exists, so
 * the session view decides between "no goal" and "no such session". Those are
 * different answers to an operator, and a script that treats them the same
 * retries a typo forever.
 */
async function readGoal(
  surface: GoalSurface,
  sessionId: string,
): Promise<GoalView | undefined> {
  const reported = surface.getGoal ? await surface.getGoal(sessionId) : undefined;
  if (reported) return reported;
  if (!surface.get) return undefined;
  const session = surface.get(sessionId);
  if (!session) throw new Error("Session not found.");
  return session.goal ?? undefined;
}

export async function runGoalCommand(
  args: readonly string[],
  io: GoalIo,
  deps: GoalDeps = {},
): Promise<number> {
  const action = args[0] ?? "";
  if (!action || action === "--help" || action === "-h") {
    io.stdout(USAGE);
    return action ? 0 : 1;
  }
  if (!["start", "status", "cancel"].includes(action)) {
    io.stderr(`Unknown goal action ${action}.`);
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
  if (!flags.session) {
    io.stderr("The goal commands need a session: --session <id>.");
    io.stderr(USAGE);
    return 1;
  }
  let tokenBudget = 0;
  if (action === "start") {
    if (!flags.tokenBudget) {
      io.stderr("A goal needs a token budget: --token-budget <n>.");
      io.stderr(USAGE);
      return 1;
    }
    if (
      !/^[0-9]+$/.test(flags.tokenBudget) ||
      !Number.isSafeInteger(Number(flags.tokenBudget)) ||
      Number(flags.tokenBudget) < 1
    ) {
      io.stderr(
        `The token budget must be a whole number of tokens above zero and within the safe integer range, not ${JSON.stringify(flags.tokenBudget)}.`,
      );
      io.stderr(USAGE);
      return 1;
    }
    tokenBudget = Number(flags.tokenBudget);
    if (!flags.objective) {
      io.stderr(
        "A goal needs an objective: nomo goal start --session <id> --token-budget <n> <objective>.",
      );
      io.stderr(USAGE);
      return 1;
    }
  } else if (flags.tokenBudget || flags.gates.length || flags.objective) {
    // Refused rather than ignored: an operator who typed --gate on cancel
    // would otherwise believe a completion gate was registered.
    const option = flags.tokenBudget
      ? "--token-budget"
      : flags.gates.length
        ? "--gate"
        : "objective";
    io.stderr(`The ${action} action takes no ${option}.`);
    io.stderr(USAGE);
    return 1;
  }
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
  // The goal methods arrive with the workbench goal runtime. The command is
  // written against the narrow surface above, so the CLI and that runtime can
  // land in either order without this file naming a method the class lacks
  // today.
  const surface: GoalSurface = deps.workbench
    ? await deps.workbench()
    : (new Workbench(env) as unknown as GoalSurface);
  try {
    if (action === "start") {
      if (!surface.startGoal) {
        io.stderr("This workbench has no goal support.");
        return 1;
      }
      const started = await surface.startGoal(flags.session, {
        objective: flags.objective,
        tokenBudget,
        gates: [...flags.gates],
      });
      for (const line of describeGoal(started)) io.stdout(line);
      io.stdout(
        `Goal started for ${flags.session}. The workbench runs the continuation and its gates; this command does not run them.`,
      );
      return 0;
    }
    if (action === "cancel") {
      if (!surface.cancelGoal) {
        io.stderr("This workbench has no goal support.");
        return 1;
      }
      const cancelled = await surface.cancelGoal(flags.session);
      if (cancelled) for (const line of describeGoal(cancelled)) io.stdout(line);
      io.stdout(`Cancelled the goal for ${flags.session}.`);
      return 0;
    }
    const goal = await readGoal(surface, flags.session);
    if (!goal) {
      io.stdout(`No goal for session ${flags.session}.`);
      return 0;
    }
    for (const line of describeGoal(goal)) io.stdout(line);
    return 0;
  } catch (error) {
    // The workbench's own sentence, kept whole: a refusal reworded here is a
    // refusal the operator cannot match against the surface that produced it.
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
