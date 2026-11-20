import assert from "node:assert/strict";
import test from "node:test";
import { visibleLength } from "./layout.ts";
import { motionContext } from "./motion.ts";
import { renderTimeline } from "./run-timeline.ts";

test("compact run timeline keeps the current phase and its duration visible", () => {
  const state = {
    steps: [
      { phase: "queued", ms: 12 },
      { phase: "starting", ms: 33 },
      { phase: "thinking", ms: 900 },
      { phase: "tool", ms: 90 },
      { phase: "verifying", ms: 31 },
    ] as const,
    current: 4,
  };
  const still = renderTimeline(state, 30, 2, {
    motion: motionContext(0, false),
  });
  assert.match(still[0]!, /<▸ verifying>/);
  assert.match(still[1]!, /◎ verifying 31ms/);
  assert.ok(still.every((row) => visibleLength(row) <= 30));
  const live = (frame: number) =>
    renderTimeline(state, 30, 2, { motion: motionContext(frame) });
  assert.notDeepEqual(live(0), live(1));
});
