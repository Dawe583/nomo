import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
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
const unsupported = (): never => {
  throw new Error("Managed Git commit execution is unavailable.");
};

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

function validateToken(value: string, label: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (!value || bytes.length > 4096 || decodeUtf8(bytes, `Invalid ${label}.`) !== value)
    throw new Error(`Invalid ${label}.`);
}

function validateSelectedPath(path: string): void {
  validateToken(path, "Git path");
  if (/[\u0000-\u001f\u007f]/u.test(path)) throw new Error("Invalid Git path.");
}

function validateBranchRef(ref: string): void {
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
  };
}

function chainLeafExpectation(name: keyof FilesRefPathBinding): "directory" | "file" | "missing-or-file" {
  if (name === "branchReflog") return "file";
  if (name === "branchRef") return "missing-or-file";
  return "directory";
}

export function verifyFilesRefPaths(
  binding: FilesRefPathBinding,
  options: { allowOwnedNamespaceCreation?: boolean } = {},
): FilesRefPathBinding {
  const boundary = component(binding.boundary.commonDir);
  if (
    boundary.dev !== binding.boundary.dev || boundary.ino !== binding.boundary.ino ||
    boundary.uid !== binding.boundary.uid || boundary.kind !== "directory"
  ) throw new Error("Git common directory identity changed.");
  const names = ["branchRef", "branchReflog", "voidNamespace", "operationNamespace", "recoveryNamespace"] as const;
  const refreshed = { ...binding };
  for (const name of names) {
    const next = captureContainedPathChain(
      binding.boundary.commonDir,
      binding[name].target,
      chainLeafExpectation(name),
    );
    const prior = binding[name];
    const preserved = next.existing.slice(0, prior.existing.length);
    if (!isDeepStrictEqual(preserved, prior.existing))
      throw new Error("Destructive Git path identity changed.");
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

export function readTreeManifest(
  treeish: string,
  services: CommitServices,
): TreeManifestEntry[] {
  const records = splitNul(
    services.gitBuffer(["ls-tree", "-rz", "--full-tree", treeish]),
    "Invalid Git tree manifest.",
  );
  const manifest = records.map((record) => parseManifestRecord(record, services.oidPattern));
  manifest.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return manifest;
}

function readIndexManifest(services: CommitServices): TreeManifestEntry[] {
  const records = splitNul(
    services.gitBuffer(["ls-files", "--stage", "-z"]),
    "Invalid Git index manifest.",
  );
  const manifest = records.map((record) => {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error("Invalid Git index manifest.");
    const header = decodeUtf8(record.subarray(0, tab), "Invalid Git index manifest.");
    const path = decodeUtf8(record.subarray(tab + 1), "Invalid Git index pathname.");
    const match = /^(\d{6}) ([0-9a-f]+) ([0-3])$/.exec(header);
    if (!match || match[3] !== "0" || !services.oidPattern.test(match[2]!))
      throw new Error("Unmerged or invalid Git index entry.");
    if (match[1] !== "100644" && match[1] !== "100755")
      throw new Error("Unsupported Git index mode.");
    return { path, mode: match[1], oid: match[2]! } as TreeManifestEntry;
  });
  manifest.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return manifest;
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

function assertRepositoryProfile(services: CommitServices, branchRef: string): { paths: FilesRefPathBinding; config: Array<[string, string]>; metadataDigest: string } {
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
  const paths = captureFilesRefPaths(services.commonDir, branchRef);
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
  let directHead: string;
  try { directHead = services.git(["show-ref", "--verify", "--hash", ref]); }
  catch { throw new Error("A born HEAD is required."); }
  if (!services.oidPattern.test(directHead)) throw new Error("A born HEAD is required.");
  const profile = assertRepositoryProfile(services, ref);
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

export function createManagedCommitLifecycle(services: CommitServices): ManagedCommitLifecycle {
  return {
    capture(mutation) { return captureCommit(mutation, services); },
    prepare(mutation, captured, operationId) {
      if (!isDeepStrictEqual(mutation, captured.mutation))
        throw new Error("Managed Git commit mutation changed.");
      const actual = captureCommit(mutation, services);
      verifyFilesRefPaths(captured.repository.destructivePaths);
      if (!isDeepStrictEqual(actual, captured))
        throw new Error("Managed Git commit capture changed.");
      return prepareCommit(captured, operationId);
    },
    execute: async () => unsupported(),
    async reconcile() { return { status: "unknown" }; },
    async recover() { return { status: "conflict", evidence: null }; },
    async reconcileRecovery() { return { status: "unknown" }; },
  };
}
