import test from "node:test";
import assert from "node:assert/strict";

import { previewState } from "./fixtures.ts";
import { stripAnsi, visibleLength } from "./layout.ts";
import type { TerminalCapabilities } from "./types.ts";
import { renderWatchFrame } from "./watch.ts";

const capabilities = (columns: number, rows: number): TerminalCapabilities => ({
  interactive: true,
  ansi: true,
  colorDepth: 24,
  columns,
  rows,
  reason: "interactive",
});

for (const columns of [80, 99, 100, 159, 160]) {
  for (const [height, rows] of [
    ["short", 12],
    ["standard", 24],
    ["tall", 48],
  ] as const) {
    test(`watch frame fits ${columns} columns and ${height} height`, () => {
      const frame = renderWatchFrame(
        previewState,
        capabilities(columns, rows),
        0,
      );
      const lines = frame.split("\n");

      assert.ok(lines.length <= rows, `${lines.length} rows > ${rows}`);
      for (const line of lines) {
        assert.ok(
          visibleLength(line) <= columns,
          `${visibleLength(line)} cells > ${columns}: ${stripAnsi(line)}`,
        );
      }
    });
  }
}

test("narrow watch frame shows the selected decision record", () => {
  const frame = stripAnsi(
    renderWatchFrame(previewState, capabilities(80, 48), 0),
  );

  assert.match(frame, /DECISION RECORD/);
  assert.match(frame, /decision\s+deny/);
  assert.match(frame, /blast radius\s+41883 targets, measured/);
});

test("untrusted cost model text cannot inject terminal controls", () => {
  const state = {
    ...previewState,
    cost: [
      {
        model: "evil\u001b[2J\u001b]0;pwned\u0007",
        tokens: 1,
        records: 1,
        usd: null,
      },
    ],
  };
  const frame = renderWatchFrame(state, capabilities(80, 48), 0);
  const plain = stripAnsi(frame);

  assert.doesNotMatch(frame, /\u001b\[2J|\u001b\]0;|\u0007/);
  assert.match(plain, /evil\?\[2J\?\]0;pwned\?/);
  for (const line of plain.split("\n"))
    assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/);
});
