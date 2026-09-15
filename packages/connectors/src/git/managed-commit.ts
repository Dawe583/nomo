import { createHash } from "node:crypto";
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
  | { present: true; mode: "100644" | "100755"; blobOid: string; revision: string };
export type SelectedBinding = {
  path: string;
  head: GitEntry;
  index: GitEntry;
  worktree: WorktreeBinding;
};
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
export type ManagedCommitLifecycle = {
  capture(mutation: CommitMutation): CommitCapture;
  prepare(mutation: CommitMutation, captured: CommitCapture, operationId: string): CommitPlan;
  execute(mutation: CommitMutation, captured: CommitCapture, plan: CommitPlan, operationId: string): Promise<Outcome>;
  reconcile(operationId: string, captured: CommitCapture, plan: CommitPlan): Promise<Reconciliation>;
  recover(captured: CommitCapture, plan: CommitPlan, outcome: Outcome, recoveryId: string): Promise<RecoveryOutcome>;
  reconcileRecovery(captured: CommitCapture, plan: CommitPlan, outcome: Outcome, recoveryId: string): Promise<RecoveryOutcome | { status: "unknown" }>;
};

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const unsupported = (): never => { throw new Error("Managed Git commit execution is unavailable."); };

function entry(output: string, path: string, oidPattern: RegExp): GitEntry {
  if (!output) return { present: false };
  const match = /^(100644|100755) (?:blob )?([0-9a-f]+)(?: 0)?\t([^\0]+)\0?$/.exec(output);
  if (!match || match[3] !== path || !oidPattern.test(match[2]!))
    throw new Error("Selected Git entry is unsupported.");
  return { present: true, mode: match[1] as "100644" | "100755", oid: match[2]! };
}

export function createManagedCommitLifecycle(services: CommitServices): ManagedCommitLifecycle {
  return {
    capture(mutation) {
      services.validateRepository();
      const ref = services.git(["symbolic-ref", "-q", "HEAD"]);
      if (!ref.startsWith("refs/heads/")) throw new Error("An attached branch is required.");
      const head = services.git(["rev-parse", "--verify", "HEAD^{commit}"]);
      const tree = services.git(["rev-parse", "--verify", "HEAD^{tree}"]);
      const headEntry = entry(services.git(["ls-tree", "-z", "HEAD", "--", mutation.path]), mutation.path, services.oidPattern);
      const indexEntry = entry(services.git(["ls-files", "--stage", "-z", "--", mutation.path]), mutation.path, services.oidPattern);
      if (JSON.stringify(headEntry) === JSON.stringify(indexEntry)) throw new Error("No-op Git commits are refused.");
      const raw = services.rawIndex();
      const emptyChain = { target: services.commonDir, existing: [], missingSuffix: [] };
      const paths: FilesRefPathBinding = {
        boundary: { commonDir: services.commonDir, dev: "", ino: "", uid: "" },
        branchRef: emptyChain,
        branchReflog: emptyChain,
        voidNamespace: emptyChain,
        operationNamespace: emptyChain,
        recoveryNamespace: emptyChain,
      };
      const repository: RepositoryBinding = {
        identity: services.identity,
        root: services.root,
        gitDir: services.gitDir,
        commonDir: services.commonDir,
        indexPath: services.indexPath,
        objectFormat: services.objectFormat,
        refBackend: "files",
        worktreeCount: 1,
        destructivePaths: paths,
      };
      const selected: SelectedBinding = {
        path: mutation.path,
        head: headEntry,
        index: indexEntry,
        worktree: indexEntry.present
          ? { present: true, mode: indexEntry.mode, blobOid: indexEntry.oid, revision: indexEntry.oid }
          : { present: false },
      };
      return {
        kind: "commit",
        mutation,
        repository,
        branch: { ref, head, tree, reflogDigest: "", reflogGeneration: "" },
        index: { rawDigest: sha256(raw), revision: services.indexRevision(), manifestDigest: "" },
        selected,
        refusalDigest: sha256(JSON.stringify([ref, head, tree, selected])),
      };
    },
    prepare: unsupported,
    execute: async () => unsupported(),
    async reconcile() { return { status: "unknown" }; },
    async recover() { return { status: "conflict", evidence: null }; },
    async reconcileRecovery() { return { status: "unknown" }; },
  };
}
