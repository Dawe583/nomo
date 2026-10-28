import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { WorkspaceInkFrame } from "./workspace-ink.ts";

test("Ink frame preserves styled NOMO glyphs without terminal-cell reflow", () => {
  const frame = "\u001b[34m∞ NOMO\u001b[0m\n  > Ask anything";
  const rendered = render(
    createElement(WorkspaceInkFrame, { frame, columns: 20, rows: 2 }),
  );

  try {
    const output = rendered.lastFrame() ?? "";
    const lines = stripAnsi(output).split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[0], "∞ NOMO");
    assert.equal(lines[1], "  > Ask anything");
    assert.ok(lines.every((line) => stringWidth(line) <= 20));
    assert.match(output, /\u001b\[34m/);
  } finally {
    rendered.unmount();
  }
});
