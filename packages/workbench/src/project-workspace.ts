/**
 * The sandbox gets a disposable copy so commands cannot read or write the host
 * project directly; control metadata stays outside the bind mount.
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  link,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  readdir,
  type FileHandle,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { dataDir } from "../../ledger/src/paths.ts";
import { canonicalProjectRoot } from "./project-sandbox.ts";

export const PROJECT_WORKSPACE_LIMITS = {
  files: 100_000,
  fileBytes: 32 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
} as const;

export type ProjectWorkspaceManifestFile = {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: number;
};

export type ProjectWorkspaceManifest = {
  readonly version: 1;
  readonly rootDigest: string;
  readonly displayName: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: readonly ProjectWorkspaceManifestFile[];
};

export type ProjectWorkspace = {
  readonly root: string;
  readonly rootDigest: string;
  readonly displayName: string;
  readonly directory: string;
  readonly source: string;
  readonly control: string;
  readonly ownerPath: string;
  readonly manifestPath: string;
  readonly backups: string;
  readonly manifest: ProjectWorkspaceManifest;
  readonly baseline: string;
};
type ProjectWorkspaceLock = {
  readonly path: string;
  readonly content: string;
  readonly handle: FileHandle;
  readonly identity: Stats;
};
export type ProjectWorkspaceChange = {
  readonly path: string;
  readonly operation: "add" | "update" | "delete";
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly digest: string;
};
export type ProjectWorkspaceStatus = {
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
  readonly changes: readonly ProjectWorkspaceChange[];
};
export class ProjectWorkspaceConflictError extends Error {
  readonly code = "PROJECT_WORKSPACE_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "ProjectWorkspaceConflictError";
  }
}
export type ProjectWorkspaceCatalogEntry = {
  readonly rootDigest: string;
  readonly displayName: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly hasChanges: boolean;
  readonly requiresConfirmation: true;
};

export class ProjectWorkspaceLimitError extends Error {
  readonly code = "PROJECT_WORKSPACE_LIMIT";
  constructor(message: string) {
    super(message);
    this.name = "ProjectWorkspaceLimitError";
  }
}
export function isAllowedProjectWorkspacePath(path: string): boolean {
  return path.length <= 4096 && isValidRelativePath(path) && !isProtectedProjectPath(path);
}

export const PROJECT_CHANGES_TOOL = {
  name: "nomo_project_changes",
  description: "Read-only status or one-file diff for the explicitly approved filtered project copy.",
  inputSchema: {
    type: "object",
    oneOf: [
      {
        type: "object",
        properties: { operation: { type: "string", const: "status" } },
        required: ["operation"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          operation: { type: "string", const: "diff" },
          path: { type: "string" },
        },
        required: ["operation", "path"],
        additionalProperties: false,
      },
    ],
  },
} as const;

export function assertProjectWorkspaceLimits(
  fileCount: number,
  fileBytes: number,
  totalBytes: number,
): void {
  if (
    !Number.isSafeInteger(fileCount) ||
    !Number.isSafeInteger(fileBytes) ||
    !Number.isSafeInteger(totalBytes) ||
    fileCount < 0 ||
    fileBytes < 0 ||
    totalBytes < 0
  ) throw new Error("Project workspace sizes must be non-negative safe integers.");
  if (fileCount > PROJECT_WORKSPACE_LIMITS.files)
    throw new ProjectWorkspaceLimitError("Project contains too many permitted files.");
  if (fileBytes > PROJECT_WORKSPACE_LIMITS.fileBytes)
    throw new ProjectWorkspaceLimitError("Project file exceeds the per-file limit.");
  if (totalBytes > PROJECT_WORKSPACE_LIMITS.totalBytes)
    throw new ProjectWorkspaceLimitError("Project exceeds the total workspace size limit.");
}
const VCS_DIRECTORIES: Readonly<Record<string, true>> = {
  ".git": true,
  ".hg": true,
  ".svn": true,
  ".bzr": true,
  "_darcs": true,
};
const BUILD_DIRECTORIES: Readonly<Record<string, true>> = {
  "node_modules": true,
  ".next": true,
  "dist": true,
  "build": true,
  "target": true,
  ".cache": true,
  "coverage": true,
};
const SECRET_EXTENSIONS: Readonly<Record<string, true>> = {
  ".pem": true,
  ".key": true,
  ".p12": true,
  ".pfx": true,
  ".jks": true,
  ".keystore": true,
  ".token": true,
  ".secret": true,
};
const CONTROL_METADATA_VERSION = 1;
const gitPathDecoder = new TextDecoder("utf-8", { fatal: true });

export async function createProjectWorkspace(input: {
  readonly projectRoot: string;
  readonly dataRoot: string;
}): Promise<ProjectWorkspace> {
  const root = await canonicalProjectRoot(input.projectRoot);
  const rootDigest = `sha256:${createHash("sha256").update(root).digest("hex")}`;
  const displayName = basename(root);
  const dataRoot = await ensureDataRoot(input.dataRoot);
  if (isWithin(root, dataRoot) || isWithin(dataRoot, root))
    throw new Error("Project and Workbench data roots must not overlap.");
  const workspacesRoot = join(dataRoot, "project-workspaces");
  await mkdir(workspacesRoot, { recursive: true, mode: 0o700 });
  const workspaceRoot = await realpath(workspacesRoot);
  if (workspaceRoot !== workspacesRoot)
    throw new Error("Project workspace storage must not be a symlink.");
  if (process.platform !== "win32") await chmod(workspacesRoot, 0o700);
  const hex = rootDigest.slice("sha256:".length);
  const directory = join(workspacesRoot, hex);

  if (await exists(directory)) return loadProjectWorkspace(root, directory, rootDigest);

  const lockPath = join(workspacesRoot, `.${hex}.lock`);
  const lock = await acquireProjectWorkspaceLock(lockPath);
  let staging: string | undefined;
  try {
    if (await exists(directory)) return loadProjectWorkspace(root, directory, rootDigest);
    const rootStat = await stat(root);
    const paths = await listGitPaths(root);
    if (paths.length > PROJECT_WORKSPACE_LIMITS.files)
      throw new ProjectWorkspaceLimitError("Project contains too many Git entries.");
    staging = await mkdtemp(join(workspacesRoot, `.${hex}.`));
    const source = join(staging, "source");
    const control = join(staging, "control");
    const backups = join(control, "backups");
    const baseline = join(control, "baseline");
    await mkdir(source, { mode: 0o700 });
    await mkdir(control, { mode: 0o700 });
    await mkdir(backups, { mode: 0o700 });
    await mkdir(baseline, { mode: 0o700 });

    const files: ProjectWorkspaceManifestFile[] = [];
    let totalBytes = 0;
    for (const path of paths) {
      if (isProtectedProjectPath(path)) continue;
      const sourceFile = await readRegularProjectFile(root, path, rootStat.dev);
      if (!sourceFile) continue;
      const nextTotalBytes = totalBytes + sourceFile.bytes.length;
      assertProjectWorkspaceLimits(files.length + 1, sourceFile.bytes.length, nextTotalBytes);
      totalBytes = nextTotalBytes;
      const destination = join(source, ...path.split("/"));
      const destinationDirectory = join(destination, "..");
      await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
      const handle = await open(destination, "wx", 0o600);
      try {
        await handle.writeFile(sourceFile.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const baselineFile = join(baseline, ...path.split("/"));
      await mkdir(join(baselineFile, ".."), { recursive: true, mode: 0o700 });
      await writePrivateBytes(baselineFile, sourceFile.bytes);
      files.push({
        path,
        sha256: hash(sourceFile.bytes),
        size: sourceFile.bytes.length,
        mode: sourceFile.mode,
      });
    }

    const manifest: ProjectWorkspaceManifest = {
      version: 1,
      rootDigest,
      displayName,
      fileCount: files.length,
      totalBytes,
      files,
    };
    const manifestPath = join(control, "manifest.json");
    const ownerPath = join(control, "owner.json");
    await writePrivateFile(manifestPath, JSON.stringify(manifest));
    await writePrivateFile(
      ownerPath,
      JSON.stringify({ version: CONTROL_METADATA_VERSION, rootDigest }),
    );
    await rename(staging, directory);
    staging = undefined;
    return loadProjectWorkspace(root, directory, rootDigest);
  } catch (error) {
    if (staging) await rm(staging, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && await exists(directory))
      return loadProjectWorkspace(root, directory, rootDigest);
    throw error;
  } finally {
    await releaseProjectWorkspaceLock(lock);
  }
}

export async function withProjectWorkspaceLock<T>(
  workspace: ProjectWorkspace,
  operation: (workspace: ProjectWorkspace) => Promise<T>,
): Promise<T> {
  const root = await canonicalProjectRoot(workspace.root);
  const rootDigest = `sha256:${createHash("sha256").update(root).digest("hex")}`;
  const hex = rootDigest.slice("sha256:".length);
  const directory = resolve(workspace.directory);
  if (
    root !== workspace.root ||
    rootDigest !== workspace.rootDigest ||
    basename(directory) !== hex
  ) throw new ProjectWorkspaceConflictError("Confirmed project workspace changed.");
  const parent = await realpath(dirname(directory));
  if (join(parent, hex) !== directory)
    throw new Error("Project workspace directory is not canonical.");
  const lock = await acquireProjectWorkspaceLock(join(parent, `.${hex}.lock`));
  try {
    const current = await loadProjectWorkspace(root, directory, rootDigest);
    return await operation(current);
  } finally {
    await releaseProjectWorkspaceLock(lock);
  }
}

export async function projectWorkspaceStatus(
  workspace: ProjectWorkspace,
): Promise<ProjectWorkspaceStatus> {
  return withProjectWorkspaceLock(workspace, collectProjectWorkspaceStatus);
}

export async function listProjectWorkspaces(
  dataRoot: string,
): Promise<readonly ProjectWorkspaceCatalogEntry[]> {
  const root = await ensureDataRoot(dataRoot);
  const workspacesRoot = join(root, "project-workspaces");
  if (!await exists(workspacesRoot)) return [];
  const canonical = await realpath(workspacesRoot);
  if (canonical !== workspacesRoot)
    throw new Error("Project workspace storage must not be a symlink.");
  if (process.platform !== "win32") await chmod(workspacesRoot, 0o700);
  const entries: ProjectWorkspaceCatalogEntry[] = [];
  for (const entry of await readdir(workspacesRoot, { withFileTypes: true })) {
    if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
    if (!entry.isDirectory())
      throw new Error("Saved project workspace directory is invalid.");
    const rootDigest = `sha256:${entry.name}`;
    const directory = join(workspacesRoot, entry.name);
    const lock = await acquireProjectWorkspaceLock(
      join(workspacesRoot, `.${entry.name}.lock`),
    );
    try {
      const workspace = await loadProjectWorkspace("", directory, rootDigest);
      const status = await collectProjectWorkspaceStatus(workspace);
      entries.push({
        rootDigest,
        displayName: workspace.displayName,
        fileCount: workspace.manifest.fileCount,
        totalBytes: workspace.manifest.totalBytes,
        hasChanges: status.changes.length > 0,
        requiresConfirmation: true,
      });
    } finally {
      await releaseProjectWorkspaceLock(lock);
    }
  }
  return entries.sort((left, right) =>
    left.displayName.localeCompare(right.displayName) ||
    left.rootDigest.localeCompare(right.rootDigest),
  );
}

export async function deleteProjectWorkspace(
  dataRoot: string,
  rootDigest: string,
): Promise<void> {
  const match = /^sha256:([a-f0-9]{64})$/.exec(rootDigest);
  if (!match) throw new Error("Project workspace digest is invalid.");
  const root = await ensureDataRoot(dataRoot);
  const workspacesRoot = join(root, "project-workspaces");
  if (!await exists(workspacesRoot))
    throw new Error("Saved project workspace does not exist.");
  const canonical = await realpath(workspacesRoot);
  if (canonical !== workspacesRoot)
    throw new Error("Project workspace storage must not be a symlink.");
  const directory = join(workspacesRoot, match[1]!);
  const lock = await acquireProjectWorkspaceLock(
    join(workspacesRoot, `.${match[1]}.lock`),
  );
  try {
    await loadProjectWorkspace("", directory, rootDigest);
    await rm(directory, { recursive: true });
  } finally {
    await releaseProjectWorkspaceLock(lock);
  }
}

export async function projectWorkspaceDiff(
  workspace: ProjectWorkspace,
  path: string,
  maxBytes = 32_768,
): Promise<{ readonly digest: string; readonly file: ProjectWorkspaceChange & { readonly diff: string } }> {
  return withProjectWorkspaceLock(workspace, async (current) => {
    if (!isValidRelativePath(path) || isProtectedProjectPath(path))
      throw new Error("Project diff path is not permitted.");
    const status = await collectProjectWorkspaceStatus(current);
    const change = status.changes.find((item) => item.path === path);
    if (!change) throw new ProjectWorkspaceConflictError("Project file has no pending change.");
    const baseline = current.manifest.files.find((file) => file.path === path);
    const baselineRoot = await stat(current.baseline);
    const before = baseline
      ? await readRegularProjectFile(current.baseline, path, baselineRoot.dev)
      : undefined;
    if (baseline && (!before || hash(before.bytes) !== baseline.sha256))
      throw new Error("Project workspace baseline failed verification.");
    const sourceRoot = await stat(current.source);
    const after = change.operation === "delete"
      ? undefined
      : await readRegularProjectFile(current.source, path, sourceRoot.dev);
    if (change.operation !== "delete" && !after)
      throw new ProjectWorkspaceConflictError("Project file changed while its diff was read.");
    const diff = unifiedProjectDiff(path, before?.bytes ?? Buffer.alloc(0), after?.bytes ?? Buffer.alloc(0), maxBytes);
    return { digest: change.digest, file: { ...change, diff } };
  });
}

export async function applyProjectWorkspaceChange(
  workspace: ProjectWorkspace,
  path: string,
  digest: string,
): Promise<{ readonly path: string; readonly operation: ProjectWorkspaceChange["operation"]; readonly alreadyApplied: boolean }> {
  return withProjectWorkspaceLock(workspace, async (current) => {
    if (!isValidRelativePath(path) || isProtectedProjectPath(path))
      throw new Error("Project apply path is not permitted.");
    if (!/^[a-f0-9]{64}$/.test(digest))
      throw new ProjectWorkspaceConflictError("Project change digest is invalid or stale.");
    const status = await collectProjectWorkspaceStatus(current);
    const change = status.changes.find((item) => item.path === path);
    if (!change || change.digest !== digest)
      throw new ProjectWorkspaceConflictError("Project change digest is stale.");
    const original = await readOriginalProjectFile(current.root, path);
    const originalHash = original ? hash(original.bytes) : null;
    if (originalHash === change.afterHash)
      return { path, operation: change.operation, alreadyApplied: true };
    if (originalHash !== change.beforeHash)
      throw new ProjectWorkspaceConflictError("Original project file changed after review.");

    if (original) {
      const backupPath = join(current.backups, `${hash(Buffer.from(change.digest))}.bak`);
      if (await exists(backupPath)) {
        const backup = await readRegularProjectFile(
          current.backups,
          basename(backupPath),
          (await stat(current.backups)).dev,
        );
        if (!backup || hash(backup.bytes) !== change.beforeHash)
          throw new Error("Project apply backup failed verification.");
      } else {
        await writePrivateBytes(backupPath, original.bytes);
        const backup = await readRegularProjectFile(
          current.backups,
          basename(backupPath),
          (await stat(current.backups)).dev,
        );
        if (!backup || hash(backup.bytes) !== change.beforeHash)
          throw new Error("Project apply backup failed verification.");
      }
    }

    const target = join(current.root, ...path.split("/"));
    if (change.operation === "delete") {
      await rm(target);
      return { path, operation: change.operation, alreadyApplied: false };
    }
    const sourceRoot = await stat(current.source);
    const edited = await readRegularProjectFile(current.source, path, sourceRoot.dev);
    if (!edited || hash(edited.bytes) !== change.afterHash)
      throw new ProjectWorkspaceConflictError("Project workspace file changed after review.");
    await ensureProjectParentDirectories(current.root, path);
    const parent = dirname(target);
    const temporary = join(parent, `.nomo-${randomBytes(16).toString("hex")}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(edited.bytes);
        await handle.chmod(original?.mode ?? edited.mode);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (change.operation === "add") {
        await link(temporary, target);
      } else {
        await rename(temporary, target);
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return { path, operation: change.operation, alreadyApplied: false };
  });
}

async function readOriginalProjectFile(
  root: string,
  path: string,
): Promise<{ readonly bytes: Buffer; readonly mode: number } | undefined> {
  const rootInfo = await stat(root);
  let parent = root;
  for (const segment of path.split("/").slice(0, -1)) {
    parent = join(parent, segment);
    let info: Stats;
    try {
      info = await lstat(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== rootInfo.dev)
      throw new ProjectWorkspaceConflictError("Original project path is not a regular directory.");
    if (!isWithin(root, await realpath(parent)))
      throw new ProjectWorkspaceConflictError("Original project path escapes its root.");
  }
  const target = join(root, ...path.split("/"));
  let info: Stats;
  try {
    info = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.dev !== rootInfo.dev ||
    info.nlink > 1
  ) throw new ProjectWorkspaceConflictError("Original project file is not a safe regular file.");
  const file = await readRegularProjectFile(root, path, rootInfo.dev);
  if (!file) throw new ProjectWorkspaceConflictError("Original project file changed during review.");
  return file;
}

async function ensureProjectParentDirectories(root: string, path: string): Promise<void> {
  let parent = root;
  for (const segment of path.split("/").slice(0, -1)) {
    parent = join(parent, segment);
    try {
      await mkdir(parent, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory() || !isWithin(root, await realpath(parent)))
      throw new ProjectWorkspaceConflictError("Original project path is not a safe directory.");
  }
}

async function collectProjectWorkspaceStatus(
  workspace: ProjectWorkspace,
): Promise<ProjectWorkspaceStatus> {
  const baseline = new Map(workspace.manifest.files.map((file) => [file.path, file]));
  const sourceRoot = await lstat(workspace.source);
  if (!sourceRoot.isDirectory() || sourceRoot.isSymbolicLink())
    throw new Error("Project workspace source is invalid.");
  const current = new Map<string, { readonly sha256: string; readonly size: number }>();
  const blocked = new Set<string>();
  let totalBytes = 0;
  const visit = async (prefix: string): Promise<void> => {
    const parent = prefix ? join(workspace.source, ...prefix.split("/")) : workspace.source;
    const entries = await readdir(parent, { withFileTypes: true });
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!isValidRelativePath(path) || isProtectedProjectPath(path)) continue;
      const fullPath = join(parent, entry.name);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) {
        blocked.add(path);
        continue;
      }
      if (info.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!info.isFile()) {
        blocked.add(path);
        continue;
      }
      if (current.size >= PROJECT_WORKSPACE_LIMITS.files)
        throw new ProjectWorkspaceLimitError("Project workspace contains too many files.");
      const file = await readRegularProjectFile(workspace.source, path, sourceRoot.dev);
      if (!file) {
        blocked.add(path);
        continue;
      }
      const nextTotalBytes = totalBytes + file.bytes.length;
      assertProjectWorkspaceLimits(current.size + 1, file.bytes.length, nextTotalBytes);
      totalBytes = nextTotalBytes;
      current.set(path, { sha256: hash(file.bytes), size: file.bytes.length });
    }
  };
  await visit("");
  const changes: ProjectWorkspaceChange[] = [];
  const addChange = (
    path: string,
    operation: ProjectWorkspaceChange["operation"],
    beforeHash: string | null,
    afterHash: string | null,
  ) => {
    const digest = hash(Buffer.from(JSON.stringify({
      rootDigest: workspace.rootDigest,
      path,
      operation,
      beforeHash,
      afterHash,
    })));
    changes.push({ path, operation, beforeHash, afterHash, digest });
  };
  for (const [path, original] of baseline) {
    if (isBlockedWorkspacePath(path, blocked)) continue;
    const edited = current.get(path);
    if (!edited) addChange(path, "delete", original.sha256, null);
    else if (edited.sha256 !== original.sha256)
      addChange(path, "update", original.sha256, edited.sha256);
  }
  for (const [path, edited] of current) {
    if (!baseline.has(path)) addChange(path, "add", null, edited.sha256);
  }
  changes.sort((left, right) => left.path.localeCompare(right.path));
  return {
    added: changes.filter((change) => change.operation === "add").length,
    modified: changes.filter((change) => change.operation === "update").length,
    deleted: changes.filter((change) => change.operation === "delete").length,
    changes,
  };
}

function isBlockedWorkspacePath(path: string, blocked: ReadonlySet<string>): boolean {
  let candidate = path;
  while (candidate) {
    if (blocked.has(candidate)) return true;
    const separator = candidate.lastIndexOf("/");
    candidate = separator < 0 ? "" : candidate.slice(0, separator);
  }
  return false;
}

function unifiedProjectDiff(
  path: string,
  beforeBytes: Buffer,
  afterBytes: Buffer,
  maxBytes: number,
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error("Project diff limit must be a positive safe integer.");
  if (beforeBytes.includes(0) || afterBytes.includes(0))
    throw new Error("Binary project files do not support text diffs.");
  let before: string;
  let after: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    before = decoder.decode(beforeBytes);
    after = decoder.decode(afterBytes);
  } catch {
    throw new Error("Binary project files do not support text diffs.");
  }
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++;
  while (prefix > 0 && before[prefix - 1] !== "\n") prefix--;
  let beforeSuffix = before.length;
  let afterSuffix = after.length;
  while (
    beforeSuffix > prefix &&
    afterSuffix > prefix &&
    before[beforeSuffix - 1] === after[afterSuffix - 1]
  ) {
    beforeSuffix--;
    afterSuffix--;
  }
  while (beforeSuffix < before.length && before[beforeSuffix] !== "\n") beforeSuffix++;
  while (afterSuffix < after.length && after[afterSuffix] !== "\n") afterSuffix++;
  if (beforeSuffix < before.length) beforeSuffix++;
  if (afterSuffix < after.length) afterSuffix++;
  const oldPart = before.slice(prefix, beforeSuffix);
  const newPart = after.slice(prefix, afterSuffix);
  if (Buffer.byteLength(oldPart) + Buffer.byteLength(newPart) > maxBytes)
    throw new ProjectWorkspaceLimitError("Project diff exceeds the output limit.");
  const oldLines = diffLines(oldPart);
  const newLines = diffLines(newPart);
  const oldLine = countLines(before.slice(0, prefix)) + 1;
  const newLine = countLines(after.slice(0, prefix)) + 1;
  const hunk = `@@ -${oldLine},${oldLines.length} +${newLine},${newLines.length} @@\n`;
  const text = [
    `--- a/${path}`,
    `+++ b/${path}`,
    hunk.trimEnd(),
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n") + "\n";
  if (Buffer.byteLength(text, "utf8") > maxBytes)
    throw new ProjectWorkspaceLimitError("Project diff exceeds the output limit.");
  return text;
}

function diffLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function countLines(text: string): number {
  let count = 0;
  for (const character of text) if (character === "\n") count++;
  return count;
}
async function acquireProjectWorkspaceLock(path: string): Promise<ProjectWorkspaceLock> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = JSON.stringify({
      host: hostname(),
      pid: process.pid,
      nonce: randomBytes(16).toString("hex"),
    });
    let handle: FileHandle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw error;
      if (attempt === 0 && await reclaimStaleProjectWorkspaceLock(path)) continue;
      throw new Error("Project workspace is being prepared by another process.");
    }
    const identity = await handle.stat();
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
      return { path, content, handle, identity };
    } catch (error) {
      await handle.close();
      await removeProjectWorkspaceLock(path, identity);
      throw error;
    }
  }
  throw new Error("Project workspace could not be locked.");
}

async function reclaimStaleProjectWorkspaceLock(path: string): Promise<boolean> {
  let content: string;
  try {
    content = await readPrivateRegularFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
  let owner: unknown;
  try {
    owner = JSON.parse(content);
  } catch {
    return false;
  }
  if (
    !owner ||
    typeof owner !== "object" ||
    !("host" in owner) ||
    owner.host !== hostname() ||
    !("pid" in owner) ||
    typeof owner.pid !== "number" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid < 1 ||
    !("nonce" in owner) ||
    typeof owner.nonce !== "string" ||
    !/^[a-f0-9]{32}$/.test(owner.nonce)
  ) return false;
  if (processIsAlive(owner.pid)) return false;
  const identity = await lstat(path);
  if (identity.isSymbolicLink() || !identity.isFile()) return false;
  return removeProjectWorkspaceLock(path, identity, content);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function releaseProjectWorkspaceLock(lock: ProjectWorkspaceLock): Promise<void> {
  await lock.handle.close();
  await removeProjectWorkspaceLock(lock.path, lock.identity, lock.content);
}

async function removeProjectWorkspaceLock(
  path: string,
  identity: Stats,
  expectedContent?: string,
): Promise<boolean> {
  try {
    const current = await lstat(path);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    ) return false;
    if (expectedContent !== undefined && await readFile(path, "utf8") !== expectedContent)
      return false;
    await rm(path, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensureDataRoot(raw: string): Promise<string> {
  if (typeof raw !== "string" || !raw || /[\u0000-\u001f\u007f]/.test(raw))
    throw new Error("A valid Workbench data root is required.");
  const requested = resolve(raw);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const root = await realpath(requested);
  if (!(await stat(root)).isDirectory())
    throw new Error("Workbench data root must be a directory.");
  if (process.platform === "win32") {
    const userDataRoot = await realpath(dataDir(homedir()));
    if (!isWithin(userDataRoot, root))
      throw new Error("Windows project workspaces must be stored under the user's NOMO data directory.");
  }
  return root;
}

async function listGitPaths(root: string): Promise<string[]> {
  const env = isolatedGitEnvironment();
  try {
    const gitRoot = execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"],
      { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8_192 },
    ).trimEnd();
    if (await realpath(gitRoot) !== root)
      throw new Error("not a Git root");
  } catch {
    throw new Error("Selected project must be the root of its Git working tree.");
  }

  const child = spawn(
    "git",
    ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const paths: string[] = [];
  let pending = Buffer.alloc(0);
  let parseError: Error | undefined;
  child.stdout.on("data", (chunk: Buffer) => {
    if (parseError) return;
    const combined = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    for (let index = 0; index < combined.length; index++) {
      if (combined[index] !== 0) continue;
      if (paths.length >= PROJECT_WORKSPACE_LIMITS.files) {
        parseError = new ProjectWorkspaceLimitError("Project contains too many Git entries.");
        child.kill("SIGTERM");
        return;
      }
      let path: string;
      try {
        path = gitPathDecoder.decode(combined.subarray(start, index));
      } catch {
        parseError = new Error("Git paths must be valid UTF-8.");
        child.kill("SIGTERM");
        return;
      }
      if (!isValidRelativePath(path)) {
        parseError = new Error("Git returned an unsupported project path.");
        child.kill("SIGTERM");
        return;
      }
      paths.push(path);
      start = index + 1;
    }
    pending = Buffer.from(combined.subarray(start));
    if (pending.length > 4_096) {
      parseError = new Error("Git returned a project path that is too long.");
      child.kill("SIGTERM");
    }
  });
  child.stderr.resume();
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? -1));
  });
  if (parseError) throw parseError;
  if (exitCode !== 0 || pending.length !== 0)
    throw new Error("Could not safely enumerate the selected Git project.");
  paths.sort();
  return paths;
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CEILING_DIRECTORIES",
    "GIT_EXEC_PATH",
    "GIT_CONFIG_PARAMETERS",
  ]) delete env[key];
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_TRACE")) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_CONFIG_COUNT = "3";
  env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
  env.GIT_CONFIG_VALUE_0 = "false";
  env.GIT_CONFIG_KEY_1 = "core.untrackedCache";
  env.GIT_CONFIG_VALUE_1 = "false";
  env.GIT_CONFIG_KEY_2 = "credential.helper";
  env.GIT_CONFIG_VALUE_2 = "";
  return env;
}

function isValidRelativePath(path: string): boolean {
  if (!path || /[\u0000-\u001f\u007f\\]/.test(path) || isAbsolute(path)) return false;
  if (/^[a-z]:/i.test(path)) return false;
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  if (process.platform === "win32") {
    const reservedDevice = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
    if (parts.some((part) =>
      /[<>:"|?*]/.test(part) ||
      /[. ]$/.test(part) ||
      reservedDevice.test(part)
    )) return false;
  }
  return true;
}

function isProtectedProjectPath(path: string): boolean {
  if (!isValidRelativePath(path)) return true;
  const normalized = path.toLowerCase();
  const parts = normalized.split("/");
  const base = parts.at(-1)!;
  if (parts.some((part) => VCS_DIRECTORIES[part] || BUILD_DIRECTORIES[part]))
    return true;
  if (parts.some((part) => part === ".ssh" || part === "secrets" || part === "credentials"))
    return true;
  if (parts.some((part) => part.startsWith(".env"))) return true;
  if (parts.some((part) => part.startsWith("id_rsa") || part.startsWith("id_ed25519")))
    return true;
  if (SECRET_EXTENSIONS[base.slice(base.lastIndexOf("."))]) return true;
  return normalized === "packages/cli/src/tui" || normalized.startsWith("packages/cli/src/tui/");
}

/**
 * Exported for the read and search tools: they must accept exactly the files
 * the copy preparation accepted, not a second interpretation of "safe".
 */
export async function readRegularProjectFile(
  root: string,
  path: string,
  rootDevice: number,
): Promise<{ readonly bytes: Buffer; readonly mode: number } | undefined> {
  const segments = path.split("/");
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    const info = await lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("Project path changed during workspace preparation.");
    if (!isWithin(root, await realpath(parent)))
      throw new Error("Project path escapes its canonical root.");
  }
  const source = join(root, ...segments);
  const before = await lstat(source);
  if (before.isSymbolicLink()) return undefined;
  if (!before.isFile()) return undefined;
  if (before.dev !== rootDevice || before.nlink > 1)
    throw new Error("Project files on another volume or with hard links are not supported.");
  if (before.size > PROJECT_WORKSPACE_LIMITS.fileBytes)
    throw new ProjectWorkspaceLimitError(`Project file exceeds the per-file limit: ${path}`);
  const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("Project file changed during workspace preparation.");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== opened.mtimeMs)
      throw new Error("Project file changed during workspace preparation.");
    return { bytes, mode: before.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  await writePrivateBytes(path, Buffer.from(content, "utf8"));
}

async function writePrivateBytes(path: string, content: Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function loadProjectWorkspace(
  root: string,
  directory: string,
  rootDigest: string,
): Promise<ProjectWorkspace> {
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
    throw new Error("Project workspace directory is not owned by Workbench.");
  const control = join(directory, "control");
  const source = join(directory, "source");
  const backups = join(control, "backups");
  const baseline = join(control, "baseline");
  for (const path of [control, source, backups, baseline]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Project workspace metadata is invalid.");
  }
  const ownerPath = join(control, "owner.json");
  const manifestPath = join(control, "manifest.json");
  const owner = JSON.parse(await readPrivateRegularFile(ownerPath)) as {
    readonly version?: unknown;
    readonly rootDigest?: unknown;
  };
  if (owner.version !== CONTROL_METADATA_VERSION || owner.rootDigest !== rootDigest)
    throw new Error("Project workspace ownership could not be verified.");
  const manifest = JSON.parse(await readPrivateRegularFile(manifestPath)) as ProjectWorkspaceManifest;
  validateManifest(manifest, rootDigest);
  return {
    root,
    rootDigest,
    displayName: manifest.displayName,
    directory,
    source,
    control,
    ownerPath,
    manifestPath,
    backups,
    baseline,
    manifest,
  };
}

async function readPrivateRegularFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Project workspace metadata is not a regular file.");
  return readFile(path, "utf8");
}

function validateManifest(manifest: ProjectWorkspaceManifest, rootDigest: string): void {
  if (
    manifest.version !== 1 ||
    manifest.rootDigest !== rootDigest ||
    typeof manifest.displayName !== "string" ||
    !Array.isArray(manifest.files) ||
    manifest.fileCount !== manifest.files.length ||
    !Number.isSafeInteger(manifest.totalBytes) ||
    manifest.totalBytes < 0
  ) throw new Error("Project workspace manifest is invalid.");
  let totalBytes = 0;
  let largestFile = 0;
  let previous = "";
  for (const file of manifest.files) {
    if (
      !isValidRelativePath(file.path) ||
      isProtectedProjectPath(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !Number.isSafeInteger(file.mode) ||
      file.mode < 0 ||
      file.mode > 0o777 ||
      file.path <= previous
    ) throw new Error("Project workspace manifest is invalid.");
    previous = file.path;
    totalBytes += file.size;
    largestFile = Math.max(largestFile, file.size);
  }
  if (totalBytes !== manifest.totalBytes)
    throw new Error("Project workspace manifest is invalid.");
  assertProjectWorkspaceLimits(manifest.files.length, largestFile, totalBytes);
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
