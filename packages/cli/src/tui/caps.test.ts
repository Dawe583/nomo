import test from "node:test";
import assert from "node:assert/strict";
import { detectCapabilities } from "./caps.ts";

for (const [reported, expected] of [
  [4, 4],
  [8, 8],
  [24, 24],
] as const) {
  test(`interactive terminal reports ${expected}-bit color depth`, () => {
    const caps = detectCapabilities(
      {},
      {
        isTTY: true,
        columns: 120,
        rows: 40,
        getColorDepth: () => reported,
      },
    );
    assert.deepEqual(
      {
        interactive: caps.interactive,
        ansi: caps.ansi,
        colorDepth: caps.colorDepth,
      },
      { interactive: true, ansi: true, colorDepth: expected },
    );
  });
}

test("explicit NOMO color, dumb TERM and CI stay undecorated", () => {
  const stream = {
    isTTY: true,
    columns: 80,
    rows: 24,
    getColorDepth: () => 24,
  };
  for (const env of [
    { NOMO_TUI_COLOR: "0" } as NodeJS.ProcessEnv,
    { TERM: "dumb" } as NodeJS.ProcessEnv,
    { CI: "1" } as NodeJS.ProcessEnv,
  ]) {
    const caps = detectCapabilities(env, stream);
    assert.equal(caps.ansi, false);
    assert.equal(caps.colorDepth, 0);
  }
  const inheritedNoColor = detectCapabilities({ NO_COLOR: "1" }, stream);
  assert.equal(inheritedNoColor.ansi, true);
  const redirected = detectCapabilities({}, { ...stream, isTTY: false });
  assert.equal(redirected.interactive, false);
  assert.equal(redirected.reason, "not-tty");
});
test("Kitty graphics are enabled only for known compatible interactive terminals", () => {
  const stream = {
    isTTY: true,
    columns: 80,
    rows: 24,
    getColorDepth: () => 24,
  };
  for (const env of [
    { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty" },
    { TERM: "xterm-kitty", TERM_PROGRAM: "xterm-kitty" },
    { TERM: "xterm-256color", TERM_PROGRAM: "WezTerm" },
    { TERM: "xterm-256color", KITTY_WINDOW_ID: "3" },
  ]) {
    assert.equal(detectCapabilities(env, stream).graphicsProtocol, "kitty");
  }

  const other = detectCapabilities({
    TERM: "xterm-256color",
    TERM_PROGRAM: "Apple_Terminal",
  }, stream);
  assert.equal(other.graphicsProtocol, undefined);

  const redirected = detectCapabilities({
    TERM: "xterm-ghostty",
    TERM_PROGRAM: "ghostty",
  }, { ...stream, isTTY: false });
  assert.equal(redirected.graphicsProtocol, undefined);
});
