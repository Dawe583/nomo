import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** Owner-only JSON files under the control-plane data directory.
 *
 * The companion registry is a file store in the same spirit as the approval
 * broker in `packages/policy/src/approvals.ts`: no second database, one atomic
 * temp-plus-rename write, and a mode that keeps credential material unreadable
 * to other local accounts. A malformed file throws instead of being repaired
 * from a guess, because a registry that silently forgot a device would hand
 * authority to whoever pairs next. */
export class CompanionStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CompanionStoreError";
    this.code = code;
  }
}

export function companionDirectory(env: Readonly<NodeJS.ProcessEnv>): string {
  return env.VOID_COMPANION_DIR ?? join(env.VOID_DATA_DIR ?? join(homedir(), ".void"), "companion");
}

/** The workspace is host configuration, never a request field: the protocol
 * derives it from the device credential and the executor it is paired to. */
export function companionWorkspace(env: Readonly<NodeJS.ProcessEnv>): string {
  const workspace = env.VOID_WORKSPACE ?? "default";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(workspace)) throw new CompanionStoreError("invalid_workspace", "invalid companion workspace");
  return workspace;
}

export function readStoreFile(path: string): unknown {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 1024 * 1024) {
    throw new CompanionStoreError("corrupt_store", "companion state requires a bounded owner-only regular file");
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof CompanionStoreError) throw error;
    throw new CompanionStoreError("corrupt_store", "companion state is not readable JSON");
  }
}

export function writeStoreFile(path: string, value: unknown): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    const handle = openSync(directory, "r");
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* Rename may already have committed. */
    }
    throw error;
  }
}
