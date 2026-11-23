#!/usr/bin/env node
import { readFileSync } from 'node:fs';

// Installed first so it runs before any node:sqlite import transitively loaded
// by the CLI runtime. node:sqlite is still an experimental builtin on this
// engine and emits a two-line ExperimentalWarning to stderr just by being
// imported; the binary's no-stderr contract (help/version/new workspace) would
// otherwise fail. The default warning listeners are cleared first because simply
// adding a no-op listener does not replace them.
for (const listener of process.listeners("warning")) {
  process.removeListener("warning", listener);
}
process.on("warning", () => {});

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

const COMMANDS = [
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
]         ;

                                                

                              
                                                  
                                  

/** Running the installed `nomo` command with no subcommand opens the live TUI.
 * TUI flags may also follow the bare command; global help/version keep their
 * existing meanings. */
function withDefaultTui(argv                   )           {
  if (argv.length === 0) return ["tui"];
  if (
    argv[0] .startsWith("-") &&
    !["--help", "-h", "--version", "-v"].includes(argv[0] )
  )
    return ["tui", ...argv];
  return [...argv];
}

/**
 * Takes argv as a parameter rather than reading process.argv, so the parser is
 * testable and the process boundary stays in the bin entry point.
 */
function parseInvocation(argv                   )                   {
  const [name, ...args] = argv;
  if (name === undefined || name === "") {
    return {
      ok: false,
      reason: `usage: nomo (opens TUI) | nomo <${COMMANDS.join("|")}>`,
    };
  }
  if (!(COMMANDS                     ).includes(name)) {
    return {
      ok: false,
      reason: `unknown command ${JSON.stringify(name)}, expected one of ${COMMANDS.join(", ")}`,
    };
  }
  return { ok: true, command: name           , args };
}


//# sourceURL=packages/cli/src/argv.ts

/**
 * The nomo binary.
 *
 * A thin entry point on purpose. `--help` and `--version` are answered from
 * argv.ts, which imports nothing, so neither path loads the command surface and
 * neither prints node's SQLite experimental warning. The dispatch is imported
 * only once a real command is named.
 */


const rawArgv = process.argv.slice(2);
const argv = withDefaultTui(rawArgv);

const flag = rawArgv.length === 1 ? rawArgv[0] : undefined;

if (flag === "--help" || flag === "-h") {
  const usage = parseInvocation([]);
  if (!usage.ok) console.log(usage.reason);
  process.exit(0);
}

if (flag === "--version" || flag === "-v") {
  const meta = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (!meta || typeof meta.version !== "string" || !meta.version) {
    console.error("Package version is missing.");
    process.exit(1);
  }
  console.log(`nomo ${meta.version}`);
  process.exit(0);
}

const parsed = parseInvocation(argv);
if (!parsed.ok) {
  console.error(parsed.reason);
  process.exit(2);
}

// One normalization, before anything is dispatched. Commands read `NOMO_*`
// only, so a machine configured before the rename under `VOID_*` behaves the
// same without each call site re-implementing the fallback.
const asTyped = { ...process.env };

try {
  const { normalizeOwnedEnv } = await import('./env-keys.mjs');
  const normalized = normalizeOwnedEnv();
  if (normalized !== process.env) Object.assign(process.env, normalized);
  const { runCommand } = await import('./dispatch.mjs').then(n => n.ac);
  // Assign exitCode, never process.exit(). A forced exit truncates a stdout
  // write that has not drained yet, which silently swallowed the first JSON-RPC
  // response of `nomo recovery serve` and killed the MCP host handshake.
  // `nomo config` prints which spelling of a setting is in force, and after the
  // normalization above every setting looks current. It is handed the
  // environment as the operator typed it, so the report names `VOID_*` when
  // `VOID_*` is what is actually running.
  process.exitCode = await runCommand(parsed, { rawEnv: asTyped });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
