import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceInput } from "./workspace-runner.ts";

test("Alt+Backspace deletes the previous word and leaves an insertable cursor", () => {
  const input = new WorkspaceInput();
  input.editing = true;
  input.set("nomo one");

  input.key(undefined, { name: "backspace", meta: true });

  assert.equal(input.value, "nomo ");
  assert.equal(input.cursor, 5);
});
