/** Append-only recovery of a managed Git commit that was already pushed.
 *
 * A pushed commit cannot be undone in place: `reset` and force-push rewrite
 * shared history, and this adapter never does either. The only append-only
 * inverse is a new commit on a new branch, published as a recovery proposal
 * that a host or an operator turns into a pull request. Nothing on the remote
 * branch, and nothing in the local branch, is moved.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  Json,
  Outcome,
  Reconciliation,
  RecoveryOutcome,
} from "../recovery.ts";
import {
  applySelectedEntry,
  assertRepositoryProfile,
  captureContainedPathChain,
  commitRefTransaction,
  createCommit,
  manifestDigest,
  readExactRef,
  readTreeManifest,
  receiptRef,
  validateBranchRef,
  validateToken,
  writeCandidateTree,
  type CommitMetadata,
  type CommitServices,
  type ContainedPathChain,
  type FilesRefPathBinding,
  type GitEntry,
  type GitObjectFormat,
  type TreeManifestEntry,
} from "./managed-commit.ts";

export type RemoteMutation = {
  action: "recoverRemote";
  /** The configured remote the recovery branch is published to. */
  remote: string;
  /** The operation identifier of the managed commit being undone. */
  operation: string;
};

/** A remote-touching Git invocation, reported rather than thrown on. */
export type RemoteCommandResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export type RemoteServices = CommitServices & {
  remoteCommand(args: readonly string[]): Promise<RemoteCommandResult>;
};

export type RemoteOperationBinding = {
  id: string;
  receiptRef: string;
  commit: string;
  parent: string;
  tree: string;
  subject: string;
};

export type RemoteUndoBinding = {
  path: string;
  /** The path entry the managed commit published. */
  from: GitEntry;
  /** The path entry the managed commit replaced, which the inverse restores. */
  to: GitEntry;
};

/** The append-only proposal a host or operator turns into a pull request. */
export type RecoveryProposal = {
  operation: { id: string; receiptRef: string; commit: string; parent: string };
  undo: { path: string; from: GitEntry; to: GitEntry };
  base: { ref: string; commit: string };
  head: string;
  digest: string;
  body: string;
};

export type RemoteCapture = {
  kind: "remote-recovery";
  mutation: RemoteMutation;
  repository: {
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
  remote: {
    name: string;
    url: string;
    branch: string;
    trackingRef: string;
    tip: string;
    tipTree: string;
  };
  operation: RemoteOperationBinding;
  undo: RemoteUndoBinding;
};

export type RemotePlan = {
  kind: "remote-recovery";
  mutation: RemoteMutation;
  repository: RemoteCapture["repository"];
  remote: RemoteCapture["remote"];
  operation: RemoteOperationBinding;
  undo: RemoteUndoBinding;
  base: string;
  baseTree: string;
  pushRef: string;
  receiptRef: string;
  expectedTreeManifestDigest: string;
  metadata: CommitMetadata;
  proposal: RecoveryProposal;
};

export type RemoteEvidence = {
  kind: "remote-recovery";
  repositoryIdentity: string;
  remote: { name: string; url: string; branch: string };
  operation: RemoteOperationBinding;
  undo: RemoteUndoBinding;
  base: string;
  pushRef: string;
  commit: string;
  receiptRef: string;
  published: true;
  proposal: RecoveryProposal;
};

export type ManagedRemoteLifecycle = {
  capture(mutation: RemoteMutation): Promise<RemoteCapture>;
  prepare(
    mutation: RemoteMutation,
    captured: RemoteCapture,
    operationId: string,
  ): RemotePlan;
  execute(
    mutation: RemoteMutation,
    captured: RemoteCapture,
    plan: RemotePlan,
    operationId: string,
  ): Promise<Outcome>;
  reconcile(
    operationId: string,
    captured: RemoteCapture,
    plan: RemotePlan,
  ): Promise<Reconciliation>;
  recover(
    captured: RemoteCapture,
    plan: RemotePlan,
    outcome: Outcome,
    recoveryId: string,
  ): Promise<RecoveryOutcome>;
  reconcileRecovery(
    captured: RemoteCapture,
    plan: RemotePlan,
    outcome: Outcome,
    recoveryId: string,
  ): Promise<RecoveryOutcome | { status: "unknown" }>;
};

const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const jsonDigest = (value: unknown) => sha256(JSON.stringify(value));
const managedCommitSubject = /^VOID managed commit [0-9a-f]{16}\n$/u;
const managedRecoverySubject = /^VOID managed recovery [0-9a-f]{16}\n$/u;

/** The one branch namespace this adapter writes on a remote, derived from the
 * operation id so a repeated attempt for one operation names one branch. */
function recoveryPushRef(operationId: string): string {
  const ref = `refs/heads/void/recovery/${sha256(operationId)}`;
  validateBranchRef(ref);
  return ref;
}

function treeEntry(
  manifest: readonly TreeManifestEntry[],
  path: string,
): GitEntry {
  const found = manifest.find((entry) => entry.path === path);
  return found
    ? { present: true, mode: found.mode, oid: found.oid }
    : { present: false };
}

function manifestAt(commit: string, services: CommitServices): TreeManifestEntry[] {
  return readTreeManifest(`${commit}^{tree}`, services);
}

/** The single path a managed commit published, derived rather than trusted. */
function changedPath(commit: string, services: CommitServices): string {
  const paths = services
    .gitBuffer(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commit])
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);
  if (paths.length !== 1)
    throw new Error("The named managed Git operation did not change exactly one path.");
  return paths[0]!;
}

function renderProposal(input: {
  operation: RemoteOperationBinding;
  undo: RemoteUndoBinding;
  base: { ref: string; commit: string };
  head: string;
}): RecoveryProposal {
  const { operation, undo, base, head } = input;
  const claimed = {
    operation: {
      id: operation.id,
      receiptRef: operation.receiptRef,
      commit: operation.commit,
      parent: operation.parent,
    },
    undo: { path: undo.path, from: undo.from, to: undo.to },
    base,
    head,
  };
  const digest = jsonDigest(claimed);
  const from = undo.from.present ? `${undo.from.mode} blob ${undo.from.oid}` : "an absent path";
  const to = undo.to.present ? `${undo.to.mode} blob ${undo.to.oid}` : "an absent path";
  return {
    ...claimed,
    digest,
    body: [
      "VOID managed Git recovery proposal.",
      "",
      `Undoes managed Git operation ${operation.id}.`,
      `Operation receipt: ${operation.receiptRef}`,
      `Operation commit: ${operation.commit}`,
      `Operation parent: ${operation.parent}`,
      `Undo: ${undo.path} returns from ${from} to ${to}`,
      `Base: ${base.ref} at ${base.commit}`,
      `Head: ${head}`,
      `Proposal digest: ${digest}`,
      "",
      "Nothing on the base branch is rewritten. The head branch is created once,",
      "and merging or closing it is a human decision.",
    ].join("\n"),
  };
}

/** Re-reads the forward operation from the objects and its own receipt.
 *
 * The recovery never trusts a caller's claim about which commit it is undoing:
 * the receipt, the commit body, its single parent and its one changed path are
 * all re-derived here, so a tampered plan cannot redirect the inverse.
 */
function readForwardOperation(
  mutation: RemoteMutation,
  services: CommitServices,
): RemoteOperationBinding {
  const ref = receiptRef("operations", mutation.operation);
  const commit = readExactRef(ref, services);
  if (commit === null)
    throw new Error("The named operation has no managed Git operation receipt.");
  const raw = services.gitBuffer(["cat-file", "commit", commit]);
  if (raw.length >= 1024 || raw.includes(Buffer.from("gpgsig")))
    throw new Error("The named operation is not a managed Git commit.");
  const text = raw.toString("utf8");
  const split = text.indexOf("\n\n");
  if (split < 0) throw new Error("The named operation is not a managed Git commit.");
  const headers = text.slice(0, split).split("\n");
  const subject = text.slice(split + 2);
  const treeLine = headers.find((line) => line.startsWith("tree "));
  const parents = headers.filter((line) => line.startsWith("parent "));
  if (
    !managedCommitSubject.test(subject) ||
    parents.length !== 1 ||
    !treeLine ||
    !services.oidPattern.test(parents[0]!.slice("parent ".length)) ||
    !services.oidPattern.test(treeLine.slice("tree ".length))
  ) throw new Error("The named operation is not a managed Git commit.");
  return {
    id: mutation.operation,
    receiptRef: ref,
    commit,
    parent: parents[0]!.slice("parent ".length),
    tree: treeLine.slice("tree ".length),
    subject: subject.slice(0, -1),
  };
}

export async function captureRemoteRecovery(
  mutation: RemoteMutation,
  services: RemoteServices,
): Promise<RemoteCapture> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u.test(mutation.remote) || mutation.remote.includes(".."))
    throw new Error("A configured Git remote is required.");
  validateToken(mutation.operation, "managed Git operation identifier");
  services.validateRepository();
  let branch: string;
  try { branch = services.git(["symbolic-ref", "-q", "HEAD"]); }
  catch { throw new Error("An attached branch is required."); }
  validateBranchRef(branch);
  if (!services.git(["remote"]).split("\n").filter(Boolean).includes(mutation.remote))
    throw new Error("A configured Git remote is required.");
  const url = services.git(["remote", "get-url", mutation.remote]);
  if (!url || services.git(["remote", "get-url", "--push", mutation.remote]) !== url)
    throw new Error("A Git remote with one shared fetch and push URL is required.");
  const profile = assertRepositoryProfile(services, branch);
  for (const [rawKey] of profile.config) {
    const key = rawKey.toLowerCase();
    if (
      key === "core.sshcommand" ||
      key === `remote.${mutation.remote.toLowerCase()}.uploadpack` ||
      key === `remote.${mutation.remote.toLowerCase()}.receivepack`
    ) throw new Error("A Git remote with a configured transport or pack program is refused.");
  }
  const trackingRef = `refs/remotes/${mutation.remote}/${branch.slice("refs/heads/".length)}`;
  // The refspec carries no `+`, so a remote that was rewritten underneath a
  // stale tracking ref is refused rather than forced into agreement.
  const fetched = await services.remoteCommand([
    "-c", "gc.auto=0",
    "-c", "maintenance.auto=0",
    "-c", "fetch.prune=false",
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-auto-maintenance",
    "--no-auto-gc",
    "--no-write-commit-graph",
    "--no-write-fetch-head",
    "--no-recurse-submodules",
    mutation.remote,
    `${branch}:${trackingRef}`,
  ]);
  if (fetched.status !== 0 || fetched.signal !== null)
    throw new Error("The named Git remote branch could not be fetched.");
  const tip = readExactRef(trackingRef, services);
  if (tip === null)
    throw new Error("The named Git remote has no branch for the attached branch.");
  const tipTree = services.git(["rev-parse", "--verify", `${tip}^{tree}`]);
  if (!services.oidPattern.test(tipTree))
    throw new Error("The named Git remote branch has no usable tree.");
  const operation = readForwardOperation(mutation, services);
  try { services.git(["merge-base", "--is-ancestor", operation.commit, tip]); }
  catch {
    throw new Error("The managed Git operation is not published on the named Git remote branch.");
  }
  const path = changedPath(operation.commit, services);
  services.pathTarget(path);
  const published = treeEntry(manifestAt(operation.commit, services), path);
  const previous = treeEntry(manifestAt(operation.parent, services), path);
  if (isDeepStrictEqual(published, previous))
    throw new Error("The named managed Git operation is a no-op and is refused.");
  if (!isDeepStrictEqual(treeEntry(manifestAt(tip, services), path), published))
    throw new Error("The selected path moved on the Git remote after the managed operation; the inverse is not automatic.");
  return {
    kind: "remote-recovery",
    mutation,
    repository: {
      identity: services.identity,
      root: services.root,
      gitDir: services.gitDir,
      commonDir: services.commonDir,
      indexPath: services.indexPath,
      objectFormat: services.objectFormat,
      refBackend: "files",
      worktreeCount: 1,
      destructivePaths: profile.paths,
    },
    remote: { name: mutation.remote, url, branch, trackingRef, tip, tipTree },
    operation,
    undo: { path, from: published, to: previous },
  };
}

export function prepareRemoteRecovery(
  captured: RemoteCapture,
  operationId: string,
  services: CommitServices,
  nowSeconds = Math.floor(Date.now() / 1000),
): RemotePlan {
  validateToken(operationId, "managed Git identifier");
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0)
    throw new Error("Invalid managed Git timestamp.");
  const inverseManifest = applySelectedEntry(
    manifestAt(captured.remote.tip, services),
    captured.undo.path,
    captured.undo.to,
  );
  return {
    kind: "remote-recovery",
    mutation: captured.mutation,
    repository: captured.repository,
    remote: captured.remote,
    operation: captured.operation,
    undo: captured.undo,
    base: captured.remote.tip,
    baseTree: captured.remote.tipTree,
    pushRef: recoveryPushRef(operationId),
    receiptRef: receiptRef("recoveries", operationId),
    expectedTreeManifestDigest: manifestDigest(inverseManifest),
    metadata: {
      authorName: "VOID Managed Git",
      authorEmail: "managed-git@void.invalid",
      committerName: "VOID Managed Git",
      committerEmail: "managed-git@void.invalid",
      timestamp: String(nowSeconds),
      subject: `VOID managed recovery ${sha256(operationId).slice(0, 16)}`,
    },
    proposal: renderProposal({
      operation: captured.operation,
      undo: captured.undo,
      base: { ref: captured.remote.branch, commit: captured.remote.tip },
      head: recoveryPushRef(operationId),
    }),
  };
}

/** Byte-exact check of the published inverse commit.
 *
 * The whole commit object is rebuilt from the plan and compared, so a recovery
 * commit carrying a second parent, a different tree or a rewritten author is
 * not mistaken for the proposal that was planned.
 */
function verifyRecoveryCommit(
  commit: string,
  plan: RemotePlan,
  services: CommitServices,
): void {
  const tree = services.git(["rev-parse", "--verify", `${commit}^{tree}`]);
  if (manifestDigest(readTreeManifest(tree, services)) !== plan.expectedTreeManifestDigest)
    throw new Error("Managed Git recovery inverse changed.");
  const expected = Buffer.from(
    `tree ${tree}\n` +
      `parent ${plan.base}\n` +
      `author ${plan.metadata.authorName} <${plan.metadata.authorEmail}> ${plan.metadata.timestamp} +0000\n` +
      `committer ${plan.metadata.committerName} <${plan.metadata.committerEmail}> ${plan.metadata.timestamp} +0000\n\n` +
      `${plan.metadata.subject}\n`,
  );
  const raw = services.gitBuffer(["cat-file", "commit", commit]);
  if (!managedRecoverySubject.test(`${plan.metadata.subject}\n`))
    throw new Error("Managed Git recovery commit changed.");
  if (raw.length >= 1024 || !raw.equals(expected))
    throw new Error("Managed Git recovery commit changed.");
  if (readExactRef(plan.operation.receiptRef, services) !== plan.operation.commit)
    throw new Error("The managed Git operation receipt changed.");
}

function outcomeFor(plan: RemotePlan, commit: string): Outcome {
  const evidence: RemoteEvidence = {
    kind: "remote-recovery",
    repositoryIdentity: plan.repository.identity,
    remote: {
      name: plan.remote.name,
      url: plan.remote.url,
      branch: plan.remote.branch,
    },
    operation: plan.operation,
    undo: plan.undo,
    base: plan.base,
    pushRef: plan.pushRef,
    commit,
    receiptRef: plan.receiptRef,
    published: true,
    proposal: plan.proposal,
  };
  return {
    result: {
      action: "recoverRemote",
      remote: plan.remote.name,
      operation: plan.operation.id,
      branch: plan.pushRef,
      commit,
    },
    evidence: evidence as unknown as Json,
  };
}

/** Reads one ref of the named remote. `unreadable` is never treated as absent. */
async function readRemoteRef(
  ref: string,
  remote: string,
  services: RemoteServices,
): Promise<
  { state: "present"; oid: string } | { state: "absent" } | { state: "unreadable" }
> {
  const listed = await services.remoteCommand(["ls-remote", "--heads", remote, ref]);
  if (listed.status !== 0 || listed.signal !== null) return { state: "unreadable" };
  const line = listed.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)[0];
  if (line === undefined) return { state: "absent" };
  const [oid, name] = line.split(/[ \t]/u);
  if (name !== ref || !oid || !services.oidPattern.test(oid))
    return { state: "unreadable" };
  return { state: "present", oid };
}

/** The receipt path must still be absent and still owned before the transaction. */
function assertReceiptAvailable(
  prior: ContainedPathChain,
  services: CommitServices,
): void {
  const current = captureContainedPathChain(
    services.commonDir,
    prior.target,
    "missing-or-file",
  );
  if (!current.missingSuffix.length)
    throw new Error("Managed Git recovery receipt is unavailable.");
  if (!isDeepStrictEqual(current.existing, prior.existing))
    throw new Error("Managed Git recovery receipt path identity changed.");
}

/** The recheck that runs while the transaction holds the receipt lock.
 *
 * `update-ref` has by then created the missing parent directories and the
 * leaf lock, so the leaf is no longer absent. What must still hold is that
 * every directory above it is the same one that was captured, and that
 * anything new belongs to the same owner.
 */
function assertReceiptPathStable(
  prior: ContainedPathChain,
  services: CommitServices,
): void {
  const current = captureContainedPathChain(
    services.commonDir,
    prior.target,
    "missing-or-file",
  );
  if (
    !isDeepStrictEqual(current.existing.slice(0, prior.existing.length), prior.existing)
  ) throw new Error("Managed Git recovery receipt path identity changed.");
  const owner = prior.existing[0]?.uid ?? current.existing[0]?.uid;
  for (const added of current.existing.slice(prior.existing.length))
    if (added.uid !== owner)
      throw new Error("Managed Git recovery receipt path ownership changed.");
}

export function createManagedRemoteLifecycle(
  services: RemoteServices,
): ManagedRemoteLifecycle {
  const receiptTarget = (ref: string) =>
    ref.split("/").reduce((prefix, segment) => `${prefix}/${segment}`, services.commonDir);
  const derive = (captured: RemoteCapture, operationId: string, timestamp: number) =>
    prepareRemoteRecovery(captured, operationId, services, timestamp);
  return {
    async capture(mutation) {
      return captureRemoteRecovery(mutation, services);
    },
    prepare(mutation, captured, operationId) {
      if (!isDeepStrictEqual(mutation, captured.mutation))
        throw new Error("Managed Git remote recovery mutation changed.");
      assertReceiptAvailable(
        captureContainedPathChain(
          services.commonDir,
          receiptTarget(receiptRef("recoveries", operationId)),
          "missing-or-file",
        ),
        services,
      );
      return derive(captured, operationId, Math.floor(Date.now() / 1000));
    },
    async execute(mutation, captured, plan, operationId) {
      if (!isDeepStrictEqual(plan, derive(captured, operationId, Number(plan.metadata.timestamp))))
        throw new Error("Managed Git recovery plan changed.");
      // The capture is re-read immediately before the write boundary, so a
      // remote that advanced under the operation is a conflict. Rebuilding the
      // inverse on the new tip would publish a change nobody asked for.
      const actual = await captureRemoteRecovery(mutation, services);
      if (actual.remote.tip !== captured.remote.tip)
        throw new Error("The Git remote advanced under the recovery; a rebase is never automatic.");
      if (!isDeepStrictEqual(actual, captured))
        throw new Error("Managed Git recovery capture changed.");
      const receipt = captureContainedPathChain(
        services.commonDir,
        receiptTarget(plan.receiptRef),
        "missing-or-file",
      );
      assertReceiptAvailable(receipt, services);
      const tree = await writeCandidateTree(
        plan.baseTree,
        plan.undo.path,
        plan.undo.to,
        plan.expectedTreeManifestDigest,
        services,
      );
      const commit = await createCommit(tree, plan.base, plan.metadata, services);
      verifyRecoveryCommit(commit, plan, services);
      // The receipt is durable before the push, so a process that dies between
      // the two leaves a record of the attempt. It records the attempt, not the
      // publication: only a live read-back of the remote ref proves that.
      await commitRefTransaction(
        [{ ref: plan.receiptRef, newOid: commit, oldOid: null }],
        () => {
          services.validateRepository();
          assertReceiptPathStable(receipt, services);
        },
        services,
      );
      await services.remoteCommand([
        "push",
        "--quiet",
        "--no-verify",
        plan.remote.name,
        `${commit}:${plan.pushRef}`,
      ]);
      const published = await readRemoteRef(plan.pushRef, plan.remote.name, services);
      if (published.state === "unreadable")
        throw new Error("The published Git recovery branch could not be read back; its remote state is unknown and is never pushed again.");
      if (published.state === "absent")
        throw new Error("The Git recovery branch was refused by the remote; nothing was published.");
      if (published.oid !== commit)
        throw new Error("The Git recovery branch is not at the published commit on the remote.");
      return outcomeFor(plan, commit);
    },
    async reconcile(operationId, captured, plan) {
      if (!isDeepStrictEqual(plan, derive(captured, operationId, Number(plan.metadata.timestamp))))
        return { status: "unknown" };
      const commit = readExactRef(plan.receiptRef, services);
      const published = await readRemoteRef(plan.pushRef, plan.remote.name, services);
      if (published.state === "unreadable") return { status: "unknown" };
      if (commit === null)
        return published.state === "absent" ? { status: "failed" } : { status: "unknown" };
      try { verifyRecoveryCommit(commit, plan, services); }
      catch { return { status: "unknown" }; }
      if (published.state === "absent") return { status: "failed" };
      if (published.oid !== commit) return { status: "unknown" };
      return { status: "succeeded", outcome: outcomeFor(plan, commit) };
    },
    async recover() {
      // The published branch is a shared ref. Undoing it would delete history
      // other people can already see, which is the one move this adapter never
      // makes, so the refusal is the recovery.
      throw new Error("A published Git recovery branch has no managed inverse; closing or deleting the remote branch is a human decision.");
    },
    async reconcileRecovery() {
      // There is no recovery receipt to read, and an absent one never
      // authorizes another inverse, so this stays unknown rather than guessing
      // that somebody closed the remote branch.
      return { status: "unknown" };
    },
  };
}
