/**
 * Project context files are the harness instructions a project carries at its
 * root. They are read from the protected baseline of the filtered copy, never
 * from the agent-writable source copy, so a session cannot edit what the next
 * request is told about the project.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProjectWorkspaceManifest } from "./project-workspace.ts";

export const PROJECT_CONTEXT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/** Matches the project skills bound, so both prompt sources share one limit. */
const MAX_FILE_BYTES = 32_768;

export type ProjectContextFile = {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly content: string;
};

export type RefusedProjectContextFile = {
  readonly path: string;
  readonly reason: string;
};

export type ProjectContextFiles = {
  readonly files: ProjectContextFile[];
  readonly refused: RefusedProjectContextFile[];
};

type BaselineRead =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: string };

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/**
 * `copyRoot` is the filtered project copy that holds the writable `source` and
 * the `control` metadata, so the baseline sits beside the source, not inside it.
 */
async function baselineRoot(copyRoot: string): Promise<string> {
  const copyInfo = await lstat(copyRoot);
  if (copyInfo.isSymbolicLink() || !copyInfo.isDirectory())
    throw new Error("Project copy root must be a real directory.");
  const copy = await realpath(copyRoot);
  const baseline = join(copy, "control", "baseline");
  let info;
  try {
    info = await lstat(baseline);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("Project copy has no protected baseline.");
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error("Project copy baseline must be a real directory.");
  return baseline;
}

async function readBaselineFile(baseline: string, name: string): Promise<BaselineRead> {
  const target = join(baseline, name);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ok: false, reason: "is listed in the workspace manifest but missing from the project copy" };
    throw error;
  }
  if (info.isSymbolicLink())
    return { ok: false, reason: "is a symlink in the project copy" };
  if (!info.isFile())
    return { ok: false, reason: "is not a regular file in the project copy" };
  if (info.size > MAX_FILE_BYTES)
    return { ok: false, reason: `exceeds the ${MAX_FILE_BYTES} byte limit` };
  if (!isWithin(baseline, await realpath(target)))
    return { ok: false, reason: "resolves outside the project copy" };
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino)
      return { ok: false, reason: "changed while it was being read" };
    const bytes = await handle.readFile();
    if (bytes.length > MAX_FILE_BYTES || bytes.length !== info.size)
      return { ok: false, reason: "changed while it was being read" };
    return { ok: true, bytes };
  } finally {
    await handle.close();
  }
}

/**
 * The copy omits symlinks, so a symlinked context file never reaches the
 * manifest. Naming it here is the only way an operator learns it was skipped.
 */
async function originalRootRefusal(
  projectRoot: string,
  name: string,
): Promise<string | undefined> {
  if (typeof projectRoot !== "string" || !projectRoot) return undefined;
  let info;
  try {
    info = await lstat(resolve(projectRoot, name));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
  if (info.isSymbolicLink())
    return "is a symlink in the project root, so the filtered project copy omits it";
  if (!info.isFile())
    return "is not a regular file in the project root, so the filtered project copy omits it";
  // A regular file outside the manifest was untracked or ignored by Git, which
  // the copy leaves out by design rather than by refusal.
  return undefined;
}

export async function readProjectContextFiles(input: {
  readonly projectRoot: string;
  readonly copyRoot: string;
  readonly manifest: ProjectWorkspaceManifest;
}): Promise<ProjectContextFiles> {
  const baseline = await baselineRoot(input.copyRoot);
  const listed = new Map(input.manifest.files.map((file) => [file.path, file]));
  const files: ProjectContextFile[] = [];
  const refused: RefusedProjectContextFile[] = [];
  for (const name of PROJECT_CONTEXT_FILE_NAMES) {
    const recorded = listed.get(name);
    if (!recorded) {
      const reason = await originalRootRefusal(input.projectRoot, name);
      if (reason) refused.push({ path: name, reason });
      continue;
    }
    const read = await readBaselineFile(baseline, name);
    if (!read.ok) {
      refused.push({ path: name, reason: read.reason });
      continue;
    }
    const bytes = read.bytes;
    if (bytes.length !== recorded.size || hash(bytes) !== recorded.sha256) {
      refused.push({ path: name, reason: "does not match the workspace manifest size or digest" });
      continue;
    }
    const content = bytes.toString("utf8");
    if (
      !Buffer.from(content, "utf8").equals(bytes) ||
      CONTROL_CHARACTERS.test(content)
    ) {
      refused.push({ path: name, reason: "is not valid UTF-8 Markdown without control characters" });
      continue;
    }
    files.push({ path: name, sha256: recorded.sha256, size: bytes.length, content });
  }
  return { files, refused };
}
