export type ProjectWorkspaceChange = {
  path: string;
  operation: "add" | "update" | "delete";
  digest: string;
};
export type ProjectWorkspaceDiff = {
  digest: string;
  file: { path: string; digest: string; diff: string };
};
export type ProjectWorkspaceSummary = {
  project: { rootDigest: string; displayName: string } | null;
  workspace: {
    fileCount: number;
    totalBytes: number;
    changes: { added: number; modified: number; deleted: number };
  } | null;
  savedWorkspaces: Array<{
    rootDigest: string;
    displayName: string;
    fileCount: number;
    totalBytes: number;
    hasChanges: boolean;
    requiresConfirmation: boolean;
  }>;
};
export type ProjectWorkspacePage = {
  snapshotDigest: string;
  files: ProjectWorkspaceChange[];
  nextCursor: string | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function rootDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}
function fileDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function projectWorkspaceSummary(value: unknown): ProjectWorkspaceSummary | null {
  if (!record(value) || !Array.isArray(value.savedWorkspaces)) return null;
  let project: ProjectWorkspaceSummary["project"] = null;
  if (value.project !== null) {
    if (
      !record(value.project) ||
      !rootDigest(value.project.rootDigest) ||
      typeof value.project.displayName !== "string"
    )
      return null;
    project = {
      rootDigest: value.project.rootDigest,
      displayName: value.project.displayName,
    };
  }
  let workspace: ProjectWorkspaceSummary["workspace"] = null;
  if (value.workspace !== null) {
    if (
      !record(value.workspace) ||
      !count(value.workspace.fileCount) ||
      !count(value.workspace.totalBytes) ||
      !record(value.workspace.changes) ||
      !count(value.workspace.changes.added) ||
      !count(value.workspace.changes.modified) ||
      !count(value.workspace.changes.deleted)
    )
      return null;
    workspace = {
      fileCount: value.workspace.fileCount,
      totalBytes: value.workspace.totalBytes,
      changes: {
        added: value.workspace.changes.added,
        modified: value.workspace.changes.modified,
        deleted: value.workspace.changes.deleted,
      },
    };
  }
  if ((project === null) !== (workspace === null)) return null;
  const savedWorkspaces: ProjectWorkspaceSummary["savedWorkspaces"] = [];
  for (const entry of value.savedWorkspaces) {
    if (
      !record(entry) ||
      !rootDigest(entry.rootDigest) ||
      typeof entry.displayName !== "string" ||
      !count(entry.fileCount) ||
      !count(entry.totalBytes) ||
      typeof entry.hasChanges !== "boolean" ||
      typeof entry.requiresConfirmation !== "boolean"
    )
      return null;
    savedWorkspaces.push({
      rootDigest: entry.rootDigest,
      displayName: entry.displayName,
      fileCount: entry.fileCount,
      totalBytes: entry.totalBytes,
      hasChanges: entry.hasChanges,
      requiresConfirmation: entry.requiresConfirmation,
    });
  }
  return { project, workspace, savedWorkspaces };
}

export function projectWorkspacePage(value: unknown): ProjectWorkspacePage | null {
  if (
    !record(value) ||
    !fileDigest(value.snapshotDigest) ||
    !Array.isArray(value.files) ||
    !(value.nextCursor === null || typeof value.nextCursor === "string")
  )
    return null;
  const files: ProjectWorkspaceChange[] = [];
  for (const file of value.files) {
    if (
      !record(file) ||
      typeof file.path !== "string" ||
      !["add", "update", "delete"].includes(String(file.operation)) ||
      !(file.beforeHash === null || fileDigest(file.beforeHash)) ||
      !(file.afterHash === null || fileDigest(file.afterHash))
    )
      return null;
    const digest = fileDigest(file.digest)
      ? file.digest
      : null;
    if (!digest) return null;
    files.push({
      path: file.path,
      operation: file.operation as ProjectWorkspaceChange["operation"],
      digest,
    });
  }
  return { snapshotDigest: value.snapshotDigest, files, nextCursor: value.nextCursor };
}

export function projectWorkspaceDiff(value: unknown): ProjectWorkspaceDiff | null {
  if (
    !record(value) ||
    !fileDigest(value.digest) ||
    !record(value.file) ||
    typeof value.file.path !== "string" ||
    value.file.digest !== value.digest ||
    typeof value.file.diff !== "string"
  )
    return null;
  return {
    digest: value.digest,
    file: {
      path: value.file.path,
      digest: value.file.digest as string,
      diff: value.file.diff,
    },
  };
}

export function projectWorkspaceErrorKind(
  error: unknown,
): "conflict" | "error" | null {
  if (error === null || error === undefined) return null;
  return record(error) && error.status === 409 ? "conflict" : "error";
}

export function projectWorkspaceApplyRequest(
  project: { rootDigest: string } | null,
  change: ProjectWorkspaceChange | null,
  diff: ProjectWorkspaceDiff | null,
): { path: string; digest: string } | null {
  if (
    !project ||
    !rootDigest(project.rootDigest) ||
    !change ||
    !diff ||
    !fileDigest(change.digest) ||
    diff.digest !== change.digest ||
    diff.file.path !== change.path ||
    diff.file.digest !== change.digest
  )
    return null;
  return { path: change.path, digest: change.digest };
}

export function projectWorkspaceDiffUrl(path: string): string {
  return "/api/project-workspace/diff?path=" + encodeURIComponent(path);
}
