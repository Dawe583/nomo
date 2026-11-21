import assert from "node:assert/strict";
import test from "node:test";
import { inlineMarkdownParts } from "./chat-markdown.ts";

test("inline emphasis and code become paintable spans", () => {
  assert.deepEqual(
    inlineMarkdownParts("Read **this**, __that__, and `code`."),
    [
      { text: "Read " },
      { text: "this", style: "strong" },
      { text: ", " },
      { text: "that", style: "strong" },
      { text: ", and " },
      { text: "code", style: "code" },
      { text: "." },
    ],
  );
});

test("unmatched markers and HTML remain literal", () => {
  const value = "Keep **unfinished, _single_, and <b>literal</b> text.";
  assert.deepEqual(inlineMarkdownParts(value), [{ text: value }]);
});

test("inline code keeps emphasis markers as code text", () => {
  assert.deepEqual(inlineMarkdownParts("`**literal**`"), [
    { text: "**literal**", style: "code" },
  ]);
});

test("plain and empty input stay plain", () => {
  assert.deepEqual(inlineMarkdownParts("plain text"), [{ text: "plain text" }]);
  assert.deepEqual(inlineMarkdownParts(""), [{ text: "" }]);
});
