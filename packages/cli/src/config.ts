/**
 * Effective configuration printer. Pure resolution over the environment:
 * it never reads encrypted state, never creates directories and never
 * prints secret values, only whether a key is set.
 *
 * Every setting resolves through the shared NOMO-first lookup, and the printed
 * source names the spelling that actually answered. An operator who set
 * `VOID_LEDGER_DIR` before the rename and is reading this output needs to see
 * which of the two names is in force, not which one the code prefers.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir } from "../../ledger/src/paths.ts";
import { envValue, legacyEnvKey, type NomoEnvKey } from "../../ledger/src/env-compat.ts";

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

  /**
   * The name the value came from, or undefined when neither spelling is set.
   * A present current name wins even when empty, which is the same rule
   * `envValue` applies, so the printed source can never disagree with the
   * resolved value.
   */
  const source = (key: NomoEnvKey): string | undefined => {
    if (env[key] !== undefined) return key;
    return env[legacyEnvKey(key)] !== undefined ? legacyEnvKey(key) : undefined;
  };

  const pick = (
    key: string,
    value: string | undefined,
    from: string | undefined,
    fallback: string,
  ): ConfigEntry =>
    value === undefined || value === ""
      ? { key, value: fallback, source: "default" }
      : { key, value, source: from ?? key };

  const workspace = envValue(env, "NOMO_WORKSPACE") ?? "default";
  const tuiColor = envValue(env, "NOMO_TUI_COLOR");
  const tuiMotion = envValue(env, "NOMO_TUI_MOTION");
  const verifyKey = envValue(env, "NOMO_VERIFY_KEY");

  return [
    pick(
      "data-dir",
      envValue(env, "NOMO_DATA_DIR"),
      source("NOMO_DATA_DIR"),
      join(dataDir(home), "workbench"),
    ),
    pick(
      "ledger-dir",
      envValue(env, "NOMO_LEDGER_DIR"),
      source("NOMO_LEDGER_DIR"),
      join(dataDir(home), "ledger"),
    ),
    pick(
      "approvals-dir",
      envValue(env, "NOMO_APPROVALS_DIR"),
      source("NOMO_APPROVALS_DIR"),
      join(dataDir(home), "approvals", workspace),
    ),
    {
      // The value is never printed, so a pinned key in a shell history, a
      // config listing or a pasted bug report cannot leak through this command.
      key: "verify-key",
      value: verifyKey ? "set" : "unset",
      source: source("NOMO_VERIFY_KEY") ?? "default",
    },
    {
      key: "tui-color",
      value: tuiColor === "0" ? "off" : "on",
      source: tuiColor === undefined ? "default" : source("NOMO_TUI_COLOR") ?? "NOMO_TUI_COLOR",
    },
    {
      key: "tui-motion",
      value: tuiMotion === "0" || env.TERM === "dumb" ? "off" : "on",
      source:
        tuiMotion === undefined && env.TERM !== "dumb"
          ? "default"
          : [
              tuiMotion === undefined ? "" : source("NOMO_TUI_MOTION") ?? "NOMO_TUI_MOTION",
              env.TERM === "dumb" ? "TERM" : "",
            ]
              .filter(Boolean)
              .join("+"),
    },
    pick("term", env.TERM, "TERM", "unset"),
  ];
}

export async function runConfigCommand(
  argv: readonly string[],
  io: ConfigIo,
  deps: ConfigDeps = {},
): Promise<number> {
  if (argv.length > 0) {
    io.stderr("usage: nomo config");
    return 2;
  }
  const env = deps.env ?? process.env;
  io.stdout(`version: ${deps.version ?? "unknown"} (package)`);
  for (const entry of resolveConfig(env))
    io.stdout(`${entry.key}: ${entry.value} (${entry.source})`);
  return 0;
}