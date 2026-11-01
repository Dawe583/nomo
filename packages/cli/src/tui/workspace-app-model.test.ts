import assert from "node:assert/strict";
import test from "node:test";

import { transcriptWindow } from "./workspace-app-model.ts";

test("chat transcript window follows latest rows, pages back and clamps at both ends", () => {
  const events = Array.from({ length: 12 }, (_, index) => index + 1);
  assert.deepEqual(transcriptWindow(events, -1, 4), [9, 10, 11, 12]);
  assert.deepEqual(transcriptWindow(events, 4, 4), [5, 6, 7, 8]);
  assert.deepEqual(transcriptWindow(events, 0, 4), [1, 2, 3, 4]);
  assert.deepEqual(transcriptWindow(events, 100, 4), [9, 10, 11, 12]);
  assert.deepEqual(transcriptWindow(events, -1, 0), [12]);
});
