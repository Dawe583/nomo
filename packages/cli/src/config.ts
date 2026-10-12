/**
 * Effective configuration printer. Pure resolution over the environment:
 * it never reads encrypted state, never creates directories and never
 * prints secret values, only whether a key is set.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { configuredEnvEntry } from "../../ledger/src/env-compat.ts";

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
    selected: { readonly name: string; readonly value: string } | undefined,
    fallback: string,
  ): ConfigEntry =>
    selected === undefined
      ? { key, value: fallback, source: "default" }
      : { key, value: selected.value, source: selected.name };
  const motion = configuredEnvEntry(env, "NOMO_TUI_MOTION");
  const workspace = configuredEnvEntry(env, "NOMO_WORKSPACE")?.value ?? "default";
  const verifyKey = configuredEnvEntry(env, "NOMO_VERIFY_KEY");
  const color = configuredEnvEntry(env, "NOMO_TUI_COLOR");
  return [
    pick("data-dir", configuredEnvEntry(env, "NOMO_DATA_DIR"), join(home, ".void", "workbench")),
    pick("ledger-dir", configuredEnvEntry(env, "NOMO_LEDGER_DIR"), join(home, ".void", "ledger")),
    pick(
      "approvals-dir",
      configuredEnvEntry(env, "NOMO_APPROVALS_DIR"),
      join(home, ".void", "approvals", workspace),
    ),
    {
      key: "verify-key",
      value: verifyKey?.value ? "set" : "unset",
      source: verifyKey?.name ?? "default",
    },
    {
      key: "tui-color",
      value: color?.value === "0" ? "off" : "on",
      source: color?.name ?? "default",
    },
    {
      key: "tui-motion",
      value: motion?.value === "0" || env.TERM === "dumb" ? "off" : "on",
      source:
        motion === undefined && env.TERM !== "dumb"
          ? "default"
          : [motion?.name ?? "", env.TERM === "dumb" ? "TERM" : ""]
              .filter(Boolean)
              .join("+"),
    },
    pick("term", configuredEnvEntry(env, "TERM"), "unset"),
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
