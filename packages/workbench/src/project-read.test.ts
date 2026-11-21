import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { PROJECT_SANDBOX_LIMITS } from "./project-sandbox.ts";
import type { ProjectWorkspace } from "./project-workspace.ts";
import {
  PROJECT_READ_LIMITS,
  PROJECT_READ_TOOL,
  PROJECT_SEARCH_LIMITS,
  PROJECT_SEARCH_TOOL,
  projectWorkspaceRead,
  projectWorkspaceSearch,
} from "./project-read.ts";

const ROOT_DIGEST = `sha256:${"a".repeat(64)}`;

/**
 * A workspace shaped like the one `createProjectWorkspace` publishes, with
 * markers in the host root and in the protected baseline. A read or search
 * that reached either place would show the marker in its result.
 */
async function projectCopy(
  t: TestContext,
): Promise<{ readonly workspace: ProjectWorkspace; readonly outside: string }> {
  const fixture = await mkdtemp(join(tmpdir(), "nomo-project-read-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, "project");
  const directory = join(fixture, "copy");
  const source = join(directory, "source");
  const control = join(directory, "control");
  const baseline = join(control, "baseline");
  const backups = join(control, "backups");
  await mkdir(root, { recursive: true });
  await mkdir(source, { recursive: true });
  await mkdir(baseline, { recursive: true });
  await mkdir(backups, { recursive: true });
  await writeFile(join(root, "host-only.txt"), "host-only-marker\n");
  await writeFile(join(baseline, "baseline-only.txt"), "baseline-only-marker\n");
  const outside = join(fixture, "outside.txt");
  await writeFile(outside, "outside-marker\n");
  return {
    outside,
    workspace: {
      root,
      rootDigest: ROOT_DIGEST,
      displayName: "project",
      directory,
      source,
      control,
      ownerPath: join(control, "owner.json"),
      manifestPath: join(control, "manifest.json"),
      backups,
      baseline,
      manifest: {
        version: 1,
        rootDigest: ROOT_DIGEST,
        displayName: "project",
        fileCount: 0,
        totalBytes: 0,
        files: [],
      },
    },
  };
}

async function writeSource(
  workspace: ProjectWorkspace,
  path: string,
  content: string | Buffer,
): Promise<void> {
  const target = join(workspace.source, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of (await readdir(directory, { recursive: true })).sort()) {
    const target = join(directory, entry);
    const info = await lstat(target);
    files[entry] = info.isFile() ? (await readFile(target)).toString("base64") : "directory";
  }
  return files;
}

function resultBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

test("project read and search are read-only tool descriptors over the copy", () => {
  assert.equal(PROJECT_READ_TOOL.name, "nomo_project_read");
  assert.equal(PROJECT_SEARCH_TOOL.name, "nomo_project_search");
  assert.match(PROJECT_READ_TOOL.description, /filtered project copy/);
  assert.match(PROJECT_SEARCH_TOOL.description, /literal/);
  assert.deepEqual(PROJECT_READ_TOOL.inputSchema.required, ["path"]);
  assert.deepEqual(PROJECT_SEARCH_TOOL.inputSchema.required, ["query"]);
  assert.equal(PROJECT_READ_TOOL.inputSchema.additionalProperties, false);
  assert.equal(PROJECT_SEARCH_TOOL.inputSchema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(PROJECT_READ_TOOL.inputSchema.properties),
    ["path", "offset", "limit"],
  );
  assert.deepEqual(
    Object.keys(PROJECT_SEARCH_TOOL.inputSchema.properties),
    ["query", "path"],
  );
  assert.equal(
    PROJECT_READ_TOOL.inputSchema.properties.path.maxLength,
    PROJECT_READ_LIMITS.pathCharacters,
  );
  assert.equal(
    PROJECT_SEARCH_TOOL.inputSchema.properties.query.maxLength,
    PROJECT_SEARCH_LIMITS.queryCharacters,
  );
});

test("read returns a line window with metadata and refuses paths outside the copy", async (t) => {
  const { workspace } = await projectCopy(t);
  const lines = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`);
  await writeSource(workspace, "notes.txt", `${lines.join("\n")}\n`);
  const before = await snapshot(workspace.directory);

  const whole = await projectWorkspaceRead(workspace, { path: "notes.txt" });
  assert.equal(whole.path, "notes.txt");
  assert.equal(whole.content, lines.join("\n"));
  assert.equal(whole.offset, 1);
  assert.equal(whole.lines, 10);
  assert.equal(whole.totalLines, 10);
  assert.equal(whole.hasMore, false);
  assert.equal(whole.truncated, false);

  const window = await projectWorkspaceRead(workspace, {
    path: "notes.txt",
    offset: 3,
    limit: 2,
  });
  assert.equal(window.content, "line-3\nline-4");
  assert.equal(window.offset, 3);
  assert.equal(window.lines, 2);
  assert.equal(window.totalLines, 10);
  assert.equal(window.hasMore, true);
  assert.equal(window.truncated, false);

  const tail = await projectWorkspaceRead(workspace, {
    path: "notes.txt",
    offset: 9,
    limit: 5,
  });
  assert.equal(tail.content, "line-9\nline-10");
  assert.equal(tail.lines, 2);
  assert.equal(tail.hasMore, false);

  const past = await projectWorkspaceRead(workspace, { path: "notes.txt", offset: 20 });
  assert.equal(past.content, "");
  assert.equal(past.lines, 0);
  assert.equal(past.hasMore, false);

  for (const path of [
    "../outside.txt",
    "/etc/passwd",
    "C:\\host.txt",
    "src\\main.ts",
    "notes.txt\u0000",
    "",
    "notes.txt/..",
    ".env",
    ".git/config",
    "secrets/token",
    "packages/cli/src/tui/workspace.ts",
    "node_modules/pkg/index.js",
    "host-only.txt",
    "baseline-only.txt",
  ]) {
    await assert.rejects(
      projectWorkspaceRead(workspace, { path }),
      /non-empty|not permitted|does not exist|not a regular file|changed|symlink|hard link/i,
      path,
    );
  }
  assert.deepEqual(await snapshot(workspace.directory), before);
});

test("read refuses binary data, invalid UTF-8 and symlinked paths", async (t) => {
  const { workspace, outside } = await projectCopy(t);
  await writeSource(workspace, "binary.dat", Buffer.from([0x61, 0x00, 0x62]));
  await writeSource(workspace, "latin1.txt", Buffer.from([0xff, 0xfe, 0x61]));
  await writeSource(workspace, "valid.txt", "zlutoucky kun: \u017elu\u0165ou\u010dk\u00fd\n");
  await symlink(outside, join(workspace.source, "escape.txt"));
  const outsideDirectory = join(dirname(outside), "outside-directory");
  await mkdir(outsideDirectory);
  await writeFile(join(outsideDirectory, "inner.txt"), "outside-inner\n");
  await symlink(outsideDirectory, join(workspace.source, "linked"));

  const valid = await projectWorkspaceRead(workspace, { path: "valid.txt" });
  assert.equal(valid.content, "zlutoucky kun: \u017elu\u0165ou\u010dk\u00fd");
  await assert.rejects(projectWorkspaceRead(workspace, { path: "binary.dat" }), /binary/i);
  await assert.rejects(projectWorkspaceRead(workspace, { path: "latin1.txt" }), /UTF-8/i);
  await assert.rejects(
    projectWorkspaceRead(workspace, { path: "escape.txt" }),
    /not a regular file/i,
  );
  await assert.rejects(projectWorkspaceRead(workspace, { path: "linked/inner.txt" }));
});

test("read validates its arguments before touching the copy", async (t) => {
  const { workspace } = await projectCopy(t);
  await writeSource(workspace, "notes.txt", "line-1\nline-2\n");
  await assert.rejects(projectWorkspaceRead(workspace, null), /object/i);
  await assert.rejects(projectWorkspaceRead(workspace, "notes.txt"), /object/i);
  await assert.rejects(projectWorkspaceRead(workspace, { path: 1 }), /path/i);
  await assert.rejects(
    projectWorkspaceRead(workspace, { path: "notes.txt", offset: 0 }),
    /offset/i,
  );
  await assert.rejects(
    projectWorkspaceRead(workspace, { path: "notes.txt", offset: 1.5 }),
    /offset/i,
  );
  await assert.rejects(
    projectWorkspaceRead(workspace, { path: "notes.txt", limit: 0 }),
    /limit/i,
  );
  await assert.rejects(
    projectWorkspaceRead(workspace, {
      path: "notes.txt",
      limit: PROJECT_READ_LIMITS.maxLines + 1,
    }),
    /limit/i,
  );
  await assert.rejects(
    projectWorkspaceRead(workspace, { path: "notes.txt", extra: true }),
    /unexpected/i,
  );
  await assert.rejects(
    projectWorkspaceRead(workspace, { path: "x".repeat(PROJECT_READ_LIMITS.pathCharacters + 1) }),
    /not permitted/i,
  );
});

test("read keeps its JSON result within the sandbox output bound", async (t) => {
  const { workspace } = await projectCopy(t);
  const wide = Array.from({ length: 2_000 }, (_, index) => `${index}:${"x".repeat(160)}`);
  await writeSource(workspace, "wide.txt", `${wide.join("\n")}\n`);

  const bounded = await projectWorkspaceRead(workspace, { path: "wide.txt" });
  assert.equal(bounded.totalLines, 2_000);
  assert.ok(resultBytes(bounded) <= PROJECT_SANDBOX_LIMITS.outputBytes);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.hasMore, true);
  assert.ok(bounded.lines > 0);
  assert.ok(bounded.lines < PROJECT_READ_LIMITS.defaultLines);

  const single = "y".repeat(200_000);
  await writeSource(workspace, "single.txt", single);
  const clipped = await projectWorkspaceRead(workspace, { path: "single.txt" });
  assert.equal(clipped.totalLines, 1);
  assert.equal(clipped.lines, 1);
  assert.ok(resultBytes(clipped) <= PROJECT_SANDBOX_LIMITS.outputBytes);
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.hasMore, true);
  assert.ok(clipped.content.length > 0);
  assert.ok(single.startsWith(clipped.content));
});

test("search matches one literal case-sensitive phrase in allowed copy files only", async (t) => {
  const { workspace, outside } = await projectCopy(t);
  await writeFile(outside, "alpha outside\n");
  await writeSource(workspace, "a.txt", "Alpha beta\nalpha Beta\n");
  await writeSource(workspace, "b.txt", "ALPHA\n");
  await writeSource(workspace, "sub/c.txt", "alpha\n");
  await writeSource(workspace, "regex.txt", "a.*a\n");
  await writeSource(workspace, "literal.txt", "needle $(echo alpha); rm -rf /\n");
  await writeSource(workspace, "binary.bin", Buffer.from("alpha\u0000", "utf8"));
  await writeSource(workspace, ".env", "alpha\n");
  await symlink(outside, join(workspace.source, "escape.txt"));

  const found = await projectWorkspaceSearch(workspace, { query: "alpha" });
  assert.equal(found.query, "alpha");
  assert.equal("path" in found, false);
  assert.deepEqual(found.matches, [
    { path: "a.txt", line: 2, text: "alpha Beta" },
    { path: "literal.txt", line: 1, text: "needle $(echo alpha); rm -rf /" },
    { path: "sub/c.txt", line: 1, text: "alpha" },
  ]);
  assert.equal(found.hasMore, false);
  assert.equal(found.truncated, false);
  assert.ok(found.scannedFiles >= 2);

  const upper = await projectWorkspaceSearch(workspace, { query: "Alpha" });
  assert.deepEqual(upper.matches, [{ path: "a.txt", line: 1, text: "Alpha beta" }]);

  const regex = await projectWorkspaceSearch(workspace, { query: "a.*a" });
  assert.deepEqual(regex.matches, [{ path: "regex.txt", line: 1, text: "a.*a" }]);

  const shell = await projectWorkspaceSearch(workspace, { query: "$(echo alpha)" });
  assert.deepEqual(shell.matches, [
    { path: "literal.txt", line: 1, text: "needle $(echo alpha); rm -rf /" },
  ]);

  const none = await projectWorkspaceSearch(workspace, { query: "not-present-anywhere" });
  assert.deepEqual(none.matches, []);
  assert.equal(none.hasMore, false);
  assert.equal(none.truncated, false);

  assert.deepEqual(
    (await projectWorkspaceSearch(workspace, { query: "host-only-marker" })).matches,
    [],
  );
  assert.deepEqual(
    (await projectWorkspaceSearch(workspace, { query: "baseline-only-marker" })).matches,
    [],
  );
  assert.deepEqual(
    (await projectWorkspaceSearch(workspace, { query: "outside-marker" })).matches,
    [],
  );
});

test("search follows an optional validated subtree and files added after the copy", async (t) => {
  const { workspace } = await projectCopy(t);
  await writeSource(workspace, "src/app.ts", "const alpha = 1;\n");
  await writeSource(workspace, "src/deep/more.ts", "alpha\n");
  await writeSource(workspace, "docs/readme.md", "alpha\n");

  const subtree = await projectWorkspaceSearch(workspace, { query: "alpha", path: "src" });
  assert.equal(subtree.path, "src");
  assert.deepEqual(subtree.matches.map((match) => match.path), [
    "src/app.ts",
    "src/deep/more.ts",
  ]);

  const single = await projectWorkspaceSearch(workspace, {
    query: "alpha",
    path: "src/app.ts",
  });
  assert.deepEqual(single.matches, [
    { path: "src/app.ts", line: 1, text: "const alpha = 1;" },
  ]);

  await writeSource(workspace, "later/added.ts", "alpha added later\n");
  const added = await projectWorkspaceSearch(workspace, { query: "alpha", path: "later" });
  assert.deepEqual(added.matches, [
    { path: "later/added.ts", line: 1, text: "alpha added later" },
  ]);

  for (const path of ["missing", "../src", "/src", ".env", "src\\app.ts", "src/app.ts\u0000"]) {
    await assert.rejects(
      projectWorkspaceSearch(workspace, { query: "alpha", path }),
      /not permitted|does not exist|not a directory|not a regular file|changed|symlink/i,
      path,
    );
  }
  const outsideDirectory = join(dirname(workspace.source), "outside-directory");
  await mkdir(outsideDirectory);
  await writeFile(join(outsideDirectory, "inner.txt"), "alpha outside\n");
  await symlink(outsideDirectory, join(workspace.source, "linked"));
  await assert.rejects(
    projectWorkspaceSearch(workspace, { query: "alpha", path: "linked" }),
    /not a directory|not a regular file/i,
  );
  await assert.rejects(projectWorkspaceSearch(workspace, { query: "alpha", path: "linked/inner.txt" }));
});

test("search bounds matches and output bytes and reports that more remain", async (t) => {
  const { workspace } = await projectCopy(t);
  for (let index = 0; index < 40; index++)
    await writeSource(
      workspace,
      `many/file-${String(index).padStart(2, "0")}.txt`,
      Array.from({ length: 20 }, (_, line) => `alpha ${line}`).join("\n"),
    );

  const capped = await projectWorkspaceSearch(workspace, { query: "alpha" });
  assert.equal(capped.matches.length, PROJECT_SEARCH_LIMITS.maxMatches);
  assert.equal(capped.hasMore, true);
  assert.equal(capped.truncated, true);
  assert.ok(resultBytes(capped) <= PROJECT_SANDBOX_LIMITS.outputBytes);
  assert.ok(capped.scannedFiles <= PROJECT_SEARCH_LIMITS.scannedFiles);

  const long = Array.from({ length: 200 }, (_, line) => `alpha ${"z".repeat(300)}`).join("\n");
  await writeSource(workspace, "long.txt", `${long}\n`);
  const bounded = await projectWorkspaceSearch(workspace, { query: "alpha" });
  assert.ok(resultBytes(bounded) <= PROJECT_SANDBOX_LIMITS.outputBytes);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.hasMore, true);
  assert.ok(bounded.matches.length > 0);
  assert.ok(bounded.matches.length < PROJECT_SEARCH_LIMITS.maxMatches);
});

test("search validates its arguments before walking the copy", async (t) => {
  const { workspace } = await projectCopy(t);
  await writeSource(workspace, "a.txt", "alpha\n");
  await assert.rejects(projectWorkspaceSearch(workspace, null), /object/i);
  await assert.rejects(projectWorkspaceSearch(workspace, { query: "" }), /query/i);
  await assert.rejects(projectWorkspaceSearch(workspace, { query: "   " }), /query/i);
  await assert.rejects(
    projectWorkspaceSearch(workspace, { query: "alpha\u0000" }),
    /control|query/i,
  );
  await assert.rejects(
    projectWorkspaceSearch(workspace, {
      query: "x".repeat(PROJECT_SEARCH_LIMITS.queryCharacters + 1),
    }),
    /query/i,
  );
  await assert.rejects(
    projectWorkspaceSearch(workspace, { query: "alpha", path: 7 }),
    /path/i,
  );
  await assert.rejects(
    projectWorkspaceSearch(workspace, { query: "alpha", extra: true }),
    /unexpected/i,
  );
});

test("read and search never write to the copy or the host project", async (t) => {
  const { workspace } = await projectCopy(t);
  await writeSource(workspace, "src/main.ts", "export const alpha = 1;\n");
  const copyBefore = await snapshot(workspace.directory);
  const hostBefore = await snapshot(workspace.root);

  await projectWorkspaceRead(workspace, { path: "src/main.ts" });
  await projectWorkspaceSearch(workspace, { query: "alpha" });

  assert.deepEqual(await snapshot(workspace.directory), copyBefore);
  assert.deepEqual(await snapshot(workspace.root), hostBefore);
});
