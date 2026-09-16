import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { managedGitAdapter } from "./managed.ts";
const posixTest = process.platform === "win32" ? test.skip : test;

import type { Json, RecoveryAdapter } from "../recovery.ts";
import { recoveryRuntime, localOperationJournal, reservedRecoveryVault } from "../../../runtime/src/index.ts";
import { devKeyProvider } from "../../../ledger/src/sign.ts";

posixTest("captures a disposable repository without mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "VOID test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "void@example.invalid"]);
  execFileSync("git", ["-C", root, "commit", "--allow-empty", "-qm", "initial"]);
  const adapter = managedGitAdapter({ root, cooperative: true });
  assert.equal(adapter.id, "git.managed");
  const observed = await adapter.preflight({ action: "write", path: "file", base64: "" });
  assert.equal(observed.readiness, "verified");
});


async function repository(t: import("node:test").TestContext) {
  const root = await mkdtemp(join(tmpdir(), "void-git-life-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  run("init", "-q");
  run("config", "user.name", "VOID test");
  run("config", "user.email", "void@example.invalid");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(join(root, "tracked"), "before", { mode: 0o755 }));
  run("add", "tracked"); run("commit", "-qm", "initial");
  return { root, run, adapter: managedGitAdapter({ root, cooperative: true }) };
}
async function dispatch(adapter: ReturnType<typeof managedGitAdapter>, args: import("../recovery.ts").Json) {
  const observation = await adapter.preflight(args);
  const prepared = await adapter.prepare(args, observation, "operation");
  const outcome = await adapter.execute(args, prepared, "operation");
  return { prepared, outcome };
}

posixTest("write, create, delete and rename restore only selected worktree state", async (t) => {
  const { root, adapter } = await repository(t);
  const { readFile, writeFile, stat } = await import("node:fs/promises");
  await writeFile(join(root, "human"), "human");
  for (const [name, args] of [
    ["write", { action: "write", path: "tracked", base64: Buffer.from("agent").toString("base64"), mode: 0o644 }],
    ["create", { action: "write", path: "created", base64: Buffer.from("new").toString("base64") }],
  ] as const) {
    const { prepared, outcome } = await dispatch(adapter, args);
    assert.equal((await adapter.recover(prepared, outcome, `recover-${name}`)).status, "restored");
  }
  assert.equal(await readFile(join(root, "tracked"), "utf8"), "before");
  assert.equal((await stat(join(root, "tracked"))).mode & 0o777, 0o755);
  await assert.rejects(stat(join(root, "created")), { code: "ENOENT" });
  const deleted = await dispatch(adapter, { action: "delete", path: "tracked" });
  assert.equal((await adapter.recover(deleted.prepared, deleted.outcome, "recover-delete")).status, "restored");
  const renamed = await dispatch(adapter, { action: "rename", path: "tracked", to: "moved" });
  assert.equal((await adapter.recover(renamed.prepared, renamed.outcome, "recover-rename")).status, "restored");
  assert.equal(await readFile(join(root, "human"), "utf8"), "human");
});

posixTest("stage and unstage restore exact selected index entry and preserve worktree", async (t) => {
  const { root, run, adapter } = await repository(t);
  const { readFile, writeFile } = await import("node:fs/promises");
  await writeFile(join(root, "tracked"), "worktree edit", { mode: 0o755 });
  await writeFile(join(root, "other"), "other staged"); run("add", "other");
  const unrelated = run("ls-files", "--stage", "--", "other");
  const staged = await dispatch(adapter, { action: "stage", path: "tracked" });
  assert.match(run("show", ":tracked"), /worktree edit/);
  assert.equal((await adapter.recover(staged.prepared, staged.outcome, "recover-stage")).status, "restored");
  assert.equal(await readFile(join(root, "tracked"), "utf8"), "worktree edit");
  assert.equal(run("ls-files", "--stage", "--", "other"), unrelated);
  run("add", "tracked");
  const unstaged = await dispatch(adapter, { action: "unstage", path: "tracked" });
  assert.match(run("show", ":tracked"), /before/);
  assert.equal((await adapter.recover(unstaged.prepared, unstaged.outcome, "recover-unstage")).status, "restored");
  assert.match(run("show", ":tracked"), /worktree edit/);
});

posixTest("lost response reconciliation stays unknown without a durable receipt", async (t) => {
  const { adapter } = await repository(t);
  const args = { action: "write", path: "tracked", base64: Buffer.from("agent").toString("base64") } as const;
  const observation = await adapter.preflight(args), prepared = await adapter.prepare(args, observation, "op"), outcome = await adapter.execute(args, prepared, "op");
  assert.deepEqual(await adapter.reconcile("op", prepared), { status: "unknown" });
  assert.equal((await adapter.recover(prepared, outcome, "recovery")).status, "restored");
  assert.deepEqual(await adapter.reconcileRecovery!(prepared, outcome, "recovery"), { status: "unknown" });
});


posixTest("recovery treats human ABA to exact agent-after bytes as conflict, not a receipt", async (t) => {
  const { root, adapter } = await repository(t);
  const { writeFile } = await import("node:fs/promises");
  const args = { action: "write", path: "tracked", base64: Buffer.from("agent").toString("base64") } as const;
  const done = await dispatch(adapter, args);
  await writeFile(join(root, "tracked"), "human");
  await writeFile(join(root, "tracked"), "agent", { mode: 0o755 });
  assert.equal((await adapter.recover(done.prepared, done.outcome, "recover")).status, "conflict");
});


posixTest("refuses repository state and path hazards without removing an existing index lock", async (t) => {
  const { root, run, adapter } = await repository(t);
  const { writeFile, mkdir, symlink, link, readFile } = await import("node:fs/promises");
  const gitDir = run("rev-parse", "--absolute-git-dir");
  const request = { action: "write", path: "new", base64: "" } as const;
  await writeFile(join(gitDir, "index.lock"), "human lock");
  await assert.rejects(adapter.preflight(request), /locked/);
  assert.equal(await readFile(join(gitDir, "index.lock"), "utf8"), "human lock");
  await rm(join(gitDir, "index.lock"));
  await writeFile(join(gitDir, "MERGE_HEAD"), "active");
  await assert.rejects(adapter.preflight(request), /Active/);
  await rm(join(gitDir, "MERGE_HEAD"));
  run("config", "core.sparseCheckout", "true");
  await assert.rejects(adapter.preflight(request), /Sparse/);
  run("config", "--unset", "core.sparseCheckout");
  await symlink("tracked", join(root, "symbol"));
  await link(join(root, "tracked"), join(root, "hard"));
  await assert.rejects(adapter.preflight({ action: "delete", path: "symbol" }));
  await assert.rejects(adapter.preflight({ action: "delete", path: "hard" }));
  await mkdir(join(root, "module"));
  const tree = run("mktree");
  const commit = run("commit-tree", tree, "-m", "submodule fixture");
  run("update-index", "--add", "--cacheinfo", "160000", commit, "module");
  await assert.rejects(adapter.preflight({ action: "write", path: "module/file", base64: "" }), /Submodule/);
});

posixTest("rejects no-op writes and turns repository drift during recovery into conflict", async (t) => {
  const { root, run, adapter } = await repository(t);
  const before = Buffer.from("before").toString("base64");
  const observation = await adapter.preflight({ action: "write", path: "tracked", base64: before, mode: 0o755 });
  await assert.rejects(adapter.prepare({ action: "write", path: "tracked", base64: before, mode: 0o755 }, observation, "noop"), /No-op/);
  const done = await dispatch(adapter, { action: "write", path: "tracked", base64: Buffer.from("agent").toString("base64") });
  const gitDir = run("rev-parse", "--absolute-git-dir");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(join(gitDir, "REVERT_HEAD"), "active"));
  assert.equal((await adapter.recover(done.prepared, done.outcome, "recover")).status, "conflict");
  assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(join(root, "tracked"), "utf8")), "agent");
});


posixTest("supports SHA-256 and linked worktree identity without exposing administrative paths", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "void-git-layout-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "--object-format=sha256", base]);
  execFileSync("git", ["-C", base, "config", "user.name", "VOID test"]);
  execFileSync("git", ["-C", base, "config", "user.email", "void@example.invalid"]);
  execFileSync("git", ["-C", base, "commit", "--allow-empty", "-qm", "initial"]);
  assert.equal((await managedGitAdapter({ root: base, cooperative: true }).preflight({ action: "write", path: "file", base64: "" })).readiness, "verified");
  const linked = join(dirname(base), `${base.split("/").pop()}-linked`);
  t.after(() => rm(linked, { recursive: true, force: true }));
  execFileSync("git", ["-C", base, "worktree", "add", "-q", "-b", "fixture-linked", linked]);
  const observed = await managedGitAdapter({ root: linked, cooperative: true }).preflight({ action: "write", path: "file", base64: "" });
  assert.ok(observed.resources.every((resource) => !resource.includes(linked) && !resource.includes(base)));
});

posixTest("fixed Git plumbing does not invoke hooks, remotes or credential helpers", async (t) => {
  const { root, run, adapter } = await repository(t);
  const sentinel = join(dirname(root), "sentinel");
  const hook = join(root, ".git", "hooks", "pre-commit");
  await import("node:fs/promises").then(async ({ writeFile, chmod }) => { await writeFile(hook, `#!/bin/sh\nprintf hook > '${sentinel}'\n`); await chmod(hook, 0o755); });
  run("config", "credential.helper", `!printf credential > '${sentinel}'`);
  run("remote", "add", "origin", "https://example.invalid/repository.git");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(join(root, "tracked"), "agent"));
  const done = await dispatch(adapter, { action: "stage", path: "tracked" });
  assert.equal((await adapter.recover(done.prepared, done.outcome, "recover")).status, "restored");
  await assert.rejects(import("node:fs/promises").then(({ stat }) => stat(sentinel)), { code: "ENOENT" });
});

test("Windows refusal occurs at adapter construction before mutation", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-windows-refusal-")); t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]); await import("node:fs/promises").then(({ writeFile }) => writeFile(join(root, "sentinel"), "unchanged")); execFileSync("git", ["-C", root, "add", "sentinel"]);
  const { readFile } = await import("node:fs/promises"), index = join(root, execFileSync("git", ["-C", root, "rev-parse", "--git-path", "index"], { encoding: "utf8" }).trim()), beforeIndex = await readFile(index), beforeBytes = await readFile(join(root, "sentinel"));
  assert.throws(() => managedGitAdapter({ root, cooperative: true }), /POSIX only/);
  assert.deepEqual(await readFile(index), beforeIndex); assert.deepEqual(await readFile(join(root, "sentinel")), beforeBytes);
});


posixTest("global unmerged entries and unsupported index flags refuse unrelated targets", async (t) => {
  for (const hazard of ["unmerged", "flag"] as const) {
    const { root, run, adapter } = await repository(t);
    if (hazard === "flag") run("update-index", "--assume-unchanged", "tracked");
    else {
      const oid = run("rev-parse", "HEAD:tracked");
      run("update-index", "--force-remove", "tracked");
      execFileSync("git", ["-C", root, "update-index", "--index-info"], { input: `100755 ${oid} 1\ttracked\n100755 ${oid} 2\ttracked\n100755 ${oid} 3\ttracked\n` });
    }
    await assert.rejects(adapter.preflight({ action: "write", path: "unrelated", base64: "" }), hazard === "flag" ? /flags/ : /Unmerged|flags/);
  }
});

posixTest("Git failures are bounded and redact child stderr", async (t) => {
  const { root, run } = await repository(t);
  const index = run("rev-parse", "--git-path", "index");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(join(root, index), Buffer.alloc(2 * 1024 * 1024, 0xff)));
  await assert.rejects(managedGitAdapter({ root, cooperative: true }).preflight({ action: "write", path: "new", base64: "" }), (error: unknown) => {
    assert.equal((error as Error).message, "Managed Git command failed.");
    assert.ok(!(error as Error).message.includes("index file"));
    return true;
  });
});


posixTest("v2 index parser does not mistake ordinary link FSMN or sdir filenames for extensions", async (t) => {
  const { root, run, adapter } = await repository(t);
  const { writeFile } = await import("node:fs/promises");
  for (const name of ["link", "FSMN", "sdir"]) { await writeFile(join(root, name), name); run("add", name); }
  assert.equal((await adapter.preflight({ action: "write", path: "new", base64: "" })).readiness, "verified");
});


posixTest("prepared evidence from repository A cannot recover same-state repository B", async (t) => {
  const a = await repository(t), done = await dispatch(a.adapter, { action: "write", path: "tracked", base64: Buffer.from("agent").toString("base64") });
  const b = await repository(t);
  await import("node:fs/promises").then(({ writeFile }) => writeFile(join(b.root, "tracked"), "agent", { mode: 0o755 }));
  assert.equal((await b.adapter.recover(done.prepared, done.outcome, "wrong-repository")).status, "conflict");
  assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(join(b.root, "tracked"), "utf8")), "agent");
});

posixTest("index away and back to the exact agent entry conflicts by index generation", async (t) => {
  const { root, run, adapter } = await repository(t);
  await import("node:fs/promises").then(({ writeFile }) => writeFile(join(root, "tracked"), "agent", { mode: 0o755 }));
  const done = await dispatch(adapter, { action: "stage", path: "tracked" });
  const exact = run("ls-files", "--stage", "--", "tracked");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(join(root, "tracked"), "human", { mode: 0o755 })); run("add", "tracked");
  const match = /^(\d+) ([0-9a-f]+) 0\ttracked$/.exec(exact)!;
  run("update-index", "--cacheinfo", match[1]!, match[2]!, "tracked");
  assert.equal(run("ls-files", "--stage", "--", "tracked"), exact);
  assert.equal((await adapter.recover(done.prepared, done.outcome, "recover")).status, "conflict");
});


posixTest("every worktree action preserves raw index and unrelated staged, unstaged and untracked state", async (t) => {
  for (const operation of ["create", "write", "delete", "rename"] as const) {
    const { root, run, adapter } = await repository(t);
    const { readFile, writeFile } = await import("node:fs/promises");
    for (const name of ["staged", "unstaged"]) await writeFile(join(root, name), "base");
    run("add", "staged", "unstaged"); run("commit", "-qm", "sentinels");
    await writeFile(join(root, "staged"), "staged human"); run("add", "staged");
    await writeFile(join(root, "unstaged"), "unstaged human"); await writeFile(join(root, "untracked"), "untracked human");
    const indexPath = run("rev-parse", "--git-path", "index"), indexBefore = await readFile(join(root, indexPath));
    const sentinels = async () => Promise.all(["staged", "unstaged", "untracked"].map((name) => readFile(join(root, name))));
    const humanBefore = await sentinels();
    const args: Json = operation === "create" ? { action: "write", path: "created", base64: "" } : operation === "write" ? { action: "write", path: "tracked", base64: Buffer.from("agent").toString("base64") } : operation === "delete" ? { action: "delete", path: "tracked" } : { action: "rename", path: "tracked", to: "moved" };
    const done = await dispatch(adapter, args);
    assert.deepEqual(await readFile(join(root, indexPath)), indexBefore);
    assert.deepEqual(await sentinels(), humanBefore);
    assert.equal((await adapter.recover(done.prepared, done.outcome, `recover-${operation}`)).status, "restored");
    assert.deepEqual(await readFile(join(root, indexPath)), indexBefore);
    assert.deepEqual(await sentinels(), humanBefore);
  }
});


posixTest("runtime records unknown when verification fails after the inverse dispatch", async (t) => {
  const { root, adapter } = await repository(t), state = `${root}-runtime-state`;
  t.after(() => rm(state, { recursive: true, force: true }));
  const signer = await devKeyProvider({ dir: join(state, "keys"), env: {} }), key = randomBytes(32);
  const options = () => ({ journal: localOperationJournal(join(state, "journal"), signer), vault: reservedRecoveryVault(join(state, "vault"), { key }, "key") });
  const runtime = recoveryRuntime({ ...options(), adapters: [adapter], authorize: async () => true });
  const request = { workspace: "test", operationId: "post-inverse", runId: "run", agentId: "agent", adapterId: "git.managed", arguments: { action: "write", path: "tracked", base64: Buffer.from("agent").toString("base64") } };
  assert.equal((await runtime.execute(request)).status, "succeeded");
  const actual = managedGitAdapter({ root, cooperative: true });
  const injected: RecoveryAdapter = { ...actual, async recover(prepared, outcome, recoveryId) {
    const changed = structuredClone(prepared) as typeof prepared;
    ((changed.before as Record<string, Json>).state as Record<string, Json>).head = "0".repeat(40);
    return actual.recover(changed, outcome, recoveryId);
  } };
  const restarted = recoveryRuntime({ ...options(), adapters: [injected], authorize: async () => true });
  const plan = await restarted.planRecovery("test", "post-inverse");
  assert.equal((await restarted.recover(plan, async () => true)).status, "unknown");
  assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(join(root, "tracked"), "utf8")), "before");
});


posixTest("refusal table rejects malformed mutations, paths, sizes and unsupported targets", async (t) => {
  const { root, adapter } = await repository(t); const { mkdir, writeFile, symlink } = await import("node:fs/promises");
  await mkdir(join(root, "directory")); await symlink("tracked", join(root, "tracked-link"));
  for (const args of [null, {}, { action: "write", path: "../escape", base64: "" }, { action: "write", path: "/absolute", base64: "" }, { action: "write", path: ".git/config", base64: "" }, { action: "write", path: "new", base64: "bad!" }, { action: "write", path: "new", base64: "", extra: true }, { action: "delete", path: "missing" }, { action: "rename", path: "missing", to: "new" }, { action: "rename", path: "tracked", to: "tracked" }, { action: "stage", path: "directory" }, { action: "stage", path: "tracked-link" }] as Json[])
    await assert.rejects(adapter.preflight(args));
  await assert.rejects(adapter.preflight({ action: "write", path: "large", base64: Buffer.alloc(1024 * 1024 + 1).toString("base64") }));
  await writeFile(join(root, "destination"), "human");
  await assert.rejects(adapter.preflight({ action: "rename", path: "tracked", to: "destination" }));
});

posixTest("refusal table covers every active marker, split index, bare and nonrepository", async (t) => {
  const { root, run, adapter } = await repository(t), request = { action: "write", path: "new", base64: "" } as const;
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "BISECT_START", "AUTO_MERGE", "sequencer", "rebase-apply", "rebase-merge"]) {
    const location = run("rev-parse", "--git-path", marker), path = join(root, location);
    if (marker === "sequencer" || marker.startsWith("rebase-")) await import("node:fs/promises").then(({ mkdir }) => mkdir(path));
    else await import("node:fs/promises").then(({ writeFile }) => writeFile(path, "active"));
    await assert.rejects(adapter.preflight(request), /Active/); await rm(path, { recursive: true, force: true });
  }
  run("update-index", "--split-index"); await assert.rejects(adapter.preflight(request), /Split/);
  const nonrepo = await mkdtemp(join(tmpdir(), "void-not-git-")); t.after(() => rm(nonrepo, { recursive: true, force: true }));
  assert.throws(() => managedGitAdapter({ root: nonrepo, cooperative: true }), /Managed Git command failed/);
  const bare = await mkdtemp(join(tmpdir(), "void-bare-git-")); t.after(() => rm(bare, { recursive: true, force: true })); execFileSync("git", ["init", "--bare", "-q", bare]);
  assert.throws(() => managedGitAdapter({ root: bare, cooperative: true }), /Bare/);
});


posixTest("prepare to execute drift matrix refuses HEAD, selected worktree and selected index changes", async (t) => {
  for (const drift of ["head", "worktree", "index"] as const) {
    const { root, run, adapter } = await repository(t), args = { action: "write", path: "tracked", base64: Buffer.from("agent").toString("base64") } as const;
    const observed = await adapter.preflight(args), prepared = await adapter.prepare(args, observed, `drift-${drift}`);
    if (drift === "head") run("commit", "--allow-empty", "-qm", "human");
    if (drift === "worktree") await import("node:fs/promises").then(({ chmod }) => chmod(join(root, "tracked"), 0o644));
    if (drift === "index") { await import("node:fs/promises").then(({ writeFile }) => writeFile(join(root, "tracked"), "index human")); run("add", "tracked"); }
    await assert.rejects(adapter.execute(args, prepared, `drift-${drift}`));
  }
});

posixTest("rename recovery conflicts on destination edit, destination ABA and source recreation", async (t) => {
  for (const drift of ["destination", "aba", "source"] as const) {
    const { root, adapter } = await repository(t), done = await dispatch(adapter, { action: "rename", path: "tracked", to: "moved" });
    const { writeFile } = await import("node:fs/promises");
    if (drift === "source") await writeFile(join(root, "tracked"), "human");
    else { await writeFile(join(root, "moved"), "human"); if (drift === "aba") await writeFile(join(root, "moved"), "before", { mode: 0o755 }); }
    assert.equal((await adapter.recover(done.prepared, done.outcome, `recover-${drift}`)).status, "conflict");
  }
});


posixTest("index lifecycle covers untracked stage, staged add unstage and staged deletion", async (t) => {
  {
    const { root, run, adapter } = await repository(t); await import("node:fs/promises").then(({ writeFile }) => writeFile(join(root, "untracked"), "new"));
    const done = await dispatch(adapter, { action: "stage", path: "untracked" }); assert.match(run("ls-files", "--stage", "--", "untracked"), /100644/);
    assert.equal((await adapter.recover(done.prepared, done.outcome, "recover-untracked")).status, "restored"); assert.equal(run("ls-files", "--stage", "--", "untracked"), "");
  }
  {
    const { root, run, adapter } = await repository(t); await import("node:fs/promises").then(({ writeFile }) => writeFile(join(root, "added"), "new")); run("add", "added");
    const done = await dispatch(adapter, { action: "unstage", path: "added" }); assert.equal(run("ls-files", "--stage", "--", "added"), "");
    assert.equal((await adapter.recover(done.prepared, done.outcome, "recover-added")).status, "restored"); assert.match(run("ls-files", "--stage", "--", "added"), /100644/);
  }
  {
    const { root, run, adapter } = await repository(t); await rm(join(root, "tracked")); run("add", "tracked");
    const done = await dispatch(adapter, { action: "unstage", path: "tracked" }); assert.match(run("ls-files", "--stage", "--", "tracked"), /100755/);
    assert.equal((await adapter.recover(done.prepared, done.outcome, "recover-deletion")).status, "restored"); assert.equal(run("ls-files", "--stage", "--", "tracked"), "");
  }
});


posixTest("worktree recovery permits unrelated staging but index recovery conservatively conflicts", async (t) => {
  {
    const { root, run, adapter } = await repository(t), done = await dispatch(adapter, { action: "write", path: "tracked", base64: Buffer.from("agent").toString("base64") });
    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(root, "human"), "staged human")); run("add", "human"); const humanEntry = run("ls-files", "--stage", "--", "human");
    assert.equal((await adapter.recover(done.prepared, done.outcome, "recover-worktree")).status, "restored"); assert.equal(run("ls-files", "--stage", "--", "human"), humanEntry);
  }
  {
    const { root, run, adapter } = await repository(t); await import("node:fs/promises").then(({ writeFile }) => writeFile(join(root, "tracked"), "agent")); const done = await dispatch(adapter, { action: "stage", path: "tracked" });
    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(root, "human"), "staged human")); run("add", "human"); const selected = run("ls-files", "--stage", "--", "tracked"), human = run("ls-files", "--stage", "--", "human");
    assert.equal((await adapter.recover(done.prepared, done.outcome, "recover-index")).status, "conflict"); assert.equal(run("ls-files", "--stage", "--", "tracked"), selected); assert.equal(run("ls-files", "--stage", "--", "human"), human);
  }
});


posixTest("v2 parser rejects checksum-valid nonzero entry padding", async (t) => {
  const { root, run, adapter } = await repository(t), location = run("rev-parse", "--git-path", "index"), path = join(root, location);
  const { readFile, writeFile } = await import("node:fs/promises"), bytes = await readFile(path), hashLength = 20, nul = bytes.indexOf(0, 12 + 40 + hashLength + 2), aligned = 12 + Math.ceil((nul + 1 - 12) / 8) * 8;
  assert.ok(aligned > nul + 1); bytes[nul + 1] = 1;
  const checksum = (await import("node:crypto")).createHash("sha1").update(bytes.subarray(0, bytes.length - hashLength)).digest(); checksum.copy(bytes, bytes.length - hashLength); await writeFile(path, bytes);
  await assert.rejects(adapter.preflight({ action: "write", path: "new", base64: "" }), /padding/);
});

posixTest("v2 parser accepts long pathname length fields in SHA-1 and SHA-256 repositories", async (t) => {
  for (const format of ["sha1", "sha256"] as const) {
    const root = await mkdtemp(join(tmpdir(), `void-long-${format}-`)); t.after(() => rm(root, { recursive: true, force: true })); execFileSync("git", ["init", "-q", `--object-format=${format}`, root]); execFileSync("git", ["-C", root, "config", "user.name", "VOID test"]); execFileSync("git", ["-C", root, "config", "user.email", "void@example.invalid"]);
    const parts = Array.from({ length: 10 }, (_, index) => `segment-${index.toString().padStart(2, "0")}-${"x".repeat(45)}`), relative = `${parts.join("/")}/file`;
    await import("node:fs/promises").then(async ({ mkdir, writeFile }) => { await mkdir(join(root, ...parts), { recursive: true }); await writeFile(join(root, relative), "long"); }); execFileSync("git", ["-C", root, "add", "--", relative]); execFileSync("git", ["-C", root, "commit", "-qm", "long"]);
    assert.equal((await managedGitAdapter({ root, cooperative: true }).preflight({ action: "write", path: "new", base64: "" })).readiness, "verified");
  }
});


posixTest("recovery-time HEAD drift conflicts and preserves exact agent-after worktree and index", async (t) => {
  const { root, run, adapter } = await repository(t), done = await dispatch(adapter, { action: "write", path: "tracked", base64: Buffer.from("agent").toString("base64") });
  const { readFile } = await import("node:fs/promises"), indexPath = join(root, run("rev-parse", "--git-path", "index")), indexAfter = await readFile(indexPath), worktreeAfter = await readFile(join(root, "tracked"));
  run("commit", "--allow-empty", "-qm", "human head");
  assert.equal((await adapter.recover(done.prepared, done.outcome, "head-drift")).status, "conflict");
  assert.deepEqual(await readFile(join(root, "tracked")), worktreeAfter); assert.deepEqual(await readFile(indexPath), indexAfter);
});

posixTest("legacy version 1 prepared JSON still executes and recovers", async (t) => {
  const { adapter } = await repository(t);
  const args = {
    action: "write",
    path: "tracked",
    base64: Buffer.from("agent").toString("base64"),
  } as const;
  const observation = await adapter.preflight(args);
  const prepared = JSON.parse(
    JSON.stringify(await adapter.prepare(args, observation, "legacy")),
  );
  assert.equal("kind" in (prepared.before as object), false);
  const outcome = await adapter.execute(args, prepared, "legacy");
  assert.equal(
    (await adapter.recover(prepared, outcome, "legacy-recovery")).status,
    "restored",
  );
});
