import { realpath, lstat } from "node:fs/promises";
import {
  dirname,
  basename,
  join,
  relative,
  isAbsolute,
  resolve,
  sep,
} from "node:path";

/** Resolve existing ancestors too, so a new state directory under an alias
 * cannot place signing keys or vault files inside the managed write boundary. */
async function canonicalDestination(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new Error(
          "Recovery state cannot use an unresolved symbolic link.",
        );
    } catch (entryError) {
      if ((entryError as NodeJS.ErrnoException).code !== "ENOENT")
        throw entryError;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalDestination(parent), basename(path));
  }
}

export async function assertRecoveryStateOutsideRoot(
  root: string,
  state: string,
) {
  const rootPath = await realpath(resolve(root));
  const statePath = await canonicalDestination(resolve(state));
  const path = relative(rootPath, statePath);
  if (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  )
    throw new Error(
      "Recovery state must be outside the managed filesystem root.",
    );
}
