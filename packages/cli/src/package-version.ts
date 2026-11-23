/**
 * The one reader of this package's version.
 *
 * Two layouts load this module and only one of them has a manifest above it.
 * In the workspace and in the shipped `dist/`, `packages/cli/package.json` sits
 * one directory above `src/` and above `dist/`, so the manifest is the answer
 * and a version bump needs no rebuild. A bundle built with `--out` to any other
 * directory has no manifest above it, and reading one there answered
 * `--version` with ENOENT. The build therefore replaces `BUNDLED_VERSION` with
 * the manifest's version, which is what an artifact without a manifest answers.
 *
 * Kept in its own module because three call sites need it and none of them
 * should drag the command surface, or its SQLite graph, in to read one field.
 */
import { readFileSync } from "node:fs";

/** Replaced with the manifest version by `rollup.config.mjs` at build time. */
const BUNDLED_VERSION = "__NOMO_BUNDLED_VERSION__";

/**
 * The version, from the manifest when one is reachable and from the build
 * stamp otherwise.
 *
 * Only ENOENT falls back. An unreadable or malformed manifest is a real
 * failure and is reported as one rather than papered over with a stale stamp.
 */
export function packageVersion(): string {
  let meta: { version?: unknown } | undefined;
  try {
    meta = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT")
      throw error;
    return bundledVersion();
  }
  if (typeof meta?.version !== "string" || !meta.version)
    throw Error("Package version is missing.");
  return meta.version;
}

/**
 * The build stamp, refusing the placeholder.
 *
 * A bundle whose replacement never ran is a build defect, not a version, so it
 * fails here instead of printing a token nobody can act on. The prefix test
 * rather than an equality keeps this check working after the replacement: the
 * stamp no longer starts with `__NOMO_`.
 */
function bundledVersion(): string {
  if (BUNDLED_VERSION.startsWith("__NOMO_"))
    throw Error("Package version is missing.");
  return BUNDLED_VERSION;
}
