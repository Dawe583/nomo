import assert from "node:assert/strict";
import test from "node:test";
import {
  inlineMarkdownParts,
  markdownBlockRows,
  paintInlineMarkdown,
} from "./chat-markdown.ts";

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

test("painter applies emphasis and code tones then pads by visible cells", () => {
  const painted: string[] = [];
  const result = paintInlineMarkdown(
    "**Bold** `code`",
    20,
    "accent",
    (text, tone, bold) => {
      painted.push(`${tone}:${bold ? "bold" : "plain"}:${text}`);
      return text;
    },
  );
  assert.deepEqual(painted, [
    "accent:bold:Bold",
    "accent:plain: ",
    "info:plain:code",
  ]);
  assert.equal(result, "Bold code" + " ".repeat(11));
});

test("painter sanitizes terminal control characters before styling", () => {
  const seen: string[] = [];
  paintInlineMarkdown("safe\u001b[31m **bold**", 24, "accent", (text) => {
    seen.push(text);
    return text;
  });
  assert.deepEqual(seen, ["safe?[31m ", "bold"]);
});

test("chat block parser presents Markdown structure as safe text rows", () => {
  assert.deepEqual(
    markdownBlockRows(
      "## Plan\n- first\n1. second\n- [x] done\n> note\n```ts\nconst x = 1;\n```\n[docs](https://example.test)",
    ).map(({ text, style }) => ({ text, style })),
    [
      { text: "Plan", style: "heading" },
      { text: "• first", style: "list" },
      { text: "1. second", style: "list" },
      { text: "✓ done", style: "list" },
      { text: "│ note", style: "quote" },
      { text: "const x = 1;", style: "code" },
      { text: "docs <https://example.test>", style: "paragraph" },
    ],
  );
});

test("chat block parser exposes emphasis spans and keeps HTML literal", () => {
  const [row] = markdownBlockRows("<b>safe</b> **bold**");
  assert.equal(row?.text, "<b>safe</b> bold");
  assert.deepEqual(row?.parts, [
    { text: "<b>safe</b> " },
    { text: "bold", style: "strong" },
  ]);
  assert.deepEqual(
    markdownBlockRows("safe\u001b]0;title\u0007")[0]?.text,
    "safe?]0;title?",
  );
  assert.equal(
    markdownBlockRows("`[literal](https://example.test)`")[0]?.text,
    "[literal](https://example.test)",
    "link syntax inside code stays literal",
  );
});
