import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  Json,
  Outcome,
  Reconciliation,
  RecoveryOutcome,
} from "../recovery.ts";

export type CommitMutation = { action: "commit"; path: string };
export type GitObjectFormat = "sha1" | "sha256";
export type GitEntry =
  | { present: false }
  | { present: true; mode: "100644" | "100755"; oid: string };
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
  gitBuffer(args: readonly string[], input?: Buffer | string, extraEnv?: NodeJS.ProcessEnv): Buffer;
  pathTarget(path: string): string;
  currentIdentity(): string;
  validateRepository(): void;
  rawIndex(): Buffer;
  indexRevision(): string;
};
export type PathComponentBinding = {
  path: string;
  kind: "directory" | "file";
  dev: string;
  ino: string;
  uid: string;
};
export type ContainedPathChain = {
  target: string;
  existing: PathComponentBinding[];
  missingSuffix: string[];
};
export type FilesRefPathBinding = {
  boundary: { commonDir: string; dev: string; ino: string; uid: string };
  branchRef: ContainedPathChain;
  branchReflog: ContainedPathChain;
  voidNamespace: ContainedPathChain;
  operationNamespace: ContainedPathChain;
  recoveryNamespace: ContainedPathChain;
  packedRefs: ContainedPathChain;
  packedRefsLock: ContainedPathChain;
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
export type BranchBinding = {
  ref: string;
  head: string;
  tree: string;
  reflogDigest: string;
  reflogGeneration: string;
};
export type IndexBinding = {
  rawDigest: string;
  revision: string;
  manifestDigest: string;
};
export type WorktreeBinding =
  | { present: false }
  | {
      present: true;
      mode: "100644" | "100755";
      blobOid: string;
      revision: string;
    };
export type SelectedBinding = {
  path: string;
  head: GitEntry;
  index: GitEntry;
  worktree: WorktreeBinding;
};
export type TreeManifestEntry = {
  path: string;
  mode: "100644" | "100755";
  oid: string;
};
export type CommitCapture = {
  kind: "commit";
  mutation: CommitMutation;
  repository: RepositoryBinding;
  branch: BranchBinding;
  index: IndexBinding;
  selected: SelectedBinding;
  expectedTreeManifestDigest: string;
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
  refNamespaceDigest: string;
};
export type RefUpdate = { ref: string; newOid: string; oldOid: string | null };
export type PrivateIndexWorkspace = {
  directory: string;
  directoryDev: bigint;
  directoryIno: bigint;
  directoryUid: bigint;
  tokenPath: string;
  tokenDev: bigint;
  tokenIno: bigint;
  token: string;
  indexPath: string;
  ownedFiles: Map<string, { dev: bigint; ino: bigint; descriptor: number }>;
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
const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const jsonDigest = (value: unknown) => sha256(JSON.stringify(value));
const decoder = new TextDecoder("utf-8", { fatal: true });
function decodeUtf8(bytes: Buffer, error: string): string {
  let value: string;
  try { value = decoder.decode(bytes); }
  catch { throw new Error(error); }
  if (!Buffer.from(value, "utf8").equals(bytes)) throw new Error(error);
  return value;
}

function splitNul(bytes: Buffer, error: string): Buffer[] {
  if (!bytes.length) return [];
  if (bytes.at(-1) !== 0) throw new Error(error);
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 0) continue;
    records.push(bytes.subarray(start, index));
    start = index + 1;
  }
  return records;
}


function pathExistsNoFollow(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function validateToken(value: string, label: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (!value || bytes.length > 4096 || decodeUtf8(bytes, `Invalid ${label}.`) !== value)
    throw new Error(`Invalid ${label}.`);
}

function validateSelectedPath(path: string): void {
  validateToken(path, "Git path");
  if (/[\u0000-\u001f\u007f]/u.test(path)) throw new Error("Invalid Git path.");
}

export function validateBranchRef(ref: string): void {
  if (!ref.startsWith("refs/heads/") || !/^[\x20-\x7e]+$/.test(ref))
    throw new Error("An attached canonical branch is required.");
  const components = ref.split("/");
  if (
    components.length < 3 ||
    components.some((part) =>
      !part || part === "." || part === ".." || part.includes("\\") ||
      /[~^:?*[\x00-\x20\x7f]/.test(part) || part.endsWith(".lock"),
    ) || ref.includes("//")
  ) throw new Error("An attached canonical branch is required.");
}

function component(path: string): PathComponentBinding {
  const item = lstatSync(path, { bigint: true });
  if (item.isSymbolicLink()) throw new Error("Destructive Git path contains a symbolic link.");
  const kind = item.isDirectory() ? "directory" : item.isFile() ? "file" : null;
  if (!kind) throw new Error("Destructive Git path has an unsupported kind.");
  return {
    path,
    kind,
    dev: String(item.dev),
    ino: String(item.ino),
    uid: String(item.uid),
  };
}

export function captureContainedPathChain(
  commonDir: string,
  target: string,
  expectedLeaf: "directory" | "file" | "missing-or-file",
): ContainedPathChain {
  const canonicalCommon = realpathSync(commonDir);
  if (canonicalCommon !== commonDir) throw new Error("Git common directory is not canonical.");
  const absolute = resolve(target);
  const suffix = relative(commonDir, absolute);
  if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))
    throw new Error("Destructive Git path fails containment.");
  const boundary = component(commonDir);
  if (boundary.kind !== "directory") throw new Error("Git common directory is not a directory.");
  const existing: PathComponentBinding[] = [];
  const parts = suffix.split(sep);
  let cursor = commonDir;
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index]!);
    let captured: PathComponentBinding;
    try { captured = component(cursor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { target: absolute, existing, missingSuffix: parts.slice(index) };
      throw error;
    }
    if (captured.uid !== boundary.uid) throw new Error("Destructive Git path ownership differs.");
    if (realpathSync(cursor) !== cursor) throw new Error("Destructive Git path fails containment.");
    const leaf = index === parts.length - 1;
    if (!leaf && captured.kind !== "directory")
      throw new Error("Destructive Git path parent is not a directory.");
    if (leaf && expectedLeaf === "directory" && captured.kind !== "directory")
      throw new Error("Destructive Git namespace is not a directory.");
    if (leaf && expectedLeaf !== "directory" && captured.kind !== "file")
      throw new Error("Destructive Git leaf is not a file.");
    existing.push(captured);
  }
  return { target: absolute, existing, missingSuffix: [] };
}

export function captureFilesRefPaths(
  commonDir: string,
  branchRef: string,
): FilesRefPathBinding {
  validateBranchRef(branchRef);
  const boundary = component(commonDir);
  if (boundary.kind !== "directory") throw new Error("Git common directory is not a directory.");
  return {
    boundary: {
      commonDir,
      dev: boundary.dev,
      ino: boundary.ino,
      uid: boundary.uid,
    },
    branchRef: captureContainedPathChain(commonDir, join(commonDir, branchRef), "missing-or-file"),
    branchReflog: captureContainedPathChain(commonDir, join(commonDir, "logs", branchRef), "file"),
    voidNamespace: captureContainedPathChain(commonDir, join(commonDir, "refs", "void"), "directory"),
    operationNamespace: captureContainedPathChain(commonDir, join(commonDir, "refs", "void", "operations"), "directory"),
    recoveryNamespace: captureContainedPathChain(commonDir, join(commonDir, "refs", "void", "recoveries"), "directory"),
    packedRefs: captureContainedPathChain(commonDir, join(commonDir, "packed-refs"), "missing-or-file"),
    packedRefsLock: captureContainedPathChain(commonDir, join(commonDir, "packed-refs.lock"), "missing-or-file"),
  };
}

function chainLeafExpectation(name: keyof FilesRefPathBinding): "directory" | "file" | "missing-or-file" {
  if (name === "branchReflog") return "file";
  if (name === "branchRef" || name === "packedRefs" || name === "packedRefsLock") return "missing-or-file";
  return "directory";
}

export function verifyFilesRefPaths(
  binding: FilesRefPathBinding,
  options: { allowOwnedNamespaceCreation?: boolean; allowManagedRefUpdates?: boolean } = {},
): FilesRefPathBinding {
  const boundary = component(binding.boundary.commonDir);
  if (
    boundary.dev !== binding.boundary.dev || boundary.ino !== binding.boundary.ino ||
    boundary.uid !== binding.boundary.uid || boundary.kind !== "directory"
  ) throw new Error("Git common directory identity changed.");
  const names = ["branchRef", "branchReflog", "voidNamespace", "operationNamespace", "recoveryNamespace", "packedRefs", "packedRefsLock"] as const;
  const refreshed = { ...binding };
  for (const name of names) {
    const next = captureContainedPathChain(
      binding.boundary.commonDir,
      binding[name].target,
      chainLeafExpectation(name),
    );
    const prior = binding[name];
    const managedRef = name === "branchRef" || name === "branchReflog";
    const replaceableLeaf = managedRef && options.allowManagedRefUpdates &&
      prior.missingSuffix.length === 0;
    const priorPrefix = replaceableLeaf
      ? prior.existing.slice(0, -1)
      : prior.existing;
    const preserved = next.existing.slice(0, priorPrefix.length);
    if (!isDeepStrictEqual(preserved, priorPrefix))
      throw new Error("Destructive Git path identity changed.");
    if (managedRef && options.allowManagedRefUpdates) {
      const leaf = next.existing.at(-1);
      if (!leaf || leaf.kind !== "file" || leaf.uid !== binding.boundary.uid)
        throw new Error("Destructive Git path ownership changed.");
      refreshed[name] = next;
      continue;
    }
    if (!isDeepStrictEqual(next, prior)) {
      const ownedNamespace = name === "voidNamespace" || name === "operationNamespace" || name === "recoveryNamespace";
      if (!options.allowOwnedNamespaceCreation || !ownedNamespace || next.existing.length < prior.existing.length)
        throw new Error("Destructive Git path identity changed.");
      for (const added of next.existing.slice(prior.existing.length)) {
        if (added.kind !== "directory" || added.uid !== binding.boundary.uid)
          throw new Error("Destructive Git path ownership changed.");
      }
    }
    refreshed[name] = next;
  }
  return refreshed;
}

export function receiptRef(kind: "operations" | "recoveries", id: string): string {
  validateToken(id, "managed Git identifier");
  return `refs/void/${kind}/${sha256(id)}`;
}

function parseManifestRecord(record: Buffer, oidPattern: RegExp): TreeManifestEntry {
  const tab = record.indexOf(0x09);
  if (tab < 0) throw new Error("Invalid Git tree manifest.");
  const header = decodeUtf8(record.subarray(0, tab), "Invalid Git tree manifest.");
  const path = decodeUtf8(record.subarray(tab + 1), "Invalid Git tree pathname.");
  const match = /^(\d{6}) (blob|commit) ([0-9a-f]+)$/.exec(header);
  if (!match || match[2] !== "blob" || !oidPattern.test(match[3]!))
    throw new Error("Unsupported Git tree entry.");
  if (match[1] !== "100644" && match[1] !== "100755")
    throw new Error("Unsupported Git tree mode.");
  return { path, mode: match[1], oid: match[3]! };
}

export function parseTreeManifest(bytes: Buffer, oidPattern: RegExp): TreeManifestEntry[] {
  const manifest = splitNul(bytes, "Invalid Git tree manifest.")
    .map((record) => parseManifestRecord(record, oidPattern));
  manifest.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return manifest;
}

export function readTreeManifest(
  treeish: string,
  services: CommitServices,
): TreeManifestEntry[] {
  return parseTreeManifest(
    services.gitBuffer(["ls-tree", "-rz", "--full-tree", treeish]),
    services.oidPattern,
  );
}

export function parseIndexManifest(bytes: Buffer, oidPattern: RegExp): TreeManifestEntry[] {
  const records = splitNul(bytes, "Invalid Git index manifest.");
  const manifest = records.map((record) => {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error("Invalid Git index manifest.");
    const header = decodeUtf8(record.subarray(0, tab), "Invalid Git index manifest.");
    const path = decodeUtf8(record.subarray(tab + 1), "Invalid Git index pathname.");
    const match = /^(\d{6}) ([0-9a-f]+) ([0-3])$/.exec(header);
    if (!match || match[3] !== "0" || !oidPattern.test(match[2]!))
      throw new Error("Unmerged or invalid Git index entry.");
    if (match[1] !== "100644" && match[1] !== "100755")
      throw new Error("Unsupported Git index mode.");
    return { path, mode: match[1], oid: match[2]! } as TreeManifestEntry;
  });
  manifest.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return manifest;
}

function readIndexManifest(services: CommitServices): TreeManifestEntry[] {
  return parseIndexManifest(
    services.gitBuffer(["ls-files", "--stage", "-z"]),
    services.oidPattern,
  );
}

export function applySelectedEntry(
  manifest: readonly TreeManifestEntry[],
  path: string,
  entry: GitEntry,
): TreeManifestEntry[] {
  const result = manifest.filter((item) => item.path !== path);
  if (entry.present) result.push({ path, mode: entry.mode, oid: entry.oid });
  result.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return result;
}

export function manifestDigest(manifest: readonly TreeManifestEntry[]): string {
  return jsonDigest(manifest.map((entry) => [entry.path, entry.mode, entry.oid]));
}

function findEntry(manifest: readonly TreeManifestEntry[], path: string): GitEntry {
  const found = manifest.find((entry) => entry.path === path);
  return found ? { present: true, mode: found.mode, oid: found.oid } : { present: false };
}

function readBoundedReflog(path: string): { digest: string; generation: string } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxReflogBytes))
      throw new Error("Branch reflog is unsupported.");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error("Branch reflog changed during capture.");
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.ctimeNs !== after.ctimeNs)
      throw new Error("Branch reflog changed during capture.");
    const digest = sha256(bytes);
    return {
      digest,
      generation: jsonDigest([digest, String(after.dev), String(after.ino), String(after.size), String(after.ctimeNs)]),
    };
  } finally { closeSync(fd); }
}

function exactConfig(services: CommitServices): Array<[string, string]> {
  return splitNul(services.gitBuffer(["config", "--null", "--list"]), "Invalid Git configuration.")
    .map((record) => {
      const newline = record.indexOf(0x0a);
      const keyBytes = newline < 0 ? record : record.subarray(0, newline);
      const valueBytes = newline < 0 ? Buffer.alloc(0) : record.subarray(newline + 1);
      return [
        decodeUtf8(keyBytes, "Invalid Git configuration."),
        decodeUtf8(valueBytes, "Invalid Git configuration."),
      ];
    });
}

function directoryMetadata(path: string, recursive: boolean): { digest: string; hasLock: boolean; hasPromisor: boolean } {
  const records: Array<[string, string, string, string]> = [];
  let remaining = 4096;
  let hasLock = false;
  let hasPromisor = false;
  const visit = (directory: string, depth: number): void => {
    if (depth > 64) throw new Error("Git metadata directory exceeds the managed limit.");
    const opened = opendirSync(directory);
    try {
      for (;;) {
        const entry = opened.readSync();
        if (!entry) break;
        if (--remaining < 0) throw new Error("Git metadata directory exceeds the managed limit.");
        const child = join(directory, entry.name);
        const item = lstatSync(child, { bigint: true });
        if (item.isSymbolicLink()) throw new Error("Git metadata contains a symbolic link.");
        const kind = item.isDirectory() ? "directory" : item.isFile() ? "file" : "other";
        if (kind === "other") throw new Error("Git metadata contains an unsupported path.");
        records.push([relative(path, child), kind, String(item.dev), String(item.ino)]);
        if (entry.name.endsWith(".lock")) hasLock = true;
        if (entry.name.endsWith(".promisor")) hasPromisor = true;
        if (recursive && item.isDirectory()) visit(child, depth + 1);
      }
    } finally { opened.closeSync(); }
  };
  if (pathExistsNoFollow(path)) visit(path, 0);
  records.sort((left, right) => left[0].localeCompare(right[0]));
  return { digest: jsonDigest(records), hasLock, hasPromisor };
}

function captureWorktree(path: string, entry: GitEntry, services: CommitServices): WorktreeBinding {
  const absolute = services.pathTarget(path);
  if (!entry.present) {
    if (pathExistsNoFollow(absolute)) throw new Error("A staged deletion requires an absent worktree path.");
    return { present: false };
  }
  let fd: number;
  try { fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("Selected staged worktree file is absent.");
    throw new Error("Selected worktree path is not a regular file.");
  }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n)
      throw new Error("Selected worktree path is not a single-link regular file.");
    const mode = (before.mode & 0o111n) === 0n ? "100644" : "100755";
    const oid = services.git(["hash-object", "--no-filters", "--", path]);
    const after = fstatSync(fd, { bigint: true });
    const pathname = lstatSync(absolute, { bigint: true });
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.ctimeNs !== after.ctimeNs || pathname.isSymbolicLink() || !pathname.isFile() ||
      pathname.dev !== after.dev || pathname.ino !== after.ino
    ) throw new Error("Selected worktree file changed during capture.");
    if (mode !== entry.mode || oid !== entry.oid)
      throw new Error("Selected worktree does not match the staged entry.");
    return {
      present: true,
      mode,
      blobOid: oid,
      revision: jsonDigest([oid, mode, String(after.dev), String(after.ino), String(after.size), String(after.ctimeNs)]),
    };
  } finally { closeSync(fd); }
}

export function assertRepositoryProfile(
  services: CommitServices,
  branchRef: string,
  capturedPaths?: FilesRefPathBinding,
): { paths: FilesRefPathBinding; config: Array<[string, string]>; metadataDigest: string } {
  if (services.currentIdentity() !== services.identity) throw new Error("Git repository identity changed.");
  if (services.git(["rev-parse", "--show-ref-format"]) !== "files")
    throw new Error("Only the files ref backend is supported.");
  const worktrees = splitNul(
    services.gitBuffer(["worktree", "list", "--porcelain", "-z"]),
    "Invalid Git worktree list.",
  ).filter((record) => record.subarray(0, 9).toString("ascii") === "worktree ");
  if (worktrees.length !== 1) throw new Error("Managed Git commit requires one registered worktree.");
  if (pathExistsNoFollow(join(services.commonDir, "shallow"))) throw new Error("Shallow repositories are unsupported.");
  if (pathExistsNoFollow(join(services.commonDir, "info", "grafts"))) throw new Error("Git grafts are unsupported.");
  if (pathExistsNoFollow(join(services.commonDir, "objects", "info", "alternates"))) throw new Error("Git alternates are unsupported.");
  if (services.git(["for-each-ref", "--format=%(refname)", "refs/replace/"]))
    throw new Error("Git replace refs are unsupported.");
  const config = exactConfig(services);
  for (const [rawKey, rawValue] of config) {
    const key = rawKey.toLowerCase();
    const value = rawValue.toLowerCase();
    if (key === "extensions.partialclone") throw new Error("Partial clones are unsupported.");
    if (/^remote\..+\.promisor$/.test(key) && ["true", "yes", "on", "1"].includes(value))
      throw new Error("Git promisor remotes are unsupported.");
    if (key === "commit.gpgsign" && ["true", "yes", "on", "1"].includes(value))
      throw new Error("Required commit signing is unsupported.");
  }
  const paths = capturedPaths ?? captureFilesRefPaths(services.commonDir, branchRef);
  verifyFilesRefPaths(paths);
  if (paths.branchReflog.missingSuffix.length) throw new Error("An existing branch reflog is required.");
  const receiptMetadata = directoryMetadata(join(services.commonDir, "refs", "void"), true);
  const packPath = captureContainedPathChain(
    services.commonDir,
    join(services.commonDir, "objects", "pack"),
    "directory",
  );
  const packMetadata = directoryMetadata(packPath.target, false);
  if (packMetadata.hasPromisor) throw new Error("Git promisor packs are unsupported.");
  if (
    pathExistsNoFollow(`${paths.branchRef.target}.lock`) ||
    pathExistsNoFollow(`${paths.branchReflog.target}.lock`) ||
    paths.packedRefsLock.missingSuffix.length === 0 ||
    receiptMetadata.hasLock
  ) throw new Error("A relevant Git ref is locked.");
  return {
    paths,
    config,
    metadataDigest: jsonDigest([packPath, packMetadata.digest, receiptMetadata.digest]),
  };
}

export function captureCommit(
  mutation: CommitMutation,
  services: CommitServices,
): CommitCapture {
  validateSelectedPath(mutation.path);
  services.pathTarget(mutation.path);
  services.validateRepository();
  let ref: string;
  try { ref = services.git(["symbolic-ref", "-q", "HEAD"]); }
  catch { throw new Error("An attached branch is required."); }
  validateBranchRef(ref);
  const destructivePaths = captureFilesRefPaths(services.commonDir, ref);
  let directHead: string;
  try { directHead = services.git(["show-ref", "--verify", "--hash", ref]); }
  catch { throw new Error("A born HEAD is required."); }
  if (!services.oidPattern.test(directHead)) throw new Error("A born HEAD is required.");
  const profile = assertRepositoryProfile(services, ref, destructivePaths);
  let head: string;
  try { head = services.git(["rev-parse", "--verify", "HEAD^{commit}"]); }
  catch { throw new Error("A born HEAD is required."); }
  if (!services.oidPattern.test(head) || head !== directHead) throw new Error("A born HEAD is required.");
  if (services.git(["rev-parse", "--symbolic-full-name", "HEAD"]) !== ref)
    throw new Error("An attached direct branch is required.");
  const tree = services.git(["rev-parse", "--verify", "HEAD^{tree}"]);
  if (!services.oidPattern.test(tree)) throw new Error("Invalid HEAD tree identity.");
  const reflog = readBoundedReflog(profile.paths.branchReflog.target);
  const headManifest = readTreeManifest(tree, services);
  const indexManifest = readIndexManifest(services);
  for (const oid of new Set([...headManifest, ...indexManifest].map((item) => item.oid)))
    services.git(["cat-file", "-e", `${oid}^{blob}`]);
  services.git(["fsck", "--connectivity-only", "--no-dangling"], undefined, {
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
  });
  const headEntry = findEntry(headManifest, mutation.path);
  const indexEntry = findEntry(indexManifest, mutation.path);
  if (isDeepStrictEqual(headEntry, indexEntry)) throw new Error("No-op Git commits are refused.");
  const selected: SelectedBinding = {
    path: mutation.path,
    head: headEntry,
    index: indexEntry,
    worktree: captureWorktree(mutation.path, indexEntry, services),
  };
  const raw = services.rawIndex();
  const repository: RepositoryBinding = {
    identity: services.identity,
    root: services.root,
    gitDir: services.gitDir,
    commonDir: services.commonDir,
    indexPath: services.indexPath,
    objectFormat: services.objectFormat,
    refBackend: "files",
    worktreeCount: 1,
    destructivePaths: profile.paths,
  };
  const refusalDigest = jsonDigest([
    ref,
    head,
    tree,
    selected,
    profile.config,
    profile.paths,
    profile.metadataDigest,
  ]);
  return {
    kind: "commit",
    mutation,
    repository,
    branch: {
      ref,
      head,
      tree,
      reflogDigest: reflog.digest,
      reflogGeneration: reflog.generation,
    },
    index: {
      rawDigest: sha256(raw),
      revision: services.indexRevision(),
      manifestDigest: manifestDigest(indexManifest),
    },
    selected,
    expectedTreeManifestDigest: manifestDigest(applySelectedEntry(headManifest, mutation.path, indexEntry)),
    refusalDigest,
  };
}

export function prepareCommit(
  captured: CommitCapture,
  operationId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): CommitPlan {
  validateToken(operationId, "managed Git identifier");
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0)
    throw new Error("Invalid managed Git timestamp.");
  const expectedTreeManifestDigest = captured.expectedTreeManifestDigest;
  const operationDigest = sha256(operationId);
  return {
    kind: "commit",
    mutation: captured.mutation,
    repository: captured.repository,
    parent: captured.branch.head,
    expectedTreeManifestDigest,
    branchRef: captured.branch.ref,
    receiptRef: receiptRef("operations", operationId),
    metadata: {
      authorName: "VOID Managed Git",
      authorEmail: "managed-git@void.invalid",
      committerName: "VOID Managed Git",
      committerEmail: "managed-git@void.invalid",
      timestamp: String(nowSeconds),
      subject: `VOID managed commit ${operationDigest.slice(0, 16)}`,
    },
  };
}

export type PrivateWorkspaceInitEvent =
  | "random"
  | "open"
  | "write"
  | "close"
  | "lstat"
  | "validation";

type PrivateWorkspaceControls = {
  seam?: (event: PrivateWorkspaceInitEvent) => void;
  directoryLstat?: (path: string) => BigIntStats;
};

export function createPrivateIndexWorkspace(
  realIndexPath: string,
  controls: PrivateWorkspaceControls = {},
): PrivateIndexWorkspace {
  const parent = realpathSync(dirname(realIndexPath));
  const parentIdentity = lstatSync(parent, { bigint: true });
  const effectiveUid = BigInt(process.geteuid?.() ?? process.getuid?.() ?? Number(parentIdentity.uid));
  const initialDirectoryMode = BigInt(0o700 & ~process.umask());
  const directory = mkdtempSync(join(parent, ".void-git-index-"));
  let createdDirectory: BigIntStats | undefined;
  let descriptor: number | undefined;
  let tokenIdentity: { dev: bigint; ino: bigint } | undefined;
  const tokenPath = join(directory, "owner");
  try {
    createdDirectory = controls.directoryLstat?.(directory) ??
      lstatSync(directory, { bigint: true });
    chmodSync(directory, 0o700);
    const item = lstatSync(directory, { bigint: true });
    if (
      !item.isDirectory() || item.isSymbolicLink() ||
      item.dev !== createdDirectory.dev || item.ino !== createdDirectory.ino ||
      item.uid !== effectiveUid || item.nlink < 1n || (item.mode & 0o777n) !== 0o700n
    ) throw new Error("Managed Git private workspace is unsafe.");
    controls.seam?.("random");
    const token = randomBytes(32).toString("hex");
    controls.seam?.("open");
    descriptor = openSync(
      tokenPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    const openedToken = fstatSync(descriptor, { bigint: true });
    tokenIdentity = { dev: openedToken.dev, ino: openedToken.ino };
    fchmodSync(descriptor, 0o600);
    controls.seam?.("write");
    writeFileSync(descriptor, token);
    controls.seam?.("close");
    // Keep the inode allocated until cleanup so unlink/create cannot reuse it.
    controls.seam?.("lstat");
    const tokenStat = lstatSync(tokenPath, { bigint: true });
    controls.seam?.("validation");
    if (
      fstatSync(descriptor, { bigint: true }).nlink !== 1n ||
      !tokenStat.isFile() || tokenStat.isSymbolicLink() || tokenStat.nlink !== 1n ||
      tokenStat.dev !== tokenIdentity.dev || tokenStat.ino !== tokenIdentity.ino ||
      tokenStat.uid !== item.uid || (tokenStat.mode & 0o777n) !== 0o600n
    ) throw new Error("Managed Git private workspace token is unsafe.");
    const workspace: PrivateIndexWorkspace = {
      directory,
      directoryDev: item.dev,
      directoryIno: item.ino,
      directoryUid: item.uid,
      tokenPath,
      tokenDev: tokenStat.dev,
      tokenIno: tokenStat.ino,
      token,
      indexPath: join(directory, "index"),
      ownedFiles: new Map(),
    };
    workspace.ownedFiles.set(tokenPath, { dev: tokenStat.dev, ino: tokenStat.ino, descriptor });
    if (pathExistsNoFollow(workspace.indexPath))
      throw new Error("Managed Git private index already exists.");
    return workspace;
  } catch (error) {
    try {
      const currentParent = lstatSync(parent, { bigint: true });
      const currentDirectory = lstatSync(directory, { bigint: true });
      const parentUnchanged =
        currentParent.isDirectory() && !currentParent.isSymbolicLink() &&
        currentParent.dev === parentIdentity.dev && currentParent.ino === parentIdentity.ino &&
        currentParent.uid === parentIdentity.uid;
      const directoryUnchanged = createdDirectory
        ? currentDirectory.isDirectory() && !currentDirectory.isSymbolicLink() &&
          currentDirectory.dev === createdDirectory.dev && currentDirectory.ino === createdDirectory.ino &&
          currentDirectory.uid === createdDirectory.uid
        : currentDirectory.isDirectory() && !currentDirectory.isSymbolicLink() &&
          currentDirectory.uid === effectiveUid && currentDirectory.nlink >= 1n &&
          (currentDirectory.mode & 0o777n) === initialDirectoryMode &&
          readdirSync(directory).length === 0;
      if (parentUnchanged && directoryUnchanged) {
        if (tokenIdentity && descriptor !== undefined && pathExistsNoFollow(tokenPath)) {
          const currentToken = lstatSync(tokenPath, { bigint: true });
          if (
            fstatSync(descriptor, { bigint: true }).nlink === 1n &&
            currentToken.isFile() && !currentToken.isSymbolicLink() &&
            currentToken.dev === tokenIdentity.dev && currentToken.ino === tokenIdentity.ino
          ) unlinkSync(tokenPath);
        }
        if (readdirSync(directory).length === 0) rmdirSync(directory);
      }
    } catch {}
    finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    throw error;
  }
}

function assertPrivateDirectory(workspace: PrivateIndexWorkspace): void {
  const directory = lstatSync(workspace.directory, { bigint: true });
  if (
    !directory.isDirectory() || directory.isSymbolicLink() ||
    directory.dev !== workspace.directoryDev || directory.ino !== workspace.directoryIno ||
    directory.uid !== workspace.directoryUid || (directory.mode & 0o777n) !== 0o700n
  ) throw new Error("Managed Git private workspace identity changed.");
}

export function recordOwnedPrivateFile(
  workspace: PrivateIndexWorkspace,
  path: string,
): void {
  if (!pathExistsNoFollow(path)) return;
  if (dirname(path) !== workspace.directory)
    throw new Error("Managed Git private file escaped its workspace.");
  assertPrivateDirectory(workspace);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let retained = false;
  try {
    const item = fstatSync(descriptor, { bigint: true });
    const pathname = lstatSync(path, { bigint: true });
    if (
      !item.isFile() || item.nlink !== 1n || item.uid !== workspace.directoryUid ||
      pathname.isSymbolicLink() || pathname.dev !== item.dev || pathname.ino !== item.ino
    ) throw new Error("Managed Git private file identity changed.");
    const previous = workspace.ownedFiles.get(path);
    workspace.ownedFiles.set(path, { dev: item.dev, ino: item.ino, descriptor });
    retained = true;
    if (previous) closeSync(previous.descriptor);
  } finally {
    if (!retained) closeSync(descriptor);
  }
}

function assertOwnedPrivateFile(workspace: PrivateIndexWorkspace, path: string): void {
  const expected = workspace.ownedFiles.get(path);
  const current = lstatSync(path, { bigint: true });
  if (
    dirname(path) !== workspace.directory || !expected || !current.isFile() ||
    current.isSymbolicLink() || current.nlink !== 1n ||
    current.uid !== workspace.directoryUid || current.dev !== expected.dev ||
    current.ino !== expected.ino || fstatSync(expected.descriptor, { bigint: true }).nlink !== 1n
  ) throw new Error("Managed Git private file identity changed.");
}

export function cleanupPrivateIndexWorkspace(workspace: PrivateIndexWorkspace): void {
  try {
    assertPrivateDirectory(workspace);
    const tokenDescriptor = workspace.ownedFiles.get(workspace.tokenPath)?.descriptor;
    if (tokenDescriptor === undefined)
      throw new Error("Managed Git private workspace token identity changed.");
    const token = fstatSync(tokenDescriptor, { bigint: true });
    const bytes = Buffer.alloc(Buffer.byteLength(workspace.token));
    const count = readSync(tokenDescriptor, bytes, 0, bytes.length, 0);
    const pathname = lstatSync(workspace.tokenPath, { bigint: true });
    if (
      !token.isFile() || token.nlink !== 1n || token.dev !== workspace.tokenDev ||
      token.ino !== workspace.tokenIno || token.uid !== workspace.directoryUid ||
      (token.mode & 0o777n) !== 0o600n || count !== bytes.length ||
      bytes.toString("utf8") !== workspace.token || pathname.isSymbolicLink() ||
      pathname.dev !== token.dev || pathname.ino !== token.ino
    ) throw new Error("Managed Git private workspace token identity changed.");
    const allowed = new Set(["owner", "index", "index.lock"]);
    if (readdirSync(workspace.directory).some((name) => !allowed.has(name)))
      throw new Error("Managed Git private workspace contains an unknown file.");
    const paths = [`${workspace.indexPath}.lock`, workspace.indexPath, workspace.tokenPath];
    for (const path of paths) {
      if (pathExistsNoFollow(path)) assertOwnedPrivateFile(workspace, path);
    }
    for (const path of paths) {
      if (!pathExistsNoFollow(path)) continue;
      assertOwnedPrivateFile(workspace, path);
      unlinkSync(path);
    }
    assertPrivateDirectory(workspace);
    rmdirSync(workspace.directory);
  } finally {
    for (const file of workspace.ownedFiles.values()) closeSync(file.descriptor);
    workspace.ownedFiles.clear();
  }
}

export async function writeCandidateTree(
  baseTree: string,
  path: string,
  entry: GitEntry,
  expectedManifestDigest: string,
  services: CommitServices,
): Promise<string> {
  const workspace = createPrivateIndexWorkspace(services.indexPath);
  const privateEnv = {
    GIT_INDEX_FILE: workspace.indexPath,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
  };
  const privateGit = (args: readonly string[]): string => {
    try { return services.git(args, undefined, privateEnv); }
    finally {
      recordOwnedPrivateFile(workspace, workspace.indexPath);
      recordOwnedPrivateFile(workspace, `${workspace.indexPath}.lock`);
    }
  };
  try {
    privateGit(["read-tree", baseTree]);
    if (entry.present) {
      privateGit(["update-index", "--add", "--cacheinfo", entry.mode, entry.oid, path]);
    } else {
      privateGit(["update-index", "--force-remove", "--", path]);
    }
    const tree = privateGit(["write-tree"]);
    if (
      !services.oidPattern.test(tree) ||
      manifestDigest(readTreeManifest(tree, services)) !== expectedManifestDigest
    ) throw new Error("Managed Git candidate tree verification failed.");
    return tree;
  } finally {
    cleanupPrivateIndexWorkspace(workspace);
  }
}

export async function createCommit(
  tree: string,
  parent: string,
  metadata: CommitMetadata,
  services: CommitServices,
): Promise<string> {
  const date = `${metadata.timestamp} +0000`;
  const oid = services.git(
    [
      "-c", "commit.gpgSign=false",
      "-c", "user.useConfigOnly=true",
      "-c", "core.hooksPath=/dev/null",
      "commit-tree", tree, "-p", parent,
    ],
    Buffer.from(`${metadata.subject}\n`),
    {
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_AUTHOR_NAME: metadata.authorName,
      GIT_AUTHOR_EMAIL: metadata.authorEmail,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: metadata.committerName,
      GIT_COMMITTER_EMAIL: metadata.committerEmail,
      GIT_COMMITTER_DATE: date,
    },
  );
  if (!services.oidPattern.test(oid))
    throw new Error("Managed Git commit creation failed.");
  return oid;
}

type TransactionControls = {
  command?: string;
  commandArgs?: string[];
  timeoutMs?: number;
  abortGraceMs?: number;
  termGraceMs?: number;
  killGraceMs?: number;
  holdAfterPrepare?: boolean;
  onSignal?: (signal: NodeJS.Signals) => void;
  onSpawn?: (pid: number) => void;
  scheduleStdinEndCallback?: (callback: () => void) => void;
};

export async function commitRefTransaction(
  updates: readonly RefUpdate[],
  lockedRecheck: () => void,
  services: CommitServices,
  controls: TransactionControls = {},
): Promise<void> {
  if (!updates.length) throw new Error("Managed Git ref transaction failed.");
  for (const update of updates) {
    if (update.ref.startsWith("refs/heads/")) validateBranchRef(update.ref);
    else if (!/^refs\/void\/(?:operations|recoveries)\/[0-9a-f]{64}$/.test(update.ref))
      throw new Error("Managed Git ref transaction failed.");
    if (!services.oidPattern.test(update.newOid) || (update.oldOid !== null && !services.oidPattern.test(update.oldOid)))
      throw new Error("Managed Git ref transaction failed.");
  }
  const commands = [
    "start",
    ...updates.map((update) => update.oldOid === null
      ? `create ${update.ref} ${update.newOid}`
      : `update ${update.ref} ${update.newOid} ${update.oldOid}`),
    "prepare",
    "",
  ].join("\n");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      controls.command ?? "git",
      controls.command
        ? (controls.commandArgs ?? [])
        : ["-c", "core.hooksPath=/dev/null", "update-ref", "--stdin"],
      {
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
      },
    );
    if (child.pid !== undefined) controls.onSpawn?.(child.pid);
    const prepareAcknowledgement = Buffer.from("start: ok\nprepare: ok\n", "ascii");
    const commitAcknowledgement = Buffer.from("start: ok\nprepare: ok\ncommit: ok\n", "ascii");
    const stdoutCap = 64 * 1024;
    let stdout = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let prepared = false;
    let accepted = false;
    let shuttingDown = false;
    let settled = false;
    let abortTimer: NodeJS.Timeout | undefined;
    let termTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const transactionError = () => new Error("Managed Git ref transaction failed.");
    const rejectOnce = () => {
      if (settled) return;
      settled = true;
      rejectPromise(transactionError());
    };
    const sendKill = () => {
      if (settled) return;
      if (child.exitCode === null && child.signalCode === null) {
        controls.onSignal?.("SIGKILL");
        child.kill("SIGKILL");
      }
      if (!settled)
        killTimer ??= setTimeout(rejectOnce, controls.killGraceMs ?? 250);
    };
    const sendTerm = () => {
      if (settled) return;
      if (child.exitCode === null && child.signalCode === null) {
        controls.onSignal?.("SIGTERM");
        child.kill("SIGTERM");
      }
      if (!settled)
        termTimer ??= setTimeout(sendKill, controls.termGraceMs ?? 250);
    };
    const waitForAbortThenTerm = () => {
      if (settled || !shuttingDown) return;
      abortTimer ??= setTimeout(sendTerm, controls.abortGraceMs ?? 250);
    };
    const endStdinForShutdown = (data?: string) => {
      if (settled) return;
      if (controls.scheduleStdinEndCallback) {
        child.stdin.end(data);
        controls.scheduleStdinEndCallback(waitForAbortThenTerm);
      } else {
        child.stdin.end(data, waitForAbortThenTerm);
      }
    };
    const shutdown = () => {
      if (shuttingDown || settled) return;
      shuttingDown = true;
      waitForAbortThenTerm();
      if (child.stdin.destroyed) return;
      try {
        endStdinForShutdown(prepared && !accepted ? "abort\n" : undefined);
      } catch { sendTerm(); }
    };
    const timeout = setTimeout(shutdown, controls.timeoutMs ?? 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (shuttingDown || settled) return;
      stdoutBytes += chunk.length;
      const available = stdoutCap - stdout.length;
      if (available > 0)
        stdout = Buffer.concat([stdout, chunk.subarray(0, available)]);

      if (
        !prepared && stdout.length >= prepareAcknowledgement.length &&
        stdout.subarray(0, prepareAcknowledgement.length).equals(prepareAcknowledgement)
      ) prepared = true;

      if (stdoutBytes > stdoutCap) return shutdown();
      const expected = accepted ? commitAcknowledgement : prepareAcknowledgement;
      if (!stdout.equals(expected.subarray(0, stdout.length))) return shutdown();
      if (!prepared || stdout.length !== prepareAcknowledgement.length) return;
      if (controls.holdAfterPrepare) return;
      try {
        lockedRecheck();
        accepted = true;
        child.stdin.end("commit\n");
      } catch { shutdown(); }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderrBytes += chunk.length;
      shutdown();
    });
    child.on("error", () => {
      if (!settled) shutdown();
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (abortTimer) clearTimeout(abortTimer);
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      const valid = accepted && !shuttingDown && code === 0 && signal === null && stderrBytes === 0 &&
        stdout.equals(Buffer.from("start: ok\nprepare: ok\ncommit: ok\n"));
      settled = true;
      if (valid) resolvePromise();
      else rejectPromise(transactionError());
    });
    child.stdin.on("error", () => {
      if (settled) return;
      if (shuttingDown) sendTerm();
      else shutdown();
    });
    child.stdin.write(commands);
  });
}

export function readExactRef(ref: string, services: CommitServices): string | null {
  try {
    const oid = services.git(["show-ref", "--verify", "--hash", ref]);
    return services.oidPattern.test(oid) ? oid : null;
  } catch { return null; }
}

function currentWorktreeDigest(captured: CommitCapture, services: CommitServices): string {
  const selected = captured.selected;
  const target = services.pathTarget(selected.path);
  if (!selected.worktree.present)
    return pathExistsNoFollow(target) ? "changed" : jsonDigest(["absent"]);
  if (!pathExistsNoFollow(target)) return "changed";
  const item = lstatSync(target, { bigint: true });
  if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1n) return "changed";
  const mode = (item.mode & 0o111n) === 0n ? "100644" : "100755";
  const oid = services.git(["hash-object", "--no-filters", "--", selected.path]);
  return jsonDigest([oid, mode]);
}

function expectedWorktreeDigest(captured: CommitCapture): string {
  return captured.selected.worktree.present
    ? jsonDigest([captured.selected.worktree.blobOid, captured.selected.worktree.mode])
    : jsonDigest(["absent"]);
}

function refNamespaceDigest(binding: FilesRefPathBinding): string {
  const identity = (chain: ContainedPathChain) => ({
    existing: chain.existing.map(({ kind, dev, ino, uid }) => ({ kind, dev, ino, uid })),
    missingSuffix: chain.missingSuffix,
  });
  return jsonDigest({
    voidNamespace: identity(binding.voidNamespace),
    operationNamespace: identity(binding.operationNamespace),
  });
}

function verifyManagedCommitEvidence(
  commit: string,
  captured: CommitCapture,
  plan: CommitPlan,
  services: CommitServices,
  requireCurrentBranch: boolean,
  requireCurrentHumanState: boolean,
): CommitEvidence {
  if (
    services.currentIdentity() !== captured.repository.identity ||
    services.root !== captured.repository.root ||
    services.gitDir !== captured.repository.gitDir ||
    services.commonDir !== captured.repository.commonDir ||
    services.indexPath !== captured.repository.indexPath ||
    services.objectFormat !== captured.repository.objectFormat
  ) throw new Error("Managed Git repository identity changed.");
  const branchChain = captureContainedPathChain(
    services.commonDir,
    captured.repository.destructivePaths.branchRef.target,
    "file",
  );
  const capturedBranch = captured.repository.destructivePaths.branchRef;
  const branchParents = capturedBranch.missingSuffix.length
    ? capturedBranch.existing
    : capturedBranch.existing.slice(0, -1);
  if (!isDeepStrictEqual(branchChain.existing.slice(0, branchParents.length), branchParents))
    throw new Error("Managed Git branch path identity changed.");
  const reflogChain = captureContainedPathChain(
    services.commonDir,
    captured.repository.destructivePaths.branchReflog.target,
    "file",
  );
  if (!isDeepStrictEqual(
    reflogChain.existing,
    captured.repository.destructivePaths.branchReflog.existing,
  )) throw new Error("Managed Git branch reflog identity changed.");
  const receiptChain = captureContainedPathChain(
    services.commonDir,
    join(services.commonDir, ...plan.receiptRef.split("/")),
    "file",
  );
  const operationPrefix = captured.repository.destructivePaths.operationNamespace.existing;
  if (!isDeepStrictEqual(receiptChain.existing.slice(0, operationPrefix.length), operationPrefix))
    throw new Error("Managed Git receipt path identity changed.");
  for (const added of receiptChain.existing.slice(operationPrefix.length, -1)) {
    if (added.kind !== "directory" || added.uid !== captured.repository.destructivePaths.boundary.uid)
      throw new Error("Managed Git receipt path ownership changed.");
  }
  if (
    (requireCurrentBranch && readExactRef(plan.branchRef, services) !== commit) ||
    readExactRef(plan.receiptRef, services) !== commit
  ) throw new Error("Managed Git commit verification failed.");
  const raw = services.gitBuffer(["cat-file", "commit", commit]);
  if (raw.length >= 1024 || raw.includes(Buffer.from("gpgsig")))
    throw new Error("Managed Git commit verification failed.");
  const tree = services.git(["rev-parse", `${commit}^{tree}`]);
  const expected = Buffer.from(
    `tree ${tree}\n` +
    `parent ${plan.parent}\n` +
    `author ${plan.metadata.authorName} <${plan.metadata.authorEmail}> ${plan.metadata.timestamp} +0000\n` +
    `committer ${plan.metadata.committerName} <${plan.metadata.committerEmail}> ${plan.metadata.timestamp} +0000\n\n` +
    `${plan.metadata.subject}\n`,
  );
  if (!raw.equals(expected)) throw new Error("Managed Git commit verification failed.");
  if (manifestDigest(readTreeManifest(tree, services)) !== plan.expectedTreeManifestDigest)
    throw new Error("Managed Git commit verification failed.");
  const indexDigest = requireCurrentHumanState
    ? sha256(services.rawIndex())
    : captured.index.rawDigest;
  if (indexDigest !== captured.index.rawDigest)
    throw new Error("Managed Git real index changed.");
  const worktreeDigest = requireCurrentHumanState
    ? currentWorktreeDigest(captured, services)
    : expectedWorktreeDigest(captured);
  if (worktreeDigest !== expectedWorktreeDigest(captured))
    throw new Error("Managed Git worktree changed.");
  const refreshedPaths = verifyFilesRefPaths(captured.repository.destructivePaths, {
    allowOwnedNamespaceCreation: true,
    allowManagedRefUpdates: true,
  });
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
    refNamespaceDigest: refNamespaceDigest(refreshedPaths),
  };
}

export function verifyManagedCommit(
  commit: string,
  captured: CommitCapture,
  plan: CommitPlan,
  services: CommitServices,
): CommitEvidence {
  return verifyManagedCommitEvidence(
    commit,
    captured,
    plan,
    services,
    true,
    true,
  );
}

export function validateOperationReceipt(
  operationId: string,
  captured: CommitCapture,
  plan: CommitPlan,
  services: CommitServices,
): Outcome | null {
  try {
    const timestamp = Number(plan.metadata.timestamp);
    const expectedPlan = prepareCommit(captured, operationId, timestamp);
    if (!isDeepStrictEqual(plan, expectedPlan)) return null;
    const exactReceipt = receiptRef("operations", operationId);
    if (plan.receiptRef !== exactReceipt) return null;
    const commit = readExactRef(exactReceipt, services);
    if (commit === null) return null;
    const evidence = verifyManagedCommitEvidence(
      commit,
      captured,
      plan,
      services,
      false,
      false,
    );
    if (readExactRef(exactReceipt, services) !== commit) return null;
    return {
      result: { action: "commit", path: captured.mutation.path, commit },
      evidence: evidence as unknown as Json,
    };
  } catch {
    return null;
  }
}

function validateOperationReceiptHash(
  captured: CommitCapture,
  plan: CommitPlan,
  services: CommitServices,
): Outcome | null {
  const commit = readExactRef(plan.receiptRef, services);
  if (commit === null) return null;
  try {
    const evidence = verifyManagedCommitEvidence(commit, captured, plan, services, false, false);
    return {
      result: { action: "commit", path: captured.mutation.path, commit },
      evidence: evidence as unknown as Json,
    };
  } catch { return null; }
}

export function verifySelectedHumanState(
  captured: CommitCapture,
  services: CommitServices,
): void {
  if (!isDeepStrictEqual(
    findEntry(readIndexManifest(services), captured.selected.path),
    captured.selected.index,
  ) || currentWorktreeDigest(captured, services) !== expectedWorktreeDigest(captured))
    throw new Error("Managed Git selected human state changed.");
}

function recoveryResult(
  commit: string,
  recoveryRef: string,
  expectedParent: string | null,
  captured: CommitCapture,
  plan: CommitPlan,
  recoveryId: string,
  services: CommitServices,
): RecoveryOutcome {
  services.validateRepository();
  if (readExactRef(recoveryRef, services) !== commit)
    throw new Error("Managed Git recovery receipt changed.");
  const raw = services.gitBuffer(["cat-file", "commit", commit]);
  if (raw.length >= 1024 || raw.includes(Buffer.from("gpgsig")))
    throw new Error("Managed Git recovery commit changed.");
  const text = decodeUtf8(raw, "Managed Git recovery commit changed.");
  const match = /^tree ([0-9a-f]+)\nparent ([0-9a-f]+)\nauthor VOID Managed Git <managed-git@void\.invalid> (\d+) \+0000\ncommitter VOID Managed Git <managed-git@void\.invalid> \3 \+0000\n\nVOID managed recovery ([0-9a-f]{16})\n$/.exec(text);
  if (!match || !services.oidPattern.test(match[1]!) || !services.oidPattern.test(match[2]!) ||
    match[4] !== sha256(recoveryId).slice(0, 16) ||
    (expectedParent !== null && match[2] !== expectedParent))
    throw new Error("Managed Git recovery commit changed.");
  const parent = match[2]!;
  const forward = readExactRef(plan.receiptRef, services);
  if (forward === null) throw new Error("Managed Git operation receipt changed.");
  services.git(["merge-base", "--is-ancestor", forward, parent]);
  const parentManifest = readTreeManifest(`${parent}^{tree}`, services);
  if (!isDeepStrictEqual(findEntry(parentManifest, captured.selected.path), captured.selected.index))
    throw new Error("Managed Git recovery parent changed.");
  const expected = applySelectedEntry(parentManifest, captured.selected.path, captured.selected.head);
  const actual = readTreeManifest(match[1]!, services);
  if (!isDeepStrictEqual(actual, expected)) throw new Error("Managed Git inverse changed.");
  return {
    status: "restored",
    evidence: {
      verified: true,
      commit,
      parent,
      receiptRef: recoveryRef,
      operationCommit: forward,
    },
  };
}

export function createManagedCommitLifecycle(services: CommitServices): ManagedCommitLifecycle {
  const receiptPath = (ref: string) => join(services.commonDir, ...ref.split("/"));
  const validateReceiptChain = (
    prior: ContainedPathChain,
    allowOwnedParentCreation: boolean,
  ): ContainedPathChain => {
    const current = captureContainedPathChain(
      services.commonDir,
      prior.target,
      "missing-or-file",
    );
    if (!current.missingSuffix.length)
      throw new Error("Managed Git receipt already exists.");
    if (!allowOwnedParentCreation) {
      if (!isDeepStrictEqual(current, prior))
        throw new Error("Managed Git receipt path identity changed.");
    } else {
      if (!isDeepStrictEqual(current.existing.slice(0, prior.existing.length), prior.existing))
        throw new Error("Managed Git receipt path identity changed.");
      for (const added of current.existing.slice(prior.existing.length)) {
        if (added.kind !== "directory" || added.uid !== capturedUid(prior))
          throw new Error("Managed Git receipt path ownership changed.");
      }
      if (current.missingSuffix.at(-1) !== prior.missingSuffix.at(-1))
        throw new Error("Managed Git receipt path identity changed.");
    }
    return current;
  };
  const capturedUid = (chain: ContainedPathChain): string => {
    const first = chain.existing[0];
    return first?.uid ?? String(lstatSync(services.commonDir, { bigint: true }).uid);
  };
  return {
    capture(mutation) { return captureCommit(mutation, services); },
    prepare(mutation, captured, operationId) {
      if (!isDeepStrictEqual(mutation, captured.mutation))
        throw new Error("Managed Git commit mutation changed.");
      const actual = captureCommit(mutation, services);
      verifyFilesRefPaths(captured.repository.destructivePaths);
      if (!isDeepStrictEqual(actual, captured))
        throw new Error("Managed Git commit capture changed.");
      const plan = prepareCommit(captured, operationId);
      const receipt = captureContainedPathChain(
        services.commonDir,
        receiptPath(plan.receiptRef),
        "missing-or-file",
      );
      if (!receipt.missingSuffix.length || pathExistsNoFollow(`${receipt.target}.lock`))
        throw new Error("Managed Git receipt is unavailable.");
      return plan;
    },
    async execute(mutation, captured, plan, operationId) {
      if (!isDeepStrictEqual(mutation, captured.mutation))
        throw new Error("Managed Git commit mutation changed.");
      const expectedPlan = prepareCommit(
        captured,
        operationId,
        Number(plan.metadata.timestamp),
      );
      if (!isDeepStrictEqual(plan, expectedPlan))
        throw new Error("Managed Git commit plan changed.");
      const actual = captureCommit(mutation, services);
      if (!isDeepStrictEqual(actual, captured))
        throw new Error("Managed Git commit capture changed.");
      verifyFilesRefPaths(captured.repository.destructivePaths);
      const receipt = captureContainedPathChain(
        services.commonDir,
        receiptPath(plan.receiptRef),
        "missing-or-file",
      );
      if (!receipt.missingSuffix.length || pathExistsNoFollow(`${receipt.target}.lock`))
        throw new Error("Managed Git receipt is unavailable.");
      const tree = await writeCandidateTree(
        captured.branch.tree,
        captured.selected.path,
        captured.selected.index,
        plan.expectedTreeManifestDigest,
        services,
      );
      const commit = await createCommit(tree, plan.parent, plan.metadata, services);
      verifyFilesRefPaths(captured.repository.destructivePaths);
      validateReceiptChain(receipt, false);
      await commitRefTransaction(
        [
          { ref: plan.branchRef, newOid: commit, oldOid: plan.parent },
          { ref: plan.receiptRef, newOid: commit, oldOid: null },
        ],
        () => {
          verifyFilesRefPaths(
            captured.repository.destructivePaths,
            { allowOwnedNamespaceCreation: true },
          );
          validateReceiptChain(receipt, true);
          const reflog = readBoundedReflog(
            captured.repository.destructivePaths.branchReflog.target,
          );
          if (
            reflog.digest !== captured.branch.reflogDigest ||
            reflog.generation !== captured.branch.reflogGeneration
          ) throw new Error("Managed Git branch reflog changed.");
        },
        services,
      );
      const evidence = verifyManagedCommit(commit, captured, plan, services);
      return {
        result: { action: "commit", path: mutation.path, commit },
        evidence: evidence as unknown as Json,
      };
    },
    async reconcile(operationId, captured, plan) {
      const outcome = validateOperationReceipt(operationId, captured, plan, services);
      return outcome === null
        ? { status: "unknown" }
        : { status: "succeeded", outcome };
    },
    async recover(captured, plan, outcome, recoveryId) {
      const reconciled = await this.reconcileRecovery(captured, plan, outcome, recoveryId);
      if (reconciled.status !== "unknown") return reconciled;
      try {
        if (!isDeepStrictEqual(
          validateOperationReceiptHash(captured, plan, services),
          outcome,
        )) throw new Error("Managed Git operation evidence changed.");
        services.validateRepository();
        const recoveryPaths = verifyFilesRefPaths(captured.repository.destructivePaths, {
          allowOwnedNamespaceCreation: true,
          allowManagedRefUpdates: true,
        });
        if (refNamespaceDigest(recoveryPaths) !==
          (outcome.evidence as unknown as CommitEvidence).refNamespaceDigest)
          throw new Error("Managed Git ref namespace identity changed.");
        verifySelectedHumanState(captured, services);
        const forward = readExactRef(plan.receiptRef, services);
        const parent = readExactRef(plan.branchRef, services);
        if (forward === null || parent === null) throw new Error("Managed Git branch changed.");
        services.git(["merge-base", "--is-ancestor", forward, parent]);
        const parentTree = services.git(["rev-parse", `${parent}^{tree}`]);
        const parentManifest = readTreeManifest(parentTree, services);
        if (!isDeepStrictEqual(findEntry(parentManifest, captured.selected.path), captured.selected.index))
          throw new Error("Managed Git selected path changed.");
        const inverseManifest = applySelectedEntry(
          parentManifest,
          captured.selected.path,
          captured.selected.head,
        );
        const inverseDigest = manifestDigest(inverseManifest);
        const tree = await writeCandidateTree(
          parentTree,
          captured.selected.path,
          captured.selected.head,
          inverseDigest,
          services,
        );
        const recoveryRef = receiptRef("recoveries", recoveryId);
        const recoveryPlan: CommitPlan = {
          ...plan,
          parent,
          expectedTreeManifestDigest: inverseDigest,
          receiptRef: recoveryRef,
          metadata: {
            ...plan.metadata,
            timestamp: String(Math.floor(Date.now() / 1000)),
            subject: `VOID managed recovery ${sha256(recoveryId).slice(0, 16)}`,
          },
        };
        const receipt = captureContainedPathChain(
          services.commonDir,
          receiptPath(recoveryRef),
          "missing-or-file",
        );
        if (!receipt.missingSuffix.length || pathExistsNoFollow(`${receipt.target}.lock`))
          throw new Error("Managed Git recovery receipt is unavailable.");
        const commit = await createCommit(tree, parent, recoveryPlan.metadata, services);
        validateReceiptChain(receipt, true);
        await commitRefTransaction(
          [
            { ref: plan.branchRef, newOid: commit, oldOid: parent },
            { ref: recoveryRef, newOid: commit, oldOid: null },
          ],
          () => {
            services.validateRepository();
            verifyFilesRefPaths(recoveryPaths, { allowOwnedNamespaceCreation: true });
            verifySelectedHumanState(captured, services);
            validateReceiptChain(receipt, true);
            if (readExactRef(plan.branchRef, services) !== parent)
              throw new Error("Managed Git branch changed.");
          },
          services,
        );
        return recoveryResult(commit, recoveryRef, parent, captured, plan, recoveryId, services);
      } catch {
        return { status: "conflict", evidence: null };
      }
    },
    async reconcileRecovery(captured, plan, outcome, recoveryId) {
      try {
        if (!isDeepStrictEqual(validateOperationReceiptHash(captured, plan, services), outcome))
          return { status: "unknown" };
        const recoveryRef = receiptRef("recoveries", recoveryId);
        const commit = readExactRef(recoveryRef, services);
        if (commit === null) return { status: "unknown" };
        return recoveryResult(commit, recoveryRef, null, captured, plan, recoveryId, services);
      } catch {
        return { status: "unknown" };
      }
    },
  };
}
