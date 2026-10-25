import test from "node:test";
import assert from "node:assert/strict";
import {
  projectWorkspaceApplyRequest,
  projectWorkspaceDiff,
  projectWorkspaceDiffUrl,
  projectWorkspaceErrorKind,
  projectWorkspacePage,
  projectWorkspaceSummary,
  type ProjectWorkspaceChange,
  type ProjectWorkspaceDiff,
} from "./project-workspace-state.ts";

const change: ProjectWorkspaceChange = {
  path: "src/file.ts",
  operation: "update",
  digest: "a".repeat(64),
};
const diff: ProjectWorkspaceDiff = {
  digest: change.digest,
  file: { path: change.path, digest: change.digest, diff: "--- a/src/file.ts\n+++ b/src/file.ts\n" },
};

test("apply is enabled only for the exact currently displayed project diff", () => {
  const project = { rootDigest: "sha256:" + "b".repeat(64) };
  assert.deepEqual(projectWorkspaceApplyRequest(project, change, diff), {
    path: change.path,
    digest: change.digest,
  });
  assert.equal(projectWorkspaceApplyRequest(null, change, diff), null);
  assert.equal(
    projectWorkspaceApplyRequest(project, change, { ...diff, digest: "c".repeat(64) }),
    null,
  );
  assert.equal(
    projectWorkspaceApplyRequest(project, change, {
      ...diff,
      file: { ...diff.file, path: "src/other.ts" },
    }),
    null,
  );
  assert.equal(
    projectWorkspaceApplyRequest(project, { ...change, digest: "invalid" }, diff),
    null,
  );
});

test("diff URL encodes a path as one query parameter", () => {
  assert.equal(
    projectWorkspaceDiffUrl("src/a?b&c.ts"),
    "/api/project-workspace/diff?path=src%2Fa%3Fb%26c.ts",
  );
});

test("change pages require their own digest and diffs must match it", () => {
  const page = {
    snapshotDigest: "b".repeat(64),
    files: [{
      path: change.path,
      operation: change.operation,
      beforeHash: "c".repeat(64),
      afterHash: "d".repeat(64),
      digest: change.digest,
    }],
    nextCursor: "opaque_cursor",
  };
  assert.deepEqual(projectWorkspacePage(page), {
    snapshotDigest: page.snapshotDigest,
    files: [change],
    nextCursor: page.nextCursor,
  });
  assert.equal(
    projectWorkspacePage({
      ...page,
      files: [{ ...page.files[0], digest: undefined }],
    }),
    null,
  );
  assert.deepEqual(projectWorkspaceDiff({
    digest: change.digest,
    file: { path: change.path, digest: change.digest, diff: "reviewed diff" },
  }), {
    digest: change.digest,
    file: { path: change.path, digest: change.digest, diff: "reviewed diff" },
  });
  assert.equal(projectWorkspaceDiff({
    digest: change.digest,
    file: { ...diff.file, digest: "e".repeat(64) },
  }), null);
});

test("workspace summary exposes confirmed and saved metadata without original paths", () => {
  const activeDigest = "sha256:" + "b".repeat(64);
  const savedDigest = "sha256:" + "c".repeat(64);
  assert.deepEqual(projectWorkspaceSummary({
    project: null,
    workspace: null,
    savedWorkspaces: [{
      rootDigest: savedDigest,
      displayName: "app",
      fileCount: 2,
      totalBytes: 20,
      hasChanges: true,
      requiresConfirmation: true,
      path: "/private/source",
    }],
  }), {
    project: null,
    workspace: null,
    savedWorkspaces: [{
      rootDigest: savedDigest,
      displayName: "app",
      fileCount: 2,
      totalBytes: 20,
      hasChanges: true,
      requiresConfirmation: true,
    }],
  });
  assert.deepEqual(projectWorkspaceSummary({
    project: { rootDigest: activeDigest, displayName: "app" },
    workspace: {
      fileCount: 2,
      totalBytes: 20,
      changes: { added: 1, modified: 1, deleted: 0 },
    },
    savedWorkspaces: [],
  }), {
    project: { rootDigest: activeDigest, displayName: "app" },
    workspace: {
      fileCount: 2,
      totalBytes: 20,
      changes: { added: 1, modified: 1, deleted: 0 },
    },
    savedWorkspaces: [],
  });
  assert.equal(projectWorkspaceSummary({ project: null, workspace: null }), null);
});

test("workspace errors distinguish stale conflicts from other failures", () => {
  assert.equal(projectWorkspaceErrorKind(null), null);
  assert.equal(projectWorkspaceErrorKind({ status: 409 }), "conflict");
  assert.equal(projectWorkspaceErrorKind({ status: 503 }), "error");
  assert.equal(projectWorkspaceErrorKind(new Error("offline")), "error");
});
