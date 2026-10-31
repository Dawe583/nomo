import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceInput, nextModelId, workspaceShortcut } from "./workspace-runner.ts";

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


test("Ctrl+Home and Ctrl+End jump across the whole prompt", () => {
  const input = new WorkspaceInput();
  input.editing = true;
  input.set("first\nsecond\nthird");
  input.cursor = 10;
  input.key(undefined, { name: "home", ctrl: true });
  assert.equal(input.cursor, 0);
  input.key(undefined, { name: "end", ctrl: true });
  assert.equal(input.cursor, [...input.value].length);
});

test("Ctrl+Up and Ctrl+Down move between blank-line-separated paragraphs", () => {
  const input = new WorkspaceInput();
  input.editing = true;
  input.set("one\nline\n\ntwo\nend");
  input.cursor = 1;
  input.key(undefined, { name: "up", ctrl: true });
  assert.equal(input.cursor, 0);
  input.key(undefined, { name: "down", ctrl: true });
  assert.equal(input.cursor, 8);
  input.key(undefined, { name: "down", ctrl: true });
  assert.equal(input.cursor, 17);
});


test("Ctrl+Shift+Z redoes the last composer edit", () => {
  const input = new WorkspaceInput();
  input.editing = true;
  input.set("hello");
  input.key("!", { name: "!" });
  assert.equal(input.value, "hello!");
  input.key(undefined, { name: "_", ctrl: true });
  assert.equal(input.value, "hello");
  input.key(undefined, { name: "z", ctrl: true, shift: true });
  assert.equal(input.value, "hello!");
  input.key("?", { name: "?" });
  input.key(undefined, { name: "z", ctrl: true, shift: true });
  assert.equal(input.value, "hello!?", "a new edit clears the redo snapshot");
});


test("Alt+B and Alt+F move by punctuation-aware word boundaries across lines", () => {
  const input = new WorkspaceInput();
  input.editing = true;
  input.set("hello, world\nnext");
  input.cursor = 8;
  input.key(undefined, { name: "b", meta: true });
  assert.equal(input.cursor, 7, "word-back stops at the word start");
  input.cursor = 13;
  input.key(undefined, { name: "b", meta: true });
  assert.equal(input.cursor, 12, "word-back at line start jumps to previous line end");
  input.cursor = 12;
  input.key(undefined, { name: "f", meta: true });
  assert.equal(input.cursor, 13, "word-forward at line end jumps to next line start");
});


test("Alt+Left and Alt+Right match the Ctrl word-motion aliases", () => {
  const input = new WorkspaceInput();
  input.editing = true;
  input.set("one two");
  input.cursor = 7;
  input.key(undefined, { name: "left", meta: true });
  assert.equal(input.cursor, 4);
  input.key(undefined, { name: "right", meta: true });
  assert.equal(input.cursor, 7);
});


test("model cycle follows the loaded provider catalog without fallback", () => {
  const models = [{ id: "alpha" }, { id: "beta" }, { id: "charlie" }];
  assert.equal(nextModelId(models, "alpha", 1), "beta");
  assert.equal(nextModelId(models, "alpha", -1), "charlie");
  assert.equal(nextModelId(models, "not-in-catalog", 1), "alpha");
  assert.equal(nextModelId([], "alpha", 1), undefined);
});
