import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  PROJECT_CONTEXT_FILE_NAMES,
  readProjectContextFiles,
} from "./project-context-files.ts";
import type {
  ProjectWorkspaceManifest,
  ProjectWorkspaceManifestFile,
} from "./project-workspace.ts";

const FILE_BYTES = 32_768;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function bytesOf(value: string | Buffer): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

function entry(path: string, content: string | Buffer): ProjectWorkspaceManifestFile {
  const bytes = bytesOf(content);
  return { path, sha256: sha256(bytes), size: bytes.length, mode: 0o644 };
}

function manifestOf(files: readonly ProjectWorkspaceManifestFile[]): ProjectWorkspaceManifest {
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
  return {
    version: 1,
    rootDigest: `sha256:${"0".repeat(64)}`,
    displayName: "project",
    fileCount: sorted.length,
    totalBytes: sorted.reduce((total, file) => total + file.size, 0),
    files: sorted,
  };
}

/**
 * Mirrors the layout createProjectWorkspace produces: the original root, the
 * agent-writable source copy and the protected baseline with its manifest.
 */
async function fixture(
  t: TestContext,
  input: {
    readonly project?: Readonly<Record<string, string | Buffer>>;
    readonly baseline?: Readonly<Record<string, string | Buffer>>;
    readonly source?: Readonly<Record<string, string | Buffer>>;
    readonly manifest?: readonly string[];
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "nomo-project-context-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projectRoot = join(directory, "project");
  const copyRoot = join(directory, "copy");
  const baseline = join(copyRoot, "control", "baseline");
  await mkdir(projectRoot);
  await mkdir(baseline, { recursive: true });
  await mkdir(join(copyRoot, "source"), { recursive: true });
  for (const [name, content] of Object.entries(input.project ?? {}))
    await writeFile(join(projectRoot, name), content);
  for (const [name, content] of Object.entries(input.baseline ?? {}))
    await writeFile(join(baseline, name), content);
  for (const [name, content] of Object.entries(input.source ?? {}))
    await writeFile(join(copyRoot, "source", name), content);
  const manifest = manifestOf(
    (input.manifest ?? []).map((name) => {
      const content = (input.baseline ?? {})[name];
      assert.ok(content !== undefined, `manifest entry ${name} needs baseline content`);
      return entry(name, content);
    }),
  );
  return { directory, projectRoot, copyRoot, baseline, manifest };
}

test("root project context files come from the protected baseline in a fixed order", async (t) => {
  assert.deepEqual([...PROJECT_CONTEXT_FILE_NAMES], ["AGENTS.md", "CLAUDE.md"]);
  const { projectRoot, copyRoot, manifest } = await fixture(t, {
    project: { "AGENTS.md": "# Project\n", "CLAUDE.md": "# Claude\n" },
    baseline: { "AGENTS.md": "# Project\n", "CLAUDE.md": "# Claude\n" },
    manifest: ["CLAUDE.md", "AGENTS.md"],
    source: { "AGENTS.md": "agent writable\n", "CLAUDE.md": "agent writable\n" },
  });
  const result = await readProjectContextFiles({ projectRoot, copyRoot, manifest });
  assert.deepEqual(result.refused, []);
  assert.deepEqual(result.files.map((file) => file.path), ["AGENTS.md", "CLAUDE.md"]);
  assert.deepEqual(result.files[0], {
    path: "AGENTS.md",
    sha256: sha256("# Project\n"),
    size: Buffer.byteLength("# Project\n"),
    content: "# Project\n",
  });
  assert.deepEqual(result.files[1], {
    path: "CLAUDE.md",
    sha256: sha256("# Claude\n"),
    size: Buffer.byteLength("# Claude\n"),
    content: "# Claude\n",
  });
});

test("an oversized project context file is refused by name while the other still loads", async (t) => {
  const oversized = `${"x".repeat(FILE_BYTES)}\n`;
  const { projectRoot, copyRoot, manifest } = await fixture(t, {
    baseline: { "AGENTS.md": oversized, "CLAUDE.md": "# Claude\n" },
    manifest: ["AGENTS.md", "CLAUDE.md"],
  });
  const result = await readProjectContextFiles({ projectRoot, copyRoot, manifest });
  assert.deepEqual(result.files.map((file) => file.path), ["CLAUDE.md"]);
  assert.deepEqual(result.refused.map((file) => file.path), ["AGENTS.md"]);
  assert.match(result.refused[0]!.reason, /exceeds the 32768 byte limit/);
});

test("a project context file that is a symlink in the original root is refused by name", async (t) => {
  const { directory, projectRoot, copyRoot, manifest } = await fixture(t);
  const outside = join(directory, "outside.md");
  await writeFile(outside, "# outside\n");
  await symlink(outside, join(projectRoot, "AGENTS.md"));
  const result = await readProjectContextFiles({ projectRoot, copyRoot, manifest });
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.refused.map((file) => file.path), ["AGENTS.md"]);
  assert.match(result.refused[0]!.reason, /symlink in the project root/);
});

test("non UTF-8 and control character project context files are refused by name", async (t) => {
  const invalid = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]);
  const control = "# Project\n\u0007ring\n";
  const { projectRoot, copyRoot, manifest } = await fixture(t, {
    baseline: { "AGENTS.md": invalid, "CLAUDE.md": control },
    manifest: ["AGENTS.md", "CLAUDE.md"],
  });
  const result = await readProjectContextFiles({ projectRoot, copyRoot, manifest });
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.refused.map((file) => file.path), ["AGENTS.md", "CLAUDE.md"]);
  for (const refused of result.refused)
    assert.match(refused.reason, /valid UTF-8 Markdown without control characters/);
});

test("a baseline that does not match the manifest size or digest is refused by name", async (t) => {
  const { projectRoot, copyRoot, manifest } = await fixture(t, {
    baseline: { "AGENTS.md": "# Project\n", "CLAUDE.md": "# Claude\n" },
    manifest: ["AGENTS.md", "CLAUDE.md"],
  });
  const tampered: ProjectWorkspaceManifest = {
    ...manifest,
    files: manifest.files.map((file) =>
      file.path === "AGENTS.md"
        ? { ...file, sha256: sha256("# Tampered\n") }
        : { ...file, size: file.size + 1 },
    ),
  };
  const result = await readProjectContextFiles({ projectRoot, copyRoot, manifest: tampered });
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.refused.map((file) => file.path), ["AGENTS.md", "CLAUDE.md"]);
  for (const refused of result.refused)
    assert.match(refused.reason, /manifest size or digest/);
});

test("missing and untracked project context files are simply absent", async (t) => {
  const { projectRoot, copyRoot, manifest } = await fixture(t, {
    project: { "AGENTS.md": "# Untracked\n" },
  });
  const result = await readProjectContextFiles({ projectRoot, copyRoot, manifest });
  assert.deepEqual(result, { files: [], refused: [] });
});

test("a manifest entry without a baseline file is refused instead of silently skipped", async (t) => {
  const { projectRoot, copyRoot } = await fixture(t);
  const manifest = manifestOf([entry("CLAUDE.md", "# Claude\n")]);
  const result = await readProjectContextFiles({ projectRoot, copyRoot, manifest });
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.refused.map((file) => file.path), ["CLAUDE.md"]);
  assert.match(result.refused[0]!.reason, /missing from the project copy/);
});

test("a baseline symlink or non regular baseline entry is refused by name", async (t) => {
  const { directory, projectRoot, copyRoot, baseline } = await fixture(t);
  const outside = join(directory, "outside.md");
  await writeFile(outside, "# outside\n");
  await symlink(outside, join(baseline, "AGENTS.md"));
  await mkdir(join(baseline, "CLAUDE.md"));
  const manifest = manifestOf([
    entry("AGENTS.md", "# outside\n"),
    entry("CLAUDE.md", "# Claude\n"),
  ]);
  const result = await readProjectContextFiles({ projectRoot, copyRoot, manifest });
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.refused.map((file) => file.path), ["AGENTS.md", "CLAUDE.md"]);
  assert.match(result.refused[0]!.reason, /symlink in the project copy/);
  assert.match(result.refused[1]!.reason, /not a regular file in the project copy/);
});

test("a copy root without a protected baseline is rejected instead of reading the source", async (t) => {
  const { projectRoot, copyRoot, manifest } = await fixture(t, {
    baseline: { "AGENTS.md": "# Project\n" },
    manifest: ["AGENTS.md"],
  });
  await assert.rejects(
    readProjectContextFiles({ projectRoot, copyRoot: join(copyRoot, "source"), manifest }),
    /no protected baseline/,
  );
});

test("a project without context files yields an empty result", async (t) => {
  const { projectRoot, copyRoot, manifest } = await fixture(t);
  assert.deepEqual(
    await readProjectContextFiles({ projectRoot, copyRoot, manifest }),
    { files: [], refused: [] },
  );
});
