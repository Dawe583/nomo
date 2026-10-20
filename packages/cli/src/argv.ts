/**
 * Argument parsing for the nomo binary, with no imports at all.
 *
 * Split out of index.ts because that barrel re-exports the whole command
 * surface, which reaches node:sqlite through the runtime. The `--help` and
 * `--version` paths must not load a database engine: it made every help
 * invocation print node's SQLite experimental warning to stderr, and it made
 * "help without opening workspace data" untestable. A pure argv parser has no
 * business carrying that graph.
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
  "config",
  "init",
  "metrics",
  "update",
  "state",
  "harness",
] as const;

export type Command = (typeof COMMANDS)[number];

export type ParsedInvocation =
  | { ok: true; command: Command; args: string[] }
  | { ok: false; reason: string };

/** Running the installed `nomo` command with no subcommand opens the live TUI.
 * TUI flags may also follow the bare command; global help/version keep their
 * existing meanings. */
export function withDefaultTui(argv: readonly string[]): string[] {
  if (argv.length === 0) return ["tui"];
  if (
    argv[0]!.startsWith("-") &&
    !["--help", "-h", "--version", "-v"].includes(argv[0]!)
  )
    return ["tui", ...argv];
  return [...argv];
}

/**
 * Takes argv as a parameter rather than reading process.argv, so the parser is
 * testable and the process boundary stays in the bin entry point.
 */
export function parseInvocation(argv: readonly string[]): ParsedInvocation {
  const [name, ...args] = argv;
  if (name === undefined || name === "") {
    return {
      ok: false,
      reason: `usage: nomo (opens TUI) | nomo <${COMMANDS.join("|")}>`,
    };
  }
  if (!(COMMANDS as readonly string[]).includes(name)) {
    return {
      ok: false,
      reason: `unknown command ${JSON.stringify(name)}, expected one of ${COMMANDS.join(", ")}`,
    };
  }
  return { ok: true, command: name as Command, args };
}
