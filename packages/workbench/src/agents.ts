import { spawn } from "node:child_process";

export type AgentProfile = {
  id: string;
  name: string;
  systemPrompt: string;
  allowedTools: string[];
  policyProfile: string;
  maxTurns: number;
  maxContextTokens: number;
};

export type Hook = {
  id: string;
  event: "before-run" | "after-tool" | "after-run";
  command: string;
  enabled: boolean;
};

export type CompactionResult = {
  summary: string;
  retainedMessageIds: string[];
  omittedMessageCount: number;
  createdAt: string;
};

export const AGENT_LIMITS = { maxTurns: 20, maxContextTokens: 131072 } as const;

export function validateAgentProfile(
  input: unknown,
  context: string = "agent profile",
): AgentProfile {
  if (!input || typeof input !== "object")
    throw new Error(`Invalid ${context}: not an object.`);
  const obj = input as Record<string, unknown>;
  if (typeof obj.id !== "string" || !/^[A-Za-z0-9][\w-]{0,119}$/.test(obj.id))
    throw new Error(`Invalid ${context}: id required as a UUID or slug.`);
  if (typeof obj.name !== "string" || !obj.name.trim() || obj.name.length > 80)
    throw new Error(`Invalid ${context}: name 1..80 chars.`);
  if (typeof obj.systemPrompt !== "string" || obj.systemPrompt.length > 16000)
    throw new Error(`Invalid ${context}: systemPrompt must be text up to 16000 characters.`);
  if (
    !Array.isArray(obj.allowedTools) || obj.allowedTools.length > 200 ||
    !obj.allowedTools.every((t) => typeof t === "string" && t.length > 0 && t.length <= 160 && !/[\x00-\x1f]/.test(t)) ||
    new Set(obj.allowedTools).size !== obj.allowedTools.length
  )
    throw new Error(`Invalid ${context}: allowedTools must be string[].`);
  if (typeof obj.policyProfile !== "string" || !obj.policyProfile.trim())
    throw new Error(`Invalid ${context}: policyProfile required.`);
  const maxTurns = obj.maxTurns;
  const maxContextTokens = obj.maxContextTokens;
  if (
    typeof maxTurns !== "number" ||
    !Number.isSafeInteger(maxTurns) ||
    maxTurns <= 0 || maxTurns > AGENT_LIMITS.maxTurns
  )
    throw new Error(`Invalid ${context}: maxTurns must be 1..${AGENT_LIMITS.maxTurns}.`);
  if (
    typeof maxContextTokens !== "number" ||
    !Number.isSafeInteger(maxContextTokens) ||
    maxContextTokens <= 0 || maxContextTokens > AGENT_LIMITS.maxContextTokens
  )
    throw new Error(`Invalid ${context}: maxContextTokens must be 1..${AGENT_LIMITS.maxContextTokens}.`);
  return {
    id: obj.id.trim(),
    name: obj.name.trim(),
    systemPrompt: obj.systemPrompt,
    allowedTools: [...obj.allowedTools] as string[],
    policyProfile: obj.policyProfile.trim(),
    maxTurns,
    maxContextTokens,
  };
}

export function validateHook(
  input: unknown,
  allowlist: readonly string[] = [],
  context: string = "hook",
): Hook {
  if (!input || typeof input !== "object")
    throw new Error(`Invalid ${context}: not an object.`);
  const obj = input as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id.trim())
    throw new Error(`Invalid ${context}: id required.`);
  const event = obj.event;
  if (event !== "before-run" && event !== "after-tool" && event !== "after-run")
    throw new Error(
      `Invalid ${context}: event must be before-run, after-tool or after-run.`,
    );
  if (typeof obj.command !== "string" || !obj.command.trim())
    throw new Error(`Invalid ${context}: command required.`);
  if (!allowlist.includes(obj.command.trim()))
    throw new Error(`Invalid ${context}: command not on operator allowlist.`);
  if (typeof obj.enabled !== "boolean")
    throw new Error(`Invalid ${context}: enabled boolean required.`);
  return {
    id: obj.id.trim(),
    event,
    command: obj.command.trim(),
    enabled: obj.enabled,
  };
}

/** The outcome of one hook process. `outcome` names the three ways a hook can
 * end that are not "the command ran and said so", so a caller never has to
 * infer a spawn failure from a null code and a non-zero time. */
export type HookResult = {
  hookId: string;
  event: Hook["event"];
  command: string;
  outcome: "exited" | "timeout" | "spawn-error" | "disabled";
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

/** A hook succeeded only if it was allowed to run and it exited zero. A
 * timeout is not a success, and neither is a process that never started. */
export function hookSucceeded(result: HookResult): boolean {
  return result.outcome === "exited" && result.code === 0;
}

export const HOOK_TIMEOUT_MS = 5000;
export const HOOK_TIMEOUT_BOUNDS = { min: 100, max: 60_000 } as const;
export const HOOK_OUTPUT_LIMIT = 64 * 1024;

/** Split an allowlisted command into an argv.
 *
 * This is deliberately not a shell. Nothing is expanded, substituted or
 * globbed, and `;`, `|`, `&&`, `>` and `$VAR` are ordinary characters that
 * arrive as ordinary arguments. The operator has already written this exact
 * string into the allowlist; quoting exists only so a path or an argument
 * containing a space survives tokenisation as one argument.
 */
export function hookArgv(command: string): string[] {
  const argv: string[] = [];
  let token = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === " " || char === "\t") {
      if (started) {
        argv.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += char;
    started = true;
  }
  if (quote) throw new Error(`Invalid hook command: unterminated quote in ${command}.`);
  if (started) argv.push(token);
  if (!argv.length) throw new Error("Hook command names no executable.");
  return argv;
}

/**
 * Run one allowlisted hook and report exactly what happened.
 *
 * Failure semantics, chosen deliberately:
 *
 * A `before-run` hook that exits non-zero, times out, or cannot start is a
 * refusal, not a shrug. The trade-off is real: a hook whose command was
 * deleted out from under the operator takes every run down with it, which is
 * availability lost for a safety property. The direction taken is fail
 * closed because the opposite failure is silent and unbounded — "the gate
 * did not open, so I let it through" is indistinguishable, in the ledger and
 * in the session view, from "the gate opened", and the operator reading
 * afterwards cannot tell which one happened. A refused run is loud, names the
 * hook, and stops. This is not configurable, because every knob that turns it
 * back is a knob that widens the boundary: the only operator lever is
 * `enabled: false` on the hook or dropping the command from the allowlist,
 * both explicit auditable acts taken in operator configuration rather than
 * smuggled in as a flag on the request.
 *
 * `after-tool` and `after-run` observe work that has already happened, so a
 * failure there cannot undo a tool that ran or a run that finished. Those
 * results never change a verdict. They are reported — as a hook result and a
 * session event carrying the exit code, the stdout and the stderr — so a
 * failed observer is visible rather than swallowed.
 *
 * The timeout is bounded on both sides: the default is 5s and no operator may
 * raise it past 60s, because a hook that can outlive its usefulness must not
 * be able to hold a run open forever. Output is captured to a fixed ceiling
 * for the same reason.
 */
export function runHook(
  hook: Hook,
  context: Record<string, unknown> = {},
  options: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<HookResult> {
  const started = Date.now();
  const summarize = (
    outcome: HookResult["outcome"],
    code: number | null,
    stdout: string,
    stderr: string,
  ): HookResult => ({
    hookId: hook.id,
    event: hook.event,
    command: hook.command,
    outcome,
    code,
    stdout: stdout.slice(0, HOOK_OUTPUT_LIMIT),
    stderr: stderr.slice(0, HOOK_OUTPUT_LIMIT),
    durationMs: Date.now() - started,
  });
  // A disabled hook is refused here as well as at the call site, so no future
  // caller can run one by accident.
  if (!hook.enabled)
    return Promise.resolve(summarize("disabled", null, "", ""));
  const timeoutMs = Math.min(
    HOOK_TIMEOUT_BOUNDS.max,
    Math.max(HOOK_TIMEOUT_BOUNDS.min, options.timeoutMs ?? HOOK_TIMEOUT_MS),
  );
  let argv: string[];
  try {
    argv = hookArgv(hook.command);
  } catch (error) {
    return Promise.resolve(summarize("spawn-error", null, "", String(error)));
  }
  return new Promise<HookResult>((resolve) => {
    let child;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve(summarize("spawn-error", null, "", String(error)));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const done = (outcome: HookResult["outcome"], code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(summarize(outcome, code, stdout, stderr));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < HOOK_OUTPUT_LIMIT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < HOOK_OUTPUT_LIMIT) stderr += chunk.toString("utf8");
    });
    // The context reaches the hook as JSON on stdin and as named environment
    // variables, so a hook can read the tool, the decision and the outcome
    // without depending on a positional argv contract.
    child.on("error", (error: Error) => {
      stderr += `${stderr ? "\n" : ""}${error.message}`;
      done("spawn-error", null);
    });
    child.on("close", (code: number | null) =>
      done(timedOut ? "timeout" : "exited", code),
    );
    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL, not SIGTERM: a hook that ignores a polite request must still
      // not be able to hold the run open.
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.stdin.on("error", () => {});
    child.stdin.end(
      JSON.stringify({
        ...context,
        VOID_HOOK_EVENT: hook.event,
        VOID_HOOK_ID: hook.id,
        ...(context.tool === undefined
          ? {}
          : { VOID_HOOK_TOOL: String(context.tool) }),
        ...(context.decision === undefined
          ? {}
          : { VOID_HOOK_DECISION: String(context.decision) }),
        ...(context.outcome === undefined
          ? {}
          : { VOID_HOOK_OUTCOME: String(context.outcome) }),
      }),
    );
  });
}
