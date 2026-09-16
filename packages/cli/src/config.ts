/**
 * Effective configuration printer. Pure resolution over the environment:
 * it never reads encrypted state, never creates directories and never
 * prints secret values, only whether a key is set.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export type ConfigIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};
export type ConfigDeps = {
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly version?: string;
};
export type ConfigEntry = { key: string; value: string; source: string };

export function resolveConfig(env: Readonly<NodeJS.ProcessEnv>): ConfigEntry[] {
  const home = env.HOME ?? homedir();
  const pick = (
    key: string,
    envKey: string,
    value: string | undefined,
    fallback: string,
  ): ConfigEntry =>
    value === undefined || value === ""
      ? { key, value: fallback, source: "default" }
      : { key, value, source: envKey };
  return [
    pick("data-dir", "VOID_DATA_DIR", env.VOID_DATA_DIR, join(home, ".void", "workbench")),
    pick("ledger-dir", "VOID_LEDGER_DIR", env.VOID_LEDGER_DIR, join(home, ".void", "ledger")),
    pick(
      "approvals-dir",
      "VOID_APPROVALS_DIR",
      env.VOID_APPROVALS_DIR,
      join(home, ".void", "approvals", env.VOID_WORKSPACE ?? "default"),
    ),
    {
      key: "verify-key",
      value: env.VOID_VERIFY_KEY ? "set" : "unset",
      source: env.VOID_VERIFY_KEY ? "VOID_VERIFY_KEY" : "default",
    },
    {
      key: "tui-color",
      value: env.VOID_TUI_COLOR === "0" ? "off" : "on",
      source: env.VOID_TUI_COLOR === undefined ? "default" : "VOID_TUI_COLOR",
    },
    {
      key: "tui-motion",
      value: env.VOID_TUI_MOTION === "0" || env.TERM === "dumb" ? "off" : "on",
      source:
        env.VOID_TUI_MOTION === undefined && env.TERM !== "dumb"
          ? "default"
          : [env.VOID_TUI_MOTION === undefined ? "" : "VOID_TUI_MOTION", env.TERM === "dumb" ? "TERM" : ""]
              .filter(Boolean)
              .join("+"),
    },
    pick("term", "TERM", env.TERM, "unset"),
  ];
}

export async function runConfigCommand(
  argv: readonly string[],
  io: ConfigIo,
  deps: ConfigDeps = {},
): Promise<number> {
  if (argv.length > 0) {
    io.stderr("usage: void config");
    return 2;
  }
  const env = deps.env ?? process.env;
  io.stdout(`version: ${deps.version ?? "unknown"} (package)`);
  for (const entry of resolveConfig(env))
    io.stdout(`${entry.key}: ${entry.value} (${entry.source})`);
  return 0;
}
