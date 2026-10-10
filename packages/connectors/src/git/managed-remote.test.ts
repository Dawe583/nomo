import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { managedGitAdapter } from "./managed.ts";
import type { Json, Prepared, RecoveryAdapter } from "../recovery.ts";
import type { RemoteCapture, RemotePlan } from "./managed-remote.ts";
import {
  localOperationJournal,
  localRecoveryVault,
  recoveryRuntime,
  type ExecutionRequest,
} from "../../../runtime/src/index.ts";
import { devKeyProvider } from "../../../ledger/src/sign.ts";

const posixTest = process.platform === "win32" ? test.skip : test;
const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

type GitRunner = (...args: string[]) => string;

type RemoteFixture = {
  base: string;
  root: string;
  remote: string;
  run: GitRunner;
  onRemote: GitRunner;
  adapter: () => RecoveryAdapter;
  publishOperation: (
    operationId: string,
    value?: string,
  ) => Promise<{ commit: string }>;
  remoteRefs: () => string[];
  recoverArgs: (operation: string) => Json;
  /** A second clone of the same remote, for a writer that is not managed. */
  outsider: (t: TestContext) => GitRunner;
};

const planOf = (prepared: Prepared): RemotePlan =>
  prepared.plan as unknown as RemotePlan;

const git = (cwd: string): GitRunner => (...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  }).trim();

/** A real local remote: a bare repository plus the cooperative worktree. */
async function remoteRepository(t: TestContext): Promise<RemoteFixture> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nomo-git-remote-")));
  const root = join(base, "work");
  const remote = join(base, "remote.git");
  t.after(() => rm(base, { recursive: true, force: true }));
  const run = git(root);
  const onRemote = git(remote);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  // Reflogs on the bare side are what make "nothing was force-pushed" an
  // assertion rather than an assumption.
  onRemote("config", "core.logAllRefUpdates", "true");
  onRemote("symbolic-ref", "HEAD", "refs/heads/main");
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  run("config", "user.name", "NOMO test");
  run("config", "user.email", "void@example.invalid");
  run("config", "commit.gpgsign", "false");
  await writeFile(join(root, "selected"), "before");
  await writeFile(join(root, "sentinel"), "base");
  run("add", "selected", "sentinel");
  run("commit", "-qm", "initial");
  run("remote", "add", "origin", remote);
  run("push", "-q", "origin", "main");

  return {
    base,
    root,
    remote,
    run,
    onRemote,
    adapter: () => managedGitAdapter({ root, cooperative: true }),
    async publishOperation(operationId, value = "after") {
      await writeFile(join(root, "selected"), value);
      run("add", "selected");
      const args = { action: "commit", path: "selected" } as const;
      const observed = await managedGitAdapter({ root, cooperative: true }).preflight(args);
      const prepared = await managedGitAdapter({ root, cooperative: true })
        .prepare(args, observed, operationId);
      await managedGitAdapter({ root, cooperative: true }).execute(args, prepared, operationId);
      return { commit: run("rev-parse", "HEAD") };
    },
    remoteRefs: () =>
      onRemote("for-each-ref", "--format=%(refname) %(objectname)", "refs/")
        .split("\n")
        .filter(Boolean)
        .sort(),
    recoverArgs: (operation) =>
      ({ action: "recoverRemote", remote: "origin", operation }) as Json,
    outsider(context) {
      const other = join(base, "other");
      execFileSync("git", ["clone", "-q", remote, other]);
      const otherRun = git(other);
      otherRun("config", "user.name", "NOMO outsider");
      otherRun("config", "user.email", "outsider@example.invalid");
      context.after(() => rm(other, { recursive: true, force: true }));
      otherRun("config", "commit.gpgsign", "false");
      return otherRun;
    },
  };
}

async function prepareRecovery(
  f: RemoteFixture,
  operation: string,
  operationId: string,
): Promise<{ args: Json; prepared: Prepared; plan: RemotePlan }> {
  const args = f.recoverArgs(operation);
  const observed = await f.adapter().preflight(args);
  const prepared = await f.adapter().prepare(args, observed, operationId);
  return { args, prepared, plan: planOf(prepared) };
}

posixTest("a published managed commit is undone by one new remote branch and nothing else moves", async (t) => {
  const f = await remoteRepository(t);
  const { commit } = await f.publishOperation("pushed-op");
  f.run("push", "-q", "origin", "main");
  const refsBefore = f.remoteRefs();
  const receiptsBefore = f.run("for-each-ref", "--format=%(refname) %(objectname)", "refs/void/");
  const remoteReflogBefore = f.onRemote("reflog", "show", "refs/heads/main");
  const statusBefore = f.run("status", "--porcelain");
  const indexPath = resolve(f.root, f.run("rev-parse", "--git-path", "index"));
  const indexBefore = await readFile(indexPath);
  const worktreeBefore = await readFile(join(f.root, "selected"));

  const { args, prepared, plan } = await prepareRecovery(f, "pushed-op", "recovery-op");
  const outcome = await f.adapter().execute(args, prepared, "recovery-op");
  const recoveryCommit = f.onRemote("rev-parse", plan.pushRef);
  assert.deepEqual(outcome.result, {
    action: "recoverRemote",
    remote: "origin",
    operation: "pushed-op",
    branch: plan.pushRef,
    commit: recoveryCommit,
  });

  // The published branch and the local branch are exactly where they were:
  // no reset, no force, and no extra commit on either side.
  assert.equal(f.onRemote("rev-parse", "refs/heads/main"), commit);
  assert.equal(f.onRemote("reflog", "show", "refs/heads/main"), remoteReflogBefore);
  assert.equal(remoteReflogBefore.split("\n").length, 2);
  assert.equal(f.run("rev-parse", "HEAD"), commit);
  assert.equal(f.run("rev-list", "--count", "HEAD"), "2");
  // Exactly one new ref, holding the inverse, parented on the remote tip.
  assert.deepEqual(
    f.remoteRefs().filter((ref) => !refsBefore.includes(ref)),
    [`${plan.pushRef} ${recoveryCommit}`],
  );
  assert.equal(f.onRemote("rev-parse", `${plan.pushRef}^`), commit);
  assert.equal(f.onRemote("rev-list", "--count", `${commit}..${plan.pushRef}`), "1");
  assert.equal(f.onRemote("show", `${plan.pushRef}:selected`), "before");
  assert.equal(f.onRemote("show", `${plan.pushRef}:sentinel`), "base");
  assert.equal(
    f.onRemote("diff-tree", "--no-commit-id", "--name-only", "-r", plan.pushRef),
    "selected",
  );
  // The forward receipt is untouched and the recovery receipt is durable.
  assert.equal(
    f.run("for-each-ref", "--format=%(refname) %(objectname)", "refs/void/operations/"),
    receiptsBefore,
  );
  assert.equal(f.run("rev-parse", plan.receiptRef), recoveryCommit);
  // The recovery branch exists on the remote only: the local repository gains
  // a receipt, never a branch.
  assert.throws(
    () => f.run("rev-parse", "--verify", plan.pushRef),
    /single revision|unknown revision/u,
  );
  assert.deepEqual(
    f.run("for-each-ref", "--format=%(refname)", "refs/heads/").split("\n").filter(Boolean),
    ["refs/heads/main"],
  );
  // The caller's index and worktree are not touched by a remote recovery.
  assert.deepEqual(await readFile(indexPath), indexBefore);
  assert.deepEqual(await readFile(join(f.root, "selected")), worktreeBefore);
  assert.equal(f.run("status", "--porcelain"), statusBefore);
});

posixTest("the recovery proposal names the undone operation, its receipt and its digest", async (t) => {
  const f = await remoteRepository(t);
  const { commit } = await f.publishOperation("named-op");
  f.run("push", "-q", "origin", "main");
  const { plan } = await prepareRecovery(f, "named-op", "proposal-op");
  const { proposal } = plan;

  assert.match(proposal.body, /Undoes managed Git operation named-op\./u);
  assert.ok(proposal.body.includes(`Operation receipt: ${plan.operation.receiptRef}`));
  assert.ok(proposal.body.includes(`Operation commit: ${commit}`));
  assert.ok(proposal.body.includes(`Base: refs/heads/main at ${commit}`));
  assert.ok(proposal.body.includes(`Head: ${plan.pushRef}`));
  assert.ok(proposal.body.includes(`Proposal digest: ${proposal.digest}\n`));
  assert.match(proposal.digest, /^[0-9a-f]{64}$/u);
  // The digest covers exactly the claim the body prints, so a body that
  // disagreed with it could not be produced.
  assert.equal(
    proposal.digest,
    sha256(
      JSON.stringify({
        operation: {
          id: proposal.operation.id,
          receiptRef: proposal.operation.receiptRef,
          commit: proposal.operation.commit,
          parent: proposal.operation.parent,
        },
        undo: { path: proposal.undo.path, from: proposal.undo.from, to: proposal.undo.to },
        base: proposal.base,
        head: proposal.head,
      }),
    ),
  );
  // Deterministic: the same capture and operation id print the same proposal.
  assert.deepEqual((await prepareRecovery(f, "named-op", "proposal-op")).plan.proposal, proposal);
  // A different base is a different proposal, so a stale digest cannot pass.
  await writeFile(join(f.root, "other"), "later");
  f.run("add", "other");
  f.run("commit", "-qm", "unrelated");
  f.run("push", "-q", "origin", "main");
  const moved = await prepareRecovery(f, "named-op", "proposal-op");
  assert.notEqual(moved.plan.proposal.digest, proposal.digest);
  assert.notEqual(moved.plan.base, plan.base);
});

posixTest("a remote that advanced between capture and apply is a conflict, never a rebase", async (t) => {
  const f = await remoteRepository(t);
  const { commit } = await f.publishOperation("raced-op");
  f.run("push", "-q", "origin", "main");
  const { args, prepared, plan } = await prepareRecovery(f, "raced-op", "race-recovery");

  // A writer that is not managed lands on the remote between capture and apply.
  const outsider = f.outsider(t);
  await writeFile(join(f.base, "other", "elsewhere"), "raced");
  outsider("add", "elsewhere");
  outsider("commit", "-qm", "raced ahead");
  outsider("push", "-q", "origin", "main");
  const raced = outsider("rev-parse", "HEAD");

  await assert.rejects(
    f.adapter().execute(args, prepared, "race-recovery"),
    /advanced under the recovery; a rebase is never automatic/u,
  );
  // Nothing was published, no receipt was written, and no local ref moved.
  assert.equal(f.onRemote("for-each-ref", "--format=%(refname)", "refs/heads/void/"), "");
  assert.equal(f.onRemote("rev-parse", "refs/heads/main"), raced);
  assert.equal(f.run("rev-parse", "HEAD"), commit);
  assert.equal(f.run("for-each-ref", "--format=%(refname)", "refs/void/recoveries/"), "");
  assert.throws(() => f.run("rev-parse", "--verify", plan.pushRef), /single revision|unknown revision/u);
  // A second attempt refuses the same way rather than rebasing onto the tip.
  await assert.rejects(
    f.adapter().execute(args, prepared, "race-recovery"),
    /advanced under the recovery; a rebase is never automatic|Git remote state conflict/u,
  );
  assert.equal(f.onRemote("rev-parse", "refs/heads/main"), raced);
});

posixTest("a path that moved on the remote after the operation refuses the inverse by name", async (t) => {
  const f = await remoteRepository(t);
  await f.publishOperation("path-raced-op");
  f.run("push", "-q", "origin", "main");
  const outsider = f.outsider(t);
  await writeFile(join(f.base, "other", "selected"), "edited by somebody else");
  outsider("commit", "-qam", "same path");
  outsider("push", "-q", "origin", "main");

  await assert.rejects(
    f.adapter().preflight(f.recoverArgs("path-raced-op")),
    /selected path moved on the Git remote after the managed operation/u,
  );
  assert.equal(f.onRemote("for-each-ref", "--format=%(refname)", "refs/heads/void/"), "");
});

posixTest("a lost execution response reconciles from the receipt and the live remote, publishing once", async (t) => {
  const f = await remoteRepository(t);
  await f.publishOperation("lost-op");
  f.run("push", "-q", "origin", "main");
  const { args, prepared, plan } = await prepareRecovery(f, "lost-op", "lost-recovery");
  const adapter = f.adapter();
  const execute = adapter.execute.bind(adapter);
  let dispatches = 0;
  const lossy: RecoveryAdapter = {
    ...adapter,
    async execute(...rest) {
      dispatches++;
      const outcome = await execute(...rest);
      throw new Error(`lost response for ${String(rest[2])}`);
    },
  };
  await assert.rejects(lossy.execute(args, prepared, "lost-recovery"), /lost response/u);
  assert.equal(dispatches, 1);
  assert.equal(f.onRemote("rev-parse", plan.pushRef), f.run("rev-parse", plan.receiptRef));

  // A fresh adapter, as after a restart, proves the same thing from the durable
  // receipt and the live remote without publishing a second time.
  const reconciled = await f.adapter().reconcile("lost-recovery", prepared);
  assert.equal(reconciled.status, "succeeded");
  assert.deepEqual(
    reconciled.status === "succeeded" ? reconciled.outcome.result : null,
    {
      action: "recoverRemote",
      remote: "origin",
      operation: "lost-op",
      branch: plan.pushRef,
      commit: f.onRemote("rev-parse", plan.pushRef),
    },
  );
  assert.equal(
    f.remoteRefs().filter((ref) => ref.startsWith("refs/heads/void/")).length,
    1,
  );
  assert.deepEqual(await f.adapter().reconcile("lost-recovery", prepared), reconciled);
});

posixTest("a refused push is a terminal failure and is never retried", async (t) => {
  const f = await remoteRepository(t);
  await f.publishOperation("refused-op");
  f.run("push", "-q", "origin", "main");
  await writeFile(join(f.remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n");
  await chmod(join(f.remote, "hooks", "pre-receive"), 0o755);
  const { args, prepared, plan } = await prepareRecovery(f, "refused-op", "refused-recovery");
  const refsBefore = f.remoteRefs();

  await assert.rejects(
    f.adapter().execute(args, prepared, "refused-recovery"),
    /refused by the remote; nothing was published/u,
  );
  assert.deepEqual(f.remoteRefs(), refsBefore);
  // The attempt is recorded locally and reconciles to a definite failure rather
  // than an unknown one, and reconciling never publishes anything.
  assert.equal(f.run("rev-parse", plan.receiptRef).length, 40);
  assert.deepEqual(await f.adapter().reconcile("refused-recovery", prepared), { status: "failed" });
  assert.deepEqual(f.remoteRefs(), refsBefore);
  assert.deepEqual(await f.adapter().reconcile("refused-recovery", prepared), { status: "failed" });
});

posixTest("a recovery branch replaced by another commit reconciles to unknown, never to success", async (t) => {
  const f = await remoteRepository(t);
  await f.publishOperation("swapped-op");
  f.run("push", "-q", "origin", "main");
  const { args, prepared, plan } = await prepareRecovery(f, "swapped-op", "swapped-recovery");
  await f.adapter().execute(args, prepared, "swapped-recovery");
  assert.equal((await f.adapter().reconcile("swapped-recovery", prepared)).status, "succeeded");

  // Somebody replaces the published branch with a different commit.
  const outsider = f.outsider(t);
  await writeFile(join(f.base, "other", "selected"), "not our inverse");
  outsider("commit", "-qam", "swapped");
  // A human force-push replaces the branch, which is the one move this adapter
  // never makes and the one state it must not claim as its own success.
  outsider("push", "-q", "--force", "origin", `${outsider("rev-parse", "HEAD")}:${plan.pushRef}`);

  assert.deepEqual(await f.adapter().reconcile("swapped-recovery", prepared), { status: "unknown" });
  assert.equal(f.onRemote("show", `${plan.pushRef}:selected`), "not our inverse");
});

posixTest("a published recovery branch has no managed inverse, and the runtime refuses to dispatch it", async (t) => {
  const f = await remoteRepository(t);
  await f.publishOperation("inverse-op");
  f.run("push", "-q", "origin", "main");
  const { args, prepared } = await prepareRecovery(f, "inverse-op", "inverse-recovery");
  const outcome = await f.adapter().execute(args, prepared, "inverse-recovery");
  await assert.rejects(
    f.adapter().recover(prepared, outcome, "undo-the-recovery"),
    /no managed inverse; closing or deleting the remote branch is a human decision/u,
  );
  assert.deepEqual(
    await f.adapter().reconcileRecovery!(prepared, outcome, "undo-the-recovery"),
    { status: "unknown" },
  );

  // The observation is honest about it: no managed inverse means R3, and the
  // default runtime denies an R3 dispatch instead of running it silently.
  const observed = await f.adapter().preflight(args);
  assert.equal(observed.reversibility, "r3");
  const state = join(f.base, "runtime-state");
  t.after(() => rm(state, { recursive: true, force: true }));
  const signer = await devKeyProvider({ dir: join(state, "keys"), env: {} });
  const runtime = recoveryRuntime({
    journal: localOperationJournal(join(state, "journal"), signer),
    vault: localRecoveryVault(join(state, "vault"), { test: randomBytes(32) }, "test"),
    adapters: [f.adapter()],
    authorize: async () => true,
  });
  const request: ExecutionRequest = {
    workspace: "test",
    operationId: "runtime-remote",
    agentId: "agent",
    runId: "run",
    adapterId: "git.managed",
    arguments: args,
  };
  const executed = await runtime.execute(request);
  assert.equal(executed.status, "denied");
  assert.equal(executed.operationId, "runtime-remote");
  assert.equal(executed.result, undefined);
});

posixTest("a local-only repository refuses remote recovery and keeps every existing action", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nomo-git-localonly-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = git(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  run("config", "user.name", "NOMO test");
  run("config", "user.email", "void@example.invalid");
  await writeFile(join(root, "tracked"), "before");
  run("add", "tracked");
  run("commit", "-qm", "initial");
  const adapter = managedGitAdapter({ root, cooperative: true });

  for (const args of [
    { action: "recoverRemote", remote: "origin", operation: "any" },
    { action: "recoverRemote", remote: "bad name", operation: "any" },
    { action: "recoverRemote", remote: "origin" },
    { action: "recoverRemote", remote: "origin", operation: "any", path: "tracked" },
  ] as Json[])
    await assert.rejects(
      adapter.preflight(args),
      /Invalid Git remote recovery|A configured Git remote is required/u,
    );

  // The worktree and index actions are untouched by the new dispatch.
  const write = {
    action: "write",
    path: "tracked",
    base64: Buffer.from("agent").toString("base64"),
  } as const;
  const observed = await adapter.preflight(write);
  assert.equal(observed.reversibility, "r1");
  assert.equal(observed.effect, "write");
  const prepared = await adapter.prepare(write, observed, "local-write");
  const outcome = await adapter.execute(write, prepared, "local-write");
  assert.equal((await adapter.recover(prepared, outcome, "local-recover")).status, "restored");
  assert.equal(await readFile(join(root, "tracked"), "utf8"), "before");
  assert.deepEqual(await adapter.reconcile("local-write", prepared), { status: "unknown" });
});

posixTest("remote recovery refuses every precondition it cannot prove", async (t) => {
  const f = await remoteRepository(t);
  await f.publishOperation("refusal-op");
  // Not published: the managed commit exists locally, the remote never got it.
  await assert.rejects(
    f.adapter().preflight(f.recoverArgs("refusal-op")),
    /not published on the named Git remote branch/u,
  );
  f.run("push", "-q", "origin", "main");
  await assert.rejects(
    f.adapter().preflight(f.recoverArgs("never-happened")),
    /no managed Git operation receipt/u,
  );
  // A branch the remote does not carry is refused before any proposal exists.
  f.run("checkout", "-qb", "side");
  await assert.rejects(
    f.adapter().preflight(f.recoverArgs("refusal-op")),
    /remote branch could not be fetched/u,
  );
  f.run("checkout", "-q", "main");
  // A divergent push URL: the recovery would be published somewhere other than
  // the branch that was inspected.
  f.run("remote", "set-url", "--push", "origin", join(f.base, "elsewhere.git"));
  await assert.rejects(
    f.adapter().preflight(f.recoverArgs("refusal-op")),
    /one shared fetch and push URL is required/u,
  );
  f.run("remote", "set-url", "--push", "origin", f.remote);
  // A configured transport program is refused rather than executed.
  f.run("config", "core.sshCommand", "/bin/false");
  await assert.rejects(
    f.adapter().preflight(f.recoverArgs("refusal-op")),
    /configured transport or pack program is refused/u,
  );
  f.run("config", "--unset", "core.sshCommand");
  // A tampered plan cannot redirect the inverse onto another path.
  const { args, prepared, plan } = await prepareRecovery(f, "refusal-op", "tamper-recovery");
  assert.equal(plan.undo.path, "selected");
  const tampered = structuredClone(prepared) as Prepared;
  planOf(tampered).undo = {
    path: "sentinel",
    from: { present: true, mode: "100644", oid: "0".repeat(40) },
    to: { present: false },
  };
  await assert.rejects(
    f.adapter().execute(args, tampered, "tamper-recovery"),
    /Managed Git recovery plan changed/u,
  );
  assert.equal(f.onRemote("for-each-ref", "--format=%(refname)", "refs/heads/void/"), "");
});

posixTest("a capture records the remote it inspected, its tip and the one path it undoes", async (t) => {
  const f = await remoteRepository(t);
  const { commit } = await f.publishOperation("capture-op");
  f.run("push", "-q", "origin", "main");
  const args = f.recoverArgs("capture-op");
  const observed = await f.adapter().preflight(args);
  const prepared = await f.adapter().prepare(args, observed, "capture-recovery");
  const capture = prepared.before as unknown as RemoteCapture;

  assert.equal(capture.remote.name, "origin");
  assert.equal(capture.remote.url, f.remote);
  assert.equal(capture.remote.branch, "refs/heads/main");
  assert.equal(capture.remote.trackingRef, "refs/remotes/origin/main");
  assert.equal(capture.remote.tip, commit);
  assert.equal(capture.operation.receiptRef, `refs/void/operations/${sha256("capture-op")}`);
  assert.equal(capture.operation.commit, commit);
  assert.equal(capture.undo.path, "selected");
  assert.equal(capture.undo.from.present, true);
  assert.equal(capture.undo.to.present, true);
  assert.notDeepEqual(capture.undo.from, capture.undo.to);
  assert.match(String(observed.revision), /^[0-9a-f]{64}$/u);
  assert.equal(observed.effect, "mixed");
  assert.equal(observed.reversibility, "r3");
  assert.equal(observed.readiness, "verified");
  assert.deepEqual(observed.blastRadius, { count: 1, precision: "exact" });
  assert.equal(observed.resources.length, 3);
  assert.ok(observed.resources.some((resource) => resource.endsWith(":origin")));
  assert.ok(observed.resources.some((resource) => resource.endsWith(":refs/heads/main")));
  assert.match(observed.scope, /no managed inverse/u);
});
