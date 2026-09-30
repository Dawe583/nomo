#!/usr/bin/env node
/**
 * The void binary.
 *
 * A thin entry point on purpose. `--help` and `--version` are answered from
 * argv.ts, which imports nothing, so neither path loads the command surface and
 * neither prints node's SQLite experimental warning. The dispatch is imported
 * only once a real command is named.
 */
import { readFileSync } from "node:fs";
import { parseInvocation, withDefaultTui } from "../src/argv.ts";

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
  console.log(`void ${meta.version}`);
  process.exit(0);
}

const parsed = parseInvocation(argv);
if (!parsed.ok) {
  console.error(parsed.reason);
  process.exit(2);
}

try {
  const { runCommand } = await import("../src/dispatch.ts");
  // Assign exitCode, never process.exit(). A forced exit truncates a stdout
  // write that has not drained yet, which silently swallowed the first JSON-RPC
  // response of `void recovery serve` and killed the MCP host handshake.
  process.exitCode = await runCommand(parsed);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
