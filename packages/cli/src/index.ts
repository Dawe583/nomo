/**
 * The void command.
 *
 * Keep the command surface in one place so unknown commands fail with useful
 * alternatives. The binary dispatches handlers; terminal views consume the
 * shared workbench rather than owning policy or recovery logic.
 */

export const COMMANDS = [
  "tui",
  "run",
  "classify",
  "feed",
  "watch",
  "approvals",
  "approve",
  "ledger",
  "replay",
  "recovery",
  "policy",
  "export",
  "attest",
  "taint",
  "verify",
  "agent",
  "doctor",
] as const;

export type Command = (typeof COMMANDS)[number];

export type ParsedInvocation =
  | { ok: true; command: Command; args: string[] }
  | { ok: false; reason: string };

/**
 * Takes argv as a parameter rather than reading process.argv, so the parser is
 * testable and the process boundary stays in the bin entry point.
 */
export function parseInvocation(argv: readonly string[]): ParsedInvocation {
  const [name, ...args] = argv;
  if (name === undefined || name === "") {
    return { ok: false, reason: `usage: void <${COMMANDS.join("|")}>` };
  }
  if (!(COMMANDS as readonly string[]).includes(name)) {
    return {
      ok: false,
      reason: `unknown command ${JSON.stringify(name)}, expected one of ${COMMANDS.join(", ")}`,
    };
  }
  return { ok: true, command: name as Command, args };
}

export * from "./tui/index.ts";
export * from "./classify.ts";
export * from "./feed.ts";
export * from "./replay.ts";
export * from "./taint.ts";
export * from "./verify.ts";
export * from "./approve.ts";
export * from "./doctor.ts";
