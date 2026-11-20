import assert from "node:assert/strict";
import test from "node:test";
import {
  animatedBar,
  completionRing,
  motionContext,
  phaseWave,
  separator,
  tabUnderline,
} from "./motion.ts";

test("active surfaces travel within a constant cell budget and respect still mode", () => {
  for (const render of [
    (m: ReturnType<typeof motionContext>) => phaseWave("Working", 24, m),
    (m: ReturnType<typeof motionContext>) => animatedBar(6, 8, 24, m),
    (m: ReturnType<typeof motionContext>) => separator(24, m, true),
    (m: ReturnType<typeof motionContext>) => tabUnderline(true, 24, m),
  ]) {
    const frames = [0, 1, 2, 3, 4].map((n) => render(motionContext(n)));
    assert.ok(new Set(frames).size > 1);
    assert.ok(frames.every((f) => f.length === 24));
    for (const [enabled, reduced] of [
      [false, false],
      [true, true],
    ] as const)
      assert.equal(
        render(motionContext(0, enabled, reduced)),
        render(motionContext(5, enabled, reduced)),
      );
  }
});

test("completion ring preserves the measured value with motion disabled", () => {
  for (const context of [
    motionContext(4, false),
    motionContext(4, true, true),
  ]) {
    assert.equal(completionRing(4, 4, context), "●");
    assert.equal(completionRing(0, 4, context), "◯");
  }
});
