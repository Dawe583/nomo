import { test } from "node:test";
import assert from "node:assert/strict";
import { documentHistory, documentContentState } from "./document-history.ts";

test("history includes deleted targets and Undo evidence without changing source order", () => {
  const operations = [
    { id: "write", path: "gone.md", kind: "write", at: "1" },
    { id: "delete", path: "gone.md", kind: "delete", at: "2" },
    { id: "undo", path: "kept.md", kind: "undo", at: "3" },
  ];
  assert.deepEqual(
    documentHistory(operations, "").map((row) => row.id),
    ["undo", "delete", "write"],
  );
  assert.deepEqual(
    operations.map((row) => row.id),
    ["write", "delete", "undo"],
  );
  assert.equal(documentHistory(operations, "")[1], operations[1]);
  assert.equal("canApply" in documentHistory(operations, "")[1], false);
});

test("history searches retained paths and operation IDs, including absent documents", () => {
  const operations = [
    { id: "capture-123", path: "Deleted/Plan.md", kind: "delete", at: "1" },
    { id: "capture-456", path: "notes.md", kind: "write", at: "2" },
  ];
  assert.deepEqual(documentHistory(operations, "  deleted/PLAN  "), [
    operations[0],
  ]);
  assert.deepEqual(documentHistory(operations, "capture-456"), [operations[1]]);
  assert.deepEqual(documentHistory(operations, "missing"), []);
  assert.deepEqual(documentHistory([], ""), []);
});

test("recovery distinguishes absent documents, empty files and unavailable content", () => {
  assert.equal(documentContentState(null), "absent");
  assert.equal(documentContentState(""), "empty");
  assert.equal(documentContentState(undefined), "unavailable");
  assert.equal(documentContentState("\n"), "content");
});
