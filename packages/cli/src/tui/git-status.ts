import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

/**
 * What the Chat location segment is allowed to say about git.
 *
 * The branch and the dirty flag are read with two read-only git commands and
 * nothing else: no `.git` internals are parsed, no refs are resolved by hand
 * and no write command is ever run. `GIT_OPTIONAL_LOCKS=0` keeps `status`
 * from refreshing the index, which is the one write a plain `git status` can
 * otherwise make.
 */
export type GitStatus = { readonly branch: string; readonly dirty: boolean };

/** A branch label is printable ASCII, capped so it cannot flood a footer. */
export const MAX_BRANCH_CHARS = 32;
/** Each probe is bounded: a hung git never holds a frame or a test open. */
const GIT_TIMEOUT_MS = 1000;
/** `status --porcelain` in a large tree is bounded rather than unbounded. */
const MAX_GIT_OUTPUT_BYTES = 256 * 1024;
/** A frame reads the cache; a stale entry is refreshed behind it. */
const CACHE_TTL_MS = 2000;
/** The cwd is stable per session, so a tiny cache is enough and bounded. */
const CACHE_LIMIT = 8;

const runGit = promisify(execFile);
const cache = new Map<string, { status: GitStatus | null; at: number }>();
const inFlight = new Map<string, Promise<GitStatus | null>>();

/**
 * A branch label safe to print: printable ASCII only, trimmed, capped.
 *
 * Anything outside that range becomes `?`, which matches how the renderer
 * treats hostile text everywhere else: it stays visible as odd data instead of
 * disappearing or being interpreted by the terminal.
 */
export function sanitizeBranch(value: string): string {
  const printable = value.trim().replace(/[^\x20-\x7e]/g, "?");
  return printable.length > MAX_BRANCH_CHARS
    ? printable.slice(0, MAX_BRANCH_CHARS)
    : printable;
}

/**
 * The directory a probe may run in, or `null` when the value is not one.
 *
 * The path must be absolute and an existing directory. This runs before any
 * spawn so a caller cannot point the probe at a file or a relative path that
 * git would resolve against an unrelated cwd.
 */
function probeDirectory(cwd: string): string | null {
  if (typeof cwd !== "string" || cwd === "" || !isAbsolute(cwd)) return null;
  try {
    return statSync(cwd).isDirectory() ? cwd : null;
  } catch {
    return null;
  }
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runGit("git", [...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      // Both keep the probe a pure read: no index refresh and no credential
      // prompt waiting on a terminal the frame does not own.
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  const { stdout } = result as { stdout: string };
  return String(stdout ?? "");
}

async function probe(cwd: string): Promise<GitStatus | null> {
  try {
    const [branchOut, statusOut] = await Promise.all([
      gitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
      gitOutput(cwd, ["status", "--porcelain"]),
    ]);
    const branch = sanitizeBranch(branchOut);
    if (branch === "") return null;
    return { branch, dirty: statusOut.trim() !== "" };
  } catch {
    // A missing git, a timeout, a non-repository or an over-limit output all
    // mean the same thing to the frame: no branch to print.
    return null;
  }
}

function remember(cwd: string, status: GitStatus | null): void {
  if (!cache.has(cwd) && cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cwd, { status, at: Date.now() });
}

/**
 * Read the branch and dirty state, or `null` when git cannot answer.
 *
 * Results are cached per directory for two seconds. A concurrent caller joins
 * the probe already in flight instead of spawning a second git.
 */
export async function readGitStatus(cwd: string): Promise<GitStatus | null> {
  const directory = probeDirectory(cwd);
  if (directory === null) return null;
  const hit = cache.get(directory);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.status;
  const pending = inFlight.get(directory);
  if (pending) return pending;
  const run = probe(directory)
    .then((status) => {
      remember(directory, status);
      return status;
    })
    .finally(() => {
      inFlight.delete(directory);
    });
  inFlight.set(directory, run);
  return run;
}

/**
 * The cached answer for a frame, without waiting for git.
 *
 * `undefined` means nothing has been probed yet, so the frame omits the
 * branch this frame. `null` means git answered with no status, so the frame
 * prints the directory alone. A stale entry is returned as-is while a refresh
 * runs behind it, which keeps the frame synchronous and the footer stable.
 */
export function cachedGitStatus(cwd: string): GitStatus | null | undefined {
  const directory = probeDirectory(cwd);
  if (directory === null) return null;
  const hit = cache.get(directory);
  if (!hit) {
    void readGitStatus(directory);
    return undefined;
  }
  if (Date.now() - hit.at >= CACHE_TTL_MS) void readGitStatus(directory);
  return hit.status;
}

/** Fill the cache before a frame that must show the branch, e.g. in tests. */
export async function primeGitStatus(cwd: string): Promise<GitStatus | null> {
  return readGitStatus(cwd);
}

/** Forget every probe result. Tests use this; a session never needs it. */
export function resetGitStatusCache(): void {
  cache.clear();
}
