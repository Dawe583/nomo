import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Return a shell-free npm invocation. Windows exposes npm.cmd, so run its
 * JavaScript entrypoint with Node instead of passing argument arrays to cmd.
 */
export function npmInvocation(args) {
  if (process.platform !== "win32") return { command: "npm", args };

  const shim = execFileSync("where.exe", ["npm.cmd"], { encoding: "utf8" })
    .split(/\r?\n/, 1)[0]
    ?.trim();
  if (!shim) throw new Error("Could not resolve npm.cmd on PATH.");

  const source = readFileSync(shim, "utf8");
  const configuredCli = source.match(/^\s*SET "NPM_CLI_JS=([^"]+)"/im)?.[1];
  if (!configuredCli)
    throw new Error("Could not find NPM_CLI_JS in " + shim + ".");

  const relativeCli = configuredCli.replace(/^%~dp0[\\/]/i, "");
  const cli = resolve(dirname(shim), relativeCli);
  if (!existsSync(cli))
    throw new Error("npm CLI entrypoint does not exist: " + cli);
  return { command: process.execPath, args: [cli, ...args] };
}
