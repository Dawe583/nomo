import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceInput, workspaceShortcut } from "./workspace-runner.ts";

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

test("Ctrl+T transposes characters in the composer and opens TODOs outside it", () => {
  const input = new WorkspaceInput();
  input.editing = true;
  input.set("nomo");
  input.cursor = 3;
  input.key(undefined, { name: "t", ctrl: true });
  assert.equal(input.value, "noom");
  assert.equal(input.cursor, 4);
  assert.equal(workspaceShortcut({ name: "t", ctrl: true }, true, "noom"), undefined);
  assert.equal(workspaceShortcut({ name: "t", ctrl: true }, false, ""), "show-todos");

  input.set("nomo");
  input.cursor = 0;
  input.key(undefined, { name: "t", ctrl: true });
  assert.equal(input.value, "onmo", "line start transposes the first two characters");
  input.set("nomo");
  input.cursor = 4;
  input.key(undefined, { name: "t", ctrl: true });
  assert.equal(input.value, "noom", "line end transposes the last two characters");
  input.set("no\nmo");
  input.cursor = 2;
  input.key(undefined, { name: "t", ctrl: true });
  assert.equal(input.value, "on\nmo", "transpose acts on the preceding pair at line end");
});

test("replacing the composer invalidates the previous yank range", () => {
  const input = new WorkspaceInput();
  input.editing = true;
  input.set("one two");
  input.key(undefined, { name: "w", ctrl: true });
  input.key(undefined, { name: "a", ctrl: true });
  input.key(undefined, { name: "k", ctrl: true });
  input.set("");
  input.key(undefined, { name: "y", ctrl: true });
  input.set("fresh text");
  input.key(undefined, { name: "y", meta: true });
  assert.equal(input.value, "fresh text");
});
