/**
 * Workspace install guard.
 *
 * Two jobs, in Node rather than `sh -c`, because the previous one-line shell
 * form made `pnpm install` fail on a machine with no POSIX shell. A Windows
 * contributor without Git Bash could not install the workspace at all, which
 * contradicts docs/WINDOWS-DESKTOP.md and hid the real Windows defects behind
 * an install error. The GitHub windows runners ship Git Bash, so CI never saw
 * it and the product looked portable when it was not.
 */

import { rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");

// A committed npm or yarn lockfile would let a second package manager resolve
// the workspace differently from pnpm-workspace.yaml, so refuse to keep one.
for (const stray of ["package-lock.json", "yarn.lock"]) {
  rmSync(resolve(root, stray), { force: true });
}

const agent = process.env.npm_config_user_agent ?? "";
if (agent && !agent.startsWith("pnpm/")) {
  process.stderr.write(`Use pnpm instead. Detected: ${agent}\n`);
  process.exit(1);
}
