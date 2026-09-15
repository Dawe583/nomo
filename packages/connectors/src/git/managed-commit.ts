import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Json, Outcome, Reconciliation, RecoveryOutcome } from "../recovery.ts";

export type CommitMutation = { action: "commit"; path: string };
export type GitObjectFormat = "sha1" | "sha256";
export type GitEntry = { present: false } | { present: true; mode: "100644" | "100755"; oid: string };
export type CommitMetadata = {
  authorName: "VOID Managed Git";
  authorEmail: "managed-git@void.invalid";
  committerName: "VOID Managed Git";
  committerEmail: "managed-git@void.invalid";
  timestamp: string;
  subject: string;
};
export type CommitServices = {
  root: string;
  gitDir: string;
  commonDir: string;
  indexPath: string;
  identity: string;
  objectFormat: GitObjectFormat;
  oidPattern: RegExp;
  git(args: readonly string[], input?: Buffer | string, extraEnv?: NodeJS.ProcessEnv): string;
  pathTarget(path: string): string;
  currentIdentity(): string;
  validateRepository(): void;
  rawIndex(): Buffer;
  indexRevision(): string;
};
export type PathComponentBinding = { path: string; kind: "directory" | "file"; dev: string; ino: string; uid: string };
export type ContainedPathChain = { target: string; existing: PathComponentBinding[]; missingSuffix: string[] };
export type FilesRefPathBinding = {
  boundary: { commonDir: string; dev: string; ino: string; uid: string };
  branchRef: ContainedPathChain;
  branchReflog: ContainedPathChain;
  voidNamespace: ContainedPathChain;
  operationNamespace: ContainedPathChain;
  recoveryNamespace: ContainedPathChain;
};
export type RepositoryBinding = {
  identity: string;
  root: string;
  gitDir: string;
  commonDir: string;
  indexPath: string;
  objectFormat: GitObjectFormat;
  refBackend: "files";
  worktreeCount: 1;
  destructivePaths: FilesRefPathBinding;
};
export type BranchBinding = { ref: string; head: string; tree: string; reflogDigest: string; reflogGeneration: string };
export type IndexBinding = { rawDigest: string; revision: string; manifestDigest: string };
export type WorktreeBinding = { present: false } | { present: true; mode: "100644" | "100755"; blobOid: string; revision: string };
export type SelectedBinding = { path: string; head: GitEntry; index: GitEntry; worktree: WorktreeBinding };
export type TreeManifestEntry = { path: string; mode: "100644" | "100755"; oid: string };
export type CommitCapture = {
  kind: "commit";
  mutation: CommitMutation;
  repository: RepositoryBinding;
  branch: BranchBinding;
  index: IndexBinding;
  selected: SelectedBinding;
  refusalDigest: string;
};
export type CommitPlan = {
  kind: "commit";
  mutation: CommitMutation;
  repository: RepositoryBinding;
  parent: string;
  expectedTreeManifestDigest: string;
  branchRef: string;
  receiptRef: string;
  metadata: CommitMetadata;
};
export type CommitEvidence = {
  kind: "commit";
  repositoryIdentity: string;
  branchRef: string;
  parent: string;
  tree: string;
  commit: string;
  receiptRef: string;
  expectedTreeManifestDigest: string;
  indexDigest: string;
  worktreeDigest: string;
};
export type RefUpdate = { ref: string; newOid: string; oldOid: string | null };
export type PrivateIndexWorkspace = {
  directory: string;
  directoryDev: bigint;
  directoryIno: bigint;
  directoryUid: bigint;
  tokenPath: string;
  tokenIno: bigint;
  token: string;
  indexPath: string;
  ownedFiles: Map<string, { dev: bigint; ino: bigint }>;
};
export type ManagedCommitLifecycle = {
  capture(mutation: CommitMutation): CommitCapture;
  prepare(mutation: CommitMutation, captured: CommitCapture, operationId: string): CommitPlan;
  execute(mutation: CommitMutation, captured: CommitCapture, plan: CommitPlan, operationId: string): Promise<Outcome>;
  reconcile(operationId: string, captured: CommitCapture, plan: CommitPlan): Promise<Reconciliation>;
  recover(captured: CommitCapture, plan: CommitPlan, outcome: Outcome, recoveryId: string): Promise<RecoveryOutcome>;
  reconcileRecovery(captured: CommitCapture, plan: CommitPlan, outcome: Outcome, recoveryId: string): Promise<RecoveryOutcome | { status: "unknown" }>;
};

const maxReflogBytes = 16 * 1024 * 1024;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const jsonDigest = (value: unknown) => sha256(JSON.stringify(value));
const unsupported = (): never => { throw new Error("Managed Git commit execution is unavailable."); };

export function receiptRef(kind: "operations" | "recoveries", id: string): string {
  return `refs/void/${kind}/${sha256(id)}`;
}

function contained(commonDir: string, target: string): boolean {
  const path = relative(commonDir, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}
function pathExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function captureContainedPathChain(
  commonDir: string,
  target: string,
  expectedLeaf: "directory" | "file" | "missing-or-file",
): ContainedPathChain {
  const boundaryPath = realpathSync(commonDir);
  const absolute = resolve(target);
  if (!contained(boundaryPath, absolute)) throw new Error("Git path containment failed.");
  const parts = relative(boundaryPath, absolute).split(sep).filter(Boolean);
  const boundary = lstatSync(boundaryPath, { bigint: true });
  if (!boundary.isDirectory() || boundary.isSymbolicLink()) throw new Error("Git path boundary is unsafe.");
  const existing: PathComponentBinding[] = [];
  let current = boundaryPath;
  let missingAt = -1;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    if (!pathExists(current)) { missingAt = index; break; }
    const item = lstatSync(current, { bigint: true });
    if (item.isSymbolicLink()) throw new Error("Git path symbolic link is unsupported.");
    if (item.uid !== boundary.uid) throw new Error("Git path ownership changed.");
    const leaf = index === parts.length - 1;
    const kind = item.isDirectory() ? "directory" : item.isFile() ? "file" : null;
    if (!kind || (!leaf && kind !== "directory")) throw new Error("Git path kind is unsupported.");
    if (leaf && expectedLeaf === "directory" && kind !== "directory") throw new Error("Git path kind is unsupported.");
    if (leaf && (expectedLeaf === "file" || expectedLeaf === "missing-or-file") && kind !== "file") throw new Error("Git path kind is unsupported.");
    const canonical = realpathSync(current);
    if (!contained(boundaryPath, canonical) || canonical !== current) throw new Error("Git path containment failed.");
    existing.push({ path: current, kind, dev: String(item.dev), ino: String(item.ino), uid: String(item.uid) });
  }
  if (missingAt >= 0 && expectedLeaf === "file" && missingAt === parts.length - 1)
    throw new Error("Required Git path is missing.");
  return { target: absolute, existing, missingSuffix: missingAt < 0 ? [] : parts.slice(missingAt) };
}

export function captureFilesRefPaths(commonDir: string, branchRef: string): FilesRefPathBinding {
  const boundaryPath = realpathSync(commonDir);
  const boundary = lstatSync(boundaryPath, { bigint: true });
  return {
    boundary: { commonDir: boundaryPath, dev: String(boundary.dev), ino: String(boundary.ino), uid: String(boundary.uid) },
    branchRef: captureContainedPathChain(boundaryPath, join(boundaryPath, ...branchRef.split("/")), "missing-or-file"),
    branchReflog: captureContainedPathChain(boundaryPath, join(boundaryPath, "logs", ...branchRef.split("/")), "file"),
    voidNamespace: captureContainedPathChain(boundaryPath, join(boundaryPath, "refs", "void"), "directory"),
    operationNamespace: captureContainedPathChain(boundaryPath, join(boundaryPath, "refs", "void", "operations"), "directory"),
    recoveryNamespace: captureContainedPathChain(boundaryPath, join(boundaryPath, "refs", "void", "recoveries"), "directory"),
  };
}

export function verifyFilesRefPaths(
  binding: FilesRefPathBinding,
  options: { allowOwnedNamespaceCreation?: boolean } = {},
): FilesRefPathBinding {
  const boundary = lstatSync(binding.boundary.commonDir, { bigint: true });
  if (!boundary.isDirectory() || String(boundary.dev) !== binding.boundary.dev || String(boundary.ino) !== binding.boundary.ino || String(boundary.uid) !== binding.boundary.uid)
    throw new Error("Git path boundary identity changed.");
  const expected = [binding.branchRef, binding.branchReflog, binding.voidNamespace, binding.operationNamespace, binding.recoveryNamespace];
  const leafKinds = ["missing-or-file", "file", "directory", "directory", "directory"] as const;
  const refreshed = expected.map((chain, index) => captureContainedPathChain(binding.boundary.commonDir, chain.target, leafKinds[index]!));
  for (let index = 0; index < expected.length; index++) {
    const before = expected[index]!, after = refreshed[index]!;
    if (isDeepStrictEqual(before, after)) continue;
    const namespace = index >= 2;
    const permitted = options.allowOwnedNamespaceCreation && namespace && before.missingSuffix.length > 0 &&
      isDeepStrictEqual(before.existing, after.existing.slice(0, before.existing.length)) && after.missingSuffix.length < before.missingSuffix.length;
    if (!permitted) throw new Error("Git destructive path identity changed.");
  }
  return {
    boundary: binding.boundary,
    branchRef: refreshed[0]!,
    branchReflog: refreshed[1]!,
    voidNamespace: refreshed[2]!,
    operationNamespace: refreshed[3]!,
    recoveryNamespace: refreshed[4]!,
  };
}

function validateBranchRef(ref: string): void {
  if (!ref.startsWith("refs/heads/") || ref.length > 1024 || /[\~^:?*\[\x00- \x7f]/.test(ref) || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".lock"))
    throw new Error("A canonical attached branch is required.");
  if (ref.split("/").some((part) => !part || part === "." || part === ".." || part.endsWith(".lock")))
    throw new Error("A canonical attached branch is required.");
}

function readReflog(path: string): { digest: string; generation: string } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxReflogBytes)) throw new Error("Branch reflog is unsupported.");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error("Branch reflog read failed.");
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.ctimeNs !== after.ctimeNs)
      throw new Error("Branch reflog changed during capture.");
    const digest = sha256(bytes);
    return { digest, generation: jsonDigest([digest, String(before.dev), String(before.ino), String(before.size), String(before.ctimeNs)]) };
  } finally { closeSync(fd); }
}

function parseManifest(output: string, oidPattern: RegExp): TreeManifestEntry[] {
  if (!output) return [];
  const entries: TreeManifestEntry[] = [];
  for (const record of output.split("\x00")) {
    if (!record) continue;
    const match = /^(100644|100755) (?:blob )?([0-9a-f]+)(?: 0)?\t(.+)$/.exec(record);
    if (!match || !oidPattern.test(match[2]!)) throw new Error("Git manifest entry is unsupported.");
    const path = match[3]!;
    if (!Buffer.from(path, "utf8").equals(Buffer.from(path))) throw new Error("Git path encoding is unsupported.");
    entries.push({ path, mode: match[1] as "100644" | "100755", oid: match[2]! });
  }
  return entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}

export function readTreeManifest(treeish: string, services: CommitServices): TreeManifestEntry[] {
  return parseManifest(services.git(["ls-tree", "-r", "-z", treeish]), services.oidPattern);
}

function readIndexManifest(services: CommitServices): TreeManifestEntry[] {
  return parseManifest(services.git(["ls-files", "--stage", "-z"]), services.oidPattern);
}

export function applySelectedEntry(manifest: readonly TreeManifestEntry[], path: string, entry: GitEntry): TreeManifestEntry[] {
  const result = manifest.filter((item) => item.path !== path);
  if (entry.present) result.push({ path, mode: entry.mode, oid: entry.oid });
  return result.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}

export function manifestDigest(manifest: readonly TreeManifestEntry[]): string {
  return jsonDigest(manifest.map((entry) => [entry.path, entry.mode, entry.oid]));
}

function selectedEntry(manifest: readonly TreeManifestEntry[], path: string): GitEntry {
  const found = manifest.find((entry) => entry.path === path);
  return found ? { present: true, mode: found.mode, oid: found.oid } : { present: false };
}

function rejectMetadataHazards(services: CommitServices): void {
  const common = services.commonDir;
  for (const path of ["shallow", "info/grafts", "objects/info/alternates"])
    if (existsSync(join(common, path))) throw new Error(path === "shallow" ? "Shallow repositories are unsupported." : path.includes("grafts") ? "Git grafts are unsupported." : "Git alternates are unsupported.");
  if (services.git(["for-each-ref", "--format=%(refname)", "refs/replace/"])) throw new Error("Git replace refs are unsupported.");
  const config = services.git(["config", "--null", "--list"]);
  const entries = config.toLowerCase().split("\0");
  if (entries.some((entry) => /^remote\..+\.promisor(?:=|\n)true$/.test(entry) || entry.startsWith("extensions.partialclone=")))
    throw new Error("Git promisor repositories are unsupported.");
  if (entries.some((entry) => /^commit\.gpgsign(?:=|\n)true$/.test(entry)))
    throw new Error("Commit signing is unsupported.");
}

export function captureCommit(mutation: CommitMutation, services: CommitServices): CommitCapture {
  services.validateRepository();
  if (services.currentIdentity() !== services.identity) throw new Error("Git repository identity changed.");
  rejectMetadataHazards(services);
  let ref: string;
  try { ref = services.git(["symbolic-ref", "-q", "HEAD"]); }
  catch { throw new Error("An attached branch is required."); }
  validateBranchRef(ref);
  if (services.git(["rev-parse", "--symbolic-full-name", "HEAD"]) !== ref) throw new Error("A direct attached branch is required.");
  let head: string;
  try { head = services.git(["rev-parse", "--verify", "HEAD^{commit}"]); }
  catch { throw new Error("A born branch is required."); }
  if (!services.oidPattern.test(head)) throw new Error("A born branch is required.");
  if (services.git(["rev-parse", "--show-ref-format"]) !== "files") throw new Error("Files refs are required.");
  const worktrees = services.git(["worktree", "list", "--porcelain", "-z"]).split("\x00").filter((value) => value.startsWith("worktree "));
  if (worktrees.length !== 1) throw new Error("Exactly one registered worktree is required.");
  const destructivePaths = captureFilesRefPaths(services.commonDir, ref);
  verifyFilesRefPaths(destructivePaths);
  for (const chain of [destructivePaths.branchRef, destructivePaths.operationNamespace, destructivePaths.recoveryNamespace])
    if (pathExists(`${chain.target}.lock`)) throw new Error("Git ref lock exists.");
  for (const namespace of [destructivePaths.operationNamespace.target, destructivePaths.recoveryNamespace.target])
    if (existsSync(namespace) && readdirSync(namespace).some((name) => name.endsWith(".lock"))) throw new Error("Git receipt lock exists.");
  const reflog = readReflog(destructivePaths.branchReflog.target);
  services.git(["fsck", "--connectivity-only", "--no-dangling"], undefined, { GIT_NO_REPLACE_OBJECTS: "1" });
  const tree = services.git(["rev-parse", "--verify", `${head}^{tree}`]);
  const headManifest = readTreeManifest(tree, services);
  const indexManifest = readIndexManifest(services);
  for (const item of indexManifest) services.git(["cat-file", "-e", `${item.oid}^{blob}`]);
  const headEntry = selectedEntry(headManifest, mutation.path);
  const indexEntry = selectedEntry(indexManifest, mutation.path);
  if (isDeepStrictEqual(headEntry, indexEntry)) throw new Error("No-op Git commits are refused.");
  const target = services.pathTarget(mutation.path);
  let worktree: WorktreeBinding;
  if (!indexEntry.present) {
    if (pathExists(target)) throw new Error("A staged deletion requires an absent worktree path.");
    worktree = { present: false };
  } else {
    const item = lstatSync(target, { bigint: true });
    if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1n) throw new Error("The selected worktree path must be a single-link regular file.");
    const mode: "100644" | "100755" = (item.mode & 0o111n) !== 0n ? "100755" : "100644";
    const blobOid = services.git(["hash-object", "--no-filters", "--", mutation.path]);
    if (mode !== indexEntry.mode || blobOid !== indexEntry.oid) throw new Error("The selected worktree path has an unstaged change.");
    worktree = { present: true, mode, blobOid, revision: jsonDigest([blobOid, mode, String(item.dev), String(item.ino), String(item.size), String(item.ctimeNs)]) };
  }
  const rawIndex = services.rawIndex();
  const repository: RepositoryBinding = {
    identity: services.identity,
    root: services.root,
    gitDir: services.gitDir,
    commonDir: services.commonDir,
    indexPath: services.indexPath,
    objectFormat: services.objectFormat,
    refBackend: "files",
    worktreeCount: 1,
    destructivePaths,
  };
  const selected = { path: mutation.path, head: headEntry, index: indexEntry, worktree };
  const refusalState = [ref, head, tree, reflog, sha256(rawIndex), services.indexRevision(), manifestDigest(indexManifest), selected, services.git(["config", "--null", "--list"])];
  return {
    kind: "commit",
    mutation,
    repository,
    branch: { ref, head, tree, reflogDigest: reflog.digest, reflogGeneration: reflog.generation },
    index: { rawDigest: sha256(rawIndex), revision: services.indexRevision(), manifestDigest: manifestDigest(indexManifest) },
    selected,
    refusalDigest: jsonDigest(refusalState),
  };
}

export function prepareCommit(captured: CommitCapture, operationId: string, nowSeconds = Math.floor(Date.now() / 1000)): CommitPlan {
  const expected = applySelectedEntry([], captured.selected.path, captured.selected.index);
  return {
    kind: "commit",
    mutation: captured.mutation,
    repository: captured.repository,
    parent: captured.branch.head,
    expectedTreeManifestDigest: manifestDigest(expected),
    branchRef: captured.branch.ref,
    receiptRef: receiptRef("operations", operationId),
    metadata: {
      authorName: "VOID Managed Git",
      authorEmail: "managed-git@void.invalid",
      committerName: "VOID Managed Git",
      committerEmail: "managed-git@void.invalid",
      timestamp: String(nowSeconds),
      subject: `VOID managed commit ${sha256(operationId).slice(0, 16)}`,
    },
  };
}


export function createPrivateIndexWorkspace(realIndexPath: string): PrivateIndexWorkspace {
  const parent = realpathSync(dirname(realIndexPath));
  const directory = mkdtempSync(join(parent, ".void-git-index-"));
  chmodSync(directory, 0o700);
  const item = lstatSync(directory, { bigint: true });
  if (!item.isDirectory() || item.isSymbolicLink() || item.uid !== BigInt(process.geteuid?.() ?? process.getuid?.() ?? Number(item.uid)) || (item.mode & 0o777n) !== 0o700n)
    throw new Error("Managed Git private index workspace is unsafe.");
  const token = randomBytes(32).toString("hex");
  const tokenPath = join(directory, "owner");
  const fd = openSync(tokenPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, token); } finally { closeSync(fd); }
  const tokenStat = lstatSync(tokenPath, { bigint: true });
  const workspace: PrivateIndexWorkspace = {
    directory,
    directoryDev: item.dev,
    directoryIno: item.ino,
    directoryUid: item.uid,
    tokenPath,
    tokenIno: tokenStat.ino,
    token,
    indexPath: join(directory, "index"),
    ownedFiles: new Map(),
  };
  workspace.ownedFiles.set(tokenPath, { dev: tokenStat.dev, ino: tokenStat.ino });
  if (existsSync(workspace.indexPath)) throw new Error("Managed Git private index already exists.");
  return workspace;
}

export function recordOwnedPrivateFile(workspace: PrivateIndexWorkspace, path: string): void {
  if (!existsSync(path)) return;
  if (dirname(path) !== workspace.directory) throw new Error("Managed Git private file escaped its workspace.");
  const parent = lstatSync(workspace.directory, { bigint: true });
  const item = lstatSync(path, { bigint: true });
  if (parent.dev !== workspace.directoryDev || parent.ino !== workspace.directoryIno || parent.uid !== workspace.directoryUid || !item.isFile() || item.isSymbolicLink() || item.nlink !== 1n || item.uid !== workspace.directoryUid)
    throw new Error("Managed Git private file identity changed.");
  workspace.ownedFiles.set(path, { dev: item.dev, ino: item.ino });
}

export function cleanupPrivateIndexWorkspace(workspace: PrivateIndexWorkspace): void {
  const directory = lstatSync(workspace.directory, { bigint: true });
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.dev !== workspace.directoryDev || directory.ino !== workspace.directoryIno || directory.uid !== workspace.directoryUid || (directory.mode & 0o777n) !== 0o700n)
    throw new Error("Managed Git private workspace identity changed.");
  const token = lstatSync(workspace.tokenPath, { bigint: true });
  if (!token.isFile() || token.isSymbolicLink() || token.ino !== workspace.tokenIno || readFileSync(workspace.tokenPath, "utf8") !== workspace.token)
    throw new Error("Managed Git private workspace token identity changed.");
  const names = readdirSync(workspace.directory);
  const allowed = new Set(["owner", "index", "index.lock"]);
  if (names.some((name) => !allowed.has(name))) throw new Error("Managed Git private workspace contains an unknown file.");
  for (const path of [workspace.tokenPath, workspace.indexPath, `${workspace.indexPath}.lock`]) {
    if (!existsSync(path)) continue;
    const expected = workspace.ownedFiles.get(path);
    const current = lstatSync(path, { bigint: true });
    if (!expected || !current.isFile() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino || dirname(path) !== workspace.directory)
      throw new Error("Managed Git private file identity changed.");
  }
  for (const path of [`${workspace.indexPath}.lock`, workspace.indexPath, workspace.tokenPath])
    if (existsSync(path)) unlinkSync(path);
  rmdirSync(workspace.directory);
}

export async function writeCandidateTree(
  baseTree: string,
  path: string,
  entry: GitEntry,
  expectedManifestDigest: string,
  services: CommitServices,
): Promise<string> {
  const workspace = createPrivateIndexWorkspace(services.indexPath);
  const privateEnv = { GIT_INDEX_FILE: workspace.indexPath, GIT_NO_REPLACE_OBJECTS: "1" };
  try {
    services.git(["read-tree", baseTree], undefined, privateEnv);
    recordOwnedPrivateFile(workspace, workspace.indexPath);
    if (entry.present)
      services.git(["update-index", "--add", "--cacheinfo", entry.mode, entry.oid, path], undefined, privateEnv);
    else services.git(["update-index", "--force-remove", "--", path], undefined, privateEnv);
    recordOwnedPrivateFile(workspace, workspace.indexPath);
    const tree = services.git(["write-tree"], undefined, privateEnv);
    recordOwnedPrivateFile(workspace, workspace.indexPath);
    if (!services.oidPattern.test(tree) || manifestDigest(readTreeManifest(tree, services)) !== expectedManifestDigest)
      throw new Error("Managed Git candidate tree verification failed.");
    return tree;
  } finally {
    try { recordOwnedPrivateFile(workspace, workspace.indexPath); } catch {}
    try { recordOwnedPrivateFile(workspace, `${workspace.indexPath}.lock`); } catch {}
    cleanupPrivateIndexWorkspace(workspace);
  }
}

export async function createCommit(tree: string, parent: string, metadata: CommitMetadata, services: CommitServices): Promise<string> {
  const date = `${metadata.timestamp} +0000`;
  const oid = services.git(
    ["-c", "commit.gpgSign=false", "-c", "user.useConfigOnly=true", "commit-tree", tree, "-p", parent],
    `${metadata.subject}\n`,
    {
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_AUTHOR_NAME: metadata.authorName,
      GIT_AUTHOR_EMAIL: metadata.authorEmail,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: metadata.committerName,
      GIT_COMMITTER_EMAIL: metadata.committerEmail,
      GIT_COMMITTER_DATE: date,
    },
  );
  if (!services.oidPattern.test(oid)) throw new Error("Managed Git commit creation failed.");
  return oid;
}

export async function commitRefTransaction(
  updates: readonly RefUpdate[],
  lockedRecheck: () => void,
  services: CommitServices,
): Promise<void> {
  if (updates.length === 0) throw new Error("Managed Git ref transaction failed.");
  const commands = ["start", ...updates.map((update) => update.oldOid === null
    ? `create ${update.ref} ${update.newOid}`
    : `update ${update.ref} ${update.newOid} ${update.oldOid}`), "prepare", ""].join("\n");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "update-ref", "--stdin"], {
      cwd: services.root,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        LC_ALL: "C",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
        GIT_LITERAL_PATHSPECS: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", settled = false, prepared = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill("SIGTERM");
      rejectPromise(new Error("Managed Git ref transaction failed."));
    };
    const timer = setTimeout(fail, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 64 * 1024) return fail();
      if (!prepared && stdout === "start: ok\nprepare: ok\n") {
        prepared = true;
        try { lockedRecheck(); child.stdin.write("commit\n"); child.stdin.end(); }
        catch { child.stdin.write("abort\n"); child.stdin.end(); }
      } else if (!"start: ok\nprepare: ok\ncommit: ok\n".startsWith(stdout)) fail();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 64 * 1024) fail();
    });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 && signal === null && stderr === "" && stdout === "start: ok\nprepare: ok\ncommit: ok\n") resolvePromise();
      else rejectPromise(new Error("Managed Git ref transaction failed."));
    });
    child.stdin.write(commands);
  });
}

function exactRef(ref: string, services: CommitServices): string | null {
  try {
    const oid = services.git(["show-ref", "--verify", "--hash", ref]);
    return services.oidPattern.test(oid) ? oid : null;
  } catch { return null; }
}

function currentWorktreeDigest(captured: CommitCapture, services: CommitServices): string {
  const selected = captured.selected;
  const target = services.pathTarget(selected.path);
  if (!selected.worktree.present) return existsSync(target) ? "changed" : jsonDigest(["absent"]);
  if (!existsSync(target)) return "changed";
  const item = lstatSync(target, { bigint: true });
  const mode = (item.mode & 0o111n) !== 0n ? "100755" : "100644";
  const oid = services.git(["hash-object", "--no-filters", "--", selected.path]);
  return jsonDigest([oid, mode]);
}

export function verifyManagedCommit(commit: string, captured: CommitCapture, plan: CommitPlan, services: CommitServices): CommitEvidence {
  if (exactRef(plan.branchRef, services) !== commit || exactRef(plan.receiptRef, services) !== commit)
    throw new Error("Managed Git commit verification failed.");
  const raw = services.git(["cat-file", "commit", commit]);
  const date = `${plan.metadata.timestamp} +0000`;
  const expectedPrefix = `tree `;
  if (!raw.startsWith(expectedPrefix) || raw.includes("gpgsig") || Buffer.byteLength(raw) >= 1024)
    throw new Error("Managed Git commit verification failed.");
  const lines = raw.split("\n");
  const tree = lines[0]?.slice(5) ?? "";
  if (lines[1] !== `parent ${plan.parent}` || lines[2] !== `author ${plan.metadata.authorName} <${plan.metadata.authorEmail}> ${date}` || lines[3] !== `committer ${plan.metadata.committerName} <${plan.metadata.committerEmail}> ${date}` || lines[4] !== "" || lines[5] !== plan.metadata.subject || lines.length !== 6)
    throw new Error("Managed Git commit verification failed.");
  if (manifestDigest(readTreeManifest(tree, services)) !== plan.expectedTreeManifestDigest)
    throw new Error("Managed Git commit verification failed.");
  const indexDigest = sha256(services.rawIndex());
  if (indexDigest !== captured.index.rawDigest) throw new Error("Managed Git real index changed.");
  const expectedWorktree = captured.selected.worktree.present
    ? jsonDigest([captured.selected.worktree.blobOid, captured.selected.worktree.mode])
    : jsonDigest(["absent"]);
  const worktreeDigest = currentWorktreeDigest(captured, services);
  if (worktreeDigest !== expectedWorktree) throw new Error("Managed Git worktree changed.");
  return {
    kind: "commit",
    repositoryIdentity: captured.repository.identity,
    branchRef: plan.branchRef,
    parent: plan.parent,
    tree,
    commit,
    receiptRef: plan.receiptRef,
    expectedTreeManifestDigest: plan.expectedTreeManifestDigest,
    indexDigest,
    worktreeDigest,
  };
}

export function createManagedCommitLifecycle(services: CommitServices): ManagedCommitLifecycle {
  return {
    capture: (mutation) => captureCommit(mutation, services),
    prepare(mutation, captured, operationId) {
      if (!isDeepStrictEqual(mutation, captured.mutation)) throw new Error("Git capture binding conflict.");
      const current = captureCommit(mutation, services);
      if (!isDeepStrictEqual(current, captured)) throw new Error("Git state conflict.");
      verifyFilesRefPaths(captured.repository.destructivePaths);
      const headManifest = readTreeManifest(captured.branch.tree, services);
      const plan = prepareCommit(captured, operationId);
      plan.expectedTreeManifestDigest = manifestDigest(applySelectedEntry(headManifest, captured.selected.path, captured.selected.index));
      if (pathExists(`${join(services.commonDir, ...plan.receiptRef.split("/"))}.lock`)) throw new Error("Git receipt lock exists.");
      return plan;
    },
    async execute(mutation, captured, plan, operationId) {
      if (!isDeepStrictEqual(mutation, captured.mutation) || plan.receiptRef !== receiptRef("operations", operationId))
        throw new Error("Git capture binding conflict.");
      const current = captureCommit(mutation, services);
      if (!isDeepStrictEqual(current, captured)) throw new Error("Git state conflict.");
      const expectedManifestDigest = manifestDigest(applySelectedEntry(readTreeManifest(captured.branch.tree, services), captured.selected.path, captured.selected.index));
      const expectedSubject = `VOID managed commit ${sha256(operationId).slice(0, 16)}`;
      if (plan.parent !== captured.branch.head || plan.branchRef !== captured.branch.ref || !isDeepStrictEqual(plan.repository, captured.repository) || plan.expectedTreeManifestDigest !== expectedManifestDigest || plan.metadata.authorName !== "VOID Managed Git" || plan.metadata.authorEmail !== "managed-git@void.invalid" || plan.metadata.committerName !== "VOID Managed Git" || plan.metadata.committerEmail !== "managed-git@void.invalid" || plan.metadata.subject !== expectedSubject || !/^\d+$/.test(plan.metadata.timestamp))
        throw new Error("Git plan binding conflict.");
      verifyFilesRefPaths(captured.repository.destructivePaths);
      const tree = await writeCandidateTree(captured.branch.tree, captured.selected.path, captured.selected.index, plan.expectedTreeManifestDigest, services);
      const commit = await createCommit(tree, plan.parent, plan.metadata, services);
      await commitRefTransaction(
        [
          { ref: plan.branchRef, newOid: commit, oldOid: plan.parent },
          { ref: plan.receiptRef, newOid: commit, oldOid: null },
        ],
        () => {
          verifyFilesRefPaths(captured.repository.destructivePaths, { allowOwnedNamespaceCreation: true });
          const reflog = readReflog(captured.repository.destructivePaths.branchReflog.target);
          if (reflog.digest !== captured.branch.reflogDigest || reflog.generation !== captured.branch.reflogGeneration)
            throw new Error("Git branch reflog changed.");
        },
        services,
      );
      const evidence = verifyManagedCommit(commit, captured, plan, services);
      return { result: { action: "commit", path: mutation.path, commit }, evidence: evidence as unknown as Json };
    },
    async reconcile() { return { status: "unknown" }; },
    async recover() { return { status: "conflict", evidence: null }; },
    async reconcileRecovery() { return { status: "unknown" }; },
  };
}
