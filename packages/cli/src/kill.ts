/**
 * `void kill` and `void reinstate`: the NOMO kill-switch from the terminal,
 * contract docs/nomo/CONTRACT.md section 7.
 *
 * This process appends to the revocation store and nothing else. It holds no
 * hold queue, so it denies no pending hold itself; the proxy that owns the
 * queue does that, and every policy check after the append denies the agent.
 * The output says what was recorded, never that the agent "stopped".
 *
 * An agent id that the agent policy does not declare is refused unless
 * --force is given: a typo in an emergency must not read as a stopped agent.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  killAgent,
  loadAgentPolicy,
  reinstateAgent,
} from "../../agent-policy/src/index.ts";

export type KillCommandIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
};
export type KillCommandOptions = {
  readonly now?: () => Date;
  /** Where a relative default policy path resolves; process.cwd() when absent. */
  readonly cwd?: string;
};

type KillArgs = {
  readonly agentId: string;
  readonly by: string;
  readonly reason: string;
  readonly store: string;
  readonly policy: string | undefined;
  readonly force: boolean;
  readonly json: boolean;
};

const USAGE = {
  kill: "usage: void kill <agentId> --by actor [--reason text] [--store path] [--policy path] [--force] [--json]",
  reinstate: "usage: void reinstate <agentId> --by actor --reason text [--store path] [--policy path] [--force] [--json]",
} as const;

export async function runKillCommand(
  argv: readonly string[], io: KillCommandIo, options: KillCommandOptions = {},
): Promise<number> {
  return await run("kill", argv, io, options);
}

export async function runReinstateCommand(
  argv: readonly string[], io: KillCommandIo, options: KillCommandOptions = {},
): Promise<number> {
  return await run("reinstate", argv, io, options);
}

async function run(
  kind: "kill" | "reinstate", argv: readonly string[], io: KillCommandIo, options: KillCommandOptions,
): Promise<number> {
  let args: KillArgs;
  try { args = parseArgs(kind, argv, io.env ?? process.env, options.cwd ?? process.cwd()); }
  catch (error) { io.stderr(message(error)); return 2; }

  const undeclared = declaredProblem(args);
  if (undeclared !== null) { io.stderr(undeclared); return 2; }
  if (args.policy === undefined && !args.force) io.stderr("note: no agent policy found (--policy, VOID_AGENT_POLICY or ./policy/agents.yaml); the agent id was not checked");

  const input = { storePath: args.store, agentId: args.agentId, by: args.by, reason: args.reason, ...(options.now ? { now: options.now } : {}) };
  try {
    if (kind === "kill") {
      const result = await killAgent(input);
      if (args.json) io.stdout(JSON.stringify({ ...result.record, store: args.store, wasKilled: result.wasKilled }));
      else {
        io.stdout(`kill recorded for ${args.agentId} at ${result.record.at} by ${args.by} in ${args.store}`);
        io.stdout("every policy check from now denies this agent, and tokens issued at or before that second are dead");
        if (result.wasKilled === true) io.stdout("note: the agent was already killed; the later kill time now applies");
        if (result.wasKilled === null) io.stderr("warning: the revocation store was unreadable before this kill; every call is denied until it is repaired");
      }
    } else {
      const record = await reinstateAgent(input);
      if (args.json) io.stdout(JSON.stringify({ ...record, store: args.store }));
      else {
        io.stdout(`reinstate recorded for ${args.agentId} at ${record.at} by ${args.by} in ${args.store}`);
        io.stdout("tokens issued before the kill stay dead; the agent needs new ones");
      }
    }
    return 0;
  } catch (error) {
    io.stderr(`could not record ${kind}: ${message(error)}`);
    return 1;
  }
}

/** A policy is consulted when one is named or found; none found means the id is unchecked, said once. */
function declaredProblem(args: KillArgs): string | null {
  if (args.force || args.policy === undefined) return null;
  let text: string;
  try { text = readFileSync(args.policy, "utf8"); }
  catch { return `cannot read the agent policy ${args.policy}; pass --force to record anyway`; }
  const loaded = loadAgentPolicy(text);
  if (!loaded.ok) return `the agent policy ${args.policy} is invalid; pass --force to record anyway`;
  const ids = loaded.policy.agents.map((agent) => agent.id);
  if (ids.includes(args.agentId)) return null;
  return `agent ${args.agentId} is not declared in ${args.policy} (declared: ${ids.join(", ") || "none"}); pass --force to record anyway`;
}

function parseArgs(
  kind: "kill" | "reinstate", argv: readonly string[], env: Readonly<NodeJS.ProcessEnv>, cwd: string,
): KillArgs {
  let agentId: string | undefined;
  let by: string | undefined;
  let reason: string | undefined;
  let store: string | undefined;
  let policy: string | undefined;
  let force = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--json") json = true;
    else if (arg === "--force") force = true;
    else if (["--by", "--reason", "--store", "--policy"].includes(arg)) {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--") || (arg !== "--reason" && value.trim() === "")) throw new Error(`${arg} needs a value`);
      if (arg === "--by") by = value;
      else if (arg === "--reason") reason = value;
      else if (arg === "--store") store = value;
      else policy = value;
    } else if (agentId === undefined && !arg.startsWith("-") && arg.trim() !== "") agentId = arg;
    else throw new Error(`unexpected argument ${JSON.stringify(arg)}\n${USAGE[kind]}`);
  }
  if (agentId === undefined || by === undefined || (kind === "reinstate" && reason === undefined)) throw new Error(USAGE[kind]);
  const workspace = env.VOID_WORKSPACE ?? "default";
  if (store === undefined && env.VOID_REVOCATIONS === undefined && !/^[a-zA-Z0-9_-]+$/.test(workspace)) throw new Error("invalid workspace");
  const found = join(cwd, "policy", "agents.yaml");
  return {
    agentId, by, reason: reason ?? "", force, json,
    store: store ?? env.VOID_REVOCATIONS ?? join(homedir(), ".void", "nomo", workspace, "revocations.jsonl"),
    policy: policy ?? env.VOID_AGENT_POLICY ?? (existsSync(found) ? found : undefined),
  };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
