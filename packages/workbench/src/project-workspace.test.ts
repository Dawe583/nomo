import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { dataDir } from "../../ledger/src/paths.ts";
import {
  assertProjectWorkspaceLimits,
  applyProjectWorkspaceChange,
  createProjectWorkspace,
  deleteProjectWorkspace,
  listProjectWorkspaces,
  projectWorkspaceDiff,
  projectWorkspaceStatus,
  PROJECT_WORKSPACE_LIMITS,
} from "./project-workspace.ts";

async function gitProject(t: TestContext) {
  const fixture = await mkdtemp(join(tmpdir(), "nomo-project-workspace-"));
  const root = join(fixture, "project");
  if (process.platform === "win32")
    await mkdir(dataDir(homedir()), { recursive: true, mode: 0o700 });
  const dataRoot = process.platform === "win32"
    ? await mkdtemp(join(dataDir(homedir()), "nomo-project-workspace-data-"))
    : join(fixture, "workbench");
  if (process.platform === "win32")
    t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const outside = join(fixture, "outside.txt");
  await mkdir(root);
  await writeFile(outside, "outside-secret");
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git(["init", "--quiet"]);
  git(["config", "user.name", "NOMO fixture"]);
  git(["config", "user.email", "nomo-fixture@example.invalid"]);
  await writeFile(join(root, ".git/info/exclude"), "global-ignore.md\n");
  await writeFile(join(root, ".gitignore"), ".env.local\nnode_modules/\n.cache/\n");
  await writeFile(join(root, "global-ignore.md"), "ignored by Git exclude");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/main.ts"), "export const answer = 42;\n");
  await writeFile(join(root, ".env.local"), "ignored-secret");
  await writeFile(join(root, ".env.production"), "tracked-secret");
  await writeFile(join(root, "token.pem"), "key-material");
  await writeFile(join(root, "id_rsa"), "private-key");
  await mkdir(join(root, "secrets"), { recursive: true });
  await writeFile(join(root, "secrets/token"), "secret");
  await mkdir(join(root, "credentials"), { recursive: true });
  await writeFile(join(root, "credentials/cloud.json"), "credential");
  await mkdir(join(root, "packages/cli/src/tui"), { recursive: true });
  await writeFile(join(root, "packages/cli/src/tui/workspace.ts"), "tui-source");
  await mkdir(join(root, "SeCrEtS"), { recursive: true });
  await writeFile(join(root, "SeCrEtS/uppercase"), "secret");
  await mkdir(join(root, "Packages/CLI/src/TUI"), { recursive: true });
  await writeFile(join(root, "Packages/CLI/src/TUI/Workspace.ts"), "tui-case");
  await writeFile(join(root, "id_rsa_backup"), "private-key");
  await mkdir(join(root, "node_modules/pkg"), { recursive: true });
  await writeFile(join(root, "node_modules/pkg/index.js"), "ignored-build");
  await mkdir(join(root, ".cache"), { recursive: true });
  await writeFile(join(root, ".cache/output"), "ignored-cache");
  await symlink(outside, join(root, "src/escape.ts"));
  git(["add", "-A"]);
  await writeFile(join(root, "notes.md"), "untracked but allowed\n");
  return { fixture, root, dataRoot, git };
}

test("a stale workspace preparation lock is reclaimed safely", async (t) => {
  const { fixture, root, dataRoot } = await gitProject(t);
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const hex = createHash("sha256").update(await realpath(root)).digest("hex");
  const workspacesRoot = join(dataRoot, "project-workspaces");
  await mkdir(workspacesRoot, { recursive: true, mode: 0o700 });
  const lockPath = join(workspacesRoot, `.${hex}.lock`);
  await writeFile(
    lockPath,
    JSON.stringify({ host: hostname(), pid: 2_147_483_647, nonce: "a".repeat(32) }),
    { flag: "wx", mode: 0o600 },
  );

  const workspace = await createProjectWorkspace({ projectRoot: root, dataRoot });
  assert.equal((await stat(workspace.directory)).isDirectory(), true);
  assert.equal(await lstat(lockPath).then(() => true, () => false), false);
});

test("an active workspace preparation lock is preserved", async (t) => {
  const { fixture, root, dataRoot } = await gitProject(t);
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const hex = createHash("sha256").update(await realpath(root)).digest("hex");
  const workspacesRoot = join(dataRoot, "project-workspaces");
  await mkdir(workspacesRoot, { recursive: true, mode: 0o700 });
  const lockPath = join(workspacesRoot, `.${hex}.lock`);
  const lockContent = JSON.stringify({ host: hostname(), pid: process.pid, nonce: "b".repeat(32) });
  await writeFile(lockPath, lockContent, { flag: "wx", mode: 0o600 });

  await assert.rejects(
    createProjectWorkspace({ projectRoot: root, dataRoot }),
    /being prepared/i,
  );
  assert.equal(await readFile(lockPath, "utf8"), lockContent);
});

test("project copy contains allowed files only and never follows symlinks", async (t) => {
  const { fixture, root, dataRoot, git } = await gitProject(t);
  t.after(() => rm(fixture, { recursive: true, force: true }));
  git(["config", "core.fsmonitor", join(fixture, "must-not-run")]);

  const workspace = await createProjectWorkspace({ projectRoot: root, dataRoot });
  const copied = new Set(await readdir(workspace.source));
  assert.ok(copied.has("src"));
  assert.ok(copied.has("notes.md"));
  assert.equal(await readFile(join(workspace.source, "src/main.ts"), "utf8"), "export const answer = 42;\n");
  assert.equal(await readFile(join(workspace.source, "notes.md"), "utf8"), "untracked but allowed\n");
  assert.equal(await lstat(join(workspace.source, "src/escape.ts")).then(() => true, () => false), false);

  for (const path of [
    ".git",
    ".env.local",
    ".env.production",
    "token.pem",
    "id_rsa",
    "secrets",
    "credentials",
    "packages",
    "nested",
    "node_modules",
    ".cache",
    "Packages",
    "global-ignore.md",
    "SeCrEtS",
  ]) {
    assert.equal(copied.has(path), false, `${path} must not enter the copy`);
  }
  assert.equal(await readFile(workspace.manifestPath, "utf8").then((text) => text.includes("tracked-secret")), false);
  assert.equal(await readFile(workspace.ownerPath, "utf8").then((text) => text.includes(root)), false);
  assert.equal(
    workspace.rootDigest,
    `sha256:${createHash("sha256").update(await realpath(root)).digest("hex")}`,
  );
  assert.equal((await stat(workspace.directory)).isDirectory(), true);
  if (process.platform !== "win32") {
    assert.equal((await stat(workspace.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(workspace.source, "src/main.ts"))).mode & 0o777, 0o600);
  }
  await writeFile(join(workspace.source, "src/main.ts"), "agent edit");
  assert.equal(await readFile(join(root, "src/main.ts"), "utf8"), "export const answer = 42;\n");
});

test("workspace status and one-file diff compare changes to the confirmed baseline", async (t) => {
  const { fixture, root, dataRoot } = await gitProject(t);
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const workspace = await createProjectWorkspace({ projectRoot: root, dataRoot });
  await writeFile(join(workspace.source, "src/main.ts"), "export const answer = 43;\n");
  await writeFile(join(workspace.source, "new.ts"), "export const added = true;\n");
  await unlink(join(workspace.source, "notes.md"));
  await symlink(join(fixture, "outside.txt"), join(workspace.source, "escape-secret.ts"));
  await mkdir(join(workspace.source, "packages/cli/src/tui"), { recursive: true });
  await writeFile(join(workspace.source, "packages/cli/src/tui/hidden.ts"), "must not appear");

  const status = await projectWorkspaceStatus(workspace);
  assert.deepEqual(
    status.changes.map(({ path, operation }) => ({ path, operation })),
    [
      { path: "new.ts", operation: "add" },
      { path: "notes.md", operation: "delete" },
      { path: "src/main.ts", operation: "update" },
    ],
  );
  const diff = await projectWorkspaceDiff(workspace, "src/main.ts");
  assert.equal(diff.digest, status.changes.find((change) => change.path === "src/main.ts")!.digest);
  assert.match(diff.file.diff, /-export const answer = 42;/);
  assert.match(diff.file.diff, /\+export const answer = 43;/);
  await assert.rejects(projectWorkspaceDiff(workspace, "src/main.ts", 16), /limit/i);
  await assert.rejects(
    projectWorkspaceDiff(workspace, "packages/cli/src/tui/hidden.ts"),
    /not permitted/i,
  );
  await assert.rejects(projectWorkspaceDiff(workspace, ".env.production"), /not permitted/i);
  assert.equal(await readFile(join(root, "src/main.ts"), "utf8"), "export const answer = 42;\n");

  await writeFile(join(workspace.source, "src/main.ts"), "export const answer = 44;\n");
  const refreshed = await projectWorkspaceDiff(workspace, "src/main.ts");
  assert.notEqual(refreshed.digest, diff.digest);
  await writeFile(join(workspace.source, "src/main.ts"), "x".repeat(32_768));
  await assert.rejects(
    projectWorkspaceDiff(workspace, "src/main.ts", 32_768),
    /limit/i,
  );
});

test("apply requires the current digest, preserves verified backup, and replays safely", async (t) => {
  const { fixture, root, dataRoot } = await gitProject(t);
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const workspace = await createProjectWorkspace({ projectRoot: root, dataRoot });
  await writeFile(join(workspace.source, "src/main.ts"), "export const answer = 43;\n");
  const diff = await projectWorkspaceDiff(workspace, "src/main.ts");

  await assert.rejects(
    applyProjectWorkspaceChange(workspace, "src/main.ts", "0".repeat(64)),
    /digest|stale/i,
  );
  assert.equal(await readFile(join(root, "src/main.ts"), "utf8"), "export const answer = 42;\n");
  const applied = await applyProjectWorkspaceChange(workspace, "src/main.ts", diff.digest);
  assert.equal(applied.alreadyApplied, false);
  assert.equal(await readFile(join(root, "src/main.ts"), "utf8"), "export const answer = 43;\n");
  const backups = await readdir(workspace.backups);
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(workspace.backups, backups[0]!), "utf8"), "export const answer = 42;\n");

  const replay = await applyProjectWorkspaceChange(workspace, "src/main.ts", diff.digest);
  assert.equal(replay.alreadyApplied, true);
  await writeFile(join(workspace.source, "src/main.ts"), "export const answer = 44;\n");
  await assert.rejects(
    applyProjectWorkspaceChange(workspace, "src/main.ts", diff.digest),
    /digest|stale/i,
  );
  assert.equal(await readFile(join(root, "src/main.ts"), "utf8"), "export const answer = 43;\n");
});

test("apply refuses a changed original and does not overwrite it", async (t) => {
  const { fixture, root, dataRoot } = await gitProject(t);
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const workspace = await createProjectWorkspace({ projectRoot: root, dataRoot });
  await writeFile(join(workspace.source, "src/main.ts"), "agent version\n");
  const diff = await projectWorkspaceDiff(workspace, "src/main.ts");
  await writeFile(join(root, "src/main.ts"), "user version\n");

  await assert.rejects(
    applyProjectWorkspaceChange(workspace, "src/main.ts", diff.digest),
    /conflict|changed/i,
  );
  assert.equal(await readFile(join(root, "src/main.ts"), "utf8"), "user version\n");
});

test("symlink replacements are neither reported as deletions nor exposed by diff", async (t) => {
  const { fixture, root, dataRoot } = await gitProject(t);
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const workspace = await createProjectWorkspace({ projectRoot: root, dataRoot });
  await unlink(join(workspace.source, "src/main.ts"));
  await symlink(join(fixture, "outside.txt"), join(workspace.source, "src/main.ts"));

  const status = await projectWorkspaceStatus(workspace);
  assert.equal(status.changes.some((change) => change.path === "src/main.ts"), false);
  await assert.rejects(projectWorkspaceDiff(workspace, "src/main.ts"), /pending change|changed/i);
  await assert.rejects(
    applyProjectWorkspaceChange(workspace, "src/main.ts", "a".repeat(64)),
    /stale|digest/i,
  );
});

test("explicit apply safely creates additions and backs up deletions", async (t) => {
  const { fixture, root, dataRoot } = await gitProject(t);
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const workspace = await createProjectWorkspace({ projectRoot: root, dataRoot });
  await writeFile(join(workspace.source, "src/added.ts"), "export const added = true;\n");
  await unlink(join(workspace.source, "notes.md"));
  const added = await projectWorkspaceDiff(workspace, "src/added.ts");
  const deleted = await projectWorkspaceDiff(workspace, "notes.md");

  await applyProjectWorkspaceChange(workspace, "src/added.ts", added.digest);
  assert.equal(await readFile(join(root, "src/added.ts"), "utf8"), "export const added = true;\n");
  await applyProjectWorkspaceChange(workspace, "notes.md", deleted.digest);
  assert.equal(await lstat(join(root, "notes.md")).then(() => true, () => false), false);
  const backups = await readdir(workspace.backups);
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(workspace.backups, backups[0]!), "utf8"), "untracked but allowed\n");
});

test("saved workspace catalog exposes only metadata and explicit deletion removes its owned copy", async (t) => {
  const { fixture, root, dataRoot } = await gitProject(t);
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const workspace = await createProjectWorkspace({ projectRoot: root, dataRoot });
  const initial = await listProjectWorkspaces(dataRoot);
  assert.deepEqual(initial, [{
    rootDigest: workspace.rootDigest,
    displayName: workspace.displayName,
    fileCount: workspace.manifest.fileCount,
    totalBytes: workspace.manifest.totalBytes,
    hasChanges: false,
    requiresConfirmation: true,
  }]);
  assert.equal(JSON.stringify(initial).includes(root), false);

  await writeFile(join(workspace.source, "src/main.ts"), "unapproved change");
  const changed = await listProjectWorkspaces(dataRoot);
  assert.equal(changed[0]!.hasChanges, true);
  assert.equal(JSON.stringify(changed).includes("unapproved change"), false);
  await deleteProjectWorkspace(dataRoot, workspace.rootDigest);
  assert.deepEqual(await readdir(join(dataRoot, "project-workspaces")), []);
});
test("workspace confirmation restores its copy without overwriting agent edits", async (t) => {
  const { fixture, root, dataRoot } = await gitProject(t);
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const workspace = await createProjectWorkspace({ projectRoot: root, dataRoot });
  const changed = "agent-owned content\n";
  await writeFile(join(workspace.source, "src/main.ts"), changed);
  const restored = await createProjectWorkspace({ projectRoot: root, dataRoot });
  assert.equal(restored.source, workspace.source);
  assert.equal(await readFile(join(restored.source, "src/main.ts"), "utf8"), changed);
  assert.equal(await readFile(join(root, "src/main.ts"), "utf8"), "export const answer = 42;\n");
});

test("non-Git roots fail without publishing a partial workspace", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "nomo-project-workspace-nogit-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, "project");
  const dataRoot = join(fixture, "workbench");
  await mkdir(root);
  await writeFile(join(root, "main.ts"), "source");
  await assert.rejects(
    createProjectWorkspace({ projectRoot: root, dataRoot }),
    /git|project/i,
  );
  assert.deepEqual(await readdir(join(dataRoot, "project-workspaces")), []);
});
test("project subdirectories and parent directories are not Git roots", async (t) => {
  const { fixture, root } = await gitProject(t);
  if (process.platform === "win32")
    await mkdir(dataDir(homedir()), { recursive: true, mode: 0o700 });
  const dataRoot = await mkdtemp(join(
    process.platform === "win32" ? dataDir(homedir()) : tmpdir(),
    "nomo-project-workspace-data-",
  ));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  for (const projectRoot of [fixture, join(root, "src")]) {
    await assert.rejects(
      createProjectWorkspace({ projectRoot, dataRoot }),
      /root of its Git working tree/i,
    );
  }
  assert.deepEqual(await readdir(join(dataRoot, "project-workspaces")), []);
});

test("oversized files fail without publishing a partial workspace", async (t) => {
  const { fixture, root, dataRoot } = await gitProject(t);
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const oversized = await open(join(root, "oversized.bin"), "w");
  try {
    await oversized.truncate(PROJECT_WORKSPACE_LIMITS.fileBytes + 1);
  } finally {
    await oversized.close();
  }
  await assert.rejects(
    createProjectWorkspace({ projectRoot: root, dataRoot }),
    /per-file limit/i,
  );
  assert.deepEqual(await readdir(join(dataRoot, "project-workspaces")), []);
});

test("hard-linked files fail closed instead of copying an external inode", async (t) => {
  const { fixture, root, dataRoot, git } = await gitProject(t);
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await link(join(root, "src/main.ts"), join(root, "src/linked.ts"));
  git(["add", "src/linked.ts"]);
  await assert.rejects(
    createProjectWorkspace({ projectRoot: root, dataRoot }),
    /hard links/i,
  );
  assert.deepEqual(await readdir(join(dataRoot, "project-workspaces")), []);
});

test("workspace limits accept exact boundaries and reject each overflow", () => {
  assert.doesNotThrow(() => assertProjectWorkspaceLimits(
    PROJECT_WORKSPACE_LIMITS.files,
    PROJECT_WORKSPACE_LIMITS.fileBytes,
    PROJECT_WORKSPACE_LIMITS.totalBytes,
  ));
  assert.throws(
    () => assertProjectWorkspaceLimits(PROJECT_WORKSPACE_LIMITS.files + 1, 0, 0),
    /too many/i,
  );
  assert.throws(
    () => assertProjectWorkspaceLimits(1, PROJECT_WORKSPACE_LIMITS.fileBytes + 1, 0),
    /per-file/i,
  );
  assert.throws(
    () => assertProjectWorkspaceLimits(1, 0, PROJECT_WORKSPACE_LIMITS.totalBytes + 1),
    /total/i,
  );
});
test("Git entry count above the workspace limit publishes no copy", async (t) => {
  const { fixture, root, dataRoot, git } = await gitProject(t);
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const objectId = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: root,
    input: "",
    encoding: "utf8",
  }).trim();
  const indexEntries = Array.from(
    { length: PROJECT_WORKSPACE_LIMITS.files + 1 },
    (_, index) => `100644 ${objectId}\tindexed/${String(index).padStart(6, "0")}.ts\n`,
  ).join("");
  execFileSync("git", ["update-index", "--index-info"], { cwd: root, input: indexEntries });
  git(["config", "core.fsmonitor", join(fixture, "must-not-run")]);
  await assert.rejects(
    createProjectWorkspace({ projectRoot: root, dataRoot }),
    /too many/i,
  );
  assert.deepEqual(await readdir(join(dataRoot, "project-workspaces")), []);
});
test("an invalid ownership marker never authorizes an existing workspace", async (t) => {
  const { fixture, root, dataRoot } = await gitProject(t);
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const workspace = await createProjectWorkspace({ projectRoot: root, dataRoot });
  await writeFile(
    workspace.ownerPath,
    JSON.stringify({ version: 1, rootDigest: `sha256:${"0".repeat(64)}` }),
  );
  await assert.rejects(
    createProjectWorkspace({ projectRoot: root, dataRoot }),
    /ownership/i,
  );
  assert.equal(await readFile(join(workspace.source, "src/main.ts"), "utf8"), "export const answer = 42;\n");
});

test("a modified baseline manifest fails closed before exposing status", async (t) => {
  const { fixture, root, dataRoot } = await gitProject(t);
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const workspace = await createProjectWorkspace({ projectRoot: root, dataRoot });
  const manifest = JSON.parse(await readFile(workspace.manifestPath, "utf8")) as {
    totalBytes: number;
  };
  manifest.totalBytes += 1;
  await writeFile(workspace.manifestPath, JSON.stringify(manifest));
  await assert.rejects(projectWorkspaceStatus(workspace), /manifest is invalid/i);
});

test("Workbench data root inside the project fails before creating a copy", async (t) => {
  const { fixture, root } = await gitProject(t);
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const dataRoot = join(root, ".nomo");
  await mkdir(dataRoot);
  await assert.rejects(
    createProjectWorkspace({ projectRoot: root, dataRoot }),
    /must not overlap/i,
  );
});
