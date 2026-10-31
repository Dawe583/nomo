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

test("Alt+Y replaces the latest yank with the next killed entry", () => {
  const input = new WorkspaceInput();
  input.editing = true;
  input.set("nomo beta");
  input.key(undefined, { name: "w", ctrl: true });
  input.key(undefined, { name: "a", ctrl: true });
  input.key(undefined, { name: "k", ctrl: true });
  input.set("");
  input.key(undefined, { name: "y", ctrl: true });
  assert.equal(input.value, "nomo ");

  input.key(undefined, { name: "y", meta: true });
  assert.equal(input.value, "beta");
  input.key(undefined, { name: "y", meta: true });
  assert.equal(input.value, "nomo ");
});

test("consecutive backward word kills accumulate for the next yank", () => {
  const input = new WorkspaceInput();
  input.editing = true;
  input.set("alpha beta gamma");
  input.key(undefined, { name: "w", ctrl: true });
  input.key(undefined, { name: "w", ctrl: true });
  assert.equal(input.value, "alpha ");
  input.key(undefined, { name: "y", ctrl: true });
  assert.equal(input.value, "alpha beta gamma");
});


test("Alt+Y is a no-op before a yank and after cursor motion", () => {
  const input = new WorkspaceInput();
  input.editing = true;
  input.set("one two");
  input.key(undefined, { name: "w", ctrl: true });
  input.key(undefined, { name: "y", meta: true });
  assert.equal(input.value, "one ");
  input.key(undefined, { name: "left" });
  input.key(undefined, { name: "y", meta: true });
  assert.equal(input.value, "one ");
});
